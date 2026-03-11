/**
 * 💰 BudgetTracker — SQLite Adapter (Bun)
 * 
 * Implementação do BudgetPort usando bun:sqlite.
 * Rastreia custos LLM com pricing estático por modelo.
 * 
 * Design inspirado pelo supervisor/state.py do razzant/ouroboros,
 * reimaginado para TypeScript com arquitetura hexagonal.
 */

import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { EventBus, globalEventBus } from '../daemon/event-bus.js';
import type {
    BudgetPort,
    BudgetCategory,
    BudgetSummary,
    LLMUsageRecord,
    BudgetAlert,
} from '../ports/budget.port.js';

// ============================================================
// Model Pricing (USD per 1M tokens)
// ============================================================

interface ModelPricing {
    /** Price per 1M input tokens */
    input: number;
    /** Price per 1M output tokens */
    output: number;
}

/**
 * Tabela de preços estática por modelo.
 * Atualizar periodicamente. Preços em USD por 1M tokens.
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
    // Z.AI / ZhiPu
    'glm-4.7': { input: 0.50, output: 0.50 },
    'glm-4-plus': { input: 1.00, output: 1.00 },
    'glm-4-flash': { input: 0.10, output: 0.10 },
    'glm-4': { input: 0.50, output: 0.50 },

    // Anthropic
    'claude-sonnet-4': { input: 3.00, output: 15.00 },
    'claude-opus-4': { input: 15.00, output: 75.00 },
    'claude-haiku-3.5': { input: 0.80, output: 4.00 },

    // OpenAI
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'o3': { input: 10.00, output: 40.00 },
    'o3-mini': { input: 1.10, output: 4.40 },

    // Google
    'gemini-2.5-pro': { input: 1.25, output: 10.00 },
    'gemini-2.5-flash': { input: 0.15, output: 0.60 },
    'gemini-2.0-flash': { input: 0.10, output: 0.40 },
};

/**
 * Fallback pricing quando o modelo não está na tabela.
 * Usa um preço conservador (assume modelo caro para não subestimar).
 */
const FALLBACK_PRICING: ModelPricing = { input: 1.00, output: 4.00 };

// ============================================================
// Budget Thresholds
// ============================================================

const BUDGET_THRESHOLDS = [
    { pct: 50, type: 'warning' as const, message: '⚠️ Budget 50% utilizado' },
    { pct: 80, type: 'critical' as const, message: '🔴 Budget 80% utilizado — considere reduzir uso' },
    { pct: 95, type: 'exceeded' as const, message: '🛑 Budget 95% utilizado — ações restritas' },
    { pct: 100, type: 'exceeded' as const, message: '⛔ Budget esgotado' },
];

// ============================================================
// BudgetTracker
// ============================================================

export class BudgetTracker implements BudgetPort {
    private db: Database | null = null;
    private dbPath: string;
    private budgetLimitUsd: number;
    private eventBus: EventBus;
    private alertedThresholds: Set<number> = new Set();
    private cachedTotalSpent: number = 0;

    constructor(
        dbPath: string = '.ouroboros/budget.db',
        budgetLimitUsd: number = 0,
        eventBus?: EventBus
    ) {
        this.dbPath = dbPath;
        this.budgetLimitUsd = budgetLimitUsd;
        this.eventBus = eventBus ?? globalEventBus;
    }

    // ============================================================
    // Lifecycle
    // ============================================================

    async initialize(): Promise<void> {
        this.db = new Database(this.dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS llm_usage (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                session_id TEXT,
                model TEXT NOT NULL,
                prompt_tokens INTEGER NOT NULL,
                completion_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL,
                cost_usd REAL NOT NULL,
                category TEXT NOT NULL DEFAULT 'task'
            );

            CREATE TABLE IF NOT EXISTS budget_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON llm_usage(timestamp);
            CREATE INDEX IF NOT EXISTS idx_usage_session ON llm_usage(session_id);
            CREATE INDEX IF NOT EXISTS idx_usage_category ON llm_usage(category);
            CREATE INDEX IF NOT EXISTS idx_usage_model ON llm_usage(model);
        `);

        // Load persisted budget limit
        const row = this.db.prepare(
            'SELECT value FROM budget_config WHERE key = ?'
        ).get('budget_limit_usd') as { value: string } | null;

        if (row) {
            this.budgetLimitUsd = parseFloat(row.value);
        }

        // Pre-compute cached total
        await this.refreshCachedTotal();
    }

    async close(): Promise<void> {
        this.db?.close();
        this.db = null;
    }

    // ============================================================
    // Core Operations
    // ============================================================

    async recordUsage(
        record: Omit<LLMUsageRecord, 'id' | 'timestamp' | 'costUsd'>
    ): Promise<LLMUsageRecord> {
        const costUsd = this.estimateCost(
            record.model,
            record.promptTokens,
            record.completionTokens
        );

        const entry: LLMUsageRecord = {
            id: randomUUID(),
            timestamp: new Date(),
            costUsd,
            ...record,
        };

        this.ensureDb().prepare(`
            INSERT INTO llm_usage (id, timestamp, session_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, category)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            entry.id,
            entry.timestamp.toISOString(),
            entry.sessionId ?? null,
            entry.model,
            entry.promptTokens,
            entry.completionTokens,
            entry.totalTokens,
            entry.costUsd,
            entry.category
        );

        // Update cached total
        this.cachedTotalSpent += costUsd;

        // Emit usage event
        this.eventBus.emit('log', {
            level: 'debug',
            message: `💰 LLM cost: $${costUsd.toFixed(4)} (${record.model}, ${record.totalTokens} tokens)`,
            timestamp: new Date(),
            source: 'BudgetTracker',
        });

        // Check thresholds
        this.checkThresholds();

        return entry;
    }

    async getSummary(): Promise<BudgetSummary> {
        const db = this.ensureDb();

        // Total aggregates
        const totals = db.prepare(`
            SELECT 
                COALESCE(SUM(cost_usd), 0) as total_cost,
                COALESCE(COUNT(*), 0) as total_calls,
                COALESCE(SUM(total_tokens), 0) as total_tokens
            FROM llm_usage
        `).get() as { total_cost: number; total_calls: number; total_tokens: number };

        // By category
        const categoryRows = db.prepare(`
            SELECT category, SUM(cost_usd) as cost, COUNT(*) as calls
            FROM llm_usage
            GROUP BY category
        `).all() as Array<{ category: BudgetCategory; cost: number; calls: number }>;

        const byCategory: BudgetSummary['byCategory'] = {
            task: { costUsd: 0, calls: 0 },
            consciousness: { costUsd: 0, calls: 0 },
            evolution: { costUsd: 0, calls: 0 },
            review: { costUsd: 0, calls: 0 },
            direct_chat: { costUsd: 0, calls: 0 },
        };
        for (const row of categoryRows) {
            byCategory[row.category] = { costUsd: row.cost, calls: row.calls };
        }

        // By model
        const modelRows = db.prepare(`
            SELECT model, SUM(cost_usd) as cost, COUNT(*) as calls, SUM(total_tokens) as tokens
            FROM llm_usage
            GROUP BY model
        `).all() as Array<{ model: string; cost: number; calls: number; tokens: number }>;

        const byModel: BudgetSummary['byModel'] = {};
        for (const row of modelRows) {
            byModel[row.model] = { costUsd: row.cost, calls: row.calls, totalTokens: row.tokens };
        }

        const totalSpent = totals.total_cost;
        const remaining = this.budgetLimitUsd > 0 ? Math.max(0, this.budgetLimitUsd - totalSpent) : Infinity;
        const usedPct = this.budgetLimitUsd > 0 ? Math.min(100, (totalSpent / this.budgetLimitUsd) * 100) : 0;

        return {
            totalSpentUsd: totalSpent,
            budgetLimitUsd: this.budgetLimitUsd,
            budgetUsedPct: Math.round(usedPct * 100) / 100,
            remainingUsd: remaining === Infinity ? -1 : remaining,
            totalCalls: totals.total_calls,
            totalTokens: totals.total_tokens,
            byCategory,
            byModel,
        };
    }

    setBudgetLimit(limitUsd: number): void {
        this.budgetLimitUsd = limitUsd;
        this.alertedThresholds.clear();

        // Persist to DB
        if (this.db) {
            this.db.prepare(`
                INSERT OR REPLACE INTO budget_config (key, value) VALUES (?, ?)
            `).run('budget_limit_usd', String(limitUsd));
        }

        this.eventBus.emit('log', {
            level: 'info',
            message: `💰 Budget limit set to $${limitUsd.toFixed(2)}`,
            timestamp: new Date(),
            source: 'BudgetTracker',
        });
    }

    getBudgetLimit(): number {
        return this.budgetLimitUsd;
    }

    async isBudgetExceeded(): Promise<boolean> {
        if (this.budgetLimitUsd <= 0) return false;
        return this.cachedTotalSpent >= this.budgetLimitUsd;
    }

    async getRecentUsage(limit: number = 20): Promise<LLMUsageRecord[]> {
        const rows = this.ensureDb().prepare(
            'SELECT * FROM llm_usage ORDER BY timestamp DESC LIMIT ?'
        ).all(limit) as Array<{
            id: string;
            timestamp: string;
            session_id: string | null;
            model: string;
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
            cost_usd: number;
            category: BudgetCategory;
        }>;

        return rows.map(row => ({
            id: row.id,
            timestamp: new Date(row.timestamp),
            sessionId: row.session_id ?? undefined,
            model: row.model,
            promptTokens: row.prompt_tokens,
            completionTokens: row.completion_tokens,
            totalTokens: row.total_tokens,
            costUsd: row.cost_usd,
            category: row.category,
        }));
    }

    // ============================================================
    // Pricing
    // ============================================================

    /**
     * Estima o custo de uma chamada LLM baseado no modelo e tokens.
     * Normaliza nomes de modelo para matching (remove prefixos como "anthropic/").
     */
    estimateCost(model: string, promptTokens: number, completionTokens: number): number {
        const pricing = this.getPricing(model);
        const inputCost = (promptTokens / 1_000_000) * pricing.input;
        const outputCost = (completionTokens / 1_000_000) * pricing.output;
        return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal precision
    }

    /**
     * Busca pricing para um modelo, tentando várias normalizações.
     */
    private getPricing(model: string): ModelPricing {
        // Direct match
        if (MODEL_PRICING[model]) return MODEL_PRICING[model];

        // Remove provider prefix (e.g., "anthropic/claude-sonnet-4" → "claude-sonnet-4")
        const withoutPrefix = model.includes('/') ? model.split('/').pop()! : model;
        if (MODEL_PRICING[withoutPrefix]) return MODEL_PRICING[withoutPrefix];

        // Partial match (e.g., "glm-4.7-chat" → "glm-4.7")
        for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
            if (model.startsWith(key) || withoutPrefix.startsWith(key)) {
                return pricing;
            }
        }

        return FALLBACK_PRICING;
    }

    // ============================================================
    // Internal
    // ============================================================

    private checkThresholds(): void {
        if (this.budgetLimitUsd <= 0) return;

        const usedPct = (this.cachedTotalSpent / this.budgetLimitUsd) * 100;

        for (const threshold of BUDGET_THRESHOLDS) {
            if (usedPct >= threshold.pct && !this.alertedThresholds.has(threshold.pct)) {
                this.alertedThresholds.add(threshold.pct);

                const alert: BudgetAlert = {
                    type: threshold.type,
                    usedPct: Math.round(usedPct * 100) / 100,
                    message: `${threshold.message} ($${this.cachedTotalSpent.toFixed(2)} / $${this.budgetLimitUsd.toFixed(2)})`,
                    timestamp: new Date(),
                };

                this.eventBus.emit('log', {
                    level: threshold.type === 'exceeded' ? 'error' : 'warn',
                    message: alert.message,
                    timestamp: alert.timestamp,
                    source: 'BudgetTracker',
                });
            }
        }
    }

    private async refreshCachedTotal(): Promise<void> {
        const row = this.ensureDb().prepare(
            'SELECT COALESCE(SUM(cost_usd), 0) as total FROM llm_usage'
        ).get() as { total: number };
        this.cachedTotalSpent = row.total;
    }

    private ensureDb(): Database {
        if (!this.db) {
            throw new Error('BudgetTracker not initialized. Call initialize() first.');
        }
        return this.db;
    }
}
