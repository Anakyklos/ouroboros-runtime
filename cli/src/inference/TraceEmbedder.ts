/**
 * 📊 TraceEmbedder
 *
 * Gera embeddings de traces de execução para análise de padrões.
 * Clusteriza falhas semelhantes e detecta padrões recorrentes.
 */

import { EmbeddingEngine } from "./EmbeddingEngine.js";
import type { InferenceTrace } from "./schemas/inference-schemas.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// Types
// ============================================================================

interface EmbeddedTrace {
    traceId: string;
    embedding: number[];
    summary: string;
    outcome: string;
    timestamp: string;
}

export interface TraceCluster {
    centroidIndex: number;
    members: string[];
    pattern: string;
    averageSimilarity: number;
}

// ============================================================================
// TraceEmbedder
// ============================================================================

export class TraceEmbedder {
    private embeddedTraces: EmbeddedTrace[] = [];
    private embeddingEngine: EmbeddingEngine;
    private eventBus: EventBus;

    constructor(embeddingEngine: EmbeddingEngine, eventBus?: EventBus) {
        this.embeddingEngine = embeddingEngine;
        this.eventBus = eventBus ?? globalEventBus;
    }

    /**
     * Gera embedding de um trace de inferência.
     */
    async embedTrace(trace: InferenceTrace): Promise<number[]> {
        // Create a compact text representation of the trace
        const summary = this.traceToText(trace);
        const embedding = await this.embeddingEngine.embed(summary);

        if (embedding.length > 0) {
            this.embeddedTraces.push({
                traceId: trace.traceId,
                embedding,
                summary,
                outcome: trace.outcome ?? "unknown",
                timestamp: trace.timestamp,
            });
        }

        return embedding;
    }

    /**
     * Encontra traces mais similares a um dado trace.
     */
    async findSimilarTraces(trace: InferenceTrace, topK: number = 5): Promise<Array<{ traceId: string; similarity: number; outcome: string }>> {
        const queryEmbedding = await this.embeddingEngine.embed(this.traceToText(trace));
        if (queryEmbedding.length === 0) return [];

        const scored = this.embeddedTraces
            .map(et => ({
                traceId: et.traceId,
                similarity: EmbeddingEngine.cosineSimilarity(queryEmbedding, et.embedding),
                outcome: et.outcome,
            }))
            .filter(s => s.traceId !== trace.traceId)
            .sort((a, b) => b.similarity - a.similarity);

        return scored.slice(0, topK);
    }

    /**
     * Clusteriza traces por similaridade (greedy clustering).
     * Simples e eficiente para CPU — não tenta ser k-means.
     */
    clusterTraces(similarityThreshold: number = 0.75): TraceCluster[] {
        if (this.embeddedTraces.length === 0) return [];

        const assigned = new Set<number>();
        const clusters: TraceCluster[] = [];

        for (let i = 0; i < this.embeddedTraces.length; i++) {
            if (assigned.has(i)) continue;

            const cluster: TraceCluster = {
                centroidIndex: i,
                members: [this.embeddedTraces[i].traceId],
                pattern: this.embeddedTraces[i].summary.slice(0, 100),
                averageSimilarity: 1.0,
            };

            let totalSim = 0;
            let simCount = 0;

            for (let j = i + 1; j < this.embeddedTraces.length; j++) {
                if (assigned.has(j)) continue;

                const sim = EmbeddingEngine.cosineSimilarity(
                    this.embeddedTraces[i].embedding,
                    this.embeddedTraces[j].embedding,
                );

                if (sim >= similarityThreshold) {
                    cluster.members.push(this.embeddedTraces[j].traceId);
                    assigned.add(j);
                    totalSim += sim;
                    simCount++;
                }
            }

            cluster.averageSimilarity = simCount > 0
                ? Math.round((totalSim / simCount) * 1000) / 1000
                : 1.0;

            assigned.add(i);
            clusters.push(cluster);
        }

        this.log("info", `Clustered ${this.embeddedTraces.length} traces into ${clusters.length} clusters`);
        return clusters;
    }

    /**
     * Retorna contagem de traces embutidos.
     */
    getTraceCount(): number {
        return this.embeddedTraces.length;
    }

    /**
     * Limpa traces armazenados.
     */
    clear(): void {
        this.embeddedTraces = [];
    }

    // ========================================================================
    // Private
    // ========================================================================

    private traceToText(trace: InferenceTrace): string {
        return [
            `model=${trace.modelId}`,
            `role=${trace.modelRole}`,
            `valid=${trace.wasValid}`,
            `outcome=${trace.outcome ?? "unknown"}`,
            `input=${trace.input.slice(0, 200)}`,
            `output=${trace.output.slice(0, 200)}`,
        ].join(" | ");
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[TraceEmbedder] ${message}`, "TraceEmbedder");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createTraceEmbedder(
    embeddingEngine: EmbeddingEngine,
    eventBus?: EventBus,
): TraceEmbedder {
    return new TraceEmbedder(embeddingEngine, eventBus);
}
