/**
 * 🧠 Inference Types
 *
 * Types compartilhados para a camada de inferência local.
 */

// ============================================================================
// Model Configuration
// ============================================================================

/**
 * Papel que um modelo desempenha no runtime.
 */
export type ModelRole = "policy" | "coder" | "embedding";

/**
 * Capacidades declaradas de um modelo.
 */
export type ModelCapability =
    | "action_selection"
    | "tool_routing"
    | "intent_classification"
    | "state_summarization"
    | "patch_generation"
    | "code_edit"
    | "test_fix"
    | "refactor"
    | "embedding_generation"
    | "semantic_search"
    | "similarity"
    | "clustering";

/**
 * Configuração de um modelo registrado.
 */
export interface ModelConfig {
    /** Identificador único (ex: "functiongemma:270m") */
    id: string;
    /** Nome legível */
    name: string;
    /** Papel no runtime */
    role: ModelRole;
    /** Capacidades declaradas */
    capabilities: ModelCapability[];
    /** Nome do modelo no Ollama */
    ollamaModel: string;
    /** Máximo de tokens de resposta */
    maxTokens: number;
    /** Temperatura padrão */
    defaultTemperature: number;
    /** System prompt padrão */
    systemPrompt?: string;
    /** Se o modelo está habilitado */
    enabled: boolean;
    /** Dimensão do embedding (só para modelos de embedding) */
    embeddingDimension?: number;
}

/**
 * Tipo de tarefa para roteamento.
 */
export type TaskType =
    | "tool_selection"
    | "action_planning"
    | "state_summary"
    | "intent_classification"
    | "patch_generation"
    | "code_edit"
    | "test_fix"
    | "refactor"
    | "embedding"
    | "retrieval"
    | "similarity"
    | "clustering";

// ============================================================================
// Inference Request/Response
// ============================================================================

/**
 * Requisição de inferência ao provider local.
 */
export interface InferenceRequest {
    /** ID do modelo (buscar no registry) */
    modelId: string;
    /** Mensagens de chat */
    messages: InferenceMessage[];
    /** Temperatura (override do default do modelo) */
    temperature?: number;
    /** Máximo de tokens de resposta (override) */
    maxTokens?: number;
    /** Schema JSON esperado na resposta (para structured output) */
    responseSchema?: Record<string, unknown>;
    /** Trace ID para rastreamento */
    traceId?: string;
    /** Timeout em ms (override) */
    timeoutMs?: number;
}

/**
 * Mensagem de inferência.
 */
export interface InferenceMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

/**
 * Resposta de inferência do provider.
 */
export interface InferenceResponse {
    /** Conteúdo textual da resposta */
    content: string;
    /** Modelo usado */
    modelId: string;
    /** Duração da inferência em ms */
    durationMs: number;
    /** Contagem de tokens (estimada) */
    tokenCount?: number;
    /** Se houve fallback para outro modelo */
    usedFallback: boolean;
    /** Trace ID */
    traceId: string;
    /** Se a resposta é JSON válido */
    isValidJSON: boolean;
}

/**
 * Requisição de embedding.
 */
export interface EmbeddingRequest {
    /** Texto para gerar embedding */
    text: string;
    /** ID do modelo de embedding */
    modelId?: string;
    /** Trace ID */
    traceId?: string;
}

/**
 * Resposta de embedding.
 */
export interface EmbeddingResponse {
    /** Vetor de embedding */
    vector: number[];
    /** Dimensão do vetor */
    dimension: number;
    /** Modelo usado */
    modelId: string;
    /** Duração em ms */
    durationMs: number;
    /** Trace ID */
    traceId: string;
}

// ============================================================================
// Routing
// ============================================================================

/**
 * Requisição de roteamento.
 */
export interface RoutingRequest {
    /** Tipo da tarefa */
    taskType: TaskType;
    /** Contexto adicional */
    context?: string;
    /** Se deve preferir velocidade sobre qualidade */
    preferSpeed?: boolean;
}

/**
 * Decisão de roteamento com justificativa.
 */
export interface RoutingDecision {
    /** Modelo escolhido */
    modelId: string;
    /** Papel do modelo */
    role: ModelRole;
    /** Justificativa */
    reasoning: string;
    /** Fallback (se o modelo primário falhar) */
    fallbackModelId?: string;
    /** Timestamp */
    timestamp: string;
}

// ============================================================================
// Inference Provider Config
// ============================================================================

/**
 * Configuração do provider de inferência local.
 */
export interface InferenceProviderConfig {
    /** URL base do Ollama */
    ollamaBaseUrl: string;
    /** Timeout padrão em ms */
    defaultTimeoutMs: number;
    /** Número de retries */
    maxRetries: number;
    /** Delay base entre retries em ms */
    retryDelayMs: number;
    /** Se deve logar todas as requisições */
    logRequests: boolean;
    /** Se deve coletar métricas */
    collectMetrics: boolean;
    /** Diretório para persistir traces */
    traceDir?: string;
}

/**
 * Configuração padrão do provider de inferência.
 */
export const DEFAULT_INFERENCE_CONFIG: InferenceProviderConfig = {
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    defaultTimeoutMs: 60_000,
    maxRetries: 3,
    retryDelayMs: 1000,
    logRequests: true,
    collectMetrics: true,
    traceDir: ".agent/traces",
};

/**
 * Métricas coletadas por modelo.
 */
export interface ModelMetrics {
    modelId: string;
    totalRequests: number;
    successCount: number;
    failureCount: number;
    validJSONCount: number;
    totalDurationMs: number;
    avgDurationMs: number;
    validJSONRate: number;
    lastRequestAt: string;
}
