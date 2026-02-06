/**
 * 🧠 MemoryRetriever
 * 
 * Indexes and retrieves relevant context from past logs using hybrid search.
 * 
 * Design Pattern (OpenClaw-inspired):
 * - Two-tier memory: Daily logs (ephemeral) + MEMORY.md (durable)
 * - Hybrid search: Vector similarity + keyword matching
 * - Temporal awareness: Recent memories weighted higher
 */

import {
    type MemoryConfig,
    type MemoryChunk,
    type SearchResult,
    type ChunkMetadata,
    DEFAULT_MEMORY_CONFIG,
} from "./memory-config.js";

// Re-export types for external use
export type { MemoryConfig } from "./memory-config.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";
import { GeminiEmbeddingClient } from "../adapters/gemini-embedding.js";
import * as fs from "fs";
import * as path from "path";

/**
 * Simple text chunker for Markdown files.
 */
function chunkText(
    content: string,
    chunkSize: number,
    overlap: number
): { content: string; startLine: number; endLine: number }[] {
    const lines = content.split("\n");
    const chunks: { content: string; startLine: number; endLine: number }[] = [];

    // Approximate tokens as words (rough estimate)
    const tokensPerLine = lines.map(line => line.split(/\s+/).length);

    let currentChunk: string[] = [];
    let currentTokens = 0;
    let startLine = 1;

    for (let i = 0; i < lines.length; i++) {
        const lineTokens = tokensPerLine[i];

        if (currentTokens + lineTokens > chunkSize && currentChunk.length > 0) {
            // Save current chunk
            chunks.push({
                content: currentChunk.join("\n"),
                startLine,
                endLine: startLine + currentChunk.length - 1,
            });

            // Start new chunk with overlap
            const overlapLines = Math.ceil(overlap / 10); // Rough estimate
            const overlapStart = Math.max(0, currentChunk.length - overlapLines);
            currentChunk = currentChunk.slice(overlapStart);
            currentTokens = currentChunk.join(" ").split(/\s+/).length;
            startLine = i - currentChunk.length + 1;
        }

        currentChunk.push(lines[i]);
        currentTokens += lineTokens;
    }

    // Save final chunk
    if (currentChunk.length > 0) {
        chunks.push({
            content: currentChunk.join("\n"),
            startLine,
            endLine: startLine + currentChunk.length - 1,
        });
    }

    return chunks;
}

/**
 * Simple keyword extraction for hybrid search.
 */
function extractKeywords(text: string): string[] {
    const stopWords = new Set([
        "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "could",
        "should", "may", "might", "must", "shall", "can", "need", "dare",
        "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
        "into", "through", "during", "before", "after", "above", "below",
        "and", "but", "or", "nor", "so", "yet", "both", "either", "neither",
        "not", "only", "own", "same", "than", "too", "very", "just",
    ]);

    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word));
}

/**
 * Calculate keyword overlap score.
 */
function keywordScore(queryKeywords: string[], chunkKeywords: string[]): number {
    if (queryKeywords.length === 0) return 0;

    const chunkSet = new Set(chunkKeywords);
    const matches = queryKeywords.filter(kw => chunkSet.has(kw));
    return matches.length / queryKeywords.length;
}

/**
 * Calculate temporal score based on date.
 */
function temporalScore(chunkDate: string, decay: number): number {
    const chunkTime = new Date(chunkDate).getTime();
    const now = Date.now();
    const daysDiff = (now - chunkTime) / (1000 * 60 * 60 * 24);

    return Math.pow(decay, daysDiff);
}

/**
 * MemoryRetriever - Indexes logs and retrieves relevant context.
 */
export class MemoryRetriever {
    private config: MemoryConfig;
    private eventBus: EventBus;
    private chunks: MemoryChunk[] = [];
    private initialized = false;
    private embedder: GeminiEmbeddingClient;

    constructor(config: Partial<MemoryConfig> = {}, eventBus?: EventBus) {
        this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
        this.embedder = new GeminiEmbeddingClient(process.env.GOOGLE_API_KEY, this.eventBus);
    }

    /**
     * Initialize the retriever.
     * For now, uses in-memory storage. SQLite can be added later.
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        this.log("info", "🧠 MemoryRetriever initializing...");

        // In-memory mode for v1
        this.chunks = [];
        this.initialized = true;

        this.log("info", "✅ MemoryRetriever ready (in-memory mode)");
    }

    /**
     * Index a Markdown log file.
     */
    async index(filePath: string): Promise<number> {
        if (!this.initialized) await this.initialize();

        if (!fs.existsSync(filePath)) {
            this.log("warn", `File not found: ${filePath}`);
            return 0;
        }

        const content = fs.readFileSync(filePath, "utf-8");
        const fileName = path.basename(filePath);
        const dateMatch = fileName.match(/(\d{4}-\d{2}-\d{2})/);
        const date = dateMatch ? dateMatch[1] : new Date().toISOString().split("T")[0];

        // Chunk the content
        const textChunks = chunkText(content, this.config.chunkSize, this.config.chunkOverlap);

        // Create memory chunks (with embeddings)
        for (let i = 0; i < textChunks.length; i++) {
            const chunk = textChunks[i];
            const id = `${fileName}-${i}`;

            // Check if already indexed
            if (this.chunks.some(c => c.id === id)) continue;

            const embedding = await this.embedder.embed(chunk.content);

            const memoryChunk: MemoryChunk = {
                id,
                content: chunk.content,
                embedding,
                metadata: {
                    sourcePath: filePath,
                    date,
                    startLine: chunk.startLine,
                    endLine: chunk.endLine,
                    chunkIndex: i,
                    indexedAt: new Date(),
                },
            };

            this.chunks.push(memoryChunk);
        }

        this.log("info", `📚 Indexed ${textChunks.length} chunks from ${fileName}`);
        return textChunks.length;
    }

    /**
     * Index all log files in a directory.
     */
    async indexDirectory(dirPath: string): Promise<number> {
        if (!fs.existsSync(dirPath)) {
            this.log("warn", `Directory not found: ${dirPath}`);
            return 0;
        }

        const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".md"));
        let totalChunks = 0;

        for (const file of files) {
            const count = await this.index(path.join(dirPath, file));
            totalChunks += count;
        }

        this.log("info", `📚 Indexed ${totalChunks} total chunks from ${files.length} files`);
        return totalChunks;
    }

    /**
     * Search for relevant chunks using hybrid search.
     * 
     * V2: Hybrid search (Keyword + Vector + Temporal).
     */
    async search(query: string, topK?: number): Promise<SearchResult[]> {
        if (!this.initialized) await this.initialize();

        const k = topK ?? this.config.topK;
        const queryKeywords = extractKeywords(query);
        const queryEmbedding = await this.embedder.embed(query);

        // Score all chunks
        const results: SearchResult[] = this.chunks.map(chunk => {
            const chunkKeywords = extractKeywords(chunk.content);
            const kwScore = keywordScore(queryKeywords, chunkKeywords);
            const tempScore = temporalScore(chunk.metadata.date, this.config.temporalDecay);
            const vecScore = GeminiEmbeddingClient.cosineSimilarity(queryEmbedding, chunk.embedding);

            // Combine scores (Hybrid: Vector + Keyword + Temporal)
            // 40% Vector, 40% Keyword, 20% Temporal
            const combinedScore = (vecScore * 0.4) + (kwScore * 0.4) + (tempScore * 0.2);

            return {
                chunk,
                score: combinedScore,
                vectorScore: vecScore,
                keywordScore: kwScore,
                temporalScore: tempScore,
            };
        });

        // Sort by score and take top-K
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, k);
    }

    /**
     * Get relevant context for a task prompt.
     * This is the main entry point for Orchestrator integration.
     */
    async getRelevantContext(taskPrompt: string): Promise<string> {
        const results = await this.search(taskPrompt);

        if (results.length === 0) {
            return "";
        }

        // Filter out low-relevance results
        const relevantResults = results.filter(r => r.score > 0.1);

        if (relevantResults.length === 0) {
            return "";
        }

        // Format as context block
        const contextBlocks = relevantResults.map(r => {
            const source = path.basename(r.chunk.metadata.sourcePath);
            return `[From ${source} (${r.chunk.metadata.date})]:\n${r.chunk.content}`;
        });

        return `## Relevant Memory Context\n\n${contextBlocks.join("\n\n---\n\n")}`;
    }

    /**
     * Flush important context to durable memory.
     * Called before context compaction.
     */
    async flush(context: string, label: string): Promise<void> {
        // For now, just index the context as a special chunk
        const id = `flush-${Date.now()}`;
        const chunk: MemoryChunk = {
            id,
            content: `[FLUSH: ${label}]\n${context}`,
            embedding: [],
            metadata: {
                sourcePath: "memory://flush",
                date: new Date().toISOString().split("T")[0],
                startLine: 1,
                endLine: context.split("\n").length,
                chunkIndex: 0,
                indexedAt: new Date(),
            },
        };

        this.chunks.push(chunk);
        this.log("info", `💾 Flushed context: ${label}`);
    }

    /**
     * Get stats about indexed memory.
     */
    getStats(): { chunkCount: number; fileCount: number } {
        const files = new Set(this.chunks.map(c => c.metadata.sourcePath));
        return {
            chunkCount: this.chunks.length,
            fileCount: files.size,
        };
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, message, "MemoryRetriever");
    }
}

/**
 * Factory function.
 */
export function createMemoryRetriever(config?: Partial<MemoryConfig>): MemoryRetriever {
    return new MemoryRetriever(config);
}
