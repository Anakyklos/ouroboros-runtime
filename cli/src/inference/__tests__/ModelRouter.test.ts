/**
 * 🧪 ModelRouter Tests
 *
 * Testa roteamento determinístico entre os três modelos,
 * circuit breaker, fallback, e histórico de roteamento.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { ModelRouter } from "../ModelRouter.js";
import { ModelRegistry } from "../ModelRegistry.js";
import { LocalInferenceProvider } from "../LocalInferenceProvider.js";
import type { ModelConfig, RoutingRequest } from "../types/inference-types.js";

// ============================================================================
// Mock Setup
// ============================================================================

function createTestRegistry(): { registry: ModelRegistry; provider: LocalInferenceProvider } {
    const provider = new LocalInferenceProvider({
        ollamaBaseUrl: "http://localhost:99999", // unreachable
        collectMetrics: false,
        logRequests: false,
    });

    const models: ModelConfig[] = [
        {
            id: "policy",
            name: "Test Policy",
            role: "policy",
            capabilities: ["action_selection", "tool_routing"],
            ollamaModel: "test-policy",
            maxTokens: 256,
            defaultTemperature: 0.1,
            enabled: true,
        },
        {
            id: "coder",
            name: "Test Coder",
            role: "coder",
            capabilities: ["patch_generation", "code_edit"],
            ollamaModel: "test-coder",
            maxTokens: 512,
            defaultTemperature: 0.2,
            enabled: true,
        },
        {
            id: "embedding",
            name: "Test Embedding",
            role: "embedding",
            capabilities: ["embedding_generation", "semantic_search"],
            ollamaModel: "test-embedding",
            maxTokens: 0,
            defaultTemperature: 0,
            enabled: true,
            embeddingDimension: 384,
        },
    ];

    const registry = new ModelRegistry(provider, undefined, models);
    return { registry, provider };
}

// ============================================================================
// Tests
// ============================================================================

describe("ModelRouter", () => {
    let router: ModelRouter;
    let registry: ModelRegistry;

    beforeEach(() => {
        const setup = createTestRegistry();
        registry = setup.registry;
        router = new ModelRouter(registry);
    });

    describe("Routing rules", () => {
        test("routes tool_selection to policy model", () => {
            const decision = router.route({ taskType: "tool_selection" });
            expect(decision.modelId).toBe("policy");
            expect(decision.role).toBe("policy");
        });

        test("routes action_planning to policy model", () => {
            const decision = router.route({ taskType: "action_planning" });
            expect(decision.modelId).toBe("policy");
        });

        test("routes intent_classification to policy model", () => {
            const decision = router.route({ taskType: "intent_classification" });
            expect(decision.modelId).toBe("policy");
        });

        test("routes state_summary to policy model", () => {
            const decision = router.route({ taskType: "state_summary" });
            expect(decision.modelId).toBe("policy");
        });

        test("routes patch_generation to coder model", () => {
            const decision = router.route({ taskType: "patch_generation" });
            expect(decision.modelId).toBe("coder");
            expect(decision.role).toBe("coder");
        });

        test("routes code_edit to coder model", () => {
            const decision = router.route({ taskType: "code_edit" });
            expect(decision.modelId).toBe("coder");
        });

        test("routes test_fix to coder model", () => {
            const decision = router.route({ taskType: "test_fix" });
            expect(decision.modelId).toBe("coder");
        });

        test("routes embedding to embedding model", () => {
            const decision = router.route({ taskType: "embedding" });
            expect(decision.modelId).toBe("embedding");
            expect(decision.role).toBe("embedding");
        });

        test("routes retrieval to embedding model", () => {
            const decision = router.route({ taskType: "retrieval" });
            expect(decision.modelId).toBe("embedding");
        });

        test("routes clustering to embedding model", () => {
            const decision = router.route({ taskType: "clustering" });
            expect(decision.modelId).toBe("embedding");
        });
    });

    describe("Routing decision records justification", () => {
        test("includes reasoning in every decision", () => {
            const decision = router.route({ taskType: "tool_selection" });
            expect(decision.reasoning).toBeTruthy();
            expect(decision.reasoning.length).toBeGreaterThan(0);
        });

        test("includes timestamp in every decision", () => {
            const decision = router.route({ taskType: "tool_selection" });
            expect(decision.timestamp).toBeTruthy();
        });
    });

    describe("Circuit breaker", () => {
        test("falls back after 3 consecutive failures", () => {
            router.recordFailure("policy");
            router.recordFailure("policy");
            router.recordFailure("policy");

            const decision = router.route({ taskType: "tool_selection" });
            // Should fallback to coder since policy has 3 failures
            expect(decision.modelId).toBe("coder");
            expect(decision.fallbackModelId).toBe("policy");
        });

        test("resets failure count on success", () => {
            router.recordFailure("policy");
            router.recordFailure("policy");
            router.recordFailure("policy");
            router.recordSuccess("policy");

            const decision = router.route({ taskType: "tool_selection" });
            expect(decision.modelId).toBe("policy");
        });

        test("no fallback for embedding model", () => {
            router.recordFailure("embedding");
            router.recordFailure("embedding");
            router.recordFailure("embedding");

            const decision = router.route({ taskType: "embedding" });
            // Should still try embedding — no fallback chain for embedding
            expect(decision.modelId).toBe("embedding");
        });
    });

    describe("Routing history", () => {
        test("records routing decisions", () => {
            router.route({ taskType: "tool_selection" });
            router.route({ taskType: "code_edit" });
            router.route({ taskType: "embedding" });

            const history = router.getRoutingHistory();
            expect(history.length).toBe(3);
        });

        test("can be cleared", () => {
            router.route({ taskType: "tool_selection" });
            router.clearHistory();
            expect(router.getRoutingHistory().length).toBe(0);
        });
    });

    describe("Routing table", () => {
        test("returns full task-to-model mapping", () => {
            const table = router.getRoutingTable();
            expect(table.tool_selection).toBe("policy");
            expect(table.patch_generation).toBe("coder");
            expect(table.embedding).toBe("embedding");
        });
    });

    describe("Missing model fallback", () => {
        test("falls back when role has no model registered", () => {
            // Remove policy model
            registry.unregister("policy");

            const decision = router.route({ taskType: "tool_selection" });
            // Should fallback to coder
            expect(decision.modelId).toBe("coder");
            expect(decision.reasoning).toContain("falling back");
        });

        test("returns none when no model or fallback available", () => {
            registry.unregister("policy");
            registry.unregister("coder");

            const decision = router.route({ taskType: "tool_selection" });
            expect(decision.modelId).toBe("none");
            expect(decision.reasoning).toContain("no fallback");
        });
    });
});
