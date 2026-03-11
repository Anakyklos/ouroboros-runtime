/**
 * ✂️ Tool History Compactor
 * 
 * Compacta tool call/result history em conversas longas.
 * Mantém últimos N rounds intactos, compacta os antigos.
 * 
 * Inspirado por compact_tool_history() do razzant/ouroboros context.py.
 * 
 * Economia: reduz 80%+ dos tokens em tool results antigos,
 * permitindo mais rounds antes de hit no context limit.
 */

import type { LLMMessage, ContentBlock } from './ContextBuilder.js';

// ============================================================
// Types
// ============================================================

export interface CompactionResult {
    messages: LLMMessage[];
    compactedRounds: number;
    tokensSaved: number;
}

// ============================================================
// Tool History Compactor
// ============================================================

export class ToolHistoryCompactor {
    /** Número de rounds recentes para manter intactos */
    private keepRecent: number;

    /** Limite de chars para argumentos de tool calls */
    private maxArgChars: number;

    /** Tools com campos grandes que devem ser stripped */
    private largeContentTools: Record<string, string> = {
        'write_file': 'content',
        'replace_file_content': 'ReplacementContent',
        'multi_replace_file_content': 'ReplacementChunks',
        'create_file': 'content',
    };

    constructor(keepRecent: number = 6, maxArgChars: number = 500) {
        this.keepRecent = keepRecent;
        this.maxArgChars = maxArgChars;
    }

    /**
     * Compacta tool history em um array de mensagens.
     * 
     * - Identifica rounds de tool calls (assistant com tool_calls)
     * - Mantém os últimos `keepRecent` rounds intactos
     * - Compacta rounds mais antigos:
     *   - Tool results → resumo de 1 linha
     *   - Tool call arguments → truncados ou stripped
     *   - Assistant content → truncado
     */
    compact(messages: LLMMessage[]): CompactionResult {
        // Find tool call round starts (assistant messages with tool_calls)
        const toolRoundStarts: number[] = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
                toolRoundStarts.push(i);
            }
        }

        if (toolRoundStarts.length <= this.keepRecent) {
            return { messages, compactedRounds: 0, tokensSaved: 0 };
        }

        // Rounds to compact: all except last keepRecent
        const roundsToCompact = new Set(
            toolRoundStarts.slice(0, -this.keepRecent)
        );

        let originalChars = 0;
        let compactedChars = 0;

        const result: LLMMessage[] = [];

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];

            // Skip system messages with multipart content (preserve caching)
            if (msg.role === 'system' && Array.isArray(msg.content)) {
                result.push(msg);
                continue;
            }

            // Compact tool results from old rounds
            if (msg.role === 'tool' && i > 0) {
                const parentRound = this.findParentRound(i, toolRoundStarts);
                if (parentRound !== null && roundsToCompact.has(parentRound)) {
                    const content = String(msg.content || '');
                    originalChars += content.length;
                    const compacted = this.compactToolResult(content);
                    compactedChars += compacted.length;
                    result.push({ ...msg, content: compacted });
                    continue;
                }
            }

            // Compact assistant messages from old rounds
            if (roundsToCompact.has(i) && msg.role === 'assistant') {
                const compacted = this.compactAssistantMessage(msg);
                result.push(compacted);
                continue;
            }

            result.push(msg);
        }

        return {
            messages: result,
            compactedRounds: roundsToCompact.size,
            tokensSaved: Math.floor((originalChars - compactedChars) / 4),
        };
    }

    // ============================================================
    // Private
    // ============================================================

    /**
     * Compacta um tool result em resumo de 1 linha.
     */
    private compactToolResult(content: string): string {
        const isError = content.startsWith('⚠️') || content.includes('Error') || content.includes('error');

        if (isError) {
            // Keep error details (first 200 chars)
            return content.substring(0, 200);
        }

        // Normal result: first line + char count
        const firstLine = content.split('\n')[0].substring(0, 80);
        const charCount = content.length;

        return charCount > 80
            ? `${firstLine}... (${charCount} chars)`
            : content.substring(0, 200);
    }

    /**
     * Compacta um assistant message: trim content and tool call args.
     */
    private compactAssistantMessage(msg: LLMMessage): LLMMessage {
        const compacted = { ...msg };

        // Trim content
        const content = String(msg.content || '');
        if (content.length > 200) {
            compacted.content = content.substring(0, 200) + '...';
        }

        // Compact tool call arguments
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
            compacted.tool_calls = msg.tool_calls.map((tc: any) => {
                const compactedTc = { ...tc };
                if (compactedTc.function) {
                    compactedTc.function = this.compactToolCallArgs(
                        compactedTc.function.name,
                        compactedTc.function.arguments || '',
                    );
                }
                return compactedTc;
            });
        }

        return compacted;
    }

    /**
     * Compacta argumentos de tool call.
     * Tools com campos grandes têm o campo stripped.
     */
    private compactToolCallArgs(
        toolName: string,
        argsJson: string,
    ): { name: string; arguments: string } {
        // Large content tools: strip the content field
        if (this.largeContentTools[toolName]) {
            try {
                const args = JSON.parse(argsJson);
                const field = this.largeContentTools[toolName];
                if (args[field]) {
                    args[field] = { _truncated: true };
                    return { name: toolName, arguments: JSON.stringify(args) };
                }
            } catch { /* ignore parse errors */ }
        }

        // Generic truncation
        if (argsJson.length > this.maxArgChars) {
            return { name: toolName, arguments: argsJson.substring(0, 200) + '...' };
        }

        return { name: toolName, arguments: argsJson };
    }

    /**
     * Encontra o round parent de um tool result message.
     */
    private findParentRound(toolMsgIndex: number, roundStarts: number[]): number | null {
        for (let i = roundStarts.length - 1; i >= 0; i--) {
            if (roundStarts[i] < toolMsgIndex) {
                return roundStarts[i];
            }
        }
        return null;
    }
}

// ============================================================
// Factory
// ============================================================

export function createToolHistoryCompactor(
    keepRecent: number = 6,
    maxArgChars: number = 500,
): ToolHistoryCompactor {
    return new ToolHistoryCompactor(keepRecent, maxArgChars);
}
