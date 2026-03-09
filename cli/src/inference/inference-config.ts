/**
 * 🔧 Inference Configuration
 *
 * Configuração centralizada da camada de inferência local.
 * Lida com variáveis de ambiente, defaults e validação.
 */

import type { ModelConfig, InferenceProviderConfig } from "./types/inference-types.js";

// ============================================================================
// Environment-based Config
// ============================================================================

/**
 * Carrega configuração do provider a partir de env vars.
 */
export function loadInferenceConfig(): InferenceProviderConfig {
    return {
        ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
        defaultTimeoutMs: parseInt(process.env.INFERENCE_TIMEOUT_MS ?? "60000", 10),
        maxRetries: parseInt(process.env.INFERENCE_MAX_RETRIES ?? "3", 10),
        retryDelayMs: parseInt(process.env.INFERENCE_RETRY_DELAY_MS ?? "1000", 10),
        logRequests: process.env.INFERENCE_LOG_REQUESTS !== "false",
        collectMetrics: process.env.INFERENCE_COLLECT_METRICS !== "false",
        traceDir: process.env.INFERENCE_TRACE_DIR ?? ".agent/traces",
    };
}

// ============================================================================
// Default Model Configurations
// ============================================================================

/**
 * System prompt do FunctionGemma (policy model).
 *
 * Extremamente objetivo. Sempre saída estruturada.
 * Nunca código longo. Nunca inventar argumentos.
 * Declarar incerteza explicitamente.
 */
export const POLICY_SYSTEM_PROMPT = `You are a policy decision model for an autonomous agent runtime.

Your role: Select the next action, choose tools, decide retrieval needs, and classify intent.

Rules:
- ALWAYS respond in valid JSON matching the requested schema
- NEVER write code longer than 5 lines
- NEVER invent tool arguments you don't know
- NEVER provide explanations outside the JSON structure
- If uncertain, set confidence < 0.5 and suggestedAction: "ask_human"
- Be decisive but honest about uncertainty
- Prefer simple actions over complex chains

Output format: Always valid JSON. No markdown. No prose.`;

/**
 * System prompt do Qwen2.5-Coder (code model).
 *
 * Focado em mudanças pequenas, locais e verificáveis.
 * Preferir patch mínimo. Preservar estilo existente.
 */
export const CODER_SYSTEM_PROMPT = `You are a code editing assistant for an autonomous agent runtime.

Your role: Generate minimal, targeted code patches.

Rules:
- ALWAYS respond in valid JSON matching the requested schema
- Generate the SMALLEST possible patch that solves the problem
- NEVER rewrite entire files unless absolutely necessary
- PRESERVE existing code style and conventions
- NEVER introduce new dependencies without explicit request
- When changing behavior, suggest tests to validate
- Include a brief explanation of what changed and why
- If you cannot solve the problem, say so honestly

Output format: Always valid JSON with filePath, originalSnippet, patchedSnippet, explanation.`;

/**
 * Nota: EmbeddingGemma não é modelo de geração — não tem system prompt.
 * É usado para indexação, busca semântica, clustering e similarity.
 * Sua integração é tratada como infraestrutura de memória e retrieval.
 */

// ============================================================================
// Default Model Registry
// ============================================================================

/**
 * Configurações padrão dos 3 modelos.
 */
export const DEFAULT_MODELS: ModelConfig[] = [
    {
        id: "policy",
        name: "FunctionGemma 270M",
        role: "policy",
        capabilities: [
            "action_selection",
            "tool_routing",
            "intent_classification",
            "state_summarization",
        ],
        ollamaModel: process.env.POLICY_MODEL ?? "gemma3:1b",
        maxTokens: 512,
        defaultTemperature: 0.1,
        systemPrompt: POLICY_SYSTEM_PROMPT,
        enabled: true,
    },
    {
        id: "coder",
        name: "Qwen2.5-Coder-0.5B-Instruct",
        role: "coder",
        capabilities: [
            "patch_generation",
            "code_edit",
            "test_fix",
            "refactor",
        ],
        ollamaModel: process.env.CODER_MODEL ?? "qwen2.5-coder:0.5b",
        maxTokens: 1024,
        defaultTemperature: 0.2,
        systemPrompt: CODER_SYSTEM_PROMPT,
        enabled: true,
    },
    {
        id: "embedding",
        name: "EmbeddingGemma 300M",
        role: "embedding",
        capabilities: [
            "embedding_generation",
            "semantic_search",
            "similarity",
            "clustering",
        ],
        ollamaModel: process.env.EMBEDDING_MODEL ?? "all-minilm:33m",
        maxTokens: 0,
        defaultTemperature: 0,
        enabled: true,
        embeddingDimension: 384,
    },
];
