import { EventBus } from "../../daemon/event-bus.js";
import { ModelProviderError } from "../ModelProvider.js";
import { REDACTED_VALUE, redactText, redactValue } from "../redaction.js";

describe("shared provider redaction", () => {
    test("redacts authorization headers and bearer tokens", () => {
        const message = "Authorization: Bearer sk-test-12345678901234567890 and Bearer ghp_abcdefghijklmnopqrstuvwxyz123456";

        const redacted = redactText(message);

        expect(redacted).not.toContain("sk-test-12345678901234567890");
        expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
        expect(redacted).toContain(`Authorization: ${REDACTED_VALUE}`);
        expect(redacted).toContain(`Bearer ${REDACTED_VALUE}`);
    });

    test("redacts sensitive query parameters and common provider key patterns", () => {
        const message = "https://provider.test/v1?api_key=secret-query&safe=1&access_token=abc123 nvapi-abcdefghijklmnopqrstuvwxyz123456";

        const redacted = redactText(message);

        expect(redacted).not.toContain("secret-query");
        expect(redacted).not.toContain("abc123");
        expect(redacted).not.toContain("nvapi-abcdefghijklmnopqrstuvwxyz123456");
        expect(redacted).toContain("api_key=[REDACTED]");
        expect(redacted).toContain("access_token=[REDACTED]");
    });

    test("redacts nested values, sensitive keys, and provider error causes", () => {
        const value = {
            authorization: "Bearer secret-token",
            nested: { apiKey: "synthetic-api-key" },
            error: new Error("request failed with secret-token"),
        };

        const redacted = JSON.stringify(redactValue(value, ["secret-token", "synthetic-api-key"]));
        const providerError = new ModelProviderError("invalid provider response: secret-token", {
            kind: "provider",
            retryable: false,
            fallbackAllowed: true,
            cause: new Error("cause: secret-token"),
            redactionSecrets: ["secret-token"],
        });

        expect(redacted).not.toContain("secret-token");
        expect(redacted).not.toContain("synthetic-api-key");
        expect(providerError.message).not.toContain("secret-token");
        expect(JSON.stringify(providerError)).not.toContain("secret-token");
    });

    test("redacts log and event payloads at the event boundary", () => {
        const eventBus = new EventBus();
        eventBus.registerRedactionSecret("workspace-secret");
        const received: unknown[] = [];
        eventBus.on("log", event => received.push(event));
        eventBus.on("task", event => received.push(event));

        eventBus.log("error", "workspace-secret");
        eventBus.emit("task", {
            type: "failed",
            sessionId: "session",
            data: { error: "workspace-secret" },
        });

        const serialized = JSON.stringify(received);
        expect(serialized).not.toContain("workspace-secret");
        expect(serialized).toContain(REDACTED_VALUE);
    });
});
