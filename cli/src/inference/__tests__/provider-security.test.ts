import { mkdtemp, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventBus } from "../../daemon/event-bus.js";
import { DatasetPipeline } from "../DatasetPipeline.js";
import { loadInferenceConfig } from "../inference-config.js";
import {
    CredentialRegistry,
    CredentialUnavailableError,
    createCredentialScope,
} from "../provider-security.js";
import type { InferenceTrace } from "../schemas/inference-schemas.js";

const SYNTHETIC_SECRET = "synthetic-provider-secret-never-persist";
const CREDENTIAL_REF = "credential://workspace-a/provider-a";

describe("provider security foundation", () => {
    test("loads typed provider/model configuration without raw credentials", () => {
        const config = loadInferenceConfig();

        expect(config.providerModel).toEqual({
            providerId: "ollama-local",
            modelId: "default",
            endpoint: "http://localhost:11434",
            timeoutMs: 60_000,
            featureFlags: {
                streaming: false,
                tools: false,
                structuredOutput: false,
            },
        });
        expect(JSON.stringify(config)).not.toContain("apiKey");
        expect(JSON.stringify(config)).not.toContain("secret");
    });

    test("resolves a credential reference only in memory and serializes without the secret", () => {
        const registry = new CredentialRegistry("deterministic-test-salt");
        registry.register(CREDENTIAL_REF, SYNTHETIC_SECRET);

        const resolved = registry.resolve(CREDENTIAL_REF);

        expect(resolved.credentialRef).toBe(CREDENTIAL_REF);
        expect(resolved.credentialScope).toBe(createCredentialScope(CREDENTIAL_REF, "deterministic-test-salt"));
        expect(resolved.secret).toBe(SYNTHETIC_SECRET);
        expect(JSON.stringify(registry)).not.toContain(SYNTHETIC_SECRET);
        expect(JSON.stringify(resolved)).not.toContain(SYNTHETIC_SECRET);
    });

    test("generates stable opaque scopes and isolates different credential references", () => {
        const first = createCredentialScope(CREDENTIAL_REF, "deterministic-test-salt");
        const same = createCredentialScope(CREDENTIAL_REF, "deterministic-test-salt");
        const second = createCredentialScope("credential://workspace-b/provider-a", "deterministic-test-salt");

        expect(first).toBe(same);
        expect(first).not.toBe(second);
        expect(first).not.toContain(CREDENTIAL_REF);
        expect(first).not.toContain(SYNTHETIC_SECRET);
        expect(first).toMatch(/^credential-scope-[a-f0-9]{64}$/);
    });

    test("fails closed when a credential is absent or revoked without revealing its value", () => {
        const registry = new CredentialRegistry("deterministic-test-salt");

        expect(() => registry.resolve(CREDENTIAL_REF)).toThrow(CredentialUnavailableError);
        registry.register(CREDENTIAL_REF, SYNTHETIC_SECRET);
        registry.revoke(CREDENTIAL_REF);

        try {
            registry.resolve(CREDENTIAL_REF);
            throw new Error("expected credential resolution to fail");
        } catch (error) {
            expect(error).toBeInstanceOf(CredentialUnavailableError);
            expect(String(error)).not.toContain(SYNTHETIC_SECRET);
        }
    });

    test("redacts synthetic credentials from logs and arbitrary event payloads", () => {
        const eventBus = new EventBus();
        eventBus.registerRedactionSecret(SYNTHETIC_SECRET);
        const events: unknown[] = [];
        eventBus.on("log", event => events.push(event));
        eventBus.on("thought", event => events.push(event));

        eventBus.log("error", `Provider failed with Authorization: Bearer ${SYNTHETIC_SECRET}`, "test");
        eventBus.emit("thought", {
            type: "tool_result",
            content: SYNTHETIC_SECRET,
            metadata: { nested: { token: SYNTHETIC_SECRET } },
            timestamp: new Date(),
        });

        expect(JSON.stringify(events)).not.toContain(SYNTHETIC_SECRET);
        expect(JSON.stringify(events)).toContain("[REDACTED]");
    });

    test("redacts secrets from persisted dataset traces", async () => {
        const eventBus = new EventBus();
        const pipeline = new DatasetPipeline(eventBus, [SYNTHETIC_SECRET]);
        const trace: InferenceTrace = {
            traceId: "trace-security",
            modelId: "test-model",
            modelRole: "coder",
            input: `prompt with ${SYNTHETIC_SECRET}`,
            output: `response with ${SYNTHETIC_SECRET}`,
            durationMs: 10,
            wasValid: true,
            wasAccepted: true,
            outcome: "success",
            timestamp: new Date().toISOString(),
        };

        pipeline.addTrace(trace);
        const directory = await mkdtemp(path.join(os.tmpdir(), "ouroboros-provider-security-"));
        const outputPath = path.join(directory, "dataset.jsonl");
        await pipeline.export(outputPath);
        const serialized = await readFile(outputPath, "utf8");

        expect(serialized).not.toContain(SYNTHETIC_SECRET);
        expect(serialized).toContain("[REDACTED]");
    });
});
