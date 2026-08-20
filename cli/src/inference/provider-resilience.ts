/**
 * 🛡️ Provider resilience policy (Issue #47).
 *
 * Vendor-neutral, bounded, deterministic and cancelable policy for the
 * `PlannerModelProvider` boundary and other authorized external calls.
 *
 * Authority rules (binding):
 * - The provider/model NEVER gains authority to decide retry, fallback,
 *   capability selection or effects. Retry happens only for explicitly
 *   typed, explicitly retryable `ModelProviderError`s. Fallback happens
 *   only through an explicitly authorized, ordered call plan.
 * - Quota and circuit state are isolated per `(providerId, credentialScope)`:
 *   a provider never consumes or blocks another provider's quota merely
 *   because they share a credential scope.
 * - Every wait is finite (bounded cooldowns, bounded attempts, explicit
 *   per-execution time budget) and cancelable through the caller's
 *   `AbortSignal`. The time budget belongs to one `execute()` call:
 *   the instance stores only the configured duration, and every
 *   wait — retry backoff, `Retry-After`, quota/circuit cooldown and
 *   the concurrency queue — is capped by the remaining budget, so no
 *   wait can oversleep the deadline.
 * - This layer is NOT a scheduler and owns no durable store. Cooldown /
 *   `nextEligibleAt` state is exported through `snapshot()`/`restore()`
 *   and, when a Mission is waiting on a provider, mapped onto the
 *   existing durable Mission abstractions (`MissionState.WAITING_FOR_PROVIDER`
 *   and `CapabilityInvocation.retry.nextEligibleAt`) by the consumer.
 *   The MissionScheduler remains the single authority for durable
 *   resumption; `providerWaitBackoffMs()` bridges a waiting event onto
 *   the existing `MissionEngine.prepareInvocationRetry` backoff input.
 * - Timeout / uncertain delivery is never blindly retried: the contract
 *   table in docs/MODEL_PROVIDER_CONTRACT.md marks `timeout` as
 *   non-retryable and this policy enforces it fail-closed, regardless
 *   of a transport adapter's flag. Delivery reconciliation belongs to
 *   the Mission runtime (#50), not to this boundary.
 * - The circuit breaker does not replace the failure domains / supervisors
 *   of #59; it only guards this provider boundary.
 */

import { ModelProviderError, type ProviderErrorKind } from "./ModelProvider.js";

export type ResilienceClock = () => number;
export type ResilienceRandom = () => number;
export type ResilienceSleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

/** Caller cancelled the wait or the call. Never retried, never a fallback trigger. */
export class ProviderResilienceCancellationError extends Error {
    constructor() {
        super("Provider resilience wait was cancelled");
        this.name = "ProviderResilienceCancellationError";
    }
}

/** The finite time budget of a resilience call was exhausted. Explicit failure. */
export class ProviderResilienceBudgetError extends Error {
    constructor() {
        super("Provider resilience time budget exhausted");
        this.name = "ProviderResilienceBudgetError";
    }
}

export interface RetryClassification {
    retryable: boolean;
    retryAfterMs?: number;
    kind?: ProviderErrorKind;
    fallbackAllowed?: boolean;
}

/**
 * Kinds the provider contract (docs/MODEL_PROVIDER_CONTRACT.md) marks as
 * never retry-safe. Enforced fail-closed: even a mislabeled
 * `retryable: true` cannot make these retry, because a retry would either
 * be pointless (authentication, authorization, invalid request, malformed
 * response, provider-specific) or would blindly repeat a call whose delivery
 * is uncertain (timeout, cancellation).
 */
const NEVER_RETRYABLE_PROVIDER_ERROR_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
    "authentication",
    "authorization",
    "invalid_request",
    "timeout",
    "cancellation",
    "malformed_response",
    "provider",
]);

/** Only these kinds may ever be retryable, and only when the error says so. */
const MAYBE_RETRYABLE_PROVIDER_ERROR_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
    "rate_limit",
    "network",
    "http_unavailable",
]);

export function classifyProviderError(error: unknown): RetryClassification {
    if (!(error instanceof ModelProviderError)) return { retryable: false };
    if (NEVER_RETRYABLE_PROVIDER_ERROR_KINDS.has(error.kind)) {
        return { retryable: false, kind: error.kind, fallbackAllowed: error.fallbackAllowed };
    }
    if (!MAYBE_RETRYABLE_PROVIDER_ERROR_KINDS.has(error.kind) || !error.retryable) {
        return { retryable: false, kind: error.kind, fallbackAllowed: error.fallbackAllowed };
    }

    const retryAfterMs = Number.isFinite(error.retryAfterMs) && (error.retryAfterMs ?? 0) >= 0
        ? error.retryAfterMs
        : undefined;
    return { retryable: true, retryAfterMs, kind: error.kind, fallbackAllowed: error.fallbackAllowed };
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

    /**
     * Execute with a bounded attempt budget. `maxAttempts` includes the
     * initial call, so the operation runs at most `maxAttempts` times.
     * Only explicitly retryable classifications sleep and retry; the wait
     * is `Retry-After` when the provider supplied it, otherwise the
     * exponential backoff (with optional deterministic jitter).
     *
     * An optional `budget` bounds the whole execution in wall-clock
     * time: every retry wait is capped at the remaining budget, so a
     * long `Retry-After` or backoff can never oversleep the deadline —
     * the execution ends with `ProviderResilienceBudgetError` at the
     * deadline instead of sleeping past it.
     */
    async execute<T>(
        operation: (attempt: number) => Promise<T>,
        signal = new AbortController().signal,
        budget?: ResilienceExecutionBudget,
    ): Promise<T> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            throwIfAborted(signal);
            budget?.assert();
            try {
                return await operation(attempt);
            } catch (error) {
                lastError = error;
                const classification = this.classifyError(error);
                if (signal.aborted) throw new ProviderResilienceCancellationError();
                if (!classification.retryable || attempt >= this.maxAttempts) throw error;

                await this.sleepBetweenAttempts(classification, attempt, signal, budget);
            }
        }
        throw lastError;
    }

    /**
     * Sleep the retry delay (`Retry-After` takes precedence over
     * the configured backoff). With a budget, the wait is capped
     * at the remaining budget: the execution ends at the deadline
     * rather than oversleeping it, and no further attempt starts.
     */
    private async sleepBetweenAttempts(
        classification: RetryClassification,
        attempt: number,
        signal: AbortSignal,
        budget?: ResilienceExecutionBudget,
    ): Promise<void> {
        const delay = classification.retryAfterMs ?? this.backoffDelay(attempt);
        if (!budget) {
            await this.sleep(delay, signal);
            return;
        }
        const remaining = budget.remaining();
        if (remaining <= 0) throw new ProviderResilienceBudgetError();
        await this.sleep(Math.min(delay, remaining), signal);
        budget.assert();
    }

    private backoffDelay(attempt: number): number {
        const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
        return this.jitter ? Math.floor(exponential * this.random()) : exponential;
    }
}

export interface QuotaLimiterOptions {
    capacity: number;
    refillTokens: number;
    refillIntervalMs: number;
    clock?: ResilienceClock;
}

export interface QuotaAdmission {
    allowed: boolean;
    remaining: number;
    nextEligibleAt?: number;
    reason?: "rate_limit";
}

export interface QuotaBucketSnapshot {
    providerId: string;
    credentialScope: string;
    tokens: number;
    lastRefillAt: number;
    nextEligibleAt?: number;
}

export interface QuotaSnapshot {
    buckets: QuotaBucketSnapshot[];
}

interface QuotaBucket {
    tokens: number;
    lastRefillAt: number;
    nextEligibleAt?: number;
}

function quotaKey(providerId: string, credentialScope: string): string {
    assertProviderId(providerId);
    assertCredentialScope(credentialScope);
    return `${providerId}\0${credentialScope}`;
}

/**
 * Token-bucket quota/pacing isolated per `(providerId, credentialScope)`.
 * Two providers that share a credential scope never share a bucket: one
 * provider cannot consume or block another provider's quota.
 */
export class ProviderQuotaLimiter {
    private readonly buckets = new Map<string, QuotaBucket>();
    private readonly clock: ResilienceClock;
    private readonly capacity: number;
    private readonly refillTokens: number;
    private readonly refillIntervalMs: number;

    constructor(options: QuotaLimiterOptions) {
        validatePositiveInteger("capacity", options.capacity);
        validatePositiveInteger("refillTokens", options.refillTokens);
        validatePositiveInteger("refillIntervalMs", options.refillIntervalMs);
        this.capacity = options.capacity;
        this.refillTokens = options.refillTokens;
        this.refillIntervalMs = options.refillIntervalMs;
        this.clock = options.clock ?? defaultClock;
    }

    tryAcquire(providerId: string, credentialScope: string): QuotaAdmission {
        const key = quotaKey(providerId, credentialScope);
        const now = this.clock();
        const bucket = this.bucketFor(key, now);
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

    /** Defer eligibility (e.g. a provider-mandated `Retry-After`) for one `(providerId, credentialScope)`. */
    defer(providerId: string, credentialScope: string, nextEligibleAt: number): void {
        const key = quotaKey(providerId, credentialScope);
        if (!Number.isSafeInteger(nextEligibleAt) || nextEligibleAt < 0) {
            throw new Error("nextEligibleAt must be a non-negative safe integer");
        }
        const now = this.clock();
        const bucket = this.bucketFor(key, now);
        this.refill(bucket, now);
        bucket.nextEligibleAt = Math.max(bucket.nextEligibleAt ?? 0, nextEligibleAt);
    }

    snapshot(): QuotaSnapshot {
        return {
            buckets: [...this.buckets.entries()].map(([key, bucket]) => {
                const separator = key.indexOf("\0");
                return {
                    providerId: key.slice(0, separator),
                    credentialScope: key.slice(separator + 1),
                    tokens: bucket.tokens,
                    lastRefillAt: bucket.lastRefillAt,
                    ...(bucket.nextEligibleAt === undefined ? {} : { nextEligibleAt: bucket.nextEligibleAt }),
                };
            }),
        };
    }

    restore(snapshot: QuotaSnapshot): void {
        if (!snapshot || !Array.isArray(snapshot.buckets)) throw new Error("Invalid quota limiter snapshot");
        const restored = new Map<string, QuotaBucket>();
        for (const bucket of snapshot.buckets) {
            const key = quotaKey(bucket.providerId, bucket.credentialScope);
            if (!Number.isFinite(bucket.tokens) || bucket.tokens < 0 || bucket.tokens > this.capacity) {
                throw new Error("Invalid quota limiter token state");
            }
            if (!Number.isSafeInteger(bucket.lastRefillAt) || bucket.lastRefillAt < 0) {
                throw new Error("Invalid quota limiter timestamp");
            }
            if (bucket.nextEligibleAt !== undefined
                && (!Number.isSafeInteger(bucket.nextEligibleAt) || bucket.nextEligibleAt < 0)) {
                throw new Error("Invalid quota limiter cooldown timestamp");
            }
            if (restored.has(key)) throw new Error("Duplicate (providerId, credentialScope) in quota limiter snapshot");
            restored.set(key, {
                tokens: bucket.tokens,
                lastRefillAt: bucket.lastRefillAt,
                ...(bucket.nextEligibleAt === undefined ? {} : { nextEligibleAt: bucket.nextEligibleAt }),
            });
        }
        this.buckets.clear();
        for (const [key, bucket] of restored) this.buckets.set(key, bucket);
    }

    private bucketFor(key: string, now: number): QuotaBucket {
        const existing = this.buckets.get(key);
        if (existing) return existing;
        const bucket = { tokens: this.capacity, lastRefillAt: now };
        this.buckets.set(key, bucket);
        return bucket;
    }

    private refill(bucket: QuotaBucket, now: number): void {
        if (now < bucket.lastRefillAt) throw new Error("Quota limiter clock moved backwards");
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
}

export interface ConcurrencyLimiterOptions {
    maxConcurrency: number;
}

export interface ConcurrencyAdmission {
    acquired: boolean;
    inFlight: number;
    maxConcurrency: number;
}

export interface ConcurrencyEntrySnapshot {
    providerId: string;
    credentialScope: string;
    inFlight: number;
    waiting: number;
}

export interface ConcurrencySnapshot {
    entries: ConcurrencyEntrySnapshot[];
}

interface WaiterEntry {
    resolve: () => void;
    cancel: () => void;
}

/**
 * Explicit concurrency bound per `(providerId, credentialScope)`.
 * Slots are handed off directly from `release` to the earliest waiter,
 * so the configured bound is never exceeded and waiters are woken
 * event-driven (no polling, no busy-wait).
 */
export class ProviderConcurrencyLimiter {
    private readonly maxConcurrency: number;
    private readonly inFlight = new Map<string, number>();
    private readonly waiters = new Map<string, WaiterEntry[]>();

    constructor(options: ConcurrencyLimiterOptions) {
        validatePositiveInteger("maxConcurrency", options.maxConcurrency);
        this.maxConcurrency = options.maxConcurrency;
    }

    tryAcquire(providerId: string, credentialScope: string): ConcurrencyAdmission {
        const key = quotaKey(providerId, credentialScope);
        const current = this.inFlight.get(key) ?? 0;
        if (current >= this.maxConcurrency) {
            return { acquired: false, inFlight: current, maxConcurrency: this.maxConcurrency };
        }
        this.inFlight.set(key, current + 1);
        return { acquired: true, inFlight: current + 1, maxConcurrency: this.maxConcurrency };
    }

    /**
     * Acquire a slot, waiting event-driven for a release when the
     * bound is reached. Slot ownership is transferred by `release`,
     * so the caller always owns exactly one slot when this resolves.
     * Aborting the signal while queued removes the waiter without
     * acquiring. With an execution budget, the queue wait is raced
     * against the budget: when the budget expires first, the
     * waiter is removed without acquiring a slot and the wait
     * rejects with `ProviderResilienceBudgetError`.
     */
    async acquire(
        providerId: string,
        credentialScope: string,
        signal: AbortSignal,
        budget?: ResilienceExecutionBudget,
    ): Promise<void> {
        budget?.assert();
        if (this.tryAcquire(providerId, credentialScope).acquired) return;
        const key = quotaKey(providerId, credentialScope);
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            let expiry: { promise: Promise<void>; cancel: () => void } | undefined;
            const cleanup = () => {
                signal.removeEventListener("abort", onAbort);
                expiry?.cancel();
            };
            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                this.removeWaiter(key, entry);
                cleanup();
                fn();
            };
            const onAbort = () => settle(() => reject(new ProviderResilienceCancellationError()));
            const onExpiry = () => settle(() => reject(new ProviderResilienceBudgetError()));
            const entry: WaiterEntry = {
                resolve: () => settle(resolve),
                cancel: onAbort,
            };
            signal.addEventListener("abort", onAbort, { once: true });
            const queue = this.waiters.get(key);
            if (queue) queue.push(entry);
            else this.waiters.set(key, [entry]);
            if (signal.aborted) {
                onAbort();
                return;
            }
            expiry = budget?.armExpiry(signal);
            // Only a rejection expires the wait: a resolution
            // means the sleep ended without the clock reaching
            // the deadline (a no-op sleep), leaving the budget
            // unexpired and the race to the wait itself.
            if (expiry) expiry.promise.then(() => undefined, onExpiry);
        });
    }

    private removeWaiter(key: string, entry: WaiterEntry): void {
        const queue = this.waiters.get(key);
        if (!queue) return;
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        if (queue.length === 0) this.waiters.delete(key);
    }

    release(providerId: string, credentialScope: string): void {
        const key = quotaKey(providerId, credentialScope);
        const current = this.inFlight.get(key) ?? 0;
        if (current <= 0) return;
        const queue = this.waiters.get(key);
        if (queue && queue.length > 0) {
            // Hand the slot directly to the earliest waiter: the in-flight
            // count is unchanged and the bound still holds.
            const entry = queue.shift()!;
            if (queue.length === 0) this.waiters.delete(key);
            entry.resolve();
            return;
        }
        const next = current - 1;
        if (next === 0) this.inFlight.delete(key);
        else this.inFlight.set(key, next);
    }

    inFlightCount(providerId: string, credentialScope: string): number {
        return this.inFlight.get(quotaKey(providerId, credentialScope)) ?? 0;
    }

    waitingCount(providerId: string, credentialScope: string): number {
        return this.waiters.get(quotaKey(providerId, credentialScope))?.length ?? 0;
    }

    snapshot(): ConcurrencySnapshot {
        const entries: ConcurrencyEntrySnapshot[] = [];
        const reported = new Set<string>();
        for (const [key, inFlight] of this.inFlight) {
            reported.add(key);
            const separator = key.indexOf("\0");
            entries.push({
                providerId: key.slice(0, separator),
                credentialScope: key.slice(separator + 1),
                inFlight,
                waiting: this.waiters.get(key)?.length ?? 0,
            });
        }
        for (const [key, queue] of this.waiters) {
            if (reported.has(key) || queue.length === 0) continue;
            const separator = key.indexOf("\0");
            entries.push({
                providerId: key.slice(0, separator),
                credentialScope: key.slice(separator + 1),
                inFlight: 0,
                waiting: queue.length,
            });
        }
        return { entries };
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
            // A half-open probe never survives a restart: only one process
            // may own the probe. Restore as open with a fresh cooldown.
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
        const key = quotaKey(providerId, credentialScope);
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
            const key = quotaKey(entry.providerId, entry.credentialScope);
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
    }
    | {
        type: "fallback";
        providerId: string;
        credentialScope: string;
        nextProviderId: string;
        nextCredentialScope: string;
        at: number;
        attempt?: number;
        errorKind?: ProviderErrorKind;
    };

/**
 * The explicitly authorized call plan. `primary` is always attempted.
 * `fallbacks` is an optional, ordered list of additional authorized
 * identities. Nothing outside this plan is ever attempted: fallback is
 * opt-in, deterministic and policy-authorized — the provider/model never
 * selects a fallback and there is no marketplace/router automation.
 */
export interface ResilienceCallPlan {
    primary: ResilienceIdentity;
    fallbacks?: readonly ResilienceIdentity[];
}

/**
 * The finite time budget of ONE `execute()` call. The
 * `ProviderResilience` instance stores only the configured
 * duration; every execution creates its own budget, so an
 * idle instance never expires future executions and
 * sequential executions never share a deadline. Every wait
 * controlled by the policy — retry backoff, provider-mandated
 * `Retry-After`, quota cooldown, circuit cooldown and the
 * concurrency queue — is capped by the remaining budget and
 * can never oversleep the deadline.
 */
export interface ResilienceExecutionBudget {
    /** Absolute deadline on the injected clock. */
    readonly deadline: number;
    /** Remaining budget in ms (<= 0 once exhausted). */
    remaining(): number;
    /** Throws `ProviderResilienceBudgetError` once exhausted. */
    assert(): void;
    /**
     * Arms the budget's expiry timer for an event-driven wait
     * (the concurrency queue). `promise` rejects with
     * `ProviderResilienceBudgetError` when the budget expires
     * and with `ProviderResilienceCancellationError` when
     * `signal` aborts first; `cancel()` disarms the underlying
     * timer so a race won by the wait never leaves a dangling
     * timer behind.
     */
    armExpiry(signal: AbortSignal): { promise: Promise<void>; cancel: () => void };
}

export interface ProviderResilienceOptions {
    retry?: Omit<RetryPolicyOptions, "clock" | "random" | "sleep" | "classifyError">;
    quota?: Omit<QuotaLimiterOptions, "clock">;
    concurrency?: ConcurrencyLimiterOptions;
    circuitBreaker?: Omit<CircuitBreakerOptions, "clock">;
    /**
     * Finite wall-clock budget for one `execute` call, including every
     * wait (retry backoff, `Retry-After`, quota/circuit cooldown,
     * concurrency slot). Every `execute()` call receives the full
     * budget — the instance stores only the duration, so a resident
     * instance never expires future executions. Defaults to
     * 300_000 ms so a resilience call can never wait forever.
     */
    timeBudgetMs?: number;
    clock?: ResilienceClock;
    random?: ResilienceRandom;
    sleep?: ResilienceSleep;
    classifyError?: (error: unknown) => RetryClassification;
    onEvent?: (event: ProviderResilienceEvent) => void;
}

export interface ProviderResilienceSnapshot {
    quota?: QuotaSnapshot;
    circuitBreakers: CircuitBreakerRegistrySnapshot;
    /**
     * In-flight/waiting counts are process-local runtime state: they are
     * reported for observability and are NEVER restored. A restarted
     * process owns no in-flight calls; only quota cooldowns and circuit
     * cooldowns survive a restart.
     */
    concurrency?: ConcurrencySnapshot;
}

/** Default finite time budget for a resilience call (5 minutes). */
export const DEFAULT_PROVIDER_RESILIENCE_TIME_BUDGET_MS = 300_000;

/**
 * Map a resilience `waiting` event onto the existing durable Mission
 * retry abstraction: the result is the `backoffMs` input of
 * `MissionEngine.prepareInvocationRetry`, which persists
 * `CapabilityInvocation.retry.nextEligibleAt` — the same durable wakeup
 * the `MissionScheduler` queries (`getNextInvocationWakeAt`). This helper
 * creates no store and owns no scheduling; the MissionScheduler remains
 * the resumption authority.
 */
export function providerWaitBackoffMs(event: ProviderResilienceEvent, now: number): number {
    if (event.type !== "waiting") throw new Error("provider wait backoff requires a waiting event");
    if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error("now must be a non-negative safe integer");
    }
    return Math.max(0, event.nextAttemptAt - now);
}

export class ProviderResilience {
    private readonly clock: ResilienceClock;
    private readonly sleep: ResilienceSleep;
    private readonly onEvent?: (event: ProviderResilienceEvent) => void;
    private readonly classifyError: (error: unknown) => RetryClassification;
    private readonly retryPolicy: RetryPolicy;
    private readonly quota?: ProviderQuotaLimiter;
    private readonly concurrency?: ProviderConcurrencyLimiter;
    private readonly circuitBreakers: CircuitBreakerRegistry;
    private readonly timeBudgetMs: number;

    constructor(options: ProviderResilienceOptions = {}) {
        this.clock = options.clock ?? defaultClock;
        this.sleep = options.sleep ?? defaultSleep;
        this.onEvent = options.onEvent;
        this.classifyError = options.classifyError ?? classifyProviderError;
        const retry = options.retry ?? { maxAttempts: 3 };
        this.retryPolicy = new RetryPolicy({
            ...retry,
            clock: this.clock,
            random: options.random,
            sleep: this.sleep,
            classifyError: this.classifyError,
        });
        if (options.quota) {
            this.quota = new ProviderQuotaLimiter({ ...options.quota, clock: this.clock });
        }
        if (options.concurrency) {
            this.concurrency = new ProviderConcurrencyLimiter(options.concurrency);
        }
        this.circuitBreakers = new CircuitBreakerRegistry({
            ...(options.circuitBreaker ?? { failureThreshold: 3, cooldownMs: 30_000 }),
            clock: this.clock,
        });
        const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_PROVIDER_RESILIENCE_TIME_BUDGET_MS;
        validatePositiveInteger("timeBudgetMs", timeBudgetMs);
        // Only the duration is stored: every execute() call
        // creates its own budget (see createExecutionBudget),
        // so a resident instance never expires future
        // executions and sequential executions never share
        // a deadline.
        this.timeBudgetMs = timeBudgetMs;
    }

    /**
     * One budget per `execute()` call. The deadline is
     * computed when the execution starts, never at
     * construction, and every wait of this execution —
     * retry backoff, `Retry-After`, quota/circuit cooldown
     * and the concurrency queue — is capped by the
     * remaining budget.
     */
    private createExecutionBudget(): ResilienceExecutionBudget {
        const deadline = this.clock() + this.timeBudgetMs;
        const clock = this.clock;
        const sleep = this.sleep;
        return {
            deadline,
            remaining: () => deadline - clock(),
            assert() {
                if (clock() >= deadline) throw new ProviderResilienceBudgetError();
            },
            armExpiry(signal: AbortSignal) {
                const controller = new AbortController();
                const onCallerAbort = () => controller.abort();
                if (signal.aborted) controller.abort();
                else signal.addEventListener("abort", onCallerAbort, { once: true });
                const promise = (async () => {
                    const remaining = deadline - clock();
                    if (remaining <= 0) throw new ProviderResilienceBudgetError();
                    await sleep(remaining, controller.signal);
                    // The budget expired only if the clock
                    // actually reached the deadline. A sleep
                    // that resolves without advancing the
                    // clock (a no-op sleep) leaves the
                    // budget unexpired: time stands still,
                    // so the expiry stays pending and the
                    // race is won by the wait itself.
                    if (clock() >= deadline) throw new ProviderResilienceBudgetError();
                })();
                return {
                    promise,
                    cancel: () => {
                        signal.removeEventListener("abort", onCallerAbort);
                        controller.abort();
                    },
                };
            },
        };
    }

    /**
     * Execute one authorized call plan. The primary identity is attempted
     * with the bounded retry policy; on a terminal error that explicitly
     * allows fallback, the next authorized identity in the plan is
     * attempted (each identity gets its own full attempt budget; the
     * finite time budget spans the whole `execute()` call, starting at
     * its first attempt). Without a configured fallback the failure is
     * explicit. Cancellation and budget exhaustion never trigger a
     * fallback.
     */
    async execute<T>(
        plan: ResilienceCallPlan,
        signal: AbortSignal,
        operation: (identity: ResilienceIdentity) => Promise<T>,
    ): Promise<T> {
        const identities = this.assertPlan(plan);
        // One time budget per execute() call: created here,
        // never at construction, so a resident instance
        // cannot poison future executions.
        const budget = this.createExecutionBudget();
        let lastError: unknown;
        for (let index = 0; index < identities.length; index += 1) {
            const identity = identities[index];
            try {
                return await this.retryPolicy.execute(
                    (attempt) => this.attemptWithGuards(identity, signal, operation, attempt, budget),
                    signal,
                    budget,
                );
            } catch (error) {
                lastError = error;
                if (error instanceof ProviderResilienceCancellationError) throw error;
                if (error instanceof ProviderResilienceBudgetError) throw error;
                const nextIdentity = identities[index + 1];
                if (!nextIdentity) throw error;
                const classification = this.classifyError(error);
                if (!classification.fallbackAllowed) throw error;
                this.emit({
                    type: "fallback",
                    providerId: identity.providerId,
                    credentialScope: identity.credentialScope,
                    nextProviderId: nextIdentity.providerId,
                    nextCredentialScope: nextIdentity.credentialScope,
                    at: this.clock(),
                    errorKind: classification.kind,
                });
            }
        }
        throw lastError;
    }

    snapshot(): ProviderResilienceSnapshot {
        return {
            ...(this.quota ? { quota: this.quota.snapshot() } : {}),
            ...(this.concurrency ? { concurrency: this.concurrency.snapshot() } : {}),
            circuitBreakers: this.circuitBreakers.snapshot(),
        };
    }

    /**
     * Restore quota and circuit cooldowns exported by `snapshot()`, so
     * `nextEligibleAt`/cooldowns survive re-instantiation (and, when the
     * consumer persists the snapshot through the existing durable Mission
     * abstractions, a process restart). Concurrency in-flight state is
     * process-local and is never restored.
     */
    restore(snapshot: ProviderResilienceSnapshot): void {
        if (snapshot.quota && this.quota) this.quota.restore(snapshot.quota);
        this.circuitBreakers.restore(snapshot.circuitBreakers);
    }

    private async attemptWithGuards<T>(
        identity: ResilienceIdentity,
        signal: AbortSignal,
        operation: (identity: ResilienceIdentity) => Promise<T>,
        attempt: number,
        budget: ResilienceExecutionBudget,
    ): Promise<T> {
        const breaker = this.circuitBreakers.get(identity.providerId, identity.credentialScope);
        while (true) {
            throwIfAborted(signal);
            budget.assert();
            const permit = breaker.beforeRequest();
            if (!permit.allowed) {
                const nextAttemptAt = permit.nextAttemptAt ?? this.clock() + 1;
                this.emit({
                    type: "waiting",
                    providerId: identity.providerId,
                    credentialScope: identity.credentialScope,
                    at: this.clock(),
                    attempt,
                    reason: "circuit_open",
                    nextAttemptAt,
                });
                await this.waitUntil(nextAttemptAt, signal, budget);
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

            if (this.quota) {
                const admission = this.quota.tryAcquire(identity.providerId, identity.credentialScope);
                if (!admission.allowed) {
                    if (permit.state === "half_open") breaker.cancelProbe();
                    const nextAttemptAt = admission.nextEligibleAt ?? this.clock() + 1;
                    this.emit({
                        type: "waiting",
                        providerId: identity.providerId,
                        credentialScope: identity.credentialScope,
                        at: this.clock(),
                        attempt,
                        reason: "rate_limit",
                        nextAttemptAt,
                    });
                    await this.waitUntil(nextAttemptAt, signal, budget);
                    continue;
                }
            }

            if (this.concurrency) {
                await this.concurrency.acquire(
                    identity.providerId,
                    identity.credentialScope,
                    signal,
                    budget,
                );
                if (signal.aborted) {
                    // The abort raced with the slot handoff: give the slot
                    // back and refuse to start the operation.
                    this.concurrency.release(identity.providerId, identity.credentialScope);
                    throw new ProviderResilienceCancellationError();
                }
            }
            try {
                return await this.executeOperation(identity, breaker, operation, attempt);
            } finally {
                this.concurrency?.release(identity.providerId, identity.credentialScope);
            }
        }
    }

    private async executeOperation<T>(
        identity: ResilienceIdentity,
        breaker: CircuitBreaker,
        operation: (identity: ResilienceIdentity) => Promise<T>,
        attempt: number,
    ): Promise<T> {
        try {
            const result = await operation(identity);
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
            const classification = this.classifyError(error);
            if (classification.retryAfterMs !== undefined) {
                const nextAttemptAt = this.clock() + classification.retryAfterMs;
                this.quota?.defer(identity.providerId, identity.credentialScope, nextAttemptAt);
                if (classification.retryable) {
                    // The provider mandated a wait. Surface it even when
                    // this layer will not retry internally: the consumer
                    // (e.g. the durable Mission runtime) needs nextAttemptAt
                    // to arrange its own explicit, durable wait.
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

    /**
     * Wait until `nextAttemptAt` (a quota or circuit cooldown).
     * With a budget, the wait is capped at the remaining budget
     * so a long cooldown can never oversleep the execution
     * deadline: the execution ends with
     * `ProviderResilienceBudgetError` at the deadline.
     */
    private async waitUntil(
        nextAttemptAt: number,
        signal: AbortSignal,
        budget?: ResilienceExecutionBudget,
    ): Promise<void> {
        while (true) {
            throwIfAborted(signal);
            budget?.assert();
            const remaining = nextAttemptAt - this.clock();
            if (remaining <= 0) return;
            if (budget) {
                const budgetRemaining = budget.remaining();
                if (budgetRemaining <= 0) throw new ProviderResilienceBudgetError();
                await this.sleep(Math.min(remaining, budgetRemaining), signal);
                budget.assert();
                continue;
            }
            await this.sleep(remaining, signal);
        }
    }

    private emit(event: ProviderResilienceEvent): void {
        this.onEvent?.(event);
    }

    private assertPlan(plan: ResilienceCallPlan): ResilienceIdentity[] {
        if (!plan || typeof plan !== "object") throw new Error("resilience call plan must be an object");
        const identities: ResilienceIdentity[] = [plan.primary, ...(plan.fallbacks ?? [])];
        const seen = new Set<string>();
        for (const identity of identities) {
            this.assertIdentity(identity);
            const key = `${identity.providerId}\0${identity.credentialScope}`;
            if (seen.has(key)) throw new Error("resilience call plan must not repeat an identity");
            seen.add(key);
        }
        return identities;
    }

    private assertIdentity(identity: ResilienceIdentity): void {
        if (!identity.providerId || !identity.providerId.trim()) throw new Error("providerId must not be empty");
        if (!identity.credentialScope || !identity.credentialScope.trim()) {
            throw new Error("credentialScope must not be empty");
        }
    }
}

function assertProviderId(providerId: string): void {
    if (!providerId || !providerId.trim()) throw new Error("providerId must not be empty");
}

function assertCredentialScope(credentialScope: string): void {
    if (!credentialScope || !credentialScope.trim()) throw new Error("credentialScope must not be empty");
}
