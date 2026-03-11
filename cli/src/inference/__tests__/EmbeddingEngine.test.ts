/**
 * 🧪 EmbeddingEngine, SemanticCache & RetrievalPolicy Tests
 *
 * Testa embedding, cache semântico, e política de retrieval.
 * Usa vetores sintéticos para evitar dependência de Ollama.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { EmbeddingEngine } from "../EmbeddingEngine.js";
import { SemanticCache } from "../SemanticCache.js";
import { RetrievalPolicy } from "../RetrievalPolicy.js";
import { MemoryIndexer } from "../MemoryIndexer.js";
import { SemanticRetriever } from "../SemanticRetriever.js";
import type { MemoryWriteCandidate } from "../schemas/inference-schemas.js";

// ============================================================================
// Cosine Similarity Tests (pure math, no model needed)
// ============================================================================

describe("EmbeddingEngine.cosineSimilarity", () => {
    test("identical vectors have similarity 1", () => {
        const v = [1, 0, 0, 1];
        expect(EmbeddingEngine.cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    test("orthogonal vectors have similarity 0", () => {
        const a = [1, 0];
        const b = [0, 1];
        expect(EmbeddingEngine.cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
    });

    test("opposite vectors have similarity -1", () => {
        const a = [1, 0];
        const b = [-1, 0];
        expect(EmbeddingEngine.cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
    });

    test("empty vectors return 0", () => {
        expect(EmbeddingEngine.cosineSimilarity([], [])).toBe(0);
    });

    test("mismatched dimensions return 0", () => {
        expect(EmbeddingEngine.cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    test("zero vectors return 0", () => {
        expect(EmbeddingEngine.cosineSimilarity([0, 0], [0, 0])).toBe(0);
    });

    test("similar vectors have high similarity", () => {
        const a = [1, 2, 3, 4];
        const b = [1, 2, 3, 5]; // slightly different
        const sim = EmbeddingEngine.cosineSimilarity(a, b);
        expect(sim).toBeGreaterThan(0.95);
    });
});

// ============================================================================
// RetrievalPolicy Tests
// ============================================================================

describe("RetrievalPolicy", () => {
    let policy: RetrievalPolicy;

    beforeEach(() => {
        policy = new RetrievalPolicy({ logDecisions: false });
    });

    describe("shouldIngest", () => {
        test("accepts valid artifact", () => {
            const candidate: MemoryWriteCandidate = {
                content: "This is a valid task summary with enough content",
                artifactType: "task_summary",
                label: "Test Task",
                origin: "PolicyEngine",
            };
            const result = policy.shouldIngest(candidate);
            expect(result.allowed).toBe(true);
        });

        test("rejects unknown artifact type", () => {
            const candidate: MemoryWriteCandidate = {
                content: "Some content here that is long enough",
                artifactType: "unknown_type" as any,
                label: "Test",
                origin: "Test",
            };
            const result = policy.shouldIngest(candidate);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("not in allowed list");
        });

        test("rejects content too short", () => {
            const candidate: MemoryWriteCandidate = {
                content: "short",
                artifactType: "task_summary",
                label: "Test",
                origin: "Test",
            };
            const result = policy.shouldIngest(candidate);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("too short");
        });

        test("rejects missing label", () => {
            const candidate: MemoryWriteCandidate = {
                content: "Enough content for this test candidate here",
                artifactType: "task_summary",
                label: "",
                origin: "Test",
            };
            const result = policy.shouldIngest(candidate);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("label");
        });

        test("rejects missing origin", () => {
            const candidate: MemoryWriteCandidate = {
                content: "Enough content for this test candidate here",
                artifactType: "task_summary",
                label: "Test",
                origin: "",
            };
            const result = policy.shouldIngest(candidate);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("origin");
        });
    });

    describe("shouldRetrieve", () => {
        test("allows normal query", () => {
            const result = policy.shouldRetrieve({ query: "test query", source: "memory" });
            expect(result.allowed).toBe(true);
        });

        test("rejects empty query", () => {
            const result = policy.shouldRetrieve({ query: "", source: "memory" });
            expect(result.allowed).toBe(false);
        });

        test("rejects very short query", () => {
            const result = policy.shouldRetrieve({ query: "ab", source: "memory" });
            expect(result.allowed).toBe(false);
        });
    });

    describe("decision log", () => {
        test("logs are recorded when enabled", () => {
            const loggingPolicy = new RetrievalPolicy({ logDecisions: true });
            const candidate: MemoryWriteCandidate = {
                content: "Enough content for this test candidate here",
                artifactType: "task_summary",
                label: "Test",
                origin: "Test",
            };
            loggingPolicy.shouldIngest(candidate);
            expect(loggingPolicy.getDecisionLog().length).toBe(1);
        });
    });
});

// ============================================================================
// SemanticCache Tests (with embedding stub)
// ============================================================================

describe("SemanticCache (stats and lifecycle)", () => {
    test("starts empty with zero hit rate", () => {
        // Create a dummy engine — we won't actually call embed
        const fakeProvider = { embed: async () => ({ vector: [], dimension: 0, modelId: "", durationMs: 0, traceId: "" }) } as any;
        const fakeRegistry = { getByRole: () => undefined } as any;
        const engine = new EmbeddingEngine(fakeProvider, fakeRegistry);
        const cache = new SemanticCache(engine, { similarityThreshold: 0.85 });

        const stats = cache.getStats();
        expect(stats.size).toBe(0);
        expect(stats.hitCount).toBe(0);
        expect(stats.missCount).toBe(0);
        expect(stats.hitRate).toBe(0);
    });

    test("clear resets all stats", () => {
        const fakeProvider = { embed: async () => ({ vector: [], dimension: 0, modelId: "", durationMs: 0, traceId: "" }) } as any;
        const fakeRegistry = { getByRole: () => undefined } as any;
        const engine = new EmbeddingEngine(fakeProvider, fakeRegistry);
        const cache = new SemanticCache(engine);

        cache.clear();
        const stats = cache.getStats();
        expect(stats.size).toBe(0);
    });
});

// ============================================================================
// Schema Validation Tests (Zod schemas)
// ============================================================================

describe("Inference Schemas", () => {
    const { ActionDecisionSchema, PatchProposalSchema, MemoryWriteCandidateSchema } = require("../schemas/inference-schemas.js");

    test("ActionDecision validates valid input", () => {
        const result = ActionDecisionSchema.safeParse({
            action: "call_tool",
            reasoning: "Need to read file",
            confidence: 0.9,
            requiresRetrieval: false,
            requiresCodeModel: false,
        });
        expect(result.success).toBe(true);
    });

    test("ActionDecision rejects invalid action", () => {
        const result = ActionDecisionSchema.safeParse({
            action: "invalid_action",
            reasoning: "test",
            confidence: 0.5,
            requiresRetrieval: false,
            requiresCodeModel: false,
        });
        expect(result.success).toBe(false);
    });

    test("ActionDecision rejects confidence out of range", () => {
        const result = ActionDecisionSchema.safeParse({
            action: "complete",
            reasoning: "test",
            confidence: 1.5,
            requiresRetrieval: false,
            requiresCodeModel: false,
        });
        expect(result.success).toBe(false);
    });

    test("PatchProposal validates valid input", () => {
        const result = PatchProposalSchema.safeParse({
            filePath: "test.ts",
            originalSnippet: "const a = 1;",
            patchedSnippet: "const a = 2;",
            explanation: "Changed value",
            changeType: "fix",
            confidence: 0.8,
            affectsTests: false,
        });
        expect(result.success).toBe(true);
    });

    test("MemoryWriteCandidate rejects content too short", () => {
        const result = MemoryWriteCandidateSchema.safeParse({
            content: "too short", // < 10 chars
            artifactType: "task_summary",
            label: "Test",
            origin: "Test",
        });
        expect(result.success).toBe(false);
    });

    test("MemoryWriteCandidate accepts valid artifact", () => {
        const result = MemoryWriteCandidateSchema.safeParse({
            content: "This is a valid task summary with enough content",
            artifactType: "decision",
            label: "Important Decision",
            origin: "PolicyEngine",
            tags: ["important", "decision"],
        });
        expect(result.success).toBe(true);
    });
});
