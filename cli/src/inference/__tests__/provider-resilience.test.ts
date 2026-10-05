import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
import { parseRetryAfterMs } from "../LocalInferenceProvider.js";
import {
    CircuitBreaker,
    CircuitBreakerRegistry,
    ProviderConcurrencyLimiter,
    ProviderQuotaLimiter,
    ProviderResilience,
    ProviderResilienceBudgetError,
    ProviderResilienceCancellationError,
    RetryPolicy,
    classifyProviderError,
    providerWaitBackoffMs,
    type CircuitBreakerRegistryEntry,
    type ProviderResilienceEvent,
    type QuotaBucketSnapshot,
    type ResilienceCallPlan,
    type ResilienceIdentity,
    type ResilienceSleep,
} from "../provider-resilience.js";
import { MissionEngine } from "../../mission/mission-engine.js";
import { MissionScheduler } from "../../mission/mission-scheduler.js";
import {
    EffectClass,
    InvocationStatus,
    MissionState,
    hasUncertainDelivery,
    isInvocationDue,
    isSafeRetryEligible,
} from "../../mission/contracts.js";
import { PlanPolicyValidator } from "../../mission/policy.js";
import { SqliteMissionStore } from "../../mission/sqlite-mission-store.js";
import {
    FakeCapabilityResolver,
    FakeClock,
    FakeIdGenerator,
    FakeVerificationAuthority,
    makeDefaultCapabilityCatalog,
} from "../../mission/testing.js";
import { CapabilityRegistry } from "../../capabilities/registry.js";
import { defineCapabilityDescriptor } from "../../capabilities/fixtures.js";
import { CapabilityResultStatus } from "../../capabilities/connector.js";
import { ConnectorDispatchSeam } from "../../capabilities/dispatch-seam.js";
import {
    CancellationSupport,
    IdempotencyMode,
    ReconciliationSupport,
    RetryBackoff,
} from "../../capabilities/contracts.js";

function providerError(
    kind: "network" | "rate_limit" | "http_unavailable" | "timeout" | "authentication" | "cancellation",
    options: Partial<ConstructorParameters<typeof ModelProviderError>[1]> = {},
): ModelProviderError {
    return new ModelProviderError(`synthetic ${kind}`, {
        kind,
        retryable: kind === "network" || kind === "rate_limit" || kind === "http_unavailable",
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

const identity: ResilienceIdentity = { providerId: "provider-a", credentialScope: "scope-a" };

function planFor(...identities: ResilienceIdentity[]): ResilienceCallPlan {
    const [primary, ...fallbacks] = identities;
    return { primary, ...(fallbacks.length > 0 ? { fallbacks } : {}) };
}

describe("provider resilience", () => {
    test("classifies only explicitly retryable provider errors, fail-closed on the contract table", () => {
        expect(classifyProviderError(providerError("network"))).toMatchObject({ retryable: true, kind: "network" });
        expect(classifyProviderError(providerError("rate_limit", { retryAfterMs: 250 }))).toMatchObject({
            retryable: true,
            retryAfterMs: 250,
            kind: "rate_limit",
        });
        expect(classifyProviderError(providerError("http_unavailable"))).toMatchObject({
            retryable: true,
            kind: "http_unavailable",
        });
        expect(classifyProviderError(providerError("authentication"))).toMatchObject({ retryable: false, kind: "authentication" });
        expect(classifyProviderError(new Error("unknown"))).toEqual({ retryable: false });
    });

    test("never classifies timeout as retryable, even when a transport mislabels it", () => {
        // docs/MODEL_PROVIDER_CONTRACT.md: timeout delivery is
        // uncertain, so retry is never safe — enforced fail-closed
        // regardless of the adapter's flag.
        expect(classifyProviderError(providerError("timeout", { retryable: true }))).toMatchObject({
            retryable: false,
            kind: "timeout",
        });
    });

    test("surfaces the fallback hint without granting fallback authority", () => {
        expect(classifyProviderError(providerError("network"))).toMatchObject({ fallbackAllowed: true });
        expect(classifyProviderError(providerError("authentication"))).toMatchObject({ fallbackAllowed: false });
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

    test("does not blindly retry a timeout-class error", async () => {
        let calls = 0;
        const policy = new RetryPolicy({
            maxAttempts: 5,
            baseDelayMs: 0,
            sleep: async () => undefined,
        });
        // Even a mislabeled `retryable: true` timeout must not
        // produce a second send: delivery is uncertain.
        const error = providerError("timeout", { retryable: true });

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

    test("produces a reproducible backoff sequence with a fake clock and jitter RNG", async () => {
        const makePolicy = (sleeps: number[]): RetryPolicy => new RetryPolicy({
            maxAttempts: 4,
            baseDelayMs: 100,
            maxDelayMs: 1_000,
            jitter: true,
            random: () => 0.25,
            sleep: async (delayMs) => {
                sleeps.push(delayMs);
            },
        });
        const first: number[] = [];
        const second: number[] = [];
        const failAlways = async (): Promise<never> => {
            throw providerError("network");
        };
        try {
            await makePolicy(first).execute(failAlways);
        } catch {
            // expected: the operation always fails
        }
        try {
            await makePolicy(second).execute(failAlways);
        } catch {
            // expected: the operation always fails
        }
        // jitter = floor(backoff * 0.25): 100→25, 200→50, 400→100.
        // The same fake RNG reproduces the exact sequence.
        expect(first).toEqual([25, 50, 100]);
        expect(second).toEqual([25, 50, 100]);
    });

    test("preserves the provider Retry-After parser for seconds and HTTP-date", () => {
        // The parser stays owned by LocalInferenceProvider (#44/#15);
        // the resilience policy consumes ModelProviderError.retryAfterMs.
        expect(parseRetryAfterMs("120")).toBe(120_000);
        expect(parseRetryAfterMs("0")).toBe(0);
        const future = new Date(Date.now() + 60_000).toUTCString();
        const parsed = parseRetryAfterMs(future);
        expect(parsed).toBeGreaterThan(0);
        expect(parsed).toBeLessThanOrEqual(60_000);
        expect(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBeUndefined();
        expect(parseRetryAfterMs("not-a-date")).toBeUndefined();
        expect(parseRetryAfterMs(null)).toBeUndefined();
    });
});

describe("provider quota limiter", () => {
    test("isolates token buckets by (providerId, credentialScope)", () => {
        let now = 1_000;
        const limiter = new ProviderQuotaLimiter({
            capacity: 1,
            refillTokens: 1,
            refillIntervalMs: 1_000,
            clock: () => now,
        });

        expect(limiter.tryAcquire("provider-a", "scope-a")).toMatchObject({ allowed: true, remaining: 0 });
        // The same provider is rate limited by its own bucket...
        expect(limiter.tryAcquire("provider-a", "scope-a").allowed).toBe(false);
        // ...but a different provider sharing the scope keeps its own quota.
        expect(limiter.tryAcquire("provider-b", "scope-a")).toMatchObject({ allowed: true, remaining: 0 });
        // A different scope is also isolated.
        expect(limiter.tryAcquire("provider-a", "scope-b")).toMatchObject({ allowed: true, remaining: 0 });

        now += 1_000;
        expect(limiter.tryAcquire("provider-a", "scope-a").allowed).toBe(true);
    });

    test("preserves per-identity cooldown and restores only opaque limiter state", () => {
        let now = 5_000;
        const limiter = new ProviderQuotaLimiter({
            capacity: 2,
            refillTokens: 1,
            refillIntervalMs: 1_000,
            clock: () => now,
        });
        limiter.tryAcquire("provider-a", "scope-a");
        limiter.defer("provider-a", "scope-a", 9_000);
        limiter.tryAcquire("provider-b", "scope-a");

        const snapshot = limiter.snapshot();
        const serialized = JSON.stringify(snapshot);
        expect(serialized).not.toContain("secret");
        expect(snapshot.buckets).toEqual([
            expect.objectContaining({ providerId: "provider-a", credentialScope: "scope-a", nextEligibleAt: 9_000 }),
            expect.objectContaining({ providerId: "provider-b", credentialScope: "scope-a" }),
        ]);

        const restored = new ProviderQuotaLimiter({
            capacity: 2,
            refillTokens: 1,
            refillIntervalMs: 1_000,
            clock: () => now,
        });
        restored.restore(snapshot);
        expect(restored.tryAcquire("provider-a", "scope-a").allowed).toBe(false);
        expect(restored.tryAcquire("provider-b", "scope-a").allowed).toBe(true);
        now = 9_000;
        expect(restored.tryAcquire("provider-a", "scope-a").allowed).toBe(true);
    });

    test("rejects invalid snapshots instead of restoring partial state", () => {
        const limiter = new ProviderQuotaLimiter({
            capacity: 1,
            refillTokens: 1,
            refillIntervalMs: 1_000,
        });
        expect(() => limiter.restore({ buckets: [{ providerId: "p", credentialScope: "s", tokens: 99, lastRefillAt: 0 }] })).toThrow();
        expect(() => limiter.restore({ buckets: "nope" as unknown as QuotaBucketSnapshot[] })).toThrow();
    });
});

describe("provider concurrency limiter", () => {
    test("never admits more calls than the configured bound", () => {
        const limiter = new ProviderConcurrencyLimiter({ maxConcurrency: 2 });

        expect(limiter.tryAcquire("provider-a", "scope-a")).toMatchObject({ acquired: true, inFlight: 1 });
        expect(limiter.tryAcquire("provider-a", "scope-a")).toMatchObject({ acquired: true, inFlight: 2 });
        expect(limiter.tryAcquire("provider-a", "scope-a")).toMatchObject({ acquired: false, inFlight: 2, maxConcurrency: 2 });

        limiter.release("provider-a", "scope-a");
        expect(limiter.tryAcquire("provider-a", "scope-a")).toMatchObject({ acquired: true, inFlight: 2 });
    });

    test("isolates the bound per (providerId, credentialScope)", () => {
        const limiter = new ProviderConcurrencyLimiter({ maxConcurrency: 1 });

        expect(limiter.tryAcquire("provider-a", "scope-a").acquired).toBe(true);
        // A different provider sharing the scope has its own bound.
        expect(limiter.tryAcquire("provider-b", "scope-a").acquired).toBe(true);
        // A different scope is also independent.
        expect(limiter.tryAcquire("provider-a", "scope-b").acquired).toBe(true);
    });

    test("hands a released slot directly to the earliest waiter", async () => {
        const limiter = new ProviderConcurrencyLimiter({ maxConcurrency: 1 });
        expect(limiter.tryAcquire("provider-a", "scope-a").acquired).toBe(true);

        const second = limiter.acquire("provider-a", "scope-a", new AbortController().signal);
        let secondCompleted = false;
        const observed = second.then(() => {
            secondCompleted = true;
        });
        // Still queued: the only slot is in flight.
        expect(limiter.inFlightCount("provider-a", "scope-a")).toBe(1);
        expect(limiter.waitingCount("provider-a", "scope-a")).toBe(1);

        limiter.release("provider-a", "scope-a");
        await observed;
        expect(secondCompleted).toBe(true);
        // The waiter now owns the slot without exceeding the bound.
        expect(limiter.inFlightCount("provider-a", "scope-a")).toBe(1);

        limiter.release("provider-a", "scope-a");
        expect(limiter.inFlightCount("provider-a", "scope-a")).toBe(0);
        await second;
    });

    test("aborting a queued wait removes the waiter without acquiring a slot", async () => {
        const limiter = new ProviderConcurrencyLimiter({ maxConcurrency: 1 });
        expect(limiter.tryAcquire("provider-a", "scope-a").acquired).toBe(true);

        const controller = new AbortController();
        const queued = limiter.acquire("provider-a", "scope-a", controller.signal);
        const observed = queued.then(
            () => "must not acquire",
            (error) => error,
        );
        controller.abort();

        const outcome = await observed;
        expect(outcome).toBeInstanceOf(ProviderResilienceCancellationError);
        expect(limiter.waitingCount("provider-a", "scope-a")).toBe(0);
        // The original slot is untouched and reusable after release.
        limiter.release("provider-a", "scope-a");
        expect(limiter.tryAcquire("provider-a", "scope-a").acquired).toBe(true);
    });

    test("reports in-flight and waiting counts without exposing identities beyond the bound", () => {
        const limiter = new ProviderConcurrencyLimiter({ maxConcurrency: 1 });
        limiter.tryAcquire("provider-a", "scope-a");
        const snapshot = limiter.snapshot();
        expect(snapshot.entries).toEqual([
            { providerId: "provider-a", credentialScope: "scope-a", inFlight: 1, waiting: 0 },
        ]);
    });
});

describe("circuit breaker", () => {
    test("opens the circuit after consecutive transient failures", () => {
        const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000, clock: () => 1_000 });

        const first = breaker.beforeRequest();
        const second = breaker.beforeRequest();
        expect(first).toMatchObject({ allowed: true, state: "closed" });
        breaker.recordFailure(first, true);
        expect(breaker.snapshot()).toMatchObject({ state: "closed", consecutiveFailures: 1 });
        breaker.recordFailure(second, true);

        expect(breaker.beforeRequest()).toMatchObject({ allowed: false, state: "open", nextAttemptAt: 2_000 });
    });

    test("allows one half-open probe after cooldown and closes on success", () => {
        let now = 1_000;
        const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now });
        breaker.recordFailure(breaker.beforeRequest(), true);

        now = 2_000;
        const probe = breaker.beforeRequest();
        expect(probe).toMatchObject({ allowed: true, state: "half_open" });
        expect(breaker.beforeRequest()).toMatchObject({ allowed: false, state: "half_open" });
        breaker.recordSuccess(probe);
        expect(breaker.snapshot()).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    });

    test("keeps the circuit open when the half-open probe fails", () => {
        let now = 1_000;
        const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now });
        breaker.recordFailure(breaker.beforeRequest(), true);

        now = 2_000;
        const probe = breaker.beforeRequest();
        expect(probe).toMatchObject({ allowed: true, state: "half_open" });
        breaker.recordFailure(probe, true);
        expect(breaker.snapshot()).toMatchObject({ state: "open", nextAttemptAt: 3_000 });
        expect(breaker.beforeRequest()).toMatchObject({ allowed: false, state: "open" });
    });

    test("isolates circuit state by providerId and credentialScope", () => {
        let now = 1_000;
        const registry = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now });

        const breaker = registry.get("provider-a", "scope-a");
        breaker.recordFailure(breaker.beforeRequest(), true);
        expect(registry.get("provider-a", "scope-a").beforeRequest().allowed).toBe(false);
        // Same scope, different provider: independent breaker.
        expect(registry.get("provider-b", "scope-a").beforeRequest().allowed).toBe(true);
        // Different scope: independent breaker.
        expect(registry.get("provider-a", "scope-b").beforeRequest().allowed).toBe(true);
    });

    test("restores an open breaker and never restores a live half-open probe", () => {
        let now = 1_000;
        const registry = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 5_000, clock: () => now });
        const breaker = registry.get("provider-a", "scope-a");
        breaker.recordFailure(breaker.beforeRequest(), true);

        const snapshot = registry.snapshot();
        const restored = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 5_000, clock: () => now });
        restored.restore(snapshot);
        expect(restored.get("provider-a", "scope-a").beforeRequest()).toMatchObject({
            allowed: false,
            state: "open",
            nextAttemptAt: 6_000,
        });

        // A half-open probe is process-local: it is restored as open
        // with a fresh cooldown so two processes never probe at once.
        const probeRegistry = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 5_000, clock: () => now });
        const probeBreaker = probeRegistry.get("provider-b", "scope-b");
        probeBreaker.recordFailure(probeBreaker.beforeRequest(), true);
        now = 6_000;
        expect(probeRegistry.get("provider-b", "scope-b").beforeRequest().state).toBe("half_open");
        const probeSnapshot = probeRegistry.snapshot();
        const probeRestored = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 5_000, clock: () => now });
        probeRestored.restore(probeSnapshot);
        expect(probeRestored.get("provider-b", "scope-b").snapshot()).toMatchObject({
            state: "open",
            probeInFlight: false,
        });
        expect(probeRestored.get("provider-b", "scope-b").beforeRequest()).toMatchObject({
            allowed: false,
            state: "open",
            nextAttemptAt: 11_000,
        });
    });

    test("rejects invalid breaker snapshots", () => {
        const registry = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 1_000 });
        expect(() => registry.restore({ breakers: [{ providerId: "p", credentialScope: "s", state: "broken", consecutiveFailures: 0, probeInFlight: false }] })).toThrow();
        expect(() => registry.restore({ breakers: "nope" as unknown as CircuitBreakerRegistryEntry[] })).toThrow();
    });

    test("ignores a concurrent closed permit after another permit opens the circuit", () => {
        let now = 1_000;
        const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now });
        const first = breaker.beforeRequest();
        const late = breaker.beforeRequest();

        breaker.recordFailure(first, true);
        breaker.recordSuccess(late);

        expect(breaker.snapshot()).toMatchObject({
            state: "open",
            consecutiveFailures: 1,
            nextAttemptAt: 2_000,
        });
        expect(breaker.beforeRequest()).toMatchObject({ allowed: false, state: "open", nextAttemptAt: 2_000 });
        now = 2_000;
        expect(breaker.beforeRequest()).toMatchObject({ allowed: true, state: "half_open" });
    });

    test("a stale closed success cannot close or release the current half-open probe", () => {
        let now = 1_000;
        const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now });
        const opener = breaker.beforeRequest();
        const staleClosed = breaker.beforeRequest();
        breaker.recordFailure(opener, true);

        now = 2_000;
        const probe = breaker.beforeRequest();
        breaker.recordSuccess(staleClosed);

        expect(breaker.snapshot()).toMatchObject({ state: "half_open", probeInFlight: true, nextAttemptAt: 2_000 });
        expect(breaker.beforeRequest()).toMatchObject({ allowed: false, state: "half_open" });
        breaker.recordSuccess(probe);
        expect(breaker.snapshot()).toMatchObject({ state: "closed", probeInFlight: false });
    });

    test("a result from an older breaker generation cannot change a later generation", () => {
        let now = 1_000;
        const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now });
        const staleClosed = breaker.beforeRequest();
        breaker.recordFailure(breaker.beforeRequest(), true);
        now = 2_000;
        const firstProbe = breaker.beforeRequest();
        breaker.recordFailure(firstProbe, true);
        now = 3_000;
        const currentProbe = breaker.beforeRequest();

        breaker.recordSuccess(staleClosed);
        expect(breaker.snapshot()).toMatchObject({ state: "half_open", probeInFlight: true, nextAttemptAt: 3_000 });
        breaker.recordFailure(currentProbe, true);
        expect(breaker.snapshot()).toMatchObject({ state: "open", probeInFlight: false, nextAttemptAt: 4_000 });
    });

    test("a half-open permit from before restore cannot close or release the restored generation's probe", () => {
        let now = 1_000;
        const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now });
        breaker.recordFailure(breaker.beforeRequest(), true);
        now = 2_000;
        const staleProbe = breaker.beforeRequest();

        breaker.restore(breaker.snapshot());
        now = 3_000;
        const currentProbe = breaker.beforeRequest();
        breaker.recordSuccess(staleProbe);

        expect(breaker.snapshot()).toMatchObject({ state: "half_open", probeInFlight: true, nextAttemptAt: 3_000 });
        expect(breaker.beforeRequest()).toMatchObject({ allowed: false, state: "half_open" });
        breaker.recordFailure(currentProbe, true);
        expect(breaker.snapshot()).toMatchObject({ state: "open", probeInFlight: false, nextAttemptAt: 4_000 });
    });
});

describe("provider resilience policy", () => {
    const noopSleep: ResilienceSleep = async () => undefined;

    test("composes quota, circuit breaker and retry through one authorized identity", async () => {
        let now = 1_000;
        const waits: number[] = [];
        const events: ProviderResilienceEvent[] = [];
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 3, baseDelayMs: 0 },
            quota: { capacity: 2, refillTokens: 1, refillIntervalMs: 1_000 },
            circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000 },
            clock: () => now,
            sleep: async (delayMs) => {
                waits.push(delayMs);
                now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        let calls = 0;

        await expect(resilience.execute(planFor(identity), new AbortController().signal, async () => {
            calls += 1;
            if (calls === 1) throw providerError("rate_limit", { retryAfterMs: 500 });
            return "ok";
        })).resolves.toBe("ok");

        expect(calls).toBe(2);
        expect(waits).toEqual([500]);
        // The Retry-After deferral is surfaced as a waiting event
        // carrying the provider-mandated nextAttemptAt.
        expect(events).toContainEqual(expect.objectContaining({
            type: "waiting",
            reason: "rate_limit",
            nextAttemptAt: 1_500,
        }));
    });

    test("does not let one provider block another that shares its credential scope", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            quota: { capacity: 1, refillTokens: 1, refillIntervalMs: 10_000 },
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });

        // provider-a consumes the only token of the shared scope.
        await expect(resilience.execute(planFor({ providerId: "provider-a", credentialScope: "shared" }), new AbortController().signal, async () => "a")).resolves.toBe("a");
        // provider-b shares the scope but owns an independent bucket.
        await expect(resilience.execute(planFor({ providerId: "provider-b", credentialScope: "shared" }), new AbortController().signal, async () => "b")).resolves.toBe("b");
        // provider-a waits for its own refill — never on provider-b's quota.
        await expect(resilience.execute(planFor({ providerId: "provider-a", credentialScope: "shared" }), new AbortController().signal, async () => "a2")).resolves.toBe("a2");

        const blockedByQuota = events.filter((event) => event.type === "waiting" && event.reason === "rate_limit");
        expect(blockedByQuota.map((event) => event.providerId)).toEqual(["provider-a"]);
    });

    test("does not count a cooldown wait as a provider attempt", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 3, baseDelayMs: 0 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 5_000 },
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        let calls = 0;

        // Open the circuit with one counted failure.
        await expect(resilience.execute(planFor(identity), new AbortController().signal, async () => {
            calls += 1;
            throw providerError("network");
        })).rejects.toThrow(ModelProviderError);
        expect(calls).toBe(3);

        // The cooldown wait precedes a fresh attempt cycle: the
        // wait itself never consumes a retry attempt.
        calls = 0;
        const recovered = await resilience.execute(planFor(identity), new AbortController().signal, async () => {
            calls += 1;
            return "recovered";
        });
        expect(recovered).toBe("recovered");
        expect(calls).toBe(1);
        const successes = events.filter((event) => event.type === "provider_success");
        expect(successes.at(-1)).toMatchObject({ attempt: 1 });
    });

    test("enforces a finite time budget across every wait", async () => {
        let now = 1_000;
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 10, baseDelayMs: 100 },
            timeBudgetMs: 500,
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
        });
        let calls = 0;

        // attempt 1 at t=1000, sleeps 100/200 -> attempts at
        // t=1100, t=1300; the t=1700 backoff is capped at the
        // remaining 200ms: the clock stops exactly at the 500ms
        // deadline (t=1500) and a fourth call never starts. The
        // wait may never oversleep the deadline.
        await expect(resilience.execute(planFor(identity), new AbortController().signal, async () => {
            calls += 1;
            throw providerError("network");
        })).rejects.toBeInstanceOf(ProviderResilienceBudgetError);

        expect(calls).toBe(3);
        expect(now).toBe(1_500);
    });

    test("gives a new execute its full budget even after the instance idles", async () => {
        let now = 1_000;
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            timeBudgetMs: 500,
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
        });

        // The instance sits idle far beyond timeBudgetMs without a
        // single execution: a resident instance must not carry a
        // lifetime deadline that poisons future executions.
        now = 10_000;
        let calls = 0;

        await expect(resilience.execute(planFor(identity), new AbortController().signal, async () => {
            calls += 1;
            return "ok";
        })).resolves.toBe("ok");

        expect(calls).toBe(1);
    });

    test("gives sequential executions independent budgets", async () => {
        let now = 1_000;
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 2, baseDelayMs: 100 },
            timeBudgetMs: 500,
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
        });

        // The first execution consumes 450ms of wall time inside
        // the operation (t=1000 -> t=1450).
        let firstCalls = 0;
        await expect(resilience.execute(planFor(identity), new AbortController().signal, async () => {
            firstCalls += 1;
            now += 450;
            return "first";
        })).resolves.toBe("first");
        expect(firstCalls).toBe(1);

        // The second execution starts with a full 500ms budget and
        // can therefore afford the 100ms retry backoff — a shared
        // lifetime deadline (t=1500, 50ms left) could not.
        let secondCalls = 0;
        const second = await resilience.execute(planFor(identity), new AbortController().signal, async () => {
            secondCalls += 1;
            if (secondCalls < 2) throw providerError("network");
            return "second";
        });

        expect(second).toBe("second");
        expect(secondCalls).toBe(2);
    });

    test("caps a Retry-After longer than the remaining budget without oversleeping", async () => {
        let now = 1_000;
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 5 },
            timeBudgetMs: 500,
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
        });
        let calls = 0;

        // timeBudgetMs=500 with Retry-After=10_000: the
        // execution must end at the 500ms deadline, never
        // sleep the 10s and only then discover the budget
        // was exhausted.
        await expect(resilience.execute(planFor(identity), new AbortController().signal, async () => {
            calls += 1;
            throw providerError("rate_limit", { retryAfterMs: 10_000 });
        })).rejects.toBeInstanceOf(ProviderResilienceBudgetError);

        expect(calls).toBe(1);
        expect(now).toBe(1_500);
    });

    test("caps a retry backoff longer than the remaining budget without oversleeping", async () => {
        let now = 1_000;
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 5, baseDelayMs: 10_000 },
            timeBudgetMs: 500,
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
        });
        let calls = 0;

        await expect(resilience.execute(planFor(identity), new AbortController().signal, async () => {
            calls += 1;
            throw providerError("network");
        })).rejects.toBeInstanceOf(ProviderResilienceBudgetError);

        expect(calls).toBe(1);
        expect(now).toBe(1_500);
    });

    test("expires the budget of a queued concurrency wait without a provider call", async () => {
        let now = 1_000;
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 1 },
            timeBudgetMs: 500,
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
        });
        let releaseFirst!: () => void;
        let firstStarted!: () => void;
        const firstStartedPromise = new Promise<void>((resolve) => {
            firstStarted = resolve;
        });
        const first = resilience.execute(planFor(identity), new AbortController().signal, () => new Promise<string>((resolve) => {
            firstStarted();
            releaseFirst = () => resolve("first");
        }));
        await firstStartedPromise;

        // The second execution queues for the single slot. Its
        // budget expires while waiting: it must never call the
        // provider and the waiter must leave the queue.
        let queuedCalls = 0;
        const queued = resilience.execute(planFor(identity), new AbortController().signal, async () => {
            queuedCalls += 1;
            return "must not run";
        });
        const queuedOutcome = queued.then(
            () => "must not resolve",
            (error) => error,
        );

        expect(await queuedOutcome).toBeInstanceOf(ProviderResilienceBudgetError);
        expect(queuedCalls).toBe(0);

        // The waiter was removed, so releasing the first slot
        // leaves the limiter counters consistent: no phantom
        // holder, no stranded waiter.
        releaseFirst();
        expect(await first).toBe("first");
        expect(resilience.snapshot().concurrency?.entries ?? []).toEqual([]);
    });

    test("cancels a queued concurrency wait without a new provider call", async () => {
        let now = 1_000;
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 1 },
            clock: () => now,
            sleep: noopSleep,
        });
        let releaseFirst!: () => void;
        let firstStarted!: () => void;
        const firstStartedPromise = new Promise<void>((resolve) => {
            firstStarted = resolve;
        });
        const first = resilience.execute(planFor(identity), new AbortController().signal, () => new Promise<string>((resolve) => {
            firstStarted();
            releaseFirst = () => resolve("first");
        }));
        await firstStartedPromise;

        const queuedController = new AbortController();
        let queuedCalls = 0;
        const queued = resilience.execute(planFor(identity), queuedController.signal, async () => {
            queuedCalls += 1;
            return "must not run";
        });
        const queuedOutcome = queued.then(
            () => "must not resolve",
            (error) => error,
        );
        queuedController.abort();

        expect(await queuedOutcome).toBeInstanceOf(ProviderResilienceCancellationError);
        expect(queuedCalls).toBe(0);
        releaseFirst();
        expect(await first).toBe("first");
    });

    test("a queued call never dispatches through a circuit that opened while it waited", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        // The fake clock advances only for caller-owned waits
        // (cooldown, Retry-After, backoff). The budget expiry
        // timer's internal wait must not advance time: with a
        // fully advancing clock a queued call would exhaust its
        // budget the instant it queues.
        const callerSignals = new Set<AbortSignal>();
        const trackedSignal = (): AbortSignal => {
            const signal = new AbortController().signal;
            callerSignals.add(signal);
            return signal;
        };
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 1 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 },
            clock: () => now,
            sleep: async (delayMs, sleepSignal) => {
                if (callerSignals.has(sleepSignal)) now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        let releaseFirst!: () => void;
        let firstStarted!: () => void;
        const firstStartedPromise = new Promise<void>((resolve) => {
            firstStarted = resolve;
        });
        // Call A occupies the only slot while the circuit is closed.
        const first = resilience.execute(planFor(identity), trackedSignal(), () => new Promise<string>((resolve, reject) => {
            firstStarted();
            releaseFirst = () => reject(providerError("network"));
        }));
        await firstStartedPromise;

        // Call B queues for the single slot.
        const queued = resilience.execute(planFor(identity), trackedSignal(), async () => {
            dispatchTimes.push(now);
            return "queued-dispatch";
        });

        // A fails retryable: recordFailure opens the circuit (threshold 1)
        // and the queue hands the slot to B.
        releaseFirst();
        await expect(first).rejects.toThrow(ModelProviderError);

        // B received the slot, but the circuit is OPEN: it must refuse
        // to dispatch, give the slot back and wait out the cooldown.
        // It only reaches the provider afterwards, as a half-open probe.
        const result = await queued;
        expect(result).toBe("queued-dispatch");
        expect(dispatchTimes).toEqual([11_000]);
        expect(events).toContainEqual(expect.objectContaining({
            type: "waiting",
            reason: "circuit_open",
            nextAttemptAt: 11_000,
        }));
        expect(resilience.snapshot().circuitBreakers.breakers[0]).toMatchObject({
            state: "closed",
            probeInFlight: false,
        });
    });

    test("a late concurrent success keeps a third dispatch parked until the circuit cooldown", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        let releaseCooldown!: () => void;
        let cooldownStarted!: () => void;
        const cooldownStartedPromise = new Promise<void>((resolve) => {
            cooldownStarted = resolve;
        });
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 2 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 },
            clock: () => now,
            sleep: async (delayMs) => {
                cooldownStarted();
                await new Promise<void>((resolve) => {
                    releaseCooldown = () => {
                        now += delayMs;
                        resolve();
                    };
                });
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        let releaseA!: () => void;
        let releaseB!: () => void;
        let startedA!: () => void;
        let startedB!: () => void;
        const startedAPromise = new Promise<void>((resolve) => { startedA = resolve; });
        const startedBPromise = new Promise<void>((resolve) => { startedB = resolve; });
        const callA = resilience.execute(planFor(identity), new AbortController().signal, () => new Promise<string>((_resolve, reject) => {
            dispatchTimes.push(now);
            startedA();
            releaseA = () => reject(providerError("network"));
        }));
        const callB = resilience.execute(planFor(identity), new AbortController().signal, () => new Promise<string>((resolve) => {
            dispatchTimes.push(now);
            startedB();
            releaseB = () => resolve("late-success");
        }));
        await Promise.all([startedAPromise, startedBPromise]);

        releaseA();
        await expect(callA).rejects.toThrow(ModelProviderError);
        const callC = resilience.execute(planFor(identity), new AbortController().signal, async () => {
            dispatchTimes.push(now);
            return "after-cooldown";
        });
        await cooldownStartedPromise;
        expect(dispatchTimes).toEqual([1_000, 1_000]);

        releaseB();
        await expect(callB).resolves.toBe("late-success");
        expect(resilience.snapshot().circuitBreakers.breakers[0]).toMatchObject({
            state: "open",
            nextAttemptAt: 11_000,
        });
        expect(dispatchTimes).toEqual([1_000, 1_000]);

        releaseCooldown();
        await expect(callC).resolves.toBe("after-cooldown");
        expect(dispatchTimes).toEqual([1_000, 1_000, 11_000]);
        expect(events.some((event) => event.type === "waiting" && event.reason === "circuit_open")).toBe(true);
    });

    test("admits exactly one half-open probe to the provider", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        // The fake clock advances only for caller-owned waits;
        // the budget expiry timer's internal wait must not
        // advance time.
        const callerSignals = new Set<AbortSignal>();
        const trackedSignal = (): AbortSignal => {
            const signal = new AbortController().signal;
            callerSignals.add(signal);
            return signal;
        };
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 1 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 5_000 },
            clock: () => now,
            sleep: async (delayMs, sleepSignal) => {
                if (callerSignals.has(sleepSignal)) now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        const halfOpenDispatchTimes: number[] = [];
        const trackDispatch = (): void => {
            dispatchTimes.push(now);
            const breaker = resilience.snapshot().circuitBreakers.breakers[0];
            if (breaker.state === "half_open" && breaker.probeInFlight) {
                halfOpenDispatchTimes.push(now);
            }
        };
        let releaseBlocker!: () => void;
        let blockerStarted!: () => void;
        const blockerStartedPromise = new Promise<void>((resolve) => {
            blockerStarted = resolve;
        });
        // A occupies the only slot while the circuit is closed.
        const blocker = resilience.execute(planFor(identity), trackedSignal(), () => new Promise<string>((resolve, reject) => {
            blockerStarted();
            releaseBlocker = () => reject(providerError("network"));
        }));
        await blockerStartedPromise;

        let releaseProbe!: () => void;
        let probeStarted!: () => void;
        const probeStartedPromise = new Promise<void>((resolve) => {
            probeStarted = resolve;
        });
        // B queues for the single slot; A's retryable failure opens the
        // circuit and the queue hands the slot to B.
        const queued = resilience.execute(planFor(identity), trackedSignal(), () => new Promise<string>((resolve) => {
            trackDispatch();
            probeStarted();
            releaseProbe = () => resolve("probe-result");
        }));
        releaseBlocker();
        await expect(blocker).rejects.toThrow(ModelProviderError);

        // B refused the open circuit, waited out the cooldown and is now
        // the single authorized half-open probe, blocked in the provider call.
        await probeStartedPromise;
        expect(dispatchTimes).toEqual([6_000]);
        expect(halfOpenDispatchTimes).toEqual([6_000]);

        // Two concurrent calls race for the single probe: neither may
        // reach the provider while the probe is in flight.
        const first = resilience.execute(planFor(identity), trackedSignal(), async () => {
            trackDispatch();
            return "first";
        });
        const second = resilience.execute(planFor(identity), trackedSignal(), async () => {
            trackDispatch();
            return "second";
        });

        // The probe succeeds and closes the circuit; the queued calls
        // then dispatch as normal closed-state calls.
        releaseProbe();
        await expect(queued).resolves.toBe("probe-result");
        expect(await first).toBe("first");
        expect(await second).toBe("second");
        // Exactly one provider call ran while the circuit was half-open:
        // the single authorized probe.
        expect(halfOpenDispatchTimes).toEqual([6_000]);
        expect(events.filter((event) => event.type === "circuit_half_open")).toHaveLength(1);
        expect(resilience.snapshot().circuitBreakers.breakers[0]).toMatchObject({
            state: "closed",
            probeInFlight: false,
        });
    });

    test("cancelling a queued half-open wait orphans no probe and never calls the provider", async () => {
        let now = 1_000;
        // The fake clock advances only for caller-owned waits;
        // the budget expiry timer's internal wait must not
        // advance time.
        const callerSignals = new Set<AbortSignal>();
        const trackedSignal = (): AbortSignal => {
            const signal = new AbortController().signal;
            callerSignals.add(signal);
            return signal;
        };
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 1 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 },
            clock: () => now,
            sleep: async (delayMs, sleepSignal) => {
                if (callerSignals.has(sleepSignal)) now += delayMs;
            },
        });
        const dispatchTimes: number[] = [];
        let releaseBlocker!: () => void;
        let blockerStarted!: () => void;
        const blockerStartedPromise = new Promise<void>((resolve) => {
            blockerStarted = resolve;
        });
        // A occupies the only slot while the circuit is closed.
        const blocker = resilience.execute(planFor(identity), trackedSignal(), () => new Promise<string>((resolve, reject) => {
            blockerStarted();
            releaseBlocker = () => reject(providerError("network"));
        }));
        await blockerStartedPromise;

        let releaseProbe!: () => void;
        let probeStarted!: () => void;
        const probeStartedPromise = new Promise<void>((resolve) => {
            probeStarted = resolve;
        });
        // B queues for the single slot; A's retryable failure opens the
        // circuit and the queue hands the slot to B.
        const queued = resilience.execute(planFor(identity), trackedSignal(), () => new Promise<string>((resolve) => {
            dispatchTimes.push(now);
            probeStarted();
            releaseProbe = () => resolve("probe-result");
        }));
        releaseBlocker();
        await expect(blocker).rejects.toThrow(ModelProviderError);

        // B refused the open circuit, waited out the cooldown and is now
        // the single authorized half-open probe, blocked in the provider call.
        await probeStartedPromise;

        // A third call queues behind the in-flight probe.
        const candidateController = new AbortController();
        callerSignals.add(candidateController.signal);
        let candidateCalls = 0;
        const candidate = resilience.execute(planFor(identity), candidateController.signal, async () => {
            candidateCalls += 1;
            return "must not run";
        });
        const candidateOutcome = candidate.then(
            () => "must not resolve",
            (error) => error,
        );

        // Cancelling the queued call must never call the provider and
        // must leave no orphaned probe behind.
        candidateController.abort();
        expect(await candidateOutcome).toBeInstanceOf(ProviderResilienceCancellationError);
        expect(candidateCalls).toBe(0);
        // The only provider call is the in-flight probe, dispatched at
        // the post-cooldown half-open moment — never through the open circuit.
        expect(dispatchTimes).toEqual([11_000]);

        // Recovery: the probe succeeds, closing the circuit.
        releaseProbe();
        await expect(queued).resolves.toBe("probe-result");
        expect(resilience.snapshot().circuitBreakers.breakers[0]).toMatchObject({
            state: "closed",
            probeInFlight: false,
        });

        // Future calls work normally again.
        const recovered = await resilience.execute(planFor(identity), trackedSignal(), async () => {
            dispatchTimes.push(now);
            return "recovered";
        });
        expect(recovered).toBe("recovered");
        expect(dispatchTimes).toEqual([11_000, 11_000]);
    });

    test("expiring the budget of a queued half-open wait orphans no probe and never calls the provider", async () => {
        let now = 1_000;
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 1 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 },
            timeBudgetMs: 500,
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
        });
        const dispatchTimes: number[] = [];

        // Open the circuit with one counted failure. The opener
        // acquires the slot immediately, so its budget timer is
        // never armed against the queue.
        await expect(resilience.execute(planFor(identity), new AbortController().signal, async () => {
            dispatchTimes.push(now);
            throw providerError("network");
        })).rejects.toThrow(ModelProviderError);

        // The cooldown elapses: the circuit is half-open eligible.
        now += 10_000;

        let releaseProbe!: () => void;
        let probeStarted!: () => void;
        const probeStartedPromise = new Promise<void>((resolve) => {
            probeStarted = resolve;
        });
        // The next call acquires the free slot immediately and is
        // authorized as the single half-open probe, blocked in the
        // provider call.
        const queued = resilience.execute(planFor(identity), new AbortController().signal, () => new Promise<string>((resolve) => {
            dispatchTimes.push(now);
            probeStarted();
            releaseProbe = () => resolve("probe-result");
        }));
        await probeStartedPromise;
        expect(dispatchTimes).toEqual([1_000, 11_000]);

        // A third call queues behind the in-flight probe; its budget
        // expires while it waits.
        let candidateCalls = 0;
        const candidate = resilience.execute(planFor(identity), new AbortController().signal, async () => {
            candidateCalls += 1;
            return "must not run";
        });
        const candidateOutcome = candidate.then(
            () => "must not resolve",
            (error) => error,
        );

        expect(await candidateOutcome).toBeInstanceOf(ProviderResilienceBudgetError);
        expect(candidateCalls).toBe(0);
        // The only post-cooldown provider call is the in-flight
        // probe, dispatched at the half-open moment — the expired
        // call never reached the provider, and no call crossed
        // the open circuit at t=1000.
        expect(dispatchTimes).toEqual([1_000, 11_000]);

        // Recovery after the budget expiry: the probe still owns the
        // breaker state and completes normally.
        releaseProbe();
        await expect(queued).resolves.toBe("probe-result");
        expect(resilience.snapshot().circuitBreakers.breakers[0]).toMatchObject({
            state: "closed",
            probeInFlight: false,
        });
        const recovered = await resilience.execute(planFor(identity), new AbortController().signal, async () => {
            dispatchTimes.push(now);
            return "recovered";
        });
        expect(recovered).toBe("recovered");
        expect(dispatchTimes).toEqual([1_000, 11_000, 11_500]);
    });

    test("closes the circuit after a valid half-open probe and resumes normal calls", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        // The fake clock advances only for caller-owned waits;
        // the budget expiry timer's internal wait must not
        // advance time.
        const callerSignals = new Set<AbortSignal>();
        const trackedSignal = (): AbortSignal => {
            const signal = new AbortController().signal;
            callerSignals.add(signal);
            return signal;
        };
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 1 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 5_000 },
            clock: () => now,
            sleep: async (delayMs, sleepSignal) => {
                if (callerSignals.has(sleepSignal)) now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        let releaseBlocker!: () => void;
        let blockerStarted!: () => void;
        const blockerStartedPromise = new Promise<void>((resolve) => {
            blockerStarted = resolve;
        });
        // A occupies the only slot while the circuit is closed.
        const blocker = resilience.execute(planFor(identity), trackedSignal(), () => new Promise<string>((resolve, reject) => {
            blockerStarted();
            releaseBlocker = () => reject(providerError("network"));
        }));
        await blockerStartedPromise;

        // B queues for the single slot; A's retryable failure opens the
        // circuit and the queue hands the slot to B.
        const queued = resilience.execute(planFor(identity), trackedSignal(), async () => {
            dispatchTimes.push(now);
            return "probe-result";
        });
        releaseBlocker();
        await expect(blocker).rejects.toThrow(ModelProviderError);

        // B refused the open circuit, waited out the cooldown and reached
        // the provider as the single valid half-open probe; its success
        // closes the circuit.
        const probeResult = await queued;
        expect(probeResult).toBe("probe-result");
        expect(dispatchTimes).toEqual([6_000]);
        expect(resilience.snapshot().circuitBreakers.breakers[0]).toMatchObject({
            state: "closed",
            consecutiveFailures: 0,
            probeInFlight: false,
        });
        expect(events).toContainEqual(expect.objectContaining({
            type: "circuit_half_open",
            at: 6_000,
        }));

        // Future calls work normally again: no cooldown wait and no
        // further probe — the circuit stays closed.
        const halfOpenCount = events.filter((event) => event.type === "circuit_half_open").length;
        const waitingCount = events.filter((event) => event.type === "waiting").length;
        const recovered = await resilience.execute(planFor(identity), trackedSignal(), async () => {
            dispatchTimes.push(now);
            return "recovered";
        });
        expect(recovered).toBe("recovered");
        expect(dispatchTimes).toEqual([6_000, 6_000]);
        expect(events.filter((event) => event.type === "circuit_half_open")).toHaveLength(halfOpenCount);
        expect(events.filter((event) => event.type === "waiting")).toHaveLength(waitingCount);
    });

    test("bounds concurrent provider calls to the configured maximum", async () => {
        let now = 1_000;
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 2 },
            clock: () => now,
            sleep: noopSleep,
        });
        let inFlight = 0;
        let peak = 0;
        const operation = async (): Promise<string> => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            return "ok";
        };

        await Promise.all(Array.from({ length: 8 }, () => resilience.execute(
            planFor(identity),
            new AbortController().signal,
            operation,
        )));

        expect(peak).toBeLessThanOrEqual(2);
        expect(inFlight).toBe(0);
    });

    test("restores quota and circuit cooldowns through snapshot and restore", async () => {
        let now = 1_000;
        const makeOptions = (): ConstructorParameters<typeof ProviderResilience>[0] => ({
            retry: { maxAttempts: 1 },
            quota: { capacity: 1, refillTokens: 1, refillIntervalMs: 10_000 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 5_000 },
            clock: () => now,
            sleep: noopSleep,
        });
        const first = new ProviderResilience(makeOptions());

        // Open the circuit and defer quota with a provider Retry-After.
        await expect(first.execute(planFor(identity), new AbortController().signal, async () => {
            throw providerError("rate_limit", { retryAfterMs: 10_000 });
        })).rejects.toThrow(ModelProviderError);

        const snapshot = first.snapshot();
        expect(snapshot.circuitBreakers.breakers[0]).toMatchObject({
            providerId: "provider-a",
            credentialScope: "scope-a",
            state: "open",
            nextAttemptAt: 6_000,
        });
        expect(snapshot.quota?.buckets[0]).toMatchObject({ nextEligibleAt: 11_000 });

        // Re-instantiation (restart): the restored policy keeps
        // blocking until the persisted cooldowns elapse.
        const second = new ProviderResilience(makeOptions());
        second.restore(snapshot);
        const restored = second.snapshot();
        expect(restored.circuitBreakers.breakers[0].nextAttemptAt).toBe(6_000);
        expect(restored.quota?.buckets[0].nextEligibleAt).toBe(11_000);

        // Once the durable cooldowns elapse, eligibility returns.
        now += 20_000;
        await expect(second.execute(planFor(identity), new AbortController().signal, async () => "recovered")).resolves.toBe("recovered");
    });

    test("fails explicitly when no fallback is configured", async () => {
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            clock: () => 1_000,
            sleep: noopSleep,
        });
        const error = providerError("network");
        const seen: ResilienceIdentity[] = [];

        await expect(resilience.execute(planFor(identity), new AbortController().signal, async (attempted) => {
            seen.push(attempted);
            throw error;
        })).rejects.toBe(error);

        expect(seen).toEqual([identity]);
    });

    test("uses the authorized fallback in plan order after a terminal fallback-allowed failure", async () => {
        const fallback: ResilienceIdentity = { providerId: "provider-b", credentialScope: "scope-a" };
        const events: ProviderResilienceEvent[] = [];
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            clock: () => 1_000,
            sleep: noopSleep,
            onEvent: (event) => events.push(event),
        });
        const seen: ResilienceIdentity[] = [];
        const error = providerError("network");

        const result = await resilience.execute(planFor(identity, fallback), new AbortController().signal, async (attempted) => {
            seen.push(attempted);
            if (attempted.providerId === identity.providerId) throw error;
            return "fallback-result";
        });

        expect(result).toBe("fallback-result");
        expect(seen).toEqual([identity, fallback]);
        expect(events).toContainEqual(expect.objectContaining({
            type: "fallback",
            providerId: "provider-a",
            credentialScope: "scope-a",
            nextProviderId: "provider-b",
            nextCredentialScope: "scope-a",
            errorKind: "network",
        }));
    });

    test("never attempts an identity outside the authorized plan", async () => {
        const unauthorized: ResilienceIdentity = { providerId: "provider-rogue", credentialScope: "scope-rogue" };
        const authorizedFallback: ResilienceIdentity = { providerId: "provider-b", credentialScope: "scope-a" };
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            clock: () => 1_000,
            sleep: noopSleep,
        });
        const seen: ResilienceIdentity[] = [];

        // Both attempts fail; the plan authorizes exactly two
        // identities, so the rogue identity is never attempted
        // even though the error allows fallback.
        await expect(resilience.execute(planFor(identity, authorizedFallback), new AbortController().signal, async (attempted) => {
            seen.push(attempted);
            throw providerError("network");
        })).rejects.toThrow(ModelProviderError);

        expect(seen).toEqual([identity, authorizedFallback]);
        expect(seen).not.toContain(unauthorized);
    });

    test("does not fall back when the error forbids it, when cancelled, or on a repeated identity", async () => {
        const fallback: ResilienceIdentity = { providerId: "provider-b", credentialScope: "scope-a" };
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            clock: () => 1_000,
            sleep: noopSleep,
        });

        // Authentication forbids fallback: the failure is explicit.
        const seen: ResilienceIdentity[] = [];
        const authError = providerError("authentication");
        await expect(resilience.execute(planFor(identity, fallback), new AbortController().signal, async (attempted) => {
            seen.push(attempted);
            throw authError;
        })).rejects.toBe(authError);
        expect(seen).toEqual([identity]);

        // Cancellation never triggers a fallback: the abort
        // dominates and the call ends cancelled.
        const cancelled: ResilienceIdentity[] = [];
        const controller = new AbortController();
        const cancelledCall = resilience.execute(planFor(identity, fallback), controller.signal, async (attempted) => {
            cancelled.push(attempted);
            controller.abort();
            throw providerError("cancellation");
        });
        await expect(cancelledCall).rejects.toBeInstanceOf(ProviderResilienceCancellationError);
        expect(cancelled).toEqual([identity]);

        // A plan may not repeat an identity.
        expect(() => resilience.execute(planFor(identity, identity), new AbortController().signal, async () => "x" as never)).toThrow();
    });

    test("maps a waiting event onto the durable mission backoff input", () => {
        const waiting: ProviderResilienceEvent = {
            type: "waiting",
            providerId: "provider-a",
            credentialScope: "scope-a",
            at: 1_000,
            reason: "rate_limit",
            nextAttemptAt: 6_000,
        };
        expect(providerWaitBackoffMs(waiting, 1_000)).toBe(5_000);
        expect(providerWaitBackoffMs(waiting, 6_000)).toBe(0);
        expect(providerWaitBackoffMs(waiting, 7_000)).toBe(0);
        expect(() => providerWaitBackoffMs({ type: "provider_success", providerId: "p", credentialScope: "s", at: 1 }, 1)).toThrow();
        expect(() => providerWaitBackoffMs(waiting, -1)).toThrow();
    });

    test("keeps secrets, prompts, full responses and credentialRef out of snapshots, events and errors", async () => {
        const secret = "synthetic-secret-material";
        const credentialRef = "credential://synthetic/secret-ref";
        const prompt = "synthetic prompt content";
        const responseContent = "synthetic full response content";
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            quota: { capacity: 2, refillTokens: 1, refillIntervalMs: 1_000 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 1_000 },
            clock: () => now,
            sleep: noopSleep,
            onEvent: (event) => events.push(event),
        });

        // Success path: the response content never enters events.
        await expect(resilience.execute(planFor(identity), new AbortController().signal, async () => responseContent)).resolves.toBe(responseContent);
        // Failure path: an error carrying the secret never leaks it.
        const leakingError = new ModelProviderError(`failure containing ${secret}`, {
            kind: "network",
            retryable: true,
            fallbackAllowed: true,
        });
        await expect(resilience.execute(planFor(identity), new AbortController().signal, async () => {
            throw leakingError;
        })).rejects.toThrow(ModelProviderError);

        const serialized = JSON.stringify({ snapshot: resilience.snapshot(), events });
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain(credentialRef);
        expect(serialized).not.toContain(prompt);
        expect(serialized).not.toContain(responseContent);
    });

    test("applies resilience in CredentialedProviderInvoker without exposing the secret", async () => {
        const eventBus = new EventBus();
        const secret = "synthetic-secret-material";
        const credentialRef = "credential://synthetic/secret-ref";
        const registry = new CredentialRegistry("resilience-test-salt");
        registry.register(credentialRef, secret);
        const credentialScope = createCredentialScope(credentialRef, "resilience-test-salt");
        let transportCalls = 0;
        const provider = fakeProvider(async () => response);
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 2, baseDelayMs: 0 },
            clock: () => 1_000,
            sleep: async () => undefined,
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
        // The resilience snapshot carries only opaque scopes,
        // counts, timestamps and cooldowns.
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
        const provider = fakeProvider(async () => {
            transportCalls += 1;
            if (transportCalls === 1) throw providerError("network");
            return response;
        });
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 2, baseDelayMs: 0 },
            clock: () => 1_000,
            sleep: async () => undefined,
        });
        const invoker = new CredentialedProviderInvoker(provider, registry, eventBus, {
            complete: async (transportProvider, transportRequest, transportContext, transportSecret) => {
                expect(transportSecret).toBe(secret);
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

    test("a concurrent call waits event-driven for a half-open probe instead of busy-spinning", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        // The fake clock advances only for caller-owned waits.
        const callerSignals = new Set<AbortSignal>();
        const trackedSignal = (): AbortSignal => {
            const signal = new AbortController().signal;
            callerSignals.add(signal);
            return signal;
        };
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 2 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 },
            clock: () => now,
            sleep: async (delayMs, sleepSignal) => {
                if (callerSignals.has(sleepSignal)) now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        // The opener consumes the cooldown with a retryable failure.
        const opener = resilience.execute(planFor(identity), trackedSignal(), async () => {
            dispatchTimes.push(now);
            throw providerError("network");
        });
        await expect(opener).rejects.toThrow(ModelProviderError);
        // The circuit cooldown elapses: the circuit is half-open-eligible.
        now += 10_000;

        let releaseProbe!: () => void;
        let probeStarted!: () => void;
        const probeStartedPromise = new Promise<void>((resolve) => {
            probeStarted = resolve;
        });
        // The probe reserves the single half-open permit and blocks
        // in the provider call.
        const probe = resilience.execute(planFor(identity), trackedSignal(), () => new Promise<string>((resolve) => {
            dispatchTimes.push(now);
            probeStarted();
            releaseProbe = () => resolve("probe-result");
        }));
        await probeStartedPromise;

        // A concurrent call takes the second free slot, is refused by
        // the half-open breaker (a probe is in flight) and must wait
        // EVENT-DRIVEN for the probe resolution.
        const concurrent = resilience.execute(planFor(identity), trackedSignal(), async () => {
            dispatchTimes.push(now);
            return "concurrent-dispatch";
        });
        // Drain the microtask queue repeatedly: a polling
        // implementation would emit one waiting event per spin
        // iteration by now. The event-driven wait emits exactly one.
        for (let i = 0; i < 100; i += 1) {
            await Promise.resolve();
        }
        expect(events.filter((event) => event.type === "waiting" && event.reason === "circuit_probe")).toHaveLength(1);
        // Only the probe dispatched; the parked call neither reached
        // the provider nor holds a slot (it returned slot 2 before
        // parking).
        expect(dispatchTimes).toEqual([1_000, 11_000]);
        expect(resilience.snapshot().concurrency?.entries[0]).toMatchObject({
            inFlight: 1,
            waiting: 0,
        });

        // The probe resolves: the circuit closes and the parked call
        // wakes and dispatches as a normal closed-state call.
        releaseProbe();
        await expect(probe).resolves.toBe("probe-result");
        expect(await concurrent).toBe("concurrent-dispatch");
        expect(dispatchTimes).toEqual([1_000, 11_000, 11_000]);
        expect(resilience.snapshot().circuitBreakers.breakers[0]).toMatchObject({
            state: "closed",
            probeInFlight: false,
        });
    });

    test("a failed half-open probe re-opens the circuit and parked waiters respect the fresh cooldown", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        const callerSignals = new Set<AbortSignal>();
        const trackedSignal = (): AbortSignal => {
            const signal = new AbortController().signal;
            callerSignals.add(signal);
            return signal;
        };
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 2 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 },
            clock: () => now,
            sleep: async (delayMs, sleepSignal) => {
                if (callerSignals.has(sleepSignal)) now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        const opener = resilience.execute(planFor(identity), trackedSignal(), async () => {
            dispatchTimes.push(now);
            throw providerError("network");
        });
        await expect(opener).rejects.toThrow(ModelProviderError);
        now += 10_000;

        let releaseProbe!: () => void;
        let probeStarted!: () => void;
        const probeStartedPromise = new Promise<void>((resolve) => {
            probeStarted = resolve;
        });
        const probe = resilience.execute(planFor(identity), trackedSignal(), () => new Promise<string>((_, reject) => {
            dispatchTimes.push(now);
            probeStarted();
            releaseProbe = () => reject(providerError("network"));
        }));
        await probeStartedPromise;

        const parked = resilience.execute(planFor(identity), trackedSignal(), async () => {
            dispatchTimes.push(now);
            return "parked-dispatch";
        });
        for (let i = 0; i < 100; i += 1) {
            await Promise.resolve();
        }
        expect(events.filter((event) => event.type === "waiting" && event.reason === "circuit_probe")).toHaveLength(1);
        expect(dispatchTimes).toEqual([1_000, 11_000]);

        // The probe fails retryable: the circuit re-opens with a FRESH
        // cooldown (11_000 + 10_000 = 21_000). The parked call wakes,
        // refuses to dispatch through the open circuit, waits out the
        // new cooldown and only then dispatches as the next probe.
        releaseProbe();
        await expect(probe).rejects.toThrow(ModelProviderError);
        expect(await parked).toBe("parked-dispatch");
        expect(dispatchTimes).toEqual([1_000, 11_000, 21_000]);
        expect(events).toContainEqual(expect.objectContaining({
            type: "waiting",
            reason: "circuit_open",
            nextAttemptAt: 21_000,
        }));
        expect(resilience.snapshot().circuitBreakers.breakers[0]).toMatchObject({
            state: "closed",
            probeInFlight: false,
        });
    });

    test("cancelling a call parked on a half-open probe orphans no waiter, slot or lease", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        const callerSignals = new Set<AbortSignal>();
        const trackedSignal = (): AbortSignal => {
            const signal = new AbortController().signal;
            callerSignals.add(signal);
            return signal;
        };
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 2 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 },
            clock: () => now,
            sleep: async (delayMs, sleepSignal) => {
                if (callerSignals.has(sleepSignal)) now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        const opener = resilience.execute(planFor(identity), trackedSignal(), async () => {
            dispatchTimes.push(now);
            throw providerError("network");
        });
        await expect(opener).rejects.toThrow(ModelProviderError);
        now += 10_000;

        let releaseProbe!: () => void;
        let probeStarted!: () => void;
        const probeStartedPromise = new Promise<void>((resolve) => {
            probeStarted = resolve;
        });
        const probe = resilience.execute(planFor(identity), trackedSignal(), () => new Promise<string>((resolve) => {
            dispatchTimes.push(now);
            probeStarted();
            releaseProbe = () => resolve("probe-result");
        }));
        await probeStartedPromise;

        // The concurrent call parks event-driven on the probe, then
        // is cancelled while the probe is still in flight.
        const parkedController = new AbortController();
        callerSignals.add(parkedController.signal);
        const parked = resilience.execute(planFor(identity), parkedController.signal, async () => {
            dispatchTimes.push(now);
            return "never-dispatched";
        });
        for (let i = 0; i < 100; i += 1) {
            await Promise.resolve();
        }
        expect(events.filter((event) => event.type === "waiting" && event.reason === "circuit_probe")).toHaveLength(1);
        parkedController.abort();
        await expect(parked).rejects.toBeInstanceOf(ProviderResilienceCancellationError);
        // The cancelled call never reached the provider.
        expect(dispatchTimes).toEqual([1_000, 11_000]);

        // The probe resolves: the circuit closes and a subsequent call
        // dispatches normally — no orphaned waiter interferes.
        releaseProbe();
        await expect(probe).resolves.toBe("probe-result");
        const after = resilience.execute(planFor(identity), trackedSignal(), async () => {
            dispatchTimes.push(now);
            return "after-recovery";
        });
        expect(await after).toBe("after-recovery");
        expect(dispatchTimes).toEqual([1_000, 11_000, 11_000]);
        // No slot is leaked by the cancelled call: no in-flight
        // or waiting entry remains.
        expect(resilience.snapshot().concurrency?.entries).toEqual([]);
    });

    test("budget expiry while parked on a half-open probe rejects with ProviderResilienceBudgetError", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        // Fully advancing clock: the budget expiry timer's internal
        // wait advances time so the parked call's budget elapses
        // deterministically.
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 2 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 },
            timeBudgetMs: 500,
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        const opener = resilience.execute(planFor(identity), new AbortController().signal, async () => {
            dispatchTimes.push(now);
            throw providerError("network");
        });
        await expect(opener).rejects.toThrow(ModelProviderError);
        now += 10_000;

        let releaseProbe!: () => void;
        let probeStarted!: () => void;
        const probeStartedPromise = new Promise<void>((resolve) => {
            probeStarted = resolve;
        });
        const probe = resilience.execute(planFor(identity), new AbortController().signal, () => new Promise<string>((resolve) => {
            dispatchTimes.push(now);
            probeStarted();
            releaseProbe = () => resolve("probe-result");
        }));
        await probeStartedPromise;

        // The parked call has a small budget: it must reject when the
        // budget expires instead of polling the probe.
        const parked = resilience.execute(
            planFor(identity),
            new AbortController().signal,
            async () => {
                dispatchTimes.push(now);
                return "never-dispatched";
            },
        );
        for (let i = 0; i < 100; i += 1) {
            await Promise.resolve();
        }
        expect(events.filter((event) => event.type === "waiting" && event.reason === "circuit_probe")).toHaveLength(1);
        await expect(parked).rejects.toBeInstanceOf(ProviderResilienceBudgetError);
        // The budget expiry never dispatched and never consumed the
        // probe: the in-flight probe is untouched.
        expect(dispatchTimes).toEqual([1_000, 11_000]);
        expect(resilience.snapshot().circuitBreakers.breakers[0]).toMatchObject({
            state: "half_open",
            probeInFlight: true,
        });

        // The probe still resolves and closes the circuit.
        releaseProbe();
        await expect(probe).resolves.toBe("probe-result");
        expect(resilience.snapshot().circuitBreakers.breakers[0]).toMatchObject({
            state: "closed",
            probeInFlight: false,
        });
    });

    test("pacing: queued dispatches respect the refill rate instead of bursting with pre-accumulated tokens", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        // The fake clock advances only for caller-owned waits.
        const callerSignals = new Set<AbortSignal>();
        const trackedSignal = (): AbortSignal => {
            const signal = new AbortController().signal;
            callerSignals.add(signal);
            return signal;
        };
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 1 },
            quota: { capacity: 1, refillTokens: 1, refillIntervalMs: 1_000 },
            clock: () => now,
            sleep: async (delayMs, sleepSignal) => {
                if (callerSignals.has(sleepSignal)) now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        let releaseBlocker!: () => void;
        let blockerStarted!: () => void;
        const blockerStartedPromise = new Promise<void>((resolve) => {
            blockerStarted = resolve;
        });
        // A occupies the only slot and consumes the only token
        // at t=1_000 (dispatch admission).
        const blocker = resilience.execute(planFor(identity), trackedSignal(), () => new Promise<string>((resolve) => {
            dispatchTimes.push(now);
            blockerStarted();
            releaseBlocker = () => resolve("blocker");
        }));
        await blockerStartedPromise;

        // B and C queue for the single slot. Neither may consume
        // a quota token while queued: the token is only consumed
        // at real dispatch admission.
        now += 1_000;
        const second = resilience.execute(planFor(identity), trackedSignal(), async () => {
            dispatchTimes.push(now);
            return "second";
        });
        now += 1_000;
        const third = resilience.execute(planFor(identity), trackedSignal(), async () => {
            dispatchTimes.push(now);
            return "third";
        });

        // The blocker releases at t=5_000: B takes the slot and
        // the token refilled since t=1_000; C must wait for the
        // NEXT token (t=6_000).
        now += 2_000;
        releaseBlocker();
        expect(await second).toBe("second");
        expect(await third).toBe("third");
        // B dispatched at 5_000 and C at 6_000: paced by the
        // 1 token/s refill — not a burst at 5_000 with tokens
        // reserved at queue entry.
        expect(dispatchTimes).toEqual([1_000, 5_000, 6_000]);
        expect(events).toContainEqual(expect.objectContaining({
            type: "waiting",
            reason: "rate_limit",
            nextAttemptAt: 6_000,
        }));
    });

    test("cancelling a queued call consumes no quota token", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        // The fake clock advances only for caller-owned waits.
        const callerSignals = new Set<AbortSignal>();
        const trackedSignal = (): AbortSignal => {
            const signal = new AbortController().signal;
            callerSignals.add(signal);
            return signal;
        };
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 1 },
            quota: { capacity: 2, refillTokens: 1, refillIntervalMs: 1_000 },
            clock: () => now,
            sleep: async (delayMs, sleepSignal) => {
                if (callerSignals.has(sleepSignal)) now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        let releaseBlocker!: () => void;
        let blockerStarted!: () => void;
        const blockerStartedPromise = new Promise<void>((resolve) => {
            blockerStarted = resolve;
        });
        // A occupies the only slot and consumes exactly one token
        // at dispatch admission (t=1_000): tokens 2 -> 1.
        const blocker = resilience.execute(planFor(identity), trackedSignal(), () => new Promise<string>((resolve) => {
            dispatchTimes.push(now);
            blockerStarted();
            releaseBlocker = () => resolve("blocker");
        }));
        await blockerStartedPromise;

        // B queues for the single slot with a tracked signal. It
        // must not consume a quota token while queued: the token
        // is only consumed at real dispatch admission.
        const queuedController = new AbortController();
        const queued = resilience.execute(planFor(identity), queuedController.signal, async () => {
            dispatchTimes.push(now);
            return "must not run";
        });
        const queuedOutcome = queued.then(
            () => "must not resolve",
            (error) => error,
        );
        for (let i = 0; i < 100; i += 1) {
            await Promise.resolve();
        }
        queuedController.abort();

        expect(await queuedOutcome).toBeInstanceOf(ProviderResilienceCancellationError);
        expect(dispatchTimes).toEqual([1_000]);
        // B consumed nothing: only A's dispatch admission consumed
        // a token. Queue-entry consumption would show 0.
        expect(resilience.snapshot().quota?.buckets[0].tokens).toBeCloseTo(1, 5);
        expect(resilience.snapshot().concurrency?.entries[0]).toMatchObject({
            providerId: "provider-a",
            credentialScope: "scope-a",
            inFlight: 1,
            waiting: 0,
        });

        // No slot is leaked by the cancelled call: no in-flight
        // or waiting entry remains.
        releaseBlocker();
        expect(await blocker).toBe("blocker");
        expect(resilience.snapshot().concurrency?.entries ?? []).toEqual([]);
    });

    test("budget expiry while queued consumes no quota token", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        // Fully advancing clock: the budget expiry timer's internal
        // wait advances time so the queued call's budget elapses
        // deterministically while it waits for the slot. The budget
        // is configured per instance: execute() takes no per-call
        // options argument, so the duration belongs to the instance
        // (the same pattern as the queued-budget-expiry test above).
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 1 },
            quota: { capacity: 2, refillTokens: 1, refillIntervalMs: 1_000 },
            timeBudgetMs: 500,
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        let releaseBlocker!: () => void;
        let blockerStarted!: () => void;
        const blockerStartedPromise = new Promise<void>((resolve) => {
            blockerStarted = resolve;
        });
        // A occupies the only slot and consumes exactly one token
        // at dispatch admission (t=1_000): tokens 2 -> 1.
        const blocker = resilience.execute(planFor(identity), new AbortController().signal, () => new Promise<string>((resolve) => {
            dispatchTimes.push(now);
            blockerStarted();
            releaseBlocker = () => resolve("blocker");
        }));
        await blockerStartedPromise;

        // B queues for the single slot. Its 500ms budget expires
        // while queued (at t=1_500): it must never call the
        // provider and must never consume a quota token.
        const queued = resilience.execute(planFor(identity), new AbortController().signal, async () => {
            dispatchTimes.push(now);
            return "must not run";
        });
        const queuedOutcome = queued.then(
            () => "must not resolve",
            (error) => error,
        );

        expect(await queuedOutcome).toBeInstanceOf(ProviderResilienceBudgetError);
        expect(dispatchTimes).toEqual([1_000]);
        // The budget expired at t=1_500. B consumed nothing: the
        // bucket still holds exactly A's remaining token (the
        // snapshot reads the state as of the last admission, with
        // no refill on read). Queue-entry consumption would show 0.
        expect(resilience.snapshot().quota?.buckets[0].tokens).toBeCloseTo(1, 5);
        expect(resilience.snapshot().concurrency?.entries[0]).toMatchObject({
            providerId: "provider-a",
            credentialScope: "scope-a",
            inFlight: 1,
            waiting: 0,
        });

        releaseBlocker();
        expect(await blocker).toBe("blocker");
    });

    test("a circuit-open refusal consumes no quota token", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        // Fully advancing clock: the budget-capped cooldown wait
        // advances time deterministically.
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            quota: { capacity: 2, refillTokens: 1, refillIntervalMs: 10_000 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 },
            timeBudgetMs: 1_000,
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        // A dispatches at t=1_000 (consuming one token: 2 -> 1)
        // and fails: the circuit opens until t=11_000.
        const opener = resilience.execute(planFor(identity), new AbortController().signal, async () => {
            dispatchTimes.push(now);
            throw providerError("network");
        });
        await expect(opener).rejects.toThrow(ModelProviderError);

        // B arrives while the circuit is open. It is refused by the
        // breaker before any quota admission — no token is consumed
        // and no slot is held (no concurrency limiter) — and its
        // budget-capped cooldown wait expires at t=2_000.
        const refused = resilience.execute(planFor(identity), new AbortController().signal, async () => {
            dispatchTimes.push(now);
            return "must not run";
        });
        const refusedOutcome = refused.then(
            () => "must not resolve",
            (error) => error,
        );

        expect(await refusedOutcome).toBeInstanceOf(ProviderResilienceBudgetError);
        expect(dispatchTimes).toEqual([1_000]);
        // B consumed nothing: the bucket still holds exactly A's
        // remaining token. Queue-entry consumption would show 0.
        expect(resilience.snapshot().quota?.buckets[0].tokens).toBeCloseTo(1, 5);
        expect(events).toContainEqual(expect.objectContaining({
            type: "waiting",
            reason: "circuit_open",
            nextAttemptAt: 11_000,
        }));
    });

    test("half-open with unavailable quota releases the probe and returns the slot before waiting", async () => {
        let now = 1_000;
        const events: ProviderResilienceEvent[] = [];
        // Fully advancing clock: the budget-capped quota wait
        // advances time deterministically.
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            concurrency: { maxConcurrency: 1 },
            quota: { capacity: 1, refillTokens: 1, refillIntervalMs: 60_000 },
            circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 },
            timeBudgetMs: 1_000,
            clock: () => now,
            sleep: async (delayMs) => {
                now += delayMs;
            },
            onEvent: (event) => events.push(event),
        });
        const dispatchTimes: number[] = [];
        // A dispatches at t=1_000, consuming the only token
        // (1 -> 0, lastRefillAt=1_000), and fails: the circuit
        // opens until t=11_000.
        const opener = resilience.execute(planFor(identity), new AbortController().signal, async () => {
            dispatchTimes.push(now);
            throw providerError("network");
        });
        await expect(opener).rejects.toThrow(ModelProviderError);
        now += 10_000;

        // B arrives at t=11_000: the cooldown elapsed, so the
        // breaker authorizes and reserves the half-open probe. The
        // quota is unavailable (tokens ~= 0.16667 < 1): the probe
        // must be released, the slot returned, and the call must
        // wait for the token — capped by its budget, which expires
        // at t=12_000.
        const parked = resilience.execute(planFor(identity), new AbortController().signal, async () => {
            dispatchTimes.push(now);
            return "must not run";
        });
        const parkedOutcome = parked.then(
            () => "must not resolve",
            (error) => error,
        );

        expect(await parkedOutcome).toBeInstanceOf(ProviderResilienceBudgetError);
        expect(dispatchTimes).toEqual([1_000]);
        // The probe was released, not orphaned: the circuit stays
        // half-open-eligible with no probe in flight.
        expect(resilience.snapshot().circuitBreakers.breakers[0]).toMatchObject({
            state: "half_open",
            probeInFlight: false,
        });
        // The slot was returned BEFORE the quota wait: no slot
        // crosses the wait.
        expect(resilience.snapshot().concurrency?.entries ?? []).toEqual([]);
        // B consumed no token: the bucket still holds exactly the
        // refill observed at B's denied admission (t=11_000).
        expect(resilience.snapshot().quota?.buckets[0].tokens).toBeCloseTo(0.16667, 4);
        // Floating point may make nextAttemptAt 61_001.
        const rateLimitWait = events.find(
            (event): event is Extract<ProviderResilienceEvent, { reason: "rate_limit" }> =>
                event.type === "waiting" && event.reason === "rate_limit",
        );
        expect(rateLimitWait?.nextAttemptAt).toBeGreaterThanOrEqual(61_000);

        // The probe reservation is reusable, not orphaned: with
        // the token refilled (t=62_000), C owns the single probe,
        // is admitted and dispatches — closing the circuit.
        now += 50_000;
        const followUp = resilience.execute(planFor(identity), new AbortController().signal, async () => {
            dispatchTimes.push(now);
            return "follow-up";
        });
        expect(await followUp).toBe("follow-up");
        expect(dispatchTimes).toEqual([1_000, 62_000]);
        expect(resilience.snapshot().circuitBreakers.breakers[0]).toMatchObject({
            state: "closed",
            probeInFlight: false,
        });
    });
});

/**
 * Durable bridge (Issue #47 requirements 8-11): a provider wait
 * must surface onto the EXISTING Mission durable abstractions —
 * `MissionState.WAITING_FOR_PROVIDER` and
 * `CapabilityInvocation.retry.nextEligibleAt` — without any new
 * store, scheduler or parallel wakeup mechanism. The
 * MissionScheduler remains the single resumption authority.
 */
describe("provider resilience durable mission bridge", () => {
    const BRIDGE_TIME = "2026-10-04T10:00:00.000Z";
    const PROVIDER_WAIT_MS = 5_000;

    interface BridgeHarness {
        store: SqliteMissionStore;
        engine: MissionEngine;
        clock: FakeClock;
        missionId: string;
        invocationId: string;
        waitingEvent: Extract<ProviderResilienceEvent, { type: "waiting" }>;
    }

    async function setupBridge(dbPath = ":memory:"): Promise<BridgeHarness> {
        const clock = new FakeClock(BRIDGE_TIME);
        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        const resolver = new FakeCapabilityResolver();
        resolver.registerMany(makeDefaultCapabilityCatalog());
        const engine = new MissionEngine({
            store,
            policy: new PlanPolicyValidator(resolver),
            clock,
            ids: new FakeIdGenerator("bridge"),
            interpreter: (intent) => intent.originalIntent,
            verificationAuthority: new FakeVerificationAuthority(),
        });
        const mission = await engine.createMission({
            intent: {
                requestId: "bridge-request",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: {
                capabilityIds: ["lifeos.query"],
                allowedEffectClasses: [EffectClass.READ],
                allowedRefPrefixes: ["refs/lifeos/"],
            },
        });
        const proposal = await engine.proposePlan(mission.missionId, {
            planId: "bridge-plan",
            missionId: mission.missionId,
            plannerNote: "bridge test plan",
            steps: [{
                stepId: "read-status",
                desiredOutcome: "Read the current LifeOS status",
                dependencyIds: [],
                capabilityRequirement: "lifeos.query",
                inputRefs: ["refs/lifeos/status"],
                expectedAcceptance: ["status read"],
                effectClass: EffectClass.READ,
            }],
        });
        if (!proposal.ok) throw new Error("bridge plan was rejected");
        await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);
        const invocation = await engine.dispatchStep(mission.missionId, "read-status", {
            descriptor: {
                contractVersion: 1,
                moduleOwner: "lifeos",
                idempotency: { mode: IdempotencyMode.IDEMPOTENT, keyScope: "request" },
                retry: { maxAttempts: 3, backoff: RetryBackoff.FIXED },
                cancellationSupport: CancellationSupport.NONE,
                reconciliationSupport: ReconciliationSupport.STATUS_REPLAY,
            },
        });

        // The planner provider call fails with a typed, retryable
        // rate limit carrying Retry-After. The resilience layer
        // surfaces the mandated wait as an event.
        const events: ProviderResilienceEvent[] = [];
        const resilience = new ProviderResilience({
            retry: { maxAttempts: 1 },
            quota: { capacity: 10, refillTokens: 10, refillIntervalMs: 1_000 },
            circuitBreaker: { failureThreshold: 5, cooldownMs: 60_000 },
            clock: () => clock.now().getTime(),
            sleep: async (delayMs) => {
                clock.advance(delayMs);
            },
            onEvent: (event) => events.push(event),
        });
        await expect(resilience.execute(
            { primary: { providerId: "bridge-provider", credentialScope: "bridge-scope" } },
            new AbortController().signal,
            async () => {
                throw new ModelProviderError("bridge provider rate limited", {
                    kind: "rate_limit",
                    retryable: true,
                    fallbackAllowed: true,
                    retryAfterMs: PROVIDER_WAIT_MS,
                });
            },
        )).rejects.toThrow(ModelProviderError);

        const waitingEvent = events.find((event): event is Extract<ProviderResilienceEvent, { type: "waiting" }> =>
            event.type === "waiting" && event.reason === "rate_limit");
        if (!waitingEvent) throw new Error("expected a rate_limit waiting event");

        return {
            store,
            engine,
            clock,
            missionId: mission.missionId,
            invocationId: invocation.invocationId,
            waitingEvent,
        };
    }

    /**
     * Apply the provider wait through the EXISTING durable paths:
     * record the failed attempt, prepare the next idempotent
     * attempt with the bridged backoff (persisting
     * `retry.nextEligibleAt`), and enter the existing
     * WAITING_FOR_PROVIDER wait state.
     */
    async function applyProviderWait(harness: BridgeHarness): Promise<void> {
        const backoffMs = providerWaitBackoffMs(harness.waitingEvent, harness.clock.now().getTime());
        expect(backoffMs).toBe(PROVIDER_WAIT_MS);
        await harness.engine.recordInvocationResult(harness.invocationId, {
            invocationId: harness.invocationId,
            status: InvocationStatus.FAILED,
            summary: "provider rate limited",
            evidenceRefs: [],
            completedAt: harness.clock.isoNow(),
        });
        await harness.engine.prepareInvocationRetry(harness.invocationId, { backoffMs });
        await harness.engine.setWaiting(
            harness.missionId,
            MissionState.WAITING_FOR_PROVIDER,
            "provider rate limit",
        );
    }

    test("bridges a provider wait onto WAITING_FOR_PROVIDER and the durable nextEligibleAt wakeup", async () => {
        const harness = await setupBridge();
        await applyProviderWait(harness);

        const invocation = await harness.store.getInvocation(harness.invocationId);
        expect(invocation?.retry.nextEligibleAt).toBe("2026-10-04T10:00:05.000Z");
        // The durable eligibility gate refuses early redispatch.
        expect(isInvocationDue(invocation!, BRIDGE_TIME)).toBe(false);
        expect(isInvocationDue(invocation!, "2026-10-04T10:00:05.000Z")).toBe(true);
        // The Mission waits explicitly — a wait is not a failure.
        expect((await harness.store.getMission(harness.missionId))?.state).toBe(MissionState.WAITING_FOR_PROVIDER);
        // The scheduler's existing wakeup query reports the cooldown.
        expect(await harness.store.getNextInvocationWakeAt(BRIDGE_TIME)).toBe("2026-10-04T10:00:05.000Z");
        await harness.store.close();
    });

    test("restart resumes only when eligible, without repeating a confirmed or uncertain effect", async () => {
        const dir = mkdtempSync(join(tmpdir(), "provider-resilience-bridge-"));
        const dbPath = join(dir, "missions.db");
        const cleanup = () => rmSync(dir, { recursive: true, force: true });
        try {
            // First process: bridge the provider wait.
            const first = await setupBridge(dbPath);
            await applyProviderWait(first);
            await first.store.close();

            // Restart: a brand-new store/engine/scheduler over the
            // same durable SQLite file — no parallel store exists.
            const clock = new FakeClock(BRIDGE_TIME);
            const store = new SqliteMissionStore(dbPath);
            await store.initialize();
            const resolver = new FakeCapabilityResolver();
            resolver.registerMany(makeDefaultCapabilityCatalog());
            const engine = new MissionEngine({
                store,
                policy: new PlanPolicyValidator(resolver),
                clock,
                ids: new FakeIdGenerator("bridge-restart"),
                interpreter: (intent) => intent.originalIntent,
                verificationAuthority: new FakeVerificationAuthority(),
            });
            const registry = new CapabilityRegistry();
            registry.register(defineCapabilityDescriptor({
                capabilityId: "lifeos.query",
                moduleOwner: "lifeos",
                purpose: "Read the LifeOS status",
                effectClass: EffectClass.READ,
                allowedInputRefPrefixes: ["refs/lifeos/"],
                ownsStorage: true,
                retry: { maxAttempts: 3, backoff: RetryBackoff.FIXED },
                reconciliationSupport: ReconciliationSupport.STATUS_REPLAY,
            }));
            const seam = new ConnectorDispatchSeam(engine, registry, clock);
            let invokes = 0;
            seam.registerConnector("lifeos.query", {
                connectorContractVersion: 1,
                capabilityId: "lifeos.query",
                describe: () => registry.requireDescriptor("lifeos.query"),
                invoke: async (connectorRequest) => {
                    invokes += 1;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: connectorRequest.requestId,
                        summary: "retried status read",
                        evidence: [],
                    };
                },
            });
            const scheduler = new MissionScheduler({ engine, store, seam, clock });

            // The cooldown survived the restart: the invocation is
            // not due, the seam refuses early dispatch, and the
            // scheduler reports the single durable wakeup.
            const invocation = await store.getInvocation(first.invocationId);
            expect(invocation?.retry.nextEligibleAt).toBe("2026-10-04T10:00:05.000Z");
            expect(isInvocationDue(invocation!, BRIDGE_TIME)).toBe(false);
            // While the Mission waits for the provider, the
            // existing seam refuses any dispatch: a provider
            // wait is never an implicit authorization to
            // resubmit the step.
            await expect(seam.dispatchThroughSeam(first.missionId, "read-status"))
                .rejects.toThrow(/waiting_for_provider|not yet eligible/);
            const beforeDue = await scheduler.runOnce();
            expect(invokes).toBe(0);
            expect(beforeDue.nextWakeAt).toBe("2026-10-04T10:00:05.000Z");
            expect((await store.getMission(first.missionId))?.state).toBe(MissionState.WAITING_FOR_PROVIDER);

            // The wait is resumed only explicitly: the
            // scheduler never auto-promotes a provider wait.
            await engine.restoreWaitingToReady(first.missionId);
            // Even with the Mission ready, the durable
            // eligibility gate owns the exact wakeup
            // moment: an early resubmission of the
            // persisted invocation is refused.
            await expect(seam.dispatchThroughSeam(
                first.missionId,
                "read-status",
                { invocationId: first.invocationId },
            )).rejects.toThrow(/not yet eligible/);

            clock.advance(PROVIDER_WAIT_MS);
            const due = await scheduler.runOnce();
            expect(invokes).toBe(1);
            expect(due.dispatchedInvocationIds).toEqual([first.invocationId]);
            expect((await store.getInvocation(first.invocationId))?.status).toBe(InvocationStatus.COMPLETED);

            // A confirmed effect is never dispatched a second time.
            const again = await scheduler.runOnce();
            expect(invokes).toBe(1);
            expect((await store.listInvocations(first.missionId))).toHaveLength(1);
            expect(again.dispatchedInvocationIds).toEqual([]);
            await store.close();
        } finally {
            cleanup();
        }
    });

    test("an uncertain delivery is never eligible for a blind retry", async () => {
        const harness = await setupBridge();
        await harness.engine.markInvocationHandoff(harness.invocationId, { deliveryState: "uncertain" });

        const invocation = await harness.store.getInvocation(harness.invocationId);
        expect(hasUncertainDelivery(invocation!)).toBe(true);
        expect(isSafeRetryEligible(invocation!, harness.clock.now())).toBe(false);
        // The durable retry path refuses an uncertain delivery:
        // reconciliation (#50) owns the outcome, never a blind resend.
        await expect(harness.engine.prepareInvocationRetry(harness.invocationId, { backoffMs: 100 }))
            .rejects.toThrow(/non-uncertain|failed or definitely not-submitted/);
        await harness.store.close();
    });
});
