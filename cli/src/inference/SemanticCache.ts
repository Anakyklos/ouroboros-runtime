/**
 * 💾 SemanticCache
 *
 * Cache semântico: detecta tarefas semelhantes a resolvidas anteriormente.
 * Reutiliza contexto, plano ou solução quando similaridade é suficiente.
 * Registra reuso bem-sucedido.
 */

import { EmbeddingEngine } from "./EmbeddingEngine.js";
import type { SemanticCacheHit } from "./schemas/inference-schemas.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// Types
// ============================================================================

interface CacheEntry {
    query: string;
    embedding: number[];
    result: string;
    createdAt: number;
    reuseCount: number;
}

export interface SemanticCacheConfig {
    /** Similaridade mínima para considerar cache hit */
    similarityThreshold: number;
    /** Máximo de entradas no cache */
    maxEntries: number;
    /** TTL em segundos (0 = sem TTL) */
    ttlSeconds: number;
}

const DEFAULT_CACHE_CONFIG: SemanticCacheConfig = {
    similarityThreshold: 0.85,
    maxEntries: 500,
    ttlSeconds: 3600 * 24, // 24 horas
};

// ============================================================================
// SemanticCache
// ============================================================================

export class SemanticCache {
    private entries: CacheEntry[] = [];
    private embeddingEngine: EmbeddingEngine;
    private config: SemanticCacheConfig;
    private eventBus: EventBus;
    private hitCount = 0;
    private missCount = 0;

    constructor(
        embeddingEngine: EmbeddingEngine,
        config?: Partial<SemanticCacheConfig>,
        eventBus?: EventBus,
    ) {
        this.embeddingEngine = embeddingEngine;
        this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
    }

    /**
     * Busca no cache por query semanticamente similar.
     * Retorna SemanticCacheHit ou null.
     */
    async lookup(query: string): Promise<SemanticCacheHit | null> {
        const queryEmb = await this.embeddingEngine.embed(query);
        if (queryEmb.length === 0) {
            this.missCount++;
            return null;
        }

        // Purge expired entries
        this.purgeExpired();

        let bestMatch: CacheEntry | null = null;
        let bestSimilarity = 0;

        for (const entry of this.entries) {
            const sim = EmbeddingEngine.cosineSimilarity(queryEmb, entry.embedding);
            if (sim > bestSimilarity && sim >= this.config.similarityThreshold) {
                bestSimilarity = sim;
                bestMatch = entry;
            }
        }

        if (!bestMatch) {
            this.missCount++;
            this.log("debug", `Cache miss for: "${query.slice(0, 60)}..."`);
            return null;
        }

        // Record reuse
        bestMatch.reuseCount++;
        this.hitCount++;

        const age = Math.floor((Date.now() - bestMatch.createdAt) / 1000);
        this.log("info", `Cache hit (sim=${bestSimilarity.toFixed(3)}, reuse=${bestMatch.reuseCount}): "${query.slice(0, 60)}..."`);

        return {
            originalQuery: bestMatch.query,
            cachedResult: bestMatch.result,
            similarity: Math.round(bestSimilarity * 1000) / 1000,
            age,
            reuseCount: bestMatch.reuseCount,
            isValid: true,
        };
    }

    /**
     * Armazena uma query e seu resultado no cache.
     */
    async store(query: string, result: string): Promise<void> {
        const embedding = await this.embeddingEngine.embed(query);
        if (embedding.length === 0) {
            this.log("warn", "Failed to embed query for cache storage");
            return;
        }

        // Check capacity
        if (this.entries.length >= this.config.maxEntries) {
            this.evictLeastUsed();
        }

        this.entries.push({
            query,
            embedding,
            result,
            createdAt: Date.now(),
            reuseCount: 0,
        });

        this.log("debug", `Stored in cache: "${query.slice(0, 60)}..."`);
    }

    /**
     * Retorna estatísticas do cache.
     */
    getStats(): {
        size: number;
        hitCount: number;
        missCount: number;
        hitRate: number;
    } {
        const total = this.hitCount + this.missCount;
        return {
            size: this.entries.length,
            hitCount: this.hitCount,
            missCount: this.missCount,
            hitRate: total > 0 ? this.hitCount / total : 0,
        };
    }

    /**
     * Limpa o cache.
     */
    clear(): void {
        this.entries = [];
        this.hitCount = 0;
        this.missCount = 0;
    }

    // ========================================================================
    // Private
    // ========================================================================

    private purgeExpired(): void {
        if (this.config.ttlSeconds === 0) return;

        const now = Date.now();
        const ttlMs = this.config.ttlSeconds * 1000;
        this.entries = this.entries.filter(e => now - e.createdAt < ttlMs);
    }

    private evictLeastUsed(): void {
        if (this.entries.length === 0) return;

        // Evict entry with lowest reuse count (then oldest)
        let minIdx = 0;
        let minScore = Infinity;

        for (let i = 0; i < this.entries.length; i++) {
            const score = this.entries[i].reuseCount * 1_000_000 + this.entries[i].createdAt;
            if (score < minScore) {
                minScore = score;
                minIdx = i;
            }
        }

        this.entries.splice(minIdx, 1);
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[SemanticCache] ${message}`, "SemanticCache");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createSemanticCache(
    embeddingEngine: EmbeddingEngine,
    config?: Partial<SemanticCacheConfig>,
    eventBus?: EventBus,
): SemanticCache {
    return new SemanticCache(embeddingEngine, config, eventBus);
}
