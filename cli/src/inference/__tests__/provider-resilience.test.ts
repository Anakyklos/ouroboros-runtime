import { EventBus } from "../../daemon/event-bus.js";
import {
    CredentialedProviderInvoker,
    CredentialRegistry,
    createCredentialScope,
} from "../provider-security.js";
import {
    ModelProviderError,
    type ModelProvider,
    type ModelRequest,
    type ModelResponse,
    type ProviderCallContext,
} from "../ModelProvider.js";
import {
    CircuitBreaker,
    CircuitBreakerRegistry,
    CredentialScopeRateLimiter,
    ProviderResilience,
    ProviderResilienceCancellationError,
    RetryPolicy,
    classifyProviderError,
} from "../provider-resilience.js";

function providerError(
    kind: "network" | "rate_limit" | "http_unavailable" | "timeout" | "authentication" | "cancellation",
    options: Partial<ConstructorParameters<typeof ModelProviderError>[1]> = {},
): ModelProviderError {
    return new ModelProviderError(`synthetic ${kind}`, {
        kind,
        retryable: kind === "network" || kind === "rate_limit" || kind === "http_unavailable" || kind === "timeout",
        fallbackAllowed: kind !== "authentication" && kind !== "cancellation",
        ...options,
    });
}

function context(credentialRef: string, credentialScope: string, signal = new AbortController().signal): ProviderCallContext {
    return {
        credentialRef,
        credentialScope,
        taskId: "task-resilience",
        stepId: "step-resilience",
        signal,
        deadline: new Date(Date.now() + 30_000),
    };
}

function fakeProvider(complete: ModelProvider["complete"]): ModelProvider {
    return {
        providerId: "synthetic-provider",
        getCapabilities: (modelId) => ({
            providerId: "synthetic-provider",
            modelId,
            features: {
                streaming: { declared: false, implemented: false, verified: false },
                tools: { declared: false, implemented: false, verified: false },
                structuredOutput: { declared: false, implemented: false, verified: false },
            },
            limits: {},
            operations: {
                complete: { declared: true, implemented: true, verified: true },
                stream: { declared: false, implemented: false, verified: false },
            },
        }),
        complete,
    };
}

const request: ModelRequest = {
    modelId: "synthetic-model",
    messages: [{ role: "user", content: "synthetic prompt" }],
};

const response: ModelResponse = {
    modelId: "synthetic-model",
    content: "synthetic response",
    finishReason: "stop",
};

describe("provider resilience", () => {
    test("classifies only explicitly retryable provider errors", () => {
        expect(classifyProviderError(providerError("network"))).toMatchObject({ retryable: true, kind: "network" });
        expect(classifyProviderError(providerError("timeout"))).toMatchObject({ retryable: true, kind: "timeout" });
        expect(classifyProviderError(providerError("rate_limit", { retryAfterMs: 250 }))).toMatchObject({
            retryable: true,
            retryAfterMs: 250,
            kind: "rate_limit",
        });
        expect(classifyProviderError(providerError("authentication"))).toMatchObject({ retryable: false, kind: "authentication" });
        expect(classifyProviderError(new Error("unknown"))).toEqual({ retryable: false });
    });

    test("retries a retryable provider error until the operation succeeds", async () => {
        let calls = 0;
        const waits: number[] = [];
        const policy = new RetryPolicy({
            maxAttempts: 3,
            baseDelayMs: 10,
            sleep: async (delayMs) => waits.push(delayMs),
        });

        await expect(policy.execute(async () => {
            calls += 1;
            if (calls < 3) throw providerError("network");
            return "ok";
        })).resolves.toBe("ok");

        expect(calls).toBe(3);
        expect(waits).toEqual([10, 20]);
    });

    test("stops after the configured maximum and never loops forever", async () => {
        let calls = 0;
        const policy = new RetryPolicy({
            maxAttempts: 2,
            baseDelayMs: 0,
            sleep: async () => undefined,
        });
        const error = providerError("http_unavailable");

        await expect(policy.execute(async () => {
            calls += 1;
            throw error;
        })).rejects.toBe(error);

        expect(calls).toBe(2);
    });

    test("does not repeat a permanent provider error", async () => {
        let calls = 0;
        const policy = new RetryPolicy({
            maxAttempts: 5,
            baseDelayMs: 0,
            sleep: async () => undefined,
        });
        const error = providerError("authentication");

        await expect(policy.execute(async () => {
            calls += 1;
            throw error;
        })).rejects.toBe(error);

        expect(calls).toBe(1);
    });

    test("does not start an operation after cancellation", async () => {
        const controller = new AbortController();
        controller.abort();
        let calls = 0;
        const policy = new RetryPolicy({ maxAttempts: 3, sleep: async () => undefined });

        await expect(policy.execute(async () => {
            calls += 1;
            return "must not run";
        }, controller.signal)).rejects.toBeInstanceOf(ProviderResilienceCancellationError);

        expect(calls).toBe(0);
    });

    test("cancellation during backoff interrupts before the next attempt", async () => {
        const controller = new AbortController();
        let calls = 0;
        const policy = new RetryPolicy({
            maxAttempts: 3,
            baseDelayMs: 100,
            sleep: async () => controller.abort(),
        });

        await expect(policy.execute(async () => {
            calls += 1;
            throw providerError("network");
        }, controller.signal)).rejects.toBeInstanceOf(ProviderResilienceCancellationError);

        expect(calls).toBe(1);
    });

    test("uses Retry-After before the configured backoff and supports deterministic jitter", async () => {
        const waits: number[] = [];
        const policy = new RetryPolicy({
            maxAttempts: 3,
            baseDelayMs: 100,
            maxDelayMs: 1_000,
            jitter: true,
            random: () => 0.5,
            sleep: async (delayMs) => waits.push(delayMs),
        });
        let calls = 0;

        await expect(policy.execute(async () => {
            calls += 1;
            if (calls === 1) throw providerError("rate_limit", { retryAfterMs: 250 });
            if (calls === 2) throw providerError("network");
            return "ok";
        })).resolves.toBe("ok");

        expect(waits).toEqual([250, 100]);
    });

    test("isolates token buckets by credentialScope", () => {
        let now = 1_000;
        const limiter = new CredentialScopeRateLimiter({
            capacity: 1,
            refillTokens: 1,
            refillIntervalMs: 1_000,
            clock: () => now,
        });

        expect(limiter.tryAcquire("scope-a")).toMatchObject({ allowed: true, remaining: 0 });
        expect(limiter.tryAcquire("scope-a").allowed).toBe(false);
        expect(limiter.tryAcquire("scope-b")).toMatchObject({ allowed: true, remaining: 0 });

        now += 1_000;
        expect(limiter.tryAcquire("scope-a").allowed).toBe(true);
    });

    test("preserves per-scope cooldown and restores only opaque limiter state", () => {
        let now = 5_000;
        const limiter = new CredentialScopeRateLimiter({
            capacity: 2,
            refillTokens: 1,
            refillIntervalMs: 1_000,
            clock: () => now,
        });
        limiter.tryAcquire("scope-a");
        limiter.defer("scope-a", 9_000);
        limiter.tryAcquire("scope-b");

        const snapshot = limiter.snapshot();
        const serialized = JSON.stringify(snapshot);
        expect(serialized).not.toContain("secret");
        expect(snapshot.buckets).toEqual([
            expect.objectContaining({ credentialScope: "scope-a", nextEligibleAt: 9_000 }),
            expect.objectContaining({ credentialScope: "scope-b" }),
        ]);

        const restored = new CredentialScopeRateLimiter({
            capacity: 2,
            refillTokens: 1,
            refillIntervalMs: 1_000,
            clock: () => now,
        });
        restored.restore(snapshot);
        expect(restored.tryAcquire("scope-a").allowed).toBe(false);
        now = 9_000;
        expect(restored.tryAcquire("scope-a").allowed).toBe(true);
    });

    test("opens the circuit after consecutive transient failures", () => {
        const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000, clock: () => 1_000 });

        expect(breaker.beforeRequest()).toMatchObject({ allowed: true, state: "closed" });
        breaker.recordFailure(true);
        expect(breaker.snapshot()).toMatchObject({ state: "closed", consecutiveFailures: 1 });
        breaker.recordFailure(true);

        expect(breaker.beforeRequest()).toMatchObject({ allowed: false, state: "open", nextAttemptAt: 2_000 });
    });

    test("allows one half-open probe after cooldown and closes on success", () => {
        let now = 1_000;
        const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now });
        breaker.beforeRequest();
        breaker.recordFailure(true);

        now = 2_000;
        expect(breaker.beforeRequest()).toMatchObject({ allowed: true, state: "half_open" });
        expect(breaker.beforeRequest()).toMatchObject({ allowed: false, state: "half_open" });
        breaker.recordSuccess();
        expect(breaker.snapshot()).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    });

    test("keeps the circuit open when the half-open probe fails", () => {
        let now = 1_000;
        const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now });
        breaker.beforeRequest();
        breaker.recordFailure(true);
        now = 2_000;
        breaker.beforeRequest();
        breaker.recordFailure(true);

        expect(breaker.snapshot()).toMatchObject({ state: "open", nextAttemptAt: 3_000 });
    });

    test("isolates circuit state by providerId and credentialScope", () => {
        const registry = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 1_000, clock: () => 1_000 });
        const providerAUserA = registry.get("provider-a", "scope-a");
        providerAUserA.beforeRequest();
        providerAUserA.recordFailure(true);

        expect(registry.get("provider-a", "scope-a").beforeRequest().allowed).toBe(false);
        expect(registry.get("provider-a", "scope-b").beforeRequest().allowed).toBe(true);
        expect(registry.get("provider-b", "scope-a").beforeRequest().allowed).toBe(true);
    });

    test("composes limiter, circuit breaker and retry without extra provider calls on cancellation", async () => {
        let now = 10_000;
        const waits: number[] = [];
        const events: unknown[] = [];
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 3, baseDelayMs: 100 },
            rateLimit: { capacity: 2, refillTokens: 1, refillIntervalMs: 1_000, clock: () => now },
            circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, clock: () => now },
            clock: () => now,
            sleep: async (delayMs) => { waits.push(delayMs); now += delayMs; },
            onEvent: (event) => events.push(event),
        });
        let calls = 0;
        const result = await resilience.execute(
            { providerId: "provider-a", credentialScope: "scope-a" },
            new AbortController().signal,
            async () => {
                calls += 1;
                if (calls === 1) throw providerError("rate_limit", { retryAfterMs: 500 });
                return "ok";
            },
        );

        expect(result).toBe("ok");
        expect(calls).toBe(2);
        expect(waits).toContain(500);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "waiting", reason: "rate_limit" }),
            expect.objectContaining({ type: "provider_success" }),
        ]));
        expect(JSON.stringify(events)).not.toContain("synthetic prompt");
        expect(JSON.stringify(events)).not.toContain("synthetic response");
    });

    test("reopens a circuit only for a controlled half-open probe after cooldown", async () => {
        let now = 1_000;
        const events: string[] = [];
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1, baseDelayMs: 0 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 1_000 },
            clock: () => now,
            sleep: async (delayMs) => { now += delayMs; },
            onEvent: (event) => events.push(event.type),
        });

        await expect(resilience.execute(
            { providerId: "provider-a", credentialScope: "scope-a" },
            new AbortController().signal,
            async () => { throw providerError("network"); },
        )).rejects.toThrow(ModelProviderError);
        await expect(resilience.execute(
            { providerId: "provider-a", credentialScope: "scope-a" },
            new AbortController().signal,
            async () => "recovered",
        )).resolves.toBe("recovered");

        expect(events).toContain("circuit_open");
        expect(events).toContain("circuit_half_open");
    });

    test("applies resilience in CredentialedProviderInvoker without exposing the secret", async () => {
        const eventBus = new EventBus();
        const secret = "synthetic-secret-that-must-not-leak";
        const credentialRef = "credential://synthetic/ref";
        const registry = new CredentialRegistry("resilience-test-salt");
        registry.register(credentialRef, secret);
        const credentialScope = createCredentialScope(credentialRef, "resilience-test-salt");
        let transportCalls = 0;
        const provider = fakeProvider(async () => response);
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 2, baseDelayMs: 0, sleep: async () => undefined },
            rateLimit: { capacity: 10, refillTokens: 10, refillIntervalMs: 1_000 },
            circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000 },
        });
        const invoker = new CredentialedProviderInvoker(provider, registry, eventBus, {
            complete: async (transportProvider, transportRequest, transportContext, transportSecret) => {
                transportCalls += 1;
                expect(transportSecret).toBe(secret);
                return transportProvider.complete(transportRequest, transportContext);
            },
        }, resilience);

        const result = await invoker.complete(
            request,
            { credentialRef, credentialScope },
            context(credentialRef, credentialScope),
        );

        expect(result).toEqual(response);
        expect(transportCalls).toBe(1);
        const serialized = JSON.stringify({ snapshot: resilience.snapshot(), result });
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain(credentialRef);
        expect(serialized).not.toContain("synthetic prompt");
    });

    test("retries transport failures through CredentialedProviderInvoker", async () => {
        const eventBus = new EventBus();
        const secret = "synthetic-invoker-secret";
        const credentialRef = "credential://synthetic/invoker";
        const registry = new CredentialRegistry("invoker-resilience-salt");
        registry.register(credentialRef, secret);
        const credentialScope = createCredentialScope(credentialRef, "invoker-resilience-salt");
        let transportCalls = 0;
        const provider = fakeProvider(async () => response);
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 2, baseDelayMs: 0 },
            sleep: async () => undefined,
        });
        const invoker = new CredentialedProviderInvoker(provider, registry, eventBus, {
            complete: async (transportProvider, transportRequest, transportContext) => {
                transportCalls += 1;
                if (transportCalls === 1) throw providerError("network");
                return transportProvider.complete(transportRequest, transportContext);
            },
        }, resilience);

        await expect(invoker.complete(
            request,
            { credentialRef, credentialScope },
            context(credentialRef, credentialScope),
        )).resolves.toEqual(response);
        expect(transportCalls).toBe(2);
    });
});
