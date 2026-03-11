/**
 * 🔍 SemanticRetriever
 *
 * Busca semântica sobre embeddings indexados.
 * Integra com MemoryIndexer e aplica RetrievalPolicy.
 * Log de confiança, origem e motivo em cada retrieval.
 */

import { EmbeddingEngine } from "./EmbeddingEngine.js";
import { MemoryIndexer } from "./MemoryIndexer.js";
import { RetrievalPolicy } from "./RetrievalPolicy.js";
import {
    RetrievalRequestSchema,
    type RetrievalRequest,
    type RetrievalResult,
} from "./schemas/inference-schemas.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// SemanticRetriever
// ============================================================================

export class SemanticRetriever {
    private embeddingEngine: EmbeddingEngine;
    private indexer: MemoryIndexer;
    private policy: RetrievalPolicy;
    private eventBus: EventBus;

    constructor(
        embeddingEngine: EmbeddingEngine,
        indexer: MemoryIndexer,
        policy: RetrievalPolicy,
        eventBus?: EventBus,
    ) {
        this.embeddingEngine = embeddingEngine;
        this.indexer = indexer;
        this.policy = policy;
        this.eventBus = eventBus ?? globalEventBus;
    }

    /**
     * Recupera contexto semanticamente relevante.
     * Aplica política de retrieval antes de buscar.
     */
    async retrieve(request: RetrievalRequest): Promise<RetrievalResult[]> {
        // Validate request
        const validated = RetrievalRequestSchema.parse(request);

        // Check policy
        const policyCheck = this.policy.shouldRetrieve({
            query: validated.query,
            source: validated.source,
        });

        if (!policyCheck.allowed) {
            this.log("debug", `Retrieval blocked by policy: ${policyCheck.reason}`);
            return [];
        }

        // Generate embedding for query
        const queryEmbedding = await this.embeddingEngine.embed(validated.query);
        if (queryEmbedding.length === 0) {
            this.log("warn", "Failed to generate embedding for query");
            return [];
        }

        // Search in index
        const topK = Math.min(validated.topK, this.policy.getMaxResults());
        const raw = this.indexer.search(queryEmbedding, topK);

        // Filter by source and minimum confidence
        const minSim = validated.minConfidence ?? this.policy.getMinSimilarity();
        const results: RetrievalResult[] = [];

        for (const entry of raw) {
            if (entry.similarity < minSim) continue;

            // Source filter
            if (validated.source !== "all") {
                const sourceMap: Record<string, string[]> = {
                    memory: ["task_summary", "decision", "solution", "failure", "correction"],
                    codebase: ["code_snippet", "document"],
                    traces: ["trace"],
                };
                const allowed = sourceMap[validated.source];
                if (!allowed || !allowed.includes(entry.artifactType)) {
                    continue;
                }
            }

            results.push({
                content: entry.content,
                similarity: Math.round(entry.similarity * 1000) / 1000,
                source: entry.origin,
                sourceType: this.mapArtifactToSourceType(entry.artifactType),
                metadata: {
                    label: entry.label,
                    tags: entry.tags,
                    version: entry.version,
                },
                timestamp: entry.timestamp,
            });
        }

        this.log("info",
            `Retrieved ${results.length} results for "${validated.query.slice(0, 50)}..." ` +
            `(searched ${raw.length} candidates, min_sim=${minSim})`,
        );

        return results;
    }

    /**
     * Shortcut: recupera contexto em formato de texto para injeção em prompts.
     */
    async getContextString(query: string, topK: number = 3): Promise<string> {
        const results = await this.retrieve({
            query,
            topK,
            source: "all",
            minConfidence: 0.3,
        });

        if (results.length === 0) return "";

        const lines = results.map((r, i) =>
            `[${i + 1}] (sim=${r.similarity}) [${r.sourceType}] ${r.content.slice(0, 300)}`,
        );

        return `--- Semantic Context ---\n${lines.join("\n\n")}\n--- End Context ---`;
    }

    // ========================================================================
    // Private
    // ========================================================================

    private mapArtifactToSourceType(artifactType: string): "memory" | "codebase" | "trace" | "cache" {
        if (["task_summary", "decision", "solution", "failure", "correction"].includes(artifactType)) {
            return "memory";
        }
        if (["code_snippet", "document"].includes(artifactType)) {
            return "codebase";
        }
        if (artifactType === "trace") {
            return "trace";
        }
        return "memory";
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[SemanticRetriever] ${message}`, "SemanticRetriever");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createSemanticRetriever(
    embeddingEngine: EmbeddingEngine,
    indexer: MemoryIndexer,
    policy: RetrievalPolicy,
    eventBus?: EventBus,
): SemanticRetriever {
    return new SemanticRetriever(embeddingEngine, indexer, policy, eventBus);
}
