import { mkdtemp, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventBus } from "../../daemon/event-bus.js";
import { DatasetPipeline } from "../DatasetPipeline.js";
import {
    CredentialRegistry,
    CredentialScopeMismatchError,
    CredentialedProviderInvoker,
    createCredentialScope,
    loadOrCreateCredentialScopeSalt,
} from "../provider-security.js";
import { loadInferenceConfig } from "../inference-config.js";
import type {
    ModelProvider,
    ModelRequest,
    ModelResponse,
    ProviderCallContext,
} from "../ModelProvider.js";

const ARBITRARY_SECRET = "ordinary-secret-without-provider-prefix-7f3c";
const CREDENTIAL_REF = "credential://workspace-a/provider-a";
const OTHER_CREDENTIAL_REF = "credential://workspace-b/provider-a";

function fakeProvider(): ModelProvider {
    return {
        providerId: "test-provider",
        getCapabilities: (modelId: string) => ({
            providerId: "test-provider",
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
        complete: async (request: ModelRequest, _context: ProviderCallContext): Promise<ModelResponse> => ({
            modelId: request.modelId,
            content: "transport-ok",
            finishReason: "stop",
        }),
    };
}

function callContext(credentialRef: string, credentialScope: string): ProviderCallContext {
    return {
        credentialRef,
        credentialScope,
        taskId: "task-security",
        stepId: "step-provider",
        signal: new AbortController().signal,
        deadline: new Date(Date.now() + 10_000),
    };
}

const request: ModelRequest = {
    modelId: "test-model",
    messages: [{ role: "user", content: "hello" }],
};

describe("blocking review findings", () => {
    test("keeps the default credential scope stable across simulated restarts", async () => {
        const projectRoot = await mkdtemp(path.join(os.tmpdir(), "ouroboros-scope-"));
        const firstSalt = loadOrCreateCredentialScopeSalt(projectRoot, ".ouroboros");
        const secondSalt = loadOrCreateCredentialScopeSalt(projectRoot, ".ouroboros");
        const firstRegistry = new CredentialRegistry({ projectRoot, stateDir: ".ouroboros" });
        const restartedRegistry = new CredentialRegistry({ projectRoot, stateDir: ".ouroboros" });

        expect(secondSalt).toBe(firstSalt);
        expect(firstRegistry.resolveScope(CREDENTIAL_REF)).toBe(restartedRegistry.resolveScope(CREDENTIAL_REF));
        expect(firstRegistry.resolveScope(CREDENTIAL_REF)).not.toBe(firstRegistry.resolveScope(OTHER_CREDENTIAL_REF));
    });

    test("executes a real credentialed provider call and gives the secret only to transport", async () => {
        const eventBus = new EventBus();
        const registry = new CredentialRegistry("stable-test-salt");
        registry.register(CREDENTIAL_REF, ARBITRARY_SECRET);
        const scope = createCredentialScope(CREDENTIAL_REF, "stable-test-salt");
        let transportSecret: string | undefined;
        let transportCalls = 0;
        const invoker = new CredentialedProviderInvoker(fakeProvider(), registry, eventBus, {
            complete: async (provider, transportRequest, context, secret) => {
                transportCalls += 1;
                transportSecret = secret;
                return provider.complete(transportRequest, context);
            },
        });

        const response = await invoker.complete(
            request,
            { credentialRef: CREDENTIAL_REF, credentialScope: scope },
            callContext(CREDENTIAL_REF, scope),
        );

        expect(response.content).toBe("transport-ok");
        expect(transportCalls).toBe(1);
        expect(transportSecret).toBe(ARBITRARY_SECRET);
        expect(JSON.stringify({ credentialRef: CREDENTIAL_REF, credentialScope: scope })).not.toContain(ARBITRARY_SECRET);
        expect(JSON.stringify(registry)).not.toContain(ARBITRARY_SECRET);
    });

    test("rejects scope mismatch, missing credentials, and revocation before transport without fallback", async () => {
        const eventBus = new EventBus();
        const registry = new CredentialRegistry("stable-test-salt");
        registry.register(CREDENTIAL_REF, ARBITRARY_SECRET);
        registry.register(OTHER_CREDENTIAL_REF, "other-secret-must-not-fallback");
        const invoker = new CredentialedProviderInvoker(fakeProvider(), registry, eventBus, {
            complete: async () => {
                throw new Error("transport must not be called");
            },
        });
        const validScope = createCredentialScope(CREDENTIAL_REF, "stable-test-salt");

        await expect(invoker.complete(
            request,
            { credentialRef: CREDENTIAL_REF, credentialScope: "credential-scope-wrong" },
            callContext(CREDENTIAL_REF, "credential-scope-wrong"),
        )).rejects.toBeInstanceOf(CredentialScopeMismatchError);

        registry.revoke(CREDENTIAL_REF);
        await expect(invoker.complete(
            request,
            { credentialRef: CREDENTIAL_REF, credentialScope: validScope },
            callContext(CREDENTIAL_REF, validScope),
        )).rejects.toThrow();
    });

    test("automatically redacts an arbitrary credential across events, errors, and dataset export during its lifecycle", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "ouroboros-redaction-"));
        const eventBus = new EventBus();
        const registry = new CredentialRegistry("stable-test-salt");
        registry.register(CREDENTIAL_REF, ARBITRARY_SECRET);
        const scope = createCredentialScope(CREDENTIAL_REF, "stable-test-salt");
        const events: unknown[] = [];
        const pipeline = new DatasetPipeline(eventBus);
        eventBus.on("log", event => events.push(event));
        eventBus.on("thought", event => events.push(event));
        const invoker = new CredentialedProviderInvoker(fakeProvider(), registry, eventBus, {
            complete: async () => {
                eventBus.log("error", `transport log ${ARBITRARY_SECRET}`, "transport");
                eventBus.emit("thought", {
                    type: "tool_result",
                    content: ARBITRARY_SECRET,
                    metadata: { nested: ARBITRARY_SECRET },
                    timestamp: new Date(),
                });
                pipeline.addPolicyDecision(ARBITRARY_SECRET, `decision ${ARBITRARY_SECRET}`, "failure");
                throw new Error(`outer ${ARBITRARY_SECRET}`, {
                    cause: new Error(`inner ${ARBITRARY_SECRET}`),
                });
            },
        });

        await expect(invoker.complete(
            request,
            { credentialRef: CREDENTIAL_REF, credentialScope: scope },
            callContext(CREDENTIAL_REF, scope),
        )).rejects.toThrow();

        const outputPath = path.join(directory, "trace.jsonl");
        await pipeline.export(outputPath);
        const exported = await readFile(outputPath, "utf8");
        expect(JSON.stringify(events)).not.toContain(ARBITRARY_SECRET);
        expect(exported).not.toContain(ARBITRARY_SECRET);
        expect(exported).toContain("[REDACTED]");

        const afterLifecycleEvents: unknown[] = [];
        eventBus.on("log", event => afterLifecycleEvents.push(event));
        eventBus.log("info", `after lifecycle ${ARBITRARY_SECRET}`, "test");
        expect(JSON.stringify(afterLifecycleEvents)).toContain(ARBITRARY_SECRET);
    });

    test("rejects invalid numeric configuration while keeping optional BYOK and Ollama defaults safe", () => {
        const registry = new CredentialRegistry("stable-test-salt");
        const config = loadInferenceConfig({
            credentialRegistry: registry,
            env: {
                OLLAMA_BASE_URL: "http://localhost:11434",
                NVIDIA_API_KEY: ARBITRARY_SECRET,
                INFERENCE_TIMEOUT_MS: "60000",
                INFERENCE_MAX_RETRIES: "3",
                INFERENCE_RETRY_DELAY_MS: "1000",
            },
        });

        expect(config.providerModel?.providerId).toBe("ollama-local");
        expect(config.credentialSources).toEqual([
            {
                providerId: "nvidia-nim",
                credentialRef: "credential://env/nvidia-api-key",
                source: "NVIDIA_API_KEY",
            },
        ]);
        expect(JSON.stringify(config)).not.toContain(ARBITRARY_SECRET);
        expect(registry.resolve("credential://env/nvidia-api-key").secret).toBe(ARBITRARY_SECRET);

        expect(() => loadInferenceConfig({ env: { INFERENCE_TIMEOUT_MS: "NaN" } })).toThrow();
        expect(() => loadInferenceConfig({ env: { INFERENCE_TIMEOUT_MS: "-1" } })).toThrow();
        expect(() => loadInferenceConfig({ env: { INFERENCE_MAX_RETRIES: "-1" } })).toThrow();
        expect(() => loadInferenceConfig({ env: { INFERENCE_RETRY_DELAY_MS: "not-a-number" } })).toThrow();
    });
});
