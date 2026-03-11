/**
 * 🧠 Inference Schemas
 *
 * Zod schemas para todas as estruturas da camada de inferência local.
 * Garantem que saídas de modelos pequenos sejam validáveis e reproduzíveis.
 */

import { z } from "zod";

// ============================================================================
// Policy Engine Schemas (FunctionGemma)
// ============================================================================

/**
 * Decisão de próxima ação do PolicyEngine.
 */
export const ActionDecisionSchema = z.object({
    action: z.enum([
        "call_tool",
        "generate_code",
        "retrieve_memory",
        "escalate",
        "summarize",
        "classify",
        "complete",
        "wait",
    ]).describe("Ação escolhida pelo policy model"),
    reasoning: z.string().max(500).describe("Justificativa da decisão"),
    confidence: z.number().min(0).max(1).describe("Confiança na decisão [0,1]"),
    requiresRetrieval: z.boolean().describe("Se precisa recuperar contexto semântico"),
    requiresCodeModel: z.boolean().describe("Se precisa escalar para code model"),
    metadata: z.record(z.string(), z.unknown()).optional().describe("Metadados adicionais"),
});
export type ActionDecision = z.infer<typeof ActionDecisionSchema>;

/**
 * Proposta de chamada de tool.
 */
export const ToolCallProposalSchema = z.object({
    toolName: z.string().describe("Nome da tool a chamar"),
    arguments: z.record(z.string(), z.unknown()).describe("Argumentos da tool"),
    reasoning: z.string().max(300).describe("Motivo da escolha"),
    confidence: z.number().min(0).max(1).describe("Confiança"),
    alternatives: z.array(z.string()).optional().describe("Tools alternativas consideradas"),
});
export type ToolCallProposal = z.infer<typeof ToolCallProposalSchema>;

/**
 * Decisão de escalonamento.
 */
export const EscalationDecisionSchema = z.object({
    shouldEscalate: z.boolean().describe("Se deve escalar"),
    reason: z.string().describe("Motivo"),
    targetRole: z.enum(["code_model", "human", "retry"]).describe("Para quem escalar"),
    context: z.string().max(500).optional().describe("Contexto adicional para o alvo"),
});
export type EscalationDecision = z.infer<typeof EscalationDecisionSchema>;

/**
 * Relatório de incerteza do modelo.
 */
export const UncertaintyReportSchema = z.object({
    isUncertain: z.boolean().describe("Se o modelo está incerto"),
    confidence: z.number().min(0).max(1).describe("Confiança geral"),
    uncertainAreas: z.array(z.string()).describe("Áreas de incerteza"),
    suggestedAction: z.enum(["proceed", "ask_human", "retrieve_more", "retry"]),
});
export type UncertaintyReport = z.infer<typeof UncertaintyReportSchema>;

// ============================================================================
// Code Worker Schemas (Qwen2.5-Coder)
// ============================================================================

/**
 * Proposta de patch de código.
 */
export const PatchProposalSchema = z.object({
    filePath: z.string().describe("Caminho do arquivo a editar"),
    originalSnippet: z.string().describe("Trecho original a substituir"),
    patchedSnippet: z.string().describe("Trecho com a mudança aplicada"),
    explanation: z.string().max(500).describe("Explicação da mudança"),
    changeType: z.enum(["fix", "refactor", "feature", "test", "docs"]),
    confidence: z.number().min(0).max(1),
    affectsTests: z.boolean().describe("Se a mudança pode afetar testes"),
    suggestedTests: z.array(z.string()).optional().describe("Testes sugeridos para validar"),
});
export type PatchProposal = z.infer<typeof PatchProposalSchema>;

/**
 * Resultado de correção de teste.
 */
export const TestFixResultSchema = z.object({
    testFile: z.string().describe("Arquivo de teste corrigido"),
    originalError: z.string().describe("Erro original"),
    fix: PatchProposalSchema.describe("Patch proposto para correção"),
    wasSuccessful: z.boolean().describe("Se a correção parece resolver o erro"),
});
export type TestFixResult = z.infer<typeof TestFixResultSchema>;

// ============================================================================
// Embedding & Retrieval Schemas (EmbeddingGemma)
// ============================================================================

/**
 * Requisição de retrieval semântico.
 */
export const RetrievalRequestSchema = z.object({
    query: z.string().describe("Query de busca"),
    topK: z.number().int().min(1).max(50).default(5),
    source: z.enum(["memory", "codebase", "traces", "all"]).default("all"),
    minConfidence: z.number().min(0).max(1).default(0.5),
    metadata: z.record(z.string(), z.unknown()).optional(),
});
export type RetrievalRequest = z.infer<typeof RetrievalRequestSchema>;

/**
 * Resultado de retrieval semântico.
 */
export const RetrievalResultSchema = z.object({
    content: z.string().describe("Conteúdo recuperado"),
    similarity: z.number().min(0).max(1).describe("Similaridade cosseno"),
    source: z.string().describe("Origem do conteúdo"),
    sourceType: z.enum(["memory", "codebase", "trace", "cache"]),
    metadata: z.record(z.string(), z.unknown()).optional(),
    timestamp: z.string().datetime().optional(),
});
export type RetrievalResult = z.infer<typeof RetrievalResultSchema>;

/**
 * Candidato para escrita em memória semântica.
 */
export const MemoryWriteCandidateSchema = z.object({
    content: z.string().min(10).describe("Conteúdo a indexar"),
    artifactType: z.enum([
        "task_summary",
        "decision",
        "solution",
        "failure",
        "correction",
        "code_snippet",
        "trace",
        "document",
    ]).describe("Tipo do artefato"),
    label: z.string().describe("Rótulo legível"),
    origin: z.string().describe("Origem (módulo/componente que gerou)"),
    tags: z.array(z.string()).optional(),
    ttlHours: z.number().optional().describe("Tempo de vida em horas (null = permanente)"),
});
export type MemoryWriteCandidate = z.infer<typeof MemoryWriteCandidateSchema>;

/**
 * Hit de cache semântico.
 */
export const SemanticCacheHitSchema = z.object({
    originalQuery: z.string().describe("Query original da cache"),
    cachedResult: z.string().describe("Resultado previamente cacheado"),
    similarity: z.number().min(0).max(1).describe("Similaridade com a query atual"),
    age: z.number().describe("Idade da entrada em segundos"),
    reuseCount: z.number().int().describe("Vezes que foi reutilizado"),
    isValid: z.boolean().describe("Se a cache é considerada válida"),
});
export type SemanticCacheHit = z.infer<typeof SemanticCacheHitSchema>;

// ============================================================================
// Failure & Tracing Schemas
// ============================================================================

/**
 * Relatório de falha de modelo.
 */
export const ModelFailureReportSchema = z.object({
    modelId: z.string().describe("Identificador do modelo que falhou"),
    modelRole: z.enum(["policy", "coder", "embedding"]),
    errorType: z.enum([
        "timeout",
        "connection_error",
        "malformed_output",
        "invalid_json",
        "empty_response",
        "model_not_loaded",
        "out_of_memory",
        "unknown",
    ]),
    errorMessage: z.string(),
    requestDurationMs: z.number(),
    timestamp: z.string().datetime(),
    retryable: z.boolean(),
    fallbackUsed: z.boolean(),
    fallbackModel: z.string().optional(),
});
export type ModelFailureReport = z.infer<typeof ModelFailureReportSchema>;

/**
 * Trace de inferência para dataset pipeline.
 */
export const InferenceTraceSchema = z.object({
    traceId: z.string().describe("ID único do trace"),
    modelId: z.string(),
    modelRole: z.enum(["policy", "coder", "embedding"]),
    input: z.string().describe("Input enviado ao modelo"),
    output: z.string().describe("Output recebido"),
    parsedOutput: z.unknown().optional().describe("Output parseado (se JSON válido)"),
    durationMs: z.number(),
    tokenCount: z.number().optional(),
    wasValid: z.boolean().describe("Se o output foi validado com sucesso"),
    wasAccepted: z.boolean().optional().describe("Se o output foi aceito pelo runtime"),
    outcome: z.enum(["success", "failure", "rollback", "human_correction"]).optional(),
    timestamp: z.string().datetime(),
});
export type InferenceTrace = z.infer<typeof InferenceTraceSchema>;
