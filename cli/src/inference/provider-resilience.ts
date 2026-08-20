import { ModelProviderError, type ProviderErrorKind } from "./ModelProvider.js";

export type ResilienceClock = () => number;
export type ResilienceRandom = () => number;
export type ResilienceSleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

export class ProviderResilienceCancellationError extends Error {
    constructor() {
        super("Provider resilience wait was cancelled");
        this.name = "ProviderResilienceCancellationError";
    }
}

export interface RetryClassification {
    retryable: boolean;
    retryAfterMs?: number;
    kind?: ProviderErrorKind;
}

export function classifyProviderError(error: unknown): RetryClassification {
    if (!(error instanceof ModelProviderError)) return { retryable: false };
    if (error.kind === "cancellation" || !error.retryable) return { retryable: false, kind: error.kind };

    const retryAfterMs = Number.isFinite(error.retryAfterMs) && (error.retryAfterMs ?? 0) >= 0
        ? error.retryAfterMs
        : undefined;
    return { retryable: true, retryAfterMs, kind: error.kind };
}

export interface RetryPolicyOptions {
    maxAttempts: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: boolean;
    clock?: ResilienceClock;
    random?: ResilienceRandom;
    sleep?: ResilienceSleep;
    classifyError?: (error: unknown) => RetryClassification;
}

const defaultClock: ResilienceClock = () => Date.now();
const defaultRandom: ResilienceRandom = () => Math.random();

function validateNonNegativeInteger(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
}

function validatePositiveInteger(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer`);
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ProviderResilienceCancellationError();
}

async function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (delayMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(new ProviderResilienceCancellationError());
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
}

export class RetryPolicy {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly jitter: boolean;
    private readonly random: ResilienceRandom;
    private readonly sleep: ResilienceSleep;
    private readonly classifyError: (error: unknown) => RetryClassification;

    constructor(options: RetryPolicyOptions) {
        validatePositiveInteger("maxAttempts", options.maxAttempts);
        const baseDelayMs = options.baseDelayMs ?? 1_000;
        const maxDelayMs = options.maxDelayMs ?? 30_000;
        validateNonNegativeInteger("baseDelayMs", baseDelayMs);
        validateNonNegativeInteger("maxDelayMs", maxDelayMs);
        if (maxDelayMs < baseDelayMs) throw new Error("maxDelayMs must be greater than or equal to baseDelayMs");

        this.maxAttempts = options.maxAttempts;
        this.baseDelayMs = baseDelayMs;
        this.maxDelayMs = maxDelayMs;
        this.jitter = options.jitter ?? false;
        this.random = options.random ?? defaultRandom;
        this.sleep = options.sleep ?? defaultSleep;
        this.classifyError = options.classifyError ?? classifyProviderError;
    }

    async execute<T>(operation: (attempt: number) => Promise<T>, signal = new AbortController().signal): Promise<T> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            throwIfAborted(signal);
            try {
                return await operation(attempt);
            } catch (error) {
                lastError = error;
                const classification = this.classifyError(error);
                if (signal.aborted) throw new ProviderResilienceCancellationError();
                if (!classification.retryable || attempt >= this.maxAttempts) throw error;

                const delay = classification.retryAfterMs ?? this.backoffDelay(attempt);
                await this.sleep(delay, signal);
            }
        }
        throw lastError;
    }

    private backoffDelay(attempt: number): number {
        const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
        return this.jitter ? Math.floor(exponential * this.random()) : exponential;
    }
}

export interface RateLimiterOptions {
    capacity: number;
    refillTokens: number;
    refillIntervalMs: number;
    clock?: ResilienceClock;
}

export interface RateLimitAdmission {
    allowed: boolean;
    remaining: number;
    nextEligibleAt?: number;
    reason?: "rate_limit";
}

export interface RateLimiterBucketSnapshot {
    credentialScope: string;
    tokens: number;
    lastRefillAt: number;
    nextEligibleAt?: number;
}

export interface RateLimiterSnapshot {
    buckets: RateLimiterBucketSnapshot[];
}

interface RateLimiterBucket {
    tokens: number;
    lastRefillAt: number;
    nextEligibleAt?: number;
}

export class CredentialScopeRateLimiter {
    private readonly buckets = new Map<string, RateLimiterBucket>();
    private readonly clock: ResilienceClock;
    private readonly capacity: number;
    private readonly refillTokens: number;
    private readonly refillIntervalMs: number;

    constructor(options: RateLimiterOptions) {
        validatePositiveInteger("capacity", options.capacity);
        validatePositiveInteger("refillTokens", options.refillTokens);
        validatePositiveInteger("refillIntervalMs", options.refillIntervalMs);
        this.capacity = options.capacity;
        this.refillTokens = options.refillTokens;
        this.refillIntervalMs = options.refillIntervalMs;
        this.clock = options.clock ?? defaultClock;
    }

    tryAcquire(credentialScope: string): RateLimitAdmission {
        this.assertScope(credentialScope);
        const now = this.clock();
        const bucket = this.bucketFor(credentialScope, now);
        this.refill(bucket, now);

        if (bucket.nextEligibleAt !== undefined && now < bucket.nextEligibleAt) {
            return {
                allowed: false,
                remaining: this.remaining(bucket.tokens),
                nextEligibleAt: bucket.nextEligibleAt,
                reason: "rate_limit",
            };
        }

        if (bucket.tokens < 1) {
            const nextEligibleAt = Math.max(now + this.timeUntilNextToken(bucket.tokens), bucket.nextEligibleAt ?? 0);
            bucket.nextEligibleAt = nextEligibleAt;
            return {
                allowed: false,
                remaining: this.remaining(bucket.tokens),
                nextEligibleAt,
                reason: "rate_limit",
            };
        }

        bucket.tokens -= 1;
        if (bucket.nextEligibleAt !== undefined && now >= bucket.nextEligibleAt) delete bucket.nextEligibleAt;
        return { allowed: true, remaining: this.remaining(bucket.tokens) };
    }

    defer(credentialScope: string, nextEligibleAt: number): void {
        this.assertScope(credentialScope);
        if (!Number.isSafeInteger(nextEligibleAt) || nextEligibleAt < 0) {
            throw new Error("nextEligibleAt must be a non-negative safe integer");
        }
        const now = this.clock();
        const bucket = this.bucketFor(credentialScope, now);
        this.refill(bucket, now);
        bucket.nextEligibleAt = Math.max(bucket.nextEligibleAt ?? 0, nextEligibleAt);
    }

    snapshot(): RateLimiterSnapshot {
        return {
            buckets: [...this.buckets.entries()].map(([credentialScope, bucket]) => ({
                credentialScope,
                tokens: bucket.tokens,
                lastRefillAt: bucket.lastRefillAt,
                ...(bucket.nextEligibleAt === undefined ? {} : { nextEligibleAt: bucket.nextEligibleAt }),
            })),
        };
    }

    restore(snapshot: RateLimiterSnapshot): void {
        if (!snapshot || !Array.isArray(snapshot.buckets)) throw new Error("Invalid rate limiter snapshot");
        const restored = new Map<string, RateLimiterBucket>();
        for (const bucket of snapshot.buckets) {
            this.assertScope(bucket.credentialScope);
            if (!Number.isFinite(bucket.tokens) || bucket.tokens < 0 || bucket.tokens > this.capacity) {
                throw new Error("Invalid rate limiter token state");
            }
            if (!Number.isSafeInteger(bucket.lastRefillAt) || bucket.lastRefillAt < 0) {
                throw new Error("Invalid rate limiter timestamp");
            }
            if (bucket.nextEligibleAt !== undefined
                && (!Number.isSafeInteger(bucket.nextEligibleAt) || bucket.nextEligibleAt < 0)) {
                throw new Error("Invalid rate limiter cooldown timestamp");
            }
            if (restored.has(bucket.credentialScope)) throw new Error("Duplicate credential scope in rate limiter snapshot");
            restored.set(bucket.credentialScope, {
                tokens: bucket.tokens,
                lastRefillAt: bucket.lastRefillAt,
                ...(bucket.nextEligibleAt === undefined ? {} : { nextEligibleAt: bucket.nextEligibleAt }),
            });
        }
        this.buckets.clear();
        for (const [scope, bucket] of restored) this.buckets.set(scope, bucket);
    }

    private bucketFor(scope: string, now: number): RateLimiterBucket {
        const existing = this.buckets.get(scope);
        if (existing) return existing;
        const bucket = { tokens: this.capacity, lastRefillAt: now };
        this.buckets.set(scope, bucket);
        return bucket;
    }

    private refill(bucket: RateLimiterBucket, now: number): void {
        if (now < bucket.lastRefillAt) throw new Error("Rate limiter clock moved backwards");
        const elapsed = now - bucket.lastRefillAt;
        if (elapsed > 0) {
            bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillTokens / this.refillIntervalMs);
            bucket.lastRefillAt = now;
        }
        if (bucket.nextEligibleAt !== undefined && now >= bucket.nextEligibleAt) delete bucket.nextEligibleAt;
    }

    private timeUntilNextToken(tokens: number): number {
        return Math.max(1, Math.ceil((1 - tokens) * this.refillIntervalMs / this.refillTokens));
    }

    private remaining(tokens: number): number {
        return Math.max(0, Math.floor(tokens * 1_000_000) / 1_000_000);
    }

    private assertScope(scope: string): void {
        if (!scope || !scope.trim()) throw new Error("credentialScope must not be empty");
    }
}

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
    failureThreshold: number;
    cooldownMs: number;
    clock?: ResilienceClock;
}

export interface CircuitPermit {
    allowed: boolean;
    state: CircuitState;
    nextAttemptAt?: number;
}

export interface CircuitBreakerSnapshot {
    state: CircuitState;
    consecutiveFailures: number;
    nextAttemptAt?: number;
    probeInFlight: boolean;
}

export class CircuitBreaker {
    private readonly clock: ResilienceClock;
    private readonly failureThreshold: number;
    private readonly cooldownMs: number;
    private state: CircuitState = "closed";
    private consecutiveFailures = 0;
    private nextAttemptAt?: number;
    private probeInFlight = false;

    constructor(options: CircuitBreakerOptions) {
        validatePositiveInteger("failureThreshold", options.failureThreshold);
        validatePositiveInteger("cooldownMs", options.cooldownMs);
        this.failureThreshold = options.failureThreshold;
        this.cooldownMs = options.cooldownMs;
        this.clock = options.clock ?? defaultClock;
    }

    beforeRequest(): CircuitPermit {
        const now = this.clock();
        if (this.state === "closed") return { allowed: true, state: "closed" };
        if (this.state === "open") {
            if (this.nextAttemptAt !== undefined && now < this.nextAttemptAt) {
                return { allowed: false, state: "open", nextAttemptAt: this.nextAttemptAt };
            }
            this.state = "half_open";
            this.probeInFlight = true;
            return { allowed: true, state: "half_open" };
        }
        if (this.probeInFlight) return { allowed: false, state: "half_open", nextAttemptAt: now };
        this.probeInFlight = true;
        return { allowed: true, state: "half_open" };
    }

    recordSuccess(): void {
        this.state = "closed";
        this.consecutiveFailures = 0;
        this.nextAttemptAt = undefined;
        this.probeInFlight = false;
    }

    recordFailure(counted: boolean): void {
        if (!counted) {
            if (this.state === "half_open") this.closeAfterUncountedProbe();
            return;
        }
        const now = this.clock();
        if (this.state === "half_open") {
            this.open(now);
            return;
        }
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.failureThreshold) this.open(now);
    }

    cancelProbe(): void {
        if (this.state !== "half_open") return;
        this.open(this.clock());
    }

    snapshot(): CircuitBreakerSnapshot {
        return {
            state: this.state,
            consecutiveFailures: this.consecutiveFailures,
            ...(this.nextAttemptAt === undefined ? {} : { nextAttemptAt: this.nextAttemptAt }),
            probeInFlight: this.probeInFlight,
        };
    }

    restore(snapshot: CircuitBreakerSnapshot): void {
        if (!snapshot || !["closed", "open", "half_open"].includes(snapshot.state)) {
            throw new Error("Invalid circuit breaker state");
        }
        if (!Number.isSafeInteger(snapshot.consecutiveFailures) || snapshot.consecutiveFailures < 0) {
            throw new Error("Invalid circuit breaker failure count");
        }
        if (snapshot.nextAttemptAt !== undefined
            && (!Number.isSafeInteger(snapshot.nextAttemptAt) || snapshot.nextAttemptAt < 0)) {
            throw new Error("Invalid circuit breaker cooldown timestamp");
        }
        this.consecutiveFailures = snapshot.consecutiveFailures;
        if (snapshot.state === "half_open") {
            this.state = "open";
            this.probeInFlight = false;
            this.nextAttemptAt = Math.max(snapshot.nextAttemptAt ?? 0, this.clock() + this.cooldownMs);
            return;
        }
        this.state = snapshot.state;
        this.nextAttemptAt = snapshot.nextAttemptAt;
        this.probeInFlight = false;
    }

    private open(now: number): void {
        this.state = "open";
        this.nextAttemptAt = now + this.cooldownMs;
        this.probeInFlight = false;
    }

    private closeAfterUncountedProbe(): void {
        this.state = "closed";
        this.consecutiveFailures = 0;
        this.nextAttemptAt = undefined;
        this.probeInFlight = false;
    }
}

export interface CircuitBreakerRegistryEntry extends CircuitBreakerSnapshot {
    providerId: string;
    credentialScope: string;
}

export interface CircuitBreakerRegistrySnapshot {
    breakers: CircuitBreakerRegistryEntry[];
}

export class CircuitBreakerRegistry {
    private readonly breakers = new Map<string, CircuitBreaker>();
    private readonly options: CircuitBreakerOptions;

    constructor(options: CircuitBreakerOptions) {
        this.options = { ...options };
    }

    get(providerId: string, credentialScope: string): CircuitBreaker {
        if (!providerId || !providerId.trim()) throw new Error("providerId must not be empty");
        if (!credentialScope || !credentialScope.trim()) throw new Error("credentialScope must not be empty");
        const key = `${providerId}\0${credentialScope}`;
        let breaker = this.breakers.get(key);
        if (!breaker) {
            breaker = new CircuitBreaker(this.options);
            this.breakers.set(key, breaker);
        }
        return breaker;
    }

    snapshot(): CircuitBreakerRegistrySnapshot {
        return {
            breakers: [...this.breakers.entries()].map(([key, breaker]) => {
                const separator = key.indexOf("\0");
                const providerId = key.slice(0, separator);
                const credentialScope = key.slice(separator + 1);
                return { providerId, credentialScope, ...breaker.snapshot() };
            }),
        };
    }

    restore(snapshot: CircuitBreakerRegistrySnapshot): void {
        if (!snapshot || !Array.isArray(snapshot.breakers)) throw new Error("Invalid circuit breaker registry snapshot");
        const restored = new Map<string, CircuitBreaker>();
        for (const entry of snapshot.breakers) {
            if (!entry.providerId || !entry.credentialScope) throw new Error("Invalid circuit breaker identity");
            const key = `${entry.providerId}\0${entry.credentialScope}`;
            if (restored.has(key)) throw new Error("Duplicate circuit breaker identity in snapshot");
            const breaker = new CircuitBreaker(this.options);
            breaker.restore(entry);
            restored.set(key, breaker);
        }
        this.breakers.clear();
        for (const [key, breaker] of restored) this.breakers.set(key, breaker);
    }
}

export interface ResilienceIdentity {
    providerId: string;
    credentialScope: string;
}

export type ProviderResilienceEvent =
    | {
        type: "circuit_open" | "circuit_half_open" | "provider_failure" | "provider_success";
        providerId: string;
        credentialScope: string;
        at: number;
        attempt?: number;
        nextAttemptAt?: number;
        errorKind?: ProviderErrorKind;
    }
    | {
        type: "waiting";
        providerId: string;
        credentialScope: string;
        at: number;
        attempt?: number;
        reason: "rate_limit" | "circuit_open";
        nextAttemptAt: number;
    };

export interface ProviderResilienceOptions {
    retry?: Omit<RetryPolicyOptions, "clock" | "random" | "sleep">;
    rateLimit?: Omit<RateLimiterOptions, "clock">;
    circuitBreaker?: Omit<CircuitBreakerOptions, "clock">;
    clock?: ResilienceClock;
    random?: ResilienceRandom;
    sleep?: ResilienceSleep;
    onEvent?: (event: ProviderResilienceEvent) => void;
}

export interface ProviderResilienceSnapshot {
    rateLimiter?: RateLimiterSnapshot;
    circuitBreakers: CircuitBreakerRegistrySnapshot;
}

export class ProviderResilience {
    private readonly clock: ResilienceClock;
    private readonly sleep: ResilienceSleep;
    private readonly onEvent?: (event: ProviderResilienceEvent) => void;
    private readonly retryPolicy: RetryPolicy;
    private readonly rateLimiter?: CredentialScopeRateLimiter;
    private readonly circuitBreakers: CircuitBreakerRegistry;

    constructor(options: ProviderResilienceOptions = {}) {
        this.clock = options.clock ?? defaultClock;
        this.sleep = options.sleep ?? defaultSleep;
        this.onEvent = options.onEvent;
        const retry = options.retry ?? { maxAttempts: 3 };
        this.retryPolicy = new RetryPolicy({
            ...retry,
            clock: this.clock,
            random: options.random,
            sleep: this.sleep,
        });
        if (options.rateLimit) {
            this.rateLimiter = new CredentialScopeRateLimiter({ ...options.rateLimit, clock: this.clock });
        }
        this.circuitBreakers = new CircuitBreakerRegistry({
            ...(options.circuitBreaker ?? { failureThreshold: 3, cooldownMs: 30_000 }),
            clock: this.clock,
        });
    }

    async execute<T>(
        identity: ResilienceIdentity,
        signal: AbortSignal,
        operation: () => Promise<T>,
    ): Promise<T> {
        this.assertIdentity(identity);
        return this.retryPolicy.execute(async (attempt) => {
            const breaker = this.circuitBreakers.get(identity.providerId, identity.credentialScope);
            while (true) {
                throwIfAborted(signal);
                const permit = breaker.beforeRequest();
                if (!permit.allowed) {
                    const nextAttemptAt = permit.nextAttemptAt ?? this.clock() + 1;
                    this.emit({
                        type: "waiting",
                        providerId: identity.providerId,
                        credentialScope: identity.credentialScope,
                        at: this.clock(),
                        reason: "circuit_open",
                        nextAttemptAt,
                    });
                    await this.waitUntil(nextAttemptAt, signal);
                    continue;
                }
                if (permit.state === "half_open") {
                    this.emit({
                        type: "circuit_half_open",
                        providerId: identity.providerId,
                        credentialScope: identity.credentialScope,
                        at: this.clock(),
                        attempt,
                    });
                }

                if (this.rateLimiter) {
                    const admission = this.rateLimiter.tryAcquire(identity.credentialScope);
                    if (!admission.allowed) {
                        if (permit.state === "half_open") breaker.cancelProbe();
                        const nextAttemptAt = admission.nextEligibleAt ?? this.clock() + 1;
                        this.emit({
                            type: "waiting",
                            providerId: identity.providerId,
                            credentialScope: identity.credentialScope,
                            at: this.clock(),
                            reason: "rate_limit",
                            nextAttemptAt,
                        });
                        await this.waitUntil(nextAttemptAt, signal);
                        continue;
                    }
                }

                return this.executeOperation(identity, breaker, operation, attempt);
            }
        }, signal);
    }

    snapshot(): ProviderResilienceSnapshot {
        return {
            ...(this.rateLimiter ? { rateLimiter: this.rateLimiter.snapshot() } : {}),
            circuitBreakers: this.circuitBreakers.snapshot(),
        };
    }

    restore(snapshot: ProviderResilienceSnapshot): void {
        if (snapshot.rateLimiter && this.rateLimiter) this.rateLimiter.restore(snapshot.rateLimiter);
        this.circuitBreakers.restore(snapshot.circuitBreakers);
    }

    private async executeOperation<T>(
        identity: ResilienceIdentity,
        breaker: CircuitBreaker,
        operation: () => Promise<T>,
        attempt: number,
    ): Promise<T> {
        try {
            const result = await operation();
            breaker.recordSuccess();
            this.emit({
                type: "provider_success",
                providerId: identity.providerId,
                credentialScope: identity.credentialScope,
                at: this.clock(),
                attempt,
            });
            return result;
        } catch (error) {
            const classification = classifyProviderError(error);
            if (classification.retryAfterMs !== undefined) {
                const nextAttemptAt = this.clock() + classification.retryAfterMs;
                if (this.rateLimiter) this.rateLimiter.defer(identity.credentialScope, nextAttemptAt);
                if (classification.retryable && attempt < this.retryPolicy.maxAttempts) {
                    this.emit({
                        type: "waiting",
                        providerId: identity.providerId,
                        credentialScope: identity.credentialScope,
                        at: this.clock(),
                        attempt,
                        reason: "rate_limit",
                        nextAttemptAt,
                    });
                }
            }
            breaker.recordFailure(classification.retryable);
            const snapshot = breaker.snapshot();
            this.emit({
                type: snapshot.state === "open" ? "circuit_open" : "provider_failure",
                providerId: identity.providerId,
                credentialScope: identity.credentialScope,
                at: this.clock(),
                attempt,
                nextAttemptAt: snapshot.nextAttemptAt,
                errorKind: classification.kind,
            });
            throw error;
        }
    }

    private async waitUntil(nextAttemptAt: number, signal: AbortSignal): Promise<void> {
        while (true) {
            throwIfAborted(signal);
            const remaining = nextAttemptAt - this.clock();
            if (remaining <= 0) return;
            await this.sleep(remaining, signal);
        }
    }

    private emit(event: ProviderResilienceEvent): void {
        this.onEvent?.(event);
    }

    private assertIdentity(identity: ResilienceIdentity): void {
        if (!identity.providerId || !identity.providerId.trim()) throw new Error("providerId must not be empty");
        if (!identity.credentialScope || !identity.credentialScope.trim()) {
            throw new Error("credentialScope must not be empty");
        }
    }
}
