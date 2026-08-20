import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../daemon/event-bus.js";
import { LocalInferenceProvider } from "../LocalInferenceProvider.js";
import type {
    ModelProvider,
    ProviderCallContext,
} from "../ModelProvider.js";
import { ModelProviderError } from "../ModelProvider.js";

const originalFetch = globalThis.fetch;

function context(overrides: Partial<ProviderCallContext> = {}): ProviderCallContext {
    return {
        credentialRef: "credential:test-user:ollama",
        credentialScope: "user:test-user",
        taskId: "task-test",
        stepId: "step-test",
        signal: new AbortController().signal,
        deadline: new Date(Date.now() + 5_000),
        ...overrides,
    };
}

function provider(): LocalInferenceProvider {
    return new LocalInferenceProvider({
        ollamaBaseUrl: "http://ollama.test",
        collectMetrics: false,
        logRequests: false,
    });
}

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("ModelProvider contract", () => {
    test("normalizes a chat response with usage and finish reason", async () => {
        globalThis.fetch = async () => new Response(JSON.stringify({
            message: { content: "normalized answer" },
            prompt_eval_count: 3,
            eval_count: 5,
            done_reason: "stop",
        }), { status: 200, headers: { "Content-Type": "application/json" } });

        const modelProvider: ModelProvider = provider();
        const response = await modelProvider.complete({
            modelId: "test-model",
            messages: [{ role: "user", content: "hello" }],
        }, context());

        expect(response).toEqual({
            modelId: "test-model",
            content: "normalized answer",
            usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
            finishReason: "stop",
        });
    });

    test("declares capabilities independently as declared, implemented, and verified", () => {
        const profile = provider().getCapabilities("test-model");

        expect(profile.providerId).toBe("ollama-local");
        expect(profile.modelId).toBe("test-model");
        expect(profile.operations.complete).toEqual({
            declared: true,
            implemented: true,
            verified: true,
        });
        expect(profile.features.streaming).toEqual({
            declared: false,
            implemented: false,
            verified: false,
        });
        expect(profile.features.tools).toEqual({
            declared: false,
            implemented: false,
            verified: false,
        });
        expect(profile.features.structuredOutput).toEqual({
            declared: false,
            implemented: false,
            verified: false,
        });
        expect((provider() as ModelProvider).stream).toBeUndefined();
    });

    test("treats CapabilityProfile as authoritative even when an optional stream method exists", () => {
        const providerWithOptionalStream = Object.assign(provider(), {
            async *stream() {
                yield { delta: "not available" };
            },
        }) as ModelProvider;

        expect(providerWithOptionalStream.stream).toBeDefined();
        expect(providerWithOptionalStream.getCapabilities("test-model").operations.stream.implemented).toBe(false);
        expect(providerWithOptionalStream.getCapabilities("test-model").features.streaming.implemented).toBe(false);
    });

    test("keeps credential context out of transport, logs, and provider state", async () => {
        const eventBus = new EventBus();
        const logEvents: unknown[] = [];
        const unsubscribe = eventBus.on("log", (event) => logEvents.push(event));
        const credentialRef = "credential://sentinel-do-not-leak";
        const credentialScope = "scope://sentinel-do-not-leak";
        let requestPayload: unknown;

        globalThis.fetch = async (_input, init) => {
            requestPayload = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({
                message: { content: "isolated" },
                done_reason: "stop",
            }), { status: 200 });
        };

        const localProvider = new LocalInferenceProvider({
            ollamaBaseUrl: "http://ollama.test",
            collectMetrics: false,
            logRequests: true,
        }, eventBus);

        await localProvider.complete({
            modelId: "test-model",
            messages: [{ role: "user", content: "hello" }],
        }, context({ credentialRef, credentialScope }));
        unsubscribe();

        const serializedPayload = JSON.stringify(requestPayload);
        const serializedLogs = JSON.stringify(logEvents);
        const serializedProviderState = JSON.stringify(localProvider);
        expect(serializedPayload).not.toContain(credentialRef);
        expect(serializedPayload).not.toContain(credentialScope);
        expect(serializedLogs).not.toContain(credentialRef);
        expect(serializedLogs).not.toContain(credentialScope);
        expect(serializedProviderState).not.toContain(credentialRef);
        expect(serializedProviderState).not.toContain(credentialScope);
    });

    test("rejects tools before transport when the capability is not implemented", async () => {
        let transportCalled = false;
        globalThis.fetch = async () => {
            transportCalled = true;
            return new Response();
        };

        const request = {
            modelId: "test-model",
            messages: [{ role: "user" as const, content: "use a tool" }],
            tools: [{ name: "lookup", parameters: {} }],
        };

        await expect(provider().complete(request, context())).rejects.toMatchObject({
            name: "ModelProviderError",
            kind: "invalid_request",
            retryable: false,
            fallbackAllowed: false,
        });
        expect(transportCalled).toBe(false);
    });

    test("classifies authentication failures without retry", async () => {
        let calls = 0;
        globalThis.fetch = async () => {
            calls++;
            return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        };

        const error = await provider().complete({
            modelId: "test-model",
            messages: [{ role: "user", content: "hello" }],
        }, context()).catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(ModelProviderError);
        expect(error).toMatchObject({
            kind: "authentication",
            retryable: false,
            fallbackAllowed: false,
        });
        expect(calls).toBe(1);
    });

    test("classifies rate limits and parses Retry-After", async () => {
        globalThis.fetch = async () => new Response("rate limited", {
            status: 429,
            headers: { "Retry-After": "2" },
        });

        await expect(provider().complete({
            modelId: "test-model",
            messages: [{ role: "user", content: "hello" }],
        }, context())).rejects.toMatchObject({
            kind: "rate_limit",
            retryable: true,
            retryAfterMs: 2_000,
            fallbackAllowed: true,
        });
    });

    test("turns request timeout into a typed timeout without retrying", async () => {
        globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("request timed out", "AbortError"));
            }, { once: true });
        });

        await expect(provider().complete({
            modelId: "test-model",
            messages: [{ role: "user", content: "wait" }],
            requestTimeoutMs: 10,
        }, context())).rejects.toMatchObject({
            kind: "timeout",
            retryable: false,
            fallbackAllowed: true,
        });
    });

    test("propagates caller cancellation to transport and never retries it", async () => {
        const caller = new AbortController();
        let transportSignal: AbortSignal | undefined;
        globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
            transportSignal = init?.signal;
            transportSignal?.addEventListener("abort", () => {
                reject(new DOMException("cancelled", "AbortError"));
            }, { once: true });
            caller.abort();
        });

        await expect(provider().complete({
            modelId: "test-model",
            messages: [{ role: "user", content: "cancel" }],
        }, context({ signal: caller.signal }))).rejects.toMatchObject({
            kind: "cancellation",
            retryable: false,
            fallbackAllowed: false,
        });
        expect(transportSignal?.aborted).toBe(true);
    });

    test("classifies transport failures as retryable network errors", async () => {
        globalThis.fetch = async () => {
            throw new TypeError("Failed to fetch");
        };

        await expect(provider().complete({
            modelId: "test-model",
            messages: [{ role: "user", content: "network" }],
        }, context())).rejects.toMatchObject({
            kind: "network",
            retryable: true,
            fallbackAllowed: true,
        });
    });

    test("rejects malformed provider responses with a non-retryable typed error", async () => {
        globalThis.fetch = async () => new Response(JSON.stringify({ done: true }), { status: 200 });

        await expect(provider().complete({
            modelId: "test-model",
            messages: [{ role: "user", content: "malformed" }],
        }, context())).rejects.toMatchObject({
            kind: "malformed_response",
            retryable: false,
            fallbackAllowed: true,
        });
    });
});
