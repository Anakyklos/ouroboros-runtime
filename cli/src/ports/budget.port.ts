/**
 * 💰 Budget Port
 * 
 * Interface para rastreamento de custos LLM.
 * Permite trocar implementação (SQLite, Memory, File) sem afetar core.
 * 
 * Inspirado pelo budget tracking do razzant/ouroboros (supervisor/state.py),
 * reimaginado para a arquitetura hexagonal do ouroboros-runtime.
 */

// ============================================================
// Types
// ============================================================

/**
 * Registro de uma chamada LLM com informações de custo.
 */
export interface LLMUsageRecord {
    /** ID único do registro */
    id: string;
    /** Timestamp da chamada */
    timestamp: Date;
    /** ID da sessão associada */
    sessionId?: string;
    /** Modelo utilizado (ex: 'glm-4.7', 'claude-sonnet-4') */
    model: string;
    /** Tokens do prompt */
    promptTokens: number;
    /** Tokens da resposta */
    completionTokens: number;
    /** Total de tokens */
    totalTokens: number;
    /** Custo estimado em USD */
    costUsd: number;
    /** Categoria (task, consciousness, evolution, review) */
    category: BudgetCategory;
}

/**
 * Categorias de gasto para breakdown.
 */
export type BudgetCategory = 'task' | 'consciousness' | 'evolution' | 'review' | 'direct_chat';

/**
 * Resumo do budget atual.
 */
export interface BudgetSummary {
    /** Custo total acumulado em USD */
    totalSpentUsd: number;
    /** Limite de budget em USD (0 = sem limite) */
    budgetLimitUsd: number;
    /** Percentual utilizado (0-100) */
    budgetUsedPct: number;
    /** Budget restante em USD */
    remainingUsd: number;
    /** Total de chamadas LLM */
    totalCalls: number;
    /** Total de tokens consumidos */
    totalTokens: number;
    /** Breakdown por categoria */
    byCategory: Record<BudgetCategory, { costUsd: number; calls: number }>;
    /** Breakdown por modelo */
    byModel: Record<string, { costUsd: number; calls: number; totalTokens: number }>;
}

/**
 * Alertas de budget emitidos via EventBus.
 */
export interface BudgetAlert {
    /** Tipo do alerta */
    type: 'warning' | 'critical' | 'exceeded';
    /** Percentual usado quando o alerta disparou */
    usedPct: number;
    /** Mensagem descritiva */
    message: string;
    /** Timestamp */
    timestamp: Date;
}

// ============================================================
// Port Interface
// ============================================================

/**
 * Port para rastreamento de custos LLM.
 * Responsabilidades:
 * - Registrar uso de tokens por chamada
 * - Estimar custos baseado em tabela de preços
 * - Fornecer breakdown por modelo e categoria
 * - Emitir alertas via EventBus quando thresholds são atingidos
 */
export interface BudgetPort {
    /**
     * Registra uma chamada LLM com seu uso de tokens.
     * Calcula custo automaticamente baseado no modelo.
     */
    recordUsage(record: Omit<LLMUsageRecord, 'id' | 'timestamp' | 'costUsd'>): Promise<LLMUsageRecord>;

    /**
     * Retorna o resumo atual do budget.
     */
    getSummary(): Promise<BudgetSummary>;

    /**
     * Define o limite de budget em USD.
     * Passar 0 para desativar o limite.
     */
    setBudgetLimit(limitUsd: number): void;

    /**
     * Retorna o limite de budget atual em USD.
     */
    getBudgetLimit(): number;

    /**
     * Verifica se o budget foi excedido.
     */
    isBudgetExceeded(): Promise<boolean>;

    /**
     * Retorna os registros de uso mais recentes.
     */
    getRecentUsage(limit?: number): Promise<LLMUsageRecord[]>;

    /**
     * Inicializa o tracker (cria tabelas, etc).
     */
    initialize(): Promise<void>;

    /**
     * Fecha recursos.
     */
    close(): Promise<void>;
}
