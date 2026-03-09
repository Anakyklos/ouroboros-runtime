/**
 * 🧱 Context Builder
 * 
 * Monta contexto LLM em 3 blocos otimizados para cache:
 * 
 * Block 1 (static): System prompt + project docs → cached 1h
 * Block 2 (semi-stable): Identity, scratchpad, knowledge → cached ephemeral
 * Block 3 (dynamic): Runtime state, health, recent logs → never cached
 * 
 * Inspirado por context.py do razzant/ouroboros.
 * Adaptado para arquitetura TypeScript com prompt caching hints.
 * 
 * Token economy: ~40-60% savings on repeat calls within same session.
 */

import type { EventBus } from '../daemon/event-bus.js';
import type { BudgetPort } from '../ports/budget.port.js';

// ============================================================
// Types
// ============================================================

export interface CacheControl {
    type: 'ephemeral';
    ttl?: string;
}

export interface ContentBlock {
    type: 'text';
    text: string;
    cache_control?: CacheControl;
}

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | ContentBlock[];
    tool_call_id?: string;
    tool_calls?: unknown[];
}

export interface ContextConfig {
    /** System prompt base */
    systemPrompt: string;
    /** Diretório raiz do projeto */
    projectRoot: string;
    /** Soft cap de tokens (default: 200k) */
    softCapTokens: number;
    /** Max tokens por bloco semi-stable */
    maxSemiStableTokens: number;
    /** Max tokens por bloco dynamic */
    maxDynamicTokens: number;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
    systemPrompt: 'You are an expert software engineer assistant.',
    projectRoot: process.cwd(),
    softCapTokens: 200_000,
    maxSemiStableTokens: 90_000,
    maxDynamicTokens: 60_000,
};

export interface ContextBuildResult {
    messages: LLMMessage[];
    estimatedTokens: number;
    trimmedSections: string[];
    blocks: {
        staticTokens: number;
        semiStableTokens: number;
        dynamicTokens: number;
    };
}

// ============================================================
// Context Builder
// ============================================================

export class ContextBuilder {
    private config: ContextConfig;
    private budgetTracker?: BudgetPort;

    // Block providers (injectable)
    private staticProvider?: () => string;
    private semiStableProvider?: () => string;
    private dynamicProvider?: () => string;

    constructor(config?: Partial<ContextConfig>, budgetTracker?: BudgetPort) {
        this.config = { ...DEFAULT_CONTEXT_CONFIG, ...config };
        this.budgetTracker = budgetTracker;
    }

    // ============================================================
    // Provider Registration
    // ============================================================

    /** Registra provider de conteúdo estático (system prompt, docs) */
    setStaticProvider(provider: () => string): void {
        this.staticProvider = provider;
    }

    /** Registra provider de conteúdo semi-estável (identity, scratchpad) */
    setSemiStableProvider(provider: () => string): void {
        this.semiStableProvider = provider;
    }

    /** Registra provider de conteúdo dinâmico (runtime state, health) */
    setDynamicProvider(provider: () => string): void {
        this.dynamicProvider = provider;
    }

    // ============================================================
    // Build
    // ============================================================

    /**
     * Monta mensagens LLM completas com prompt caching.
     * 
     * @param userMessage - Mensagem do usuário
     * @param additionalContext - Contexto adicional (e.g., task history)
     */
    build(userMessage: string, additionalContext?: string): ContextBuildResult {
        // 1. Collect block content
        const staticText = this.buildStaticBlock();
        const semiStableText = this.buildSemiStableBlock();
        const dynamicText = this.buildDynamicBlock(additionalContext);

        // 2. Estimate tokens
        const staticTokens = estimateTokens(staticText);
        const semiStableTokens = estimateTokens(semiStableText);
        const dynamicTokens = estimateTokens(dynamicText);
        const userTokens = estimateTokens(userMessage);

        let totalTokens = staticTokens + semiStableTokens + dynamicTokens + userTokens;
        const trimmedSections: string[] = [];

        // 3. Build 3-block system message with cache hints
        const contentBlocks: ContentBlock[] = [
            {
                type: 'text',
                text: staticText,
                cache_control: { type: 'ephemeral', ttl: '1h' },
            },
        ];

        // Only add semi-stable if it has content
        if (semiStableText.trim()) {
            contentBlocks.push({
                type: 'text',
                text: clipText(semiStableText, this.config.maxSemiStableTokens * 4),
                cache_control: { type: 'ephemeral' },
            });
        }

        // Dynamic block (never cached)
        if (dynamicText.trim()) {
            contentBlocks.push({
                type: 'text',
                text: clipText(dynamicText, this.config.maxDynamicTokens * 4),
            });
        }

        // 4. Soft cap trimming
        if (totalTokens > this.config.softCapTokens) {
            const result = this.applySoftCap(contentBlocks, totalTokens);
            totalTokens = result.newTotal;
            trimmedSections.push(...result.trimmed);
        }

        const messages: LLMMessage[] = [
            { role: 'system', content: contentBlocks },
            { role: 'user', content: userMessage },
        ];

        return {
            messages,
            estimatedTokens: totalTokens,
            trimmedSections,
            blocks: {
                staticTokens,
                semiStableTokens,
                dynamicTokens,
            },
        };
    }

    /**
     * Build simplificado que retorna apenas string (para AgentLoop existente).
     * Usa flat system prompt sem cache hints.
     */
    buildFlat(userMessage: string, additionalContext?: string): { systemPrompt: string; estimatedTokens: number } {
        const staticText = this.buildStaticBlock();
        const semiStableText = this.buildSemiStableBlock();
        const dynamicText = this.buildDynamicBlock(additionalContext);

        const parts = [staticText];
        if (semiStableText.trim()) parts.push(semiStableText);
        if (dynamicText.trim()) parts.push(dynamicText);

        const systemPrompt = parts.join('\n\n---\n\n');
        const estimatedTokens = estimateTokens(systemPrompt) + estimateTokens(userMessage);

        return { systemPrompt, estimatedTokens };
    }

    // ============================================================
    // Block Builders
    // ============================================================

    private buildStaticBlock(): string {
        if (this.staticProvider) {
            return this.staticProvider();
        }
        return this.config.systemPrompt;
    }

    private buildSemiStableBlock(): string {
        if (this.semiStableProvider) {
            return this.semiStableProvider();
        }
        return '';
    }

    private buildDynamicBlock(additionalContext?: string): string {
        const parts: string[] = [];

        // Runtime context
        parts.push(`## Runtime Context\n\n${JSON.stringify({
            utcNow: new Date().toISOString(),
            projectRoot: this.config.projectRoot,
        }, null, 2)}`);

        // Budget info
        if (this.budgetTracker) {
            try {
                // Note: getSummary is async but we do sync build
                // Budget info will be available if pre-fetched
            } catch { /* ignore */ }
        }

        // Dynamic provider (health invariants, recent logs, etc.)
        if (this.dynamicProvider) {
            const dynamicContent = this.dynamicProvider();
            if (dynamicContent.trim()) {
                parts.push(dynamicContent);
            }
        }

        // Additional task context
        if (additionalContext?.trim()) {
            parts.push(`## Additional Context\n\n${additionalContext}`);
        }

        return parts.join('\n\n');
    }

    // ============================================================
    // Soft Cap Trimming
    // ============================================================

    /**
     * Se tokens excedem soft cap, remove seções prunable do bloco dinâmico.
     */
    private applySoftCap(
        blocks: ContentBlock[],
        currentTotal: number,
    ): { newTotal: number; trimmed: string[] } {
        const prunable = [
            '## Recent Chat', '## Recent Progress',
            '## Recent Tools', '## Recent Events', '## Supervisor',
        ];
        const trimmed: string[] = [];
        let total = currentTotal;

        // Find the dynamic block (the one without cache_control)
        const dynamicBlock = blocks.find(b => !b.cache_control);
        if (!dynamicBlock) return { newTotal: total, trimmed };

        for (const prefix of prunable) {
            if (total <= this.config.softCapTokens) break;
            if (dynamicBlock.text.includes(prefix)) {
                const sections = dynamicBlock.text.split('\n\n');
                const filtered: string[] = [];
                let skipping = false;

                for (const section of sections) {
                    if (section.startsWith(prefix)) {
                        skipping = true;
                        trimmed.push(prefix);
                        continue;
                    }
                    if (section.startsWith('##')) {
                        skipping = false;
                    }
                    if (!skipping) {
                        filtered.push(section);
                    }
                }

                dynamicBlock.text = filtered.join('\n\n');
                total = blocks.reduce((sum, b) => sum + estimateTokens(b.text), 0);
            }
        }

        return { newTotal: total, trimmed };
    }
}

// ============================================================
// Token Estimation
// ============================================================

/**
 * Estima tokens de um texto (rough: ~4 chars per token).
 * Suficiente para budget checking — não precisa ser exato.
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    // Rough estimate: ~4 chars per token for English/code
    return Math.ceil(text.length / 4);
}

/**
 * Clipa texto para um número máximo de caracteres.
 */
export function clipText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars) + '\n\n[... truncated]';
}

// ============================================================
// Factory
// ============================================================

export function createContextBuilder(
    config?: Partial<ContextConfig>,
    budgetTracker?: BudgetPort,
): ContextBuilder {
    return new ContextBuilder(config, budgetTracker);
}
