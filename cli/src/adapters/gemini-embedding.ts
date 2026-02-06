/**
 * 💎 Gemini Embedding Adapter
 * 
 * Generates vector embeddings using Google's Gemini API.
 * Requires GOOGLE_API_KEY environment variable.
 */

import { EventBus, globalEventBus } from "../daemon/event-bus.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent";

export class GeminiEmbeddingClient {
    private apiKey: string;
    private eventBus: EventBus;
    private available: boolean = false;

    constructor(apiKey?: string, eventBus?: EventBus) {
        this.apiKey = apiKey ?? process.env.GOOGLE_API_KEY ?? "";
        this.eventBus = eventBus ?? globalEventBus;
        this.available = !!this.apiKey;

        if (!this.available) {
            this.eventBus.log("warn", "GOOGLE_API_KEY not found. Embeddings will be disabled.", "GeminiEmbeddingClient");
        }
    }

    /**
     * Generate embedding for a single text string.
     * Returns 768-dimensional vector (typically).
     */
    async embed(text: string): Promise<number[]> {
        if (!this.available) return [];

        try {
            const response = await fetch(`${GEMINI_API_BASE}?key=${this.apiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "models/embedding-001",
                    content: { parts: [{ text }] }
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Gemini API error: ${response.status} ${errText}`);
            }

            const data = await response.json() as { embedding?: { values: number[] } };
            
            if (!data.embedding?.values) {
                throw new Error("Invalid response format from Gemini API");
            }

            return data.embedding.values;
        } catch (error) {
            this.eventBus.log("error", `Embedding failed: ${error}`, "GeminiEmbeddingClient");
            return [];
        }
    }

    /**
     * Calculate cosine similarity between two vectors.
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
}
