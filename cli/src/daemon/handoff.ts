/**
 * 🤝 Handoff Protocol
 * 
 * Permite transição de contexto entre sessões/agentes.
 * Serializa estado do AgentLoop para continuidade.
 */

import type { Message, ToolCall } from '../providers/direct-zai.js';

// ============================================================
// Types
// ============================================================

export interface HandoffContext {
    /** Original session ID */
    sessionId: string;
    /** Conversation history (excluding system prompt) */
    conversationHistory: Message[];
    /** System prompt to use */
    systemPrompt: string;
    /** Working directory for tool executor */
    workingDirectory: string;
    /** Pending tool calls not yet executed */
    pendingToolCalls?: ToolCall[];
    /** Custom metadata for extensions */
    metadata?: Record<string, unknown>;
    /** Timestamp when handoff was created */
    createdAt: Date;
    /** Reason for handoff */
    reason?: string;
}

export interface HandoffResult {
    success: boolean;
    context?: HandoffContext;
    error?: string;
}

// ============================================================
// HandoffManager
// ============================================================

export class HandoffManager {
    /**
     * Prepare a handoff context from current agent state
     */
    prepareHandoff(params: {
        sessionId: string;
        conversationHistory: Message[];
        systemPrompt: string;
        workingDirectory: string;
        pendingToolCalls?: ToolCall[];
        metadata?: Record<string, unknown>;
        reason?: string;
    }): HandoffContext {
        // Filter out system messages from history (will be re-added on receive)
        const filteredHistory = params.conversationHistory.filter(
            msg => msg.role !== 'system'
        );

        return {
            sessionId: params.sessionId,
            conversationHistory: filteredHistory,
            systemPrompt: params.systemPrompt,
            workingDirectory: params.workingDirectory,
            pendingToolCalls: params.pendingToolCalls,
            metadata: params.metadata,
            createdAt: new Date(),
            reason: params.reason,
        };
    }

    /**
     * Serialize context to JSON string for storage/transmission
     */
    serializeContext(context: HandoffContext): string {
        return JSON.stringify(context, null, 2);
    }

    /**
     * Deserialize context from JSON string
     */
    deserializeContext(json: string): HandoffResult {
        try {
            const parsed = JSON.parse(json) as HandoffContext;

            // Validate required fields
            if (!parsed.sessionId || !parsed.conversationHistory || !parsed.systemPrompt) {
                return {
                    success: false,
                    error: 'Invalid handoff context: missing required fields',
                };
            }

            // Restore Date object
            parsed.createdAt = new Date(parsed.createdAt);

            return {
                success: true,
                context: parsed,
            };
        } catch (err) {
            return {
                success: false,
                error: `Failed to parse handoff context: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    /**
     * Rebuild messages array from handoff context (with system prompt)
     */
    rebuildMessages(context: HandoffContext): Message[] {
        return [
            { role: 'system', content: context.systemPrompt },
            ...context.conversationHistory,
        ];
    }

    /**
     * Calculate estimated tokens in context (rough approximation)
     */
    estimateTokens(context: HandoffContext): number {
        const textLength = context.conversationHistory.reduce((sum, msg) => {
            return sum + (msg.content?.length ?? 0);
        }, context.systemPrompt.length);

        // Rough estimate: 1 token ≈ 4 characters
        return Math.ceil(textLength / 4);
    }

    /**
     * Truncate context to fit within token limit
     */
    truncateContext(context: HandoffContext, maxTokens: number): HandoffContext {
        const currentTokens = this.estimateTokens(context);

        if (currentTokens <= maxTokens) {
            return context;
        }

        // Remove oldest messages (keeping user's first message)
        const truncatedHistory = [...context.conversationHistory];

        while (this.estimateTokens({ ...context, conversationHistory: truncatedHistory }) > maxTokens) {
            if (truncatedHistory.length <= 2) {
                break; // Keep at least first and last message
            }
            // Remove second message (preserve first user message)
            truncatedHistory.splice(1, 1);
        }

        return {
            ...context,
            conversationHistory: truncatedHistory,
            metadata: {
                ...context.metadata,
                truncated: true,
                originalMessageCount: context.conversationHistory.length,
            },
        };
    }
}

// ============================================================
// Factory
// ============================================================

/**
 * Create a HandoffManager instance
 */
export function createHandoffManager(): HandoffManager {
    return new HandoffManager();
}
