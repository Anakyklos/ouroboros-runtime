/**
 * ConciergeClient - Lightweight AI intent router
 * 
 * Uses Groq API to classify user intent and route to CLI commands.
 * Designed to be fast and token-efficient.
 */

import Groq from 'groq-sdk';

// ============================================================================
// Types
// ============================================================================

export type IntentType =
    | 'consult'   // → Consult Architect
    | 'task'      // → Dispatch Task
    | 'wave'      // → Execute Wave
    | 'memory'    // → Search Memory
    | 'unknown';  // → Show menu

export interface ClassificationResult {
    intent: IntentType;
    confidence: number;
    extractedQuery: string;
    raw?: string; // For debugging
}

export interface ConciergeConfig {
    apiKey: string;
    model?: string;
    maxTokens?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = 'llama-3.1-8b-instant'; // Fast model for routing
const DEFAULT_MAX_TOKENS = 150;

const SYSTEM_PROMPT = `You are a router. Classify the user's intent into ONE of these categories:
- consult: Questions about design, architecture, planning, advice, "how should I..."
- task: Requests to execute code, create files, run commands, implement something
- wave: Requests for parallel/batch operations, "run multiple...", "do N things at once"
- memory: Requests to recall past context, "what did we discuss...", "remember..."

Respond ONLY with valid JSON (no markdown, no explanation):
{"intent": "consult|task|wave|memory", "confidence": 0.0-1.0, "query": "extracted user query"}

If you cannot classify, use: {"intent": "unknown", "confidence": 0.0, "query": ""}`;

// ============================================================================
// Client
// ============================================================================

export class ConciergeClient {
    private client: Groq;
    private model: string;
    private maxTokens: number;
    private available: boolean = false;

    constructor(config: ConciergeConfig) {
        this.client = new Groq({ apiKey: config.apiKey });
        this.model = config.model || DEFAULT_MODEL;
        this.maxTokens = config.maxTokens || DEFAULT_MAX_TOKENS;
        this.available = true;
    }

    /**
     * Check if the Concierge is available
     */
    async isAvailable(): Promise<boolean> {
        if (!this.available) return false;

        try {
            // Quick ping to check API
            await this.client.models.list();
            return true;
        } catch {
            this.available = false;
            return false;
        }
    }

    /**
     * Classify user intent
     */
    async classify(userInput: string): Promise<ClassificationResult> {
        if (!this.available) {
            return { intent: 'unknown', confidence: 0, extractedQuery: userInput };
        }

        try {
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userInput }
                ],
                max_tokens: this.maxTokens,
                temperature: 0.1, // Low temperature for consistent routing
            });

            const content = response.choices[0]?.message?.content?.trim() || '';

            // Parse JSON response
            const parsed = this.parseResponse(content, userInput);
            return parsed;

        } catch (error) {
            // On error, return unknown to fallback to menu
            console.error('[Concierge] Classification error:', error);
            return { intent: 'unknown', confidence: 0, extractedQuery: userInput };
        }
    }

    /**
     * Parse the LLM response into ClassificationResult
     */
    private parseResponse(content: string, originalInput: string): ClassificationResult {
        try {
            // Try to extract JSON from response (handle markdown code blocks)
            let jsonStr = content;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                jsonStr = jsonMatch[0];
            }

            const parsed = JSON.parse(jsonStr);

            const intent = this.validateIntent(parsed.intent);
            const confidence = typeof parsed.confidence === 'number'
                ? Math.min(1, Math.max(0, parsed.confidence))
                : 0.5;
            const extractedQuery = parsed.query || originalInput;

            return { intent, confidence, extractedQuery, raw: content };

        } catch {
            // If JSON parsing fails, try to extract intent from text
            const lowerContent = content.toLowerCase();

            if (lowerContent.includes('consult')) {
                return { intent: 'consult', confidence: 0.6, extractedQuery: originalInput, raw: content };
            }
            if (lowerContent.includes('task')) {
                return { intent: 'task', confidence: 0.6, extractedQuery: originalInput, raw: content };
            }
            if (lowerContent.includes('wave')) {
                return { intent: 'wave', confidence: 0.6, extractedQuery: originalInput, raw: content };
            }
            if (lowerContent.includes('memory')) {
                return { intent: 'memory', confidence: 0.6, extractedQuery: originalInput, raw: content };
            }

            return { intent: 'unknown', confidence: 0, extractedQuery: originalInput, raw: content };
        }
    }

    /**
     * Validate and normalize intent type
     */
    private validateIntent(intent: unknown): IntentType {
        const validIntents: IntentType[] = ['consult', 'task', 'wave', 'memory'];

        if (typeof intent === 'string') {
            const normalized = intent.toLowerCase().trim();
            if (validIntents.includes(normalized as IntentType)) {
                return normalized as IntentType;
            }
        }

        return 'unknown';
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createConcierge(apiKey: string): ConciergeClient {
    return new ConciergeClient({ apiKey });
}
