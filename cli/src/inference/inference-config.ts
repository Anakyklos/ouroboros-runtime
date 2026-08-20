/**
 * 🔧 Inference Configuration
 *
 * Configuração centralizada da camada de inferência local.
 * Lida com variáveis de ambiente, defaults e validação.
 */

import type { CredentialRegistry } from "./provider-security.js";
import type { ModelConfig, InferenceProviderConfig } from "./types/inference-types.js";

export interface LoadInferenceConfigOptions {
    env?: NodeJS.ProcessEnv;
    credentialRegistry?: CredentialRegistry;
}

// ============================================================================
// Environment-based Config
// ============================================================================

/**
 * Lê um inteiro finito dentro do domínio permitido. Configuração inválida
 * falha no startup em vez de ser convertida silenciosamente em NaN/negativo.
 */
function parseInteger(
    env: NodeJS.ProcessEnv,
    name: string,
    fallback: number,
    minimum: number,
): number {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    if (!/^-?\d+$/.test(raw.trim())) {
        throw new Error(`${name} must be an integer`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${name} must be an integer >= ${minimum}`);
    }
    return value;
}

/**
 * Carrega configuração do provider a partir de env vars.
 * O suporte BYOK é opt-in: um registry explícito recebe a chave apenas em
 * memória; o objeto retornado contém somente a referência não sensível.
 */
export function loadInferenceConfig(options: LoadInferenceConfigOptions = {}): InferenceProviderConfig {
    const env = options.env ?? process.env;
    const ollamaBaseUrl = env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    const defaultTimeoutMs = parseInteger(env, "INFERENCE_TIMEOUT_MS", 60_000, 1);
    const maxRetries = parseInteger(env, "INFERENCE_MAX_RETRIES", 3, 0);
    const retryDelayMs = parseInteger(env, "INFERENCE_RETRY_DELAY_MS", 1000, 0);
    const credentialSources = [] as NonNullable<InferenceProviderConfig["credentialSources"]>;
    const nvidiaApiKey = env.NVIDIA_API_KEY?.trim();
    if (nvidiaApiKey) {
        const credentialRef = "credential://env/nvidia-api-key";
        options.credentialRegistry?.register(credentialRef, nvidiaApiKey);
        credentialSources.push({
            providerId: "nvidia-nim",
            credentialRef,
            source: "NVIDIA_API_KEY",
        });
    }

    return {
        ollamaBaseUrl,
        defaultTimeoutMs,
        maxRetries,
        retryDelayMs,
        logRequests: env.INFERENCE_LOG_REQUESTS !== "false",
        collectMetrics: env.INFERENCE_COLLECT_METRICS !== "false",
        traceDir: env.INFERENCE_TRACE_DIR ?? ".agent/traces",
        credentialSources,
        providerModel: {
            providerId: "ollama-local",
            modelId: "default",
            endpoint: ollamaBaseUrl,
            timeoutMs: defaultTimeoutMs,
            featureFlags: {
                streaming: false,
                tools: false,
                structuredOutput: false,
            },
        },
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
// Constants
// ============================================================================

/** Dimensão padrão de embedding (all-minilm:33m) */
export const DEFAULT_EMBEDDING_DIMENSION = 384;

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
