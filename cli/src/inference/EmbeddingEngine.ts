/**
 * 💎 EmbeddingEngine
 *
 * Embedding local via EmbeddingGemma (Ollama).
 * Substitui GeminiEmbeddingClient para uso local sem API paga.
 * Gera embeddings, calcula similaridade, suporta batch.
 */

import { LocalInferenceProvider } from "./LocalInferenceProvider.js";
import { ModelRegistry } from "./ModelRegistry.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// EmbeddingEngine
// ============================================================================

export class EmbeddingEngine {
    private provider: LocalInferenceProvider;
    private registry: ModelRegistry;
    private eventBus: EventBus;

    constructor(
        provider: LocalInferenceProvider,
        registry: ModelRegistry,
        eventBus?: EventBus,
    ) {
        this.provider = provider;
        this.registry = registry;
        this.eventBus = eventBus ?? globalEventBus;
    }

    /**
     * Gera embedding para um texto.
     * Retorna vetor numérico ou vetor vazio em caso de falha.
     */
    async embed(text: string): Promise<number[]> {
        const model = this.registry.getByRole("embedding");
        if (!model) {
            this.log("warn", "No embedding model registered");
            return [];
        }

        const response = await this.provider.embed({
            text,
            modelId: model.ollamaModel,
            traceId: `emb_${Date.now()}`,
        });

        return response.vector;
    }

    /**
     * Gera embeddings em batch.
     * Processa sequencialmente para evitar sobrecarga em CPU.
     */
    async embedBatch(texts: string[]): Promise<number[][]> {
        const results: number[][] = [];

        for (const text of texts) {
            const vector = await this.embed(text);
            results.push(vector);
        }

        return results;
    }

    /**
     * Calcula similaridade cosseno entre dois vetores.
     */
    static cosineSimilarity(a: number[], b: number[]): number {
        if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

        let dotProduct = 0;
        let magnitudeA = 0;
        let magnitudeB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            magnitudeA += a[i] * a[i];
            magnitudeB += b[i] * b[i];
        }

        magnitudeA = Math.sqrt(magnitudeA);
        magnitudeB = Math.sqrt(magnitudeB);

        if (magnitudeA === 0 || magnitudeB === 0) return 0;

        return dotProduct / (magnitudeA * magnitudeB);
    }

    /**
     * Encontra os textos mais similares a uma query dentro de um corpus.
     */
    async findMostSimilar(
        query: string,
        corpus: Array<{ id: string; text: string; embedding?: number[] }>,
        topK: number = 5,
    ): Promise<Array<{ id: string; similarity: number }>> {
        const queryEmbedding = await this.embed(query);
        if (queryEmbedding.length === 0) return [];

        const scored: Array<{ id: string; similarity: number }> = [];

        for (const item of corpus) {
            const itemEmbedding = item.embedding ?? await this.embed(item.text);
            if (itemEmbedding.length === 0) continue;

            const similarity = EmbeddingEngine.cosineSimilarity(queryEmbedding, itemEmbedding);
            scored.push({ id: item.id, similarity });
        }

        scored.sort((a, b) => b.similarity - a.similarity);
        return scored.slice(0, topK);
    }

    /**
     * Retorna a dimensão do embedding do modelo registrado.
     */
    getDimension(): number {
        const model = this.registry.getByRole("embedding");
        return model?.embeddingDimension ?? 384;
    }

    /**
     * Verifica se o engine está disponível.
     */
    async isAvailable(): Promise<boolean> {
        const model = this.registry.getByRole("embedding");
        if (!model) return false;
        return this.provider.isModelAvailable(model.ollamaModel);
    }

    // ========================================================================
    // Private
    // ========================================================================

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[EmbeddingEngine] ${message}`, "EmbeddingEngine");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createEmbeddingEngine(
    provider: LocalInferenceProvider,
    registry: ModelRegistry,
    eventBus?: EventBus,
): EmbeddingEngine {
    return new EmbeddingEngine(provider, registry, eventBus);
}
