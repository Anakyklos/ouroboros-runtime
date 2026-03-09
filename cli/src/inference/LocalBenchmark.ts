/**
 * 📏 LocalBenchmark
 *
 * Benchmark local mínimo para os três modelos.
 * Mede latência, taxa de JSON válido, taxa de patch aceito,
 * tempo de retrieval e custo de memória.
 */

import { LocalInferenceProvider } from "./LocalInferenceProvider.js";
import { ModelRegistry } from "./ModelRegistry.js";
import { EmbeddingEngine } from "./EmbeddingEngine.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";
import type { InferenceMessage } from "./types/inference-types.js";

// ============================================================================
// Constants
// ============================================================================

/** Timeout para cada chamada individual de benchmark */
const BENCHMARK_TIMEOUT_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

export interface BenchmarkResult {
    modelId: string;
    role: string;
    latencyMs: number;
    isValidJSON: boolean;
    outputLength: number;
    error?: string;
}

export interface BenchmarkReport {
    timestamp: string;
    duration: number;
    results: BenchmarkResult[];
    summary: {
        policyLatencyMs: number;
        coderLatencyMs: number;
        embeddingLatencyMs: number;
        retrievalLatencyMs: number;
        validJSONRate: number;
        modelAvailability: Record<string, boolean>;
        memoryUsageMB: number;
    };
}

// ============================================================================
// Test Prompts
// ============================================================================

const POLICY_TEST_PROMPT: InferenceMessage[] = [
    { role: "system", content: "You are a policy model. Respond with JSON only." },
    {
        role: "user",
        content: `Decide the next action: { "action": "complete", "reasoning": "test", "confidence": 0.9, "requiresRetrieval": false, "requiresCodeModel": false }`,
    },
];

const CODER_TEST_PROMPT: InferenceMessage[] = [
    { role: "system", content: "You are a code editor. Respond with JSON only." },
    {
        role: "user",
        content: `Generate a minimal patch: { "filePath": "test.ts", "originalSnippet": "const a = 1;", "patchedSnippet": "const a = 2;", "explanation": "test change", "changeType": "fix", "confidence": 0.8, "affectsTests": false }`,
    },
];

const EMBEDDING_TEST_TEXT = "This is a benchmark test for semantic embedding generation.";

// ============================================================================
// LocalBenchmark
// ============================================================================

export class LocalBenchmark {
    private provider: LocalInferenceProvider;
    private registry: ModelRegistry;
    private embeddingEngine: EmbeddingEngine;
    private eventBus: EventBus;

    constructor(
        provider: LocalInferenceProvider,
        registry: ModelRegistry,
        embeddingEngine: EmbeddingEngine,
        eventBus?: EventBus,
    ) {
        this.provider = provider;
        this.registry = registry;
        this.embeddingEngine = embeddingEngine;
        this.eventBus = eventBus ?? globalEventBus;
    }

    /**
     * Executa benchmark completo dos três modelos.
     */
    async run(): Promise<BenchmarkReport> {
        const startTime = Date.now();
        this.log("info", "Starting local benchmark...");

        const results: BenchmarkResult[] = [];

        // 1. Policy model benchmark
        const policyResult = await this.benchmarkChat("policy", POLICY_TEST_PROMPT);
        results.push(policyResult);

        // 2. Coder model benchmark
        const coderResult = await this.benchmarkChat("coder", CODER_TEST_PROMPT);
        results.push(coderResult);

        // 3. Embedding model benchmark
        const embResult = await this.benchmarkEmbedding();
        results.push(embResult);

        // 4. Retrieval benchmark (embedding + similarity)
        const retrievalResult = await this.benchmarkRetrieval();
        results.push(retrievalResult);

        // 5. Check model availability
        const availability = await this.registry.checkAllAvailability();

        // 6. Memory usage
        const memUsage = process.memoryUsage();
        const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);

        const duration = Date.now() - startTime;

        const report: BenchmarkReport = {
            timestamp: new Date().toISOString(),
            duration,
            results,
            summary: {
                policyLatencyMs: policyResult.latencyMs,
                coderLatencyMs: coderResult.latencyMs,
                embeddingLatencyMs: embResult.latencyMs,
                retrievalLatencyMs: retrievalResult.latencyMs,
                validJSONRate: results.filter(r => r.isValidJSON).length / Math.max(results.filter(r => r.role !== "embedding").length, 1),
                modelAvailability: Object.fromEntries(availability),
                memoryUsageMB: memMB,
            },
        };

        this.log("info", `Benchmark complete in ${duration}ms`);
        this.log("info", `Policy: ${policyResult.latencyMs}ms | Coder: ${coderResult.latencyMs}ms | Embedding: ${embResult.latencyMs}ms`);
        this.log("info", `Memory: ${memMB}MB | Valid JSON: ${Math.round(report.summary.validJSONRate * 100)}%`);

        return report;
    }

    /**
     * Formata relatório como texto legível.
     */
    static formatReport(report: BenchmarkReport): string {
        const lines = [
            "=== Local Inference Benchmark ===",
            `Timestamp: ${report.timestamp}`,
            `Duration: ${report.duration}ms`,
            "",
            "--- Latency ---",
            `Policy Model:    ${report.summary.policyLatencyMs}ms`,
            `Coder Model:     ${report.summary.coderLatencyMs}ms`,
            `Embedding Model: ${report.summary.embeddingLatencyMs}ms`,
            `Retrieval:       ${report.summary.retrievalLatencyMs}ms`,
            "",
            "--- Quality ---",
            `Valid JSON Rate: ${Math.round(report.summary.validJSONRate * 100)}%`,
            `Memory Usage:    ${report.summary.memoryUsageMB}MB`,
            "",
            "--- Availability ---",
        ];

        for (const [model, available] of Object.entries(report.summary.modelAvailability)) {
            lines.push(`${available ? "✅" : "❌"} ${model}`);
        }

        if (report.results.some(r => r.error)) {
            lines.push("", "--- Errors ---");
            for (const r of report.results) {
                if (r.error) lines.push(`${r.modelId}: ${r.error}`);
            }
        }

        return lines.join("\n");
    }

    // ========================================================================
    // Private
    // ========================================================================

    private async benchmarkChat(role: "policy" | "coder", messages: InferenceMessage[]): Promise<BenchmarkResult> {
        const model = this.registry.getByRole(role);
        if (!model) {
            return {
                modelId: role,
                role,
                latencyMs: 0,
                isValidJSON: false,
                outputLength: 0,
                error: `No ${role} model registered`,
            };
        }

        const start = Date.now();
        try {
            const response = await this.provider.chat({
                modelId: model.ollamaModel,
                messages,
                temperature: 0.1,
                maxTokens: 256,
                responseSchema: {},
                traceId: `bench_${role}_${Date.now()}`,
                timeoutMs: BENCHMARK_TIMEOUT_MS,
            });

            return {
                modelId: model.ollamaModel,
                role,
                latencyMs: Date.now() - start,
                isValidJSON: response.isValidJSON,
                outputLength: response.content.length,
            };
        } catch (error) {
            return {
                modelId: model.ollamaModel,
                role,
                latencyMs: Date.now() - start,
                isValidJSON: false,
                outputLength: 0,
                error: (error as Error).message,
            };
        }
    }

    private async benchmarkEmbedding(): Promise<BenchmarkResult> {
        const model = this.registry.getByRole("embedding");
        if (!model) {
            return {
                modelId: "embedding",
                role: "embedding",
                latencyMs: 0,
                isValidJSON: true,
                outputLength: 0,
                error: "No embedding model registered",
            };
        }

        const start = Date.now();
        try {
            const vector = await this.embeddingEngine.embed(EMBEDDING_TEST_TEXT);
            return {
                modelId: model.ollamaModel,
                role: "embedding",
                latencyMs: Date.now() - start,
                isValidJSON: true,
                outputLength: vector.length,
                error: vector.length === 0 ? "Empty embedding returned" : undefined,
            };
        } catch (error) {
            return {
                modelId: model.ollamaModel,
                role: "embedding",
                latencyMs: Date.now() - start,
                isValidJSON: false,
                outputLength: 0,
                error: (error as Error).message,
            };
        }
    }

    private async benchmarkRetrieval(): Promise<BenchmarkResult> {
        const start = Date.now();
        try {
            const v1 = await this.embeddingEngine.embed("test query for retrieval");
            const v2 = await this.embeddingEngine.embed("similar test for searching");

            if (v1.length > 0 && v2.length > 0) {
                const sim = EmbeddingEngine.cosineSimilarity(v1, v2);
                return {
                    modelId: "retrieval",
                    role: "retrieval",
                    latencyMs: Date.now() - start,
                    isValidJSON: true,
                    outputLength: v1.length,
                };
            }

            return {
                modelId: "retrieval",
                role: "retrieval",
                latencyMs: Date.now() - start,
                isValidJSON: true,
                outputLength: 0,
                error: "Empty embeddings",
            };
        } catch (error) {
            return {
                modelId: "retrieval",
                role: "retrieval",
                latencyMs: Date.now() - start,
                isValidJSON: false,
                outputLength: 0,
                error: (error as Error).message,
            };
        }
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[Benchmark] ${message}`, "LocalBenchmark");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createLocalBenchmark(
    provider: LocalInferenceProvider,
    registry: ModelRegistry,
    embeddingEngine: EmbeddingEngine,
    eventBus?: EventBus,
): LocalBenchmark {
    return new LocalBenchmark(provider, registry, embeddingEngine, eventBus);
}
