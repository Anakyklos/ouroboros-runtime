/**
 * 🧠 Memory Configuration
 * 
 * Settings for MemoryRetriever: chunking, embedding, and search parameters.
 */

export interface MemoryConfig {
    /** Maximum tokens per chunk (default: 500) */
    chunkSize: number;

    /** Overlap between chunks in tokens (default: 50) */
    chunkOverlap: number;

    /** Number of top results to return (default: 5) */
    topK: number;

    /** Embedding model to use */
    embeddingModel: "gemini" | "local" | "openai";

    /** Storage backend */
    storageBackend: "sqlite" | "memory";

    /** Path to SQLite database */
    dbPath: string;

    /** Weight for vector similarity (0-1) */
    vectorWeight: number;

    /** Weight for keyword matching (0-1) */
    keywordWeight: number;

    /** Temporal decay factor (recent memories weighted higher) */
    temporalDecay: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    chunkSize: 500,
    chunkOverlap: 50,
    topK: 5,
    embeddingModel: "gemini",
    storageBackend: "sqlite",
    dbPath: ".ouroboros/memory.db",
    vectorWeight: 0.7,
    keywordWeight: 0.3,
    temporalDecay: 0.95,
};

/**
 * Chunk metadata for retrieval context.
 */
export interface ChunkMetadata {
    /** Source file path */
    sourcePath: string;

    /** Date of the log (YYYY-MM-DD) */
    date: string;

    /** Position in source file */
    startLine: number;
    endLine: number;

    /** Chunk index within file */
    chunkIndex: number;

    /** When the chunk was indexed */
    indexedAt: Date;
}

/**
 * Memory chunk with content and embedding.
 */
export interface MemoryChunk {
    id: string;
    content: string;
    embedding: number[];
    metadata: ChunkMetadata;
}

/**
 * Search result with relevance score.
 */
export interface SearchResult {
    chunk: MemoryChunk;

    /** Combined relevance score (0-1) */
    score: number;

    /** Vector similarity component */
    vectorScore: number;

    /** Keyword match component */
    keywordScore: number;

    /** Temporal recency component */
    temporalScore: number;
}
