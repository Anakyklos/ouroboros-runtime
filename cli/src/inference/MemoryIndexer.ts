/**
 * 📇 MemoryIndexer
 *
 * Indexa artefatos em memória semântica com política de ingestão explícita.
 * Persiste em JSONL para portabilidade. Versionamento por hash de conteúdo.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { EmbeddingEngine } from "./EmbeddingEngine.js";
import { RetrievalPolicy } from "./RetrievalPolicy.js";
import {
    MemoryWriteCandidateSchema,
    type MemoryWriteCandidate,
} from "./schemas/inference-schemas.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// Types
// ============================================================================

export interface IndexedEntry {
    id: string;
    content: string;
    embedding: number[];
    artifactType: string;
    label: string;
    origin: string;
    tags: string[];
    contentHash: string;
    timestamp: string;
    ttlHours?: number;
    version: number;
}

export interface MemoryIndexerConfig {
    /** Diretório para persistir o índice */
    storageDir: string;
    /** Tamanho máximo de chunk para ingestão */
    maxChunkSize: number;
    /** Overlap entre chunks */
    chunkOverlap: number;
    /** Máximo de entradas em memória */
    maxEntries: number;
}

const DEFAULT_INDEXER_CONFIG: MemoryIndexerConfig = {
    storageDir: ".agent/semantic-memory",
    maxChunkSize: 1000,
    chunkOverlap: 100,
    maxEntries: 10000,
};

// ============================================================================
// MemoryIndexer
// ============================================================================

export class MemoryIndexer {
    private entries: Map<string, IndexedEntry> = new Map();
    private embeddingEngine: EmbeddingEngine;
    private policy: RetrievalPolicy;
    private config: MemoryIndexerConfig;
    private eventBus: EventBus;
    private dirty = false;

    constructor(
        embeddingEngine: EmbeddingEngine,
        policy: RetrievalPolicy,
        config?: Partial<MemoryIndexerConfig>,
        eventBus?: EventBus,
    ) {
        this.embeddingEngine = embeddingEngine;
        this.policy = policy;
        this.config = { ...DEFAULT_INDEXER_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
    }

    /**
     * Inicializa o indexer, carregando dados persistidos.
     */
    async initialize(projectRoot: string = process.cwd()): Promise<void> {
        const storePath = path.join(projectRoot, this.config.storageDir);
        if (!fs.existsSync(storePath)) {
            fs.mkdirSync(storePath, { recursive: true });
        }

        const indexFile = path.join(storePath, "index.jsonl");
        if (fs.existsSync(indexFile)) {
            const lines = fs.readFileSync(indexFile, "utf-8").split("\n").filter(Boolean);
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line) as IndexedEntry;
                    // Check TTL
                    if (this.isExpired(entry)) continue;
                    this.entries.set(entry.id, entry);
                } catch {
                    this.log("warn", `Skipping corrupt index entry`);
                }
            }
            this.log("info", `Loaded ${this.entries.size} entries from disk`);
        }
    }

    /**
     * Ingere um artefato na memória semântica.
     * Aplica política de ingestão antes de indexar.
     */
    async ingest(candidate: MemoryWriteCandidate): Promise<{ indexed: boolean; reason: string }> {
        // Validate candidate
        try {
            MemoryWriteCandidateSchema.parse(candidate);
        } catch (error) {
            return { indexed: false, reason: `Invalid candidate: ${(error as Error).message}` };
        }

        // Apply ingestion policy
        const policyResult = this.policy.shouldIngest(candidate);
        if (!policyResult.allowed) {
            this.log("debug", `Ingestion rejected: ${policyResult.reason}`);
            return { indexed: false, reason: policyResult.reason };
        }

        // Check for duplicate content (by hash)
        const contentHash = this.hashContent(candidate.content);
        const existing = this.findByHash(contentHash);
        if (existing) {
            this.log("debug", `Duplicate content, updating version for: ${candidate.label}`);
            existing.version++;
            existing.timestamp = new Date().toISOString();
            this.dirty = true;
            return { indexed: true, reason: "Content updated (version incremented)" };
        }

        // Check capacity
        if (this.entries.size >= this.config.maxEntries) {
            this.evictOldest();
        }

        // Generate embedding
        const chunks = this.chunk(candidate.content);
        for (let i = 0; i < chunks.length; i++) {
            const embedding = await this.embeddingEngine.embed(chunks[i]);
            if (embedding.length === 0) {
                this.log("warn", `Failed to embed chunk ${i} of: ${candidate.label}`);
                continue;
            }

            const id = `${contentHash}_${i}`;
            const entry: IndexedEntry = {
                id,
                content: chunks[i],
                embedding,
                artifactType: candidate.artifactType,
                label: candidate.label,
                origin: candidate.origin,
                tags: candidate.tags ?? [],
                contentHash,
                timestamp: new Date().toISOString(),
                ttlHours: candidate.ttlHours,
                version: 1,
            };

            this.entries.set(id, entry);
        }

        this.dirty = true;
        this.log("info", `Indexed "${candidate.label}" (${chunks.length} chunks)`);
        return { indexed: true, reason: `Indexed ${chunks.length} chunk(s)` };
    }

    /**
     * Busca entradas mais similares a uma query.
     */
    search(queryEmbedding: number[], topK: number = 5): Array<IndexedEntry & { similarity: number }> {
        if (queryEmbedding.length === 0) return [];

        const scored: Array<IndexedEntry & { similarity: number }> = [];

        for (const entry of this.entries.values()) {
            if (this.isExpired(entry)) continue;
            if (entry.embedding.length === 0) continue;

            const similarity = EmbeddingEngine.cosineSimilarity(queryEmbedding, entry.embedding);
            scored.push({ ...entry, similarity });
        }

        scored.sort((a, b) => b.similarity - a.similarity);
        return scored.slice(0, topK);
    }

    /**
     * Persiste o índice em disco (JSONL).
     */
    async persist(projectRoot: string = process.cwd()): Promise<void> {
        if (!this.dirty) return;

        const storePath = path.join(projectRoot, this.config.storageDir);
        if (!fs.existsSync(storePath)) {
            fs.mkdirSync(storePath, { recursive: true });
        }

        const indexFile = path.join(storePath, "index.jsonl");
        const lines: string[] = [];
        for (const entry of this.entries.values()) {
            if (!this.isExpired(entry)) {
                lines.push(JSON.stringify(entry));
            }
        }

        await fs.promises.writeFile(indexFile, lines.join("\n") + "\n", "utf-8");
        this.dirty = false;
        this.log("info", `Persisted ${lines.length} entries to ${indexFile}`);
    }

    /**
     * Retorna estatísticas do índice.
     */
    getStats(): { totalEntries: number; byType: Record<string, number>; dirty: boolean } {
        const byType: Record<string, number> = {};
        for (const entry of this.entries.values()) {
            byType[entry.artifactType] = (byType[entry.artifactType] ?? 0) + 1;
        }
        return { totalEntries: this.entries.size, byType, dirty: this.dirty };
    }

    /**
     * Retorna todas as entradas (para testes/debug).
     */
    getAllEntries(): IndexedEntry[] {
        return Array.from(this.entries.values());
    }

    // ========================================================================
    // Private
    // ========================================================================

    private chunk(text: string): string[] {
        if (text.length <= this.config.maxChunkSize) return [text];

        const chunks: string[] = [];
        let start = 0;
        while (start < text.length) {
            const end = Math.min(start + this.config.maxChunkSize, text.length);
            chunks.push(text.slice(start, end));
            start = end - this.config.chunkOverlap;
            if (start >= text.length) break;
        }
        return chunks;
    }

    private hashContent(content: string): string {
        return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    }

    private findByHash(hash: string): IndexedEntry | undefined {
        for (const entry of this.entries.values()) {
            if (entry.contentHash === hash) return entry;
        }
        return undefined;
    }

    private isExpired(entry: IndexedEntry): boolean {
        if (!entry.ttlHours) return false;
        const age = Date.now() - new Date(entry.timestamp).getTime();
        return age > entry.ttlHours * 3600_000;
    }

    private evictOldest(): void {
        let oldest: string | null = null;
        let oldestTime = Infinity;

        for (const [id, entry] of this.entries) {
            const time = new Date(entry.timestamp).getTime();
            if (time < oldestTime) {
                oldestTime = time;
                oldest = id;
            }
        }

        if (oldest) {
            this.entries.delete(oldest);
            this.log("debug", `Evicted oldest entry: ${oldest}`);
        }
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[MemoryIndexer] ${message}`, "MemoryIndexer");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createMemoryIndexer(
    embeddingEngine: EmbeddingEngine,
    policy: RetrievalPolicy,
    config?: Partial<MemoryIndexerConfig>,
    eventBus?: EventBus,
): MemoryIndexer {
    return new MemoryIndexer(embeddingEngine, policy, config, eventBus);
}
