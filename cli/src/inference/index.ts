/**
 * 🧠 Local Inference Module
 *
 * Camada de inferência local especializada com três modelos:
 * - PolicyEngine (FunctionGemma) → decisão operacional
 * - CodeWorker (Qwen2.5-Coder) → execução de tarefas de código
 * - EmbeddingEngine (EmbeddingGemma) → memória e recuperação semântica
 *
 * Barrel export para uso externo.
 */

// --- Core Infrastructure ---
export { LocalInferenceProvider, createLocalInferenceProvider } from "./LocalInferenceProvider.js";
export {
    ModelProviderError,
    type CapabilityProfile,
    type CapabilitySupport,
    type FinishReason,
    type ModelMessage,
    type ModelMessageRole,
    type ModelProvider,
    type ModelRequest,
    type ModelResponse,
    type ModelStreamChunk,
    type ModelToolCall,
    type ModelToolDefinition,
    type ModelUsage,
    type ProviderCallContext,
    type ProviderErrorKind,
} from "./ModelProvider.js";
export { ModelRegistry, createModelRegistry } from "./ModelRegistry.js";
export { ModelRouter, createModelRouter } from "./ModelRouter.js";

// --- Engines ---
export { PolicyEngine, createPolicyEngine } from "./PolicyEngine.js";
export { CodeWorker, createCodeWorker } from "./CodeWorker.js";
export { EmbeddingEngine, createEmbeddingEngine } from "./EmbeddingEngine.js";

// --- Memory & Retrieval ---
export { MemoryIndexer, createMemoryIndexer } from "./MemoryIndexer.js";
export { SemanticRetriever, createSemanticRetriever } from "./SemanticRetriever.js";
export { SemanticCache, createSemanticCache } from "./SemanticCache.js";
export { TraceEmbedder, createTraceEmbedder } from "./TraceEmbedder.js";
export { RetrievalPolicy, createRetrievalPolicy } from "./RetrievalPolicy.js";

// --- Safety & Quality ---
export { InferenceGuardrails, createInferenceGuardrails } from "./InferenceGuardrails.js";

// --- Dataset & Benchmark ---
export { DatasetPipeline, createDatasetPipeline } from "./DatasetPipeline.js";
export { LocalBenchmark, createLocalBenchmark } from "./LocalBenchmark.js";

// --- Provider security ---
export {
    CredentialRegistry,
    CredentialUnavailableError,
    CredentialScopeMismatchError,
    CredentialedProviderInvoker,
    createCredentialScope,
    loadOrCreateCredentialScopeSalt,
    type CredentialRegistryOptions,
    type CredentialSelection,
    type CredentialedProviderTransport,
    type ProviderFeatureFlags,
    type ProviderModelConfig,
    type ResolvedCredential,
} from "./provider-security.js";
export { REDACTED_VALUE, redactError, redactText, redactValue } from "./redaction.js";

// --- Subsystem Facade ---
export { InferenceSubsystem, createInferenceSubsystem } from "./InferenceSubsystem.js";
export type { InferenceSubsystemConfig, InferenceStatus } from "./InferenceSubsystem.js";

// --- Config ---
export {
    loadInferenceConfig,
    DEFAULT_MODELS,
    POLICY_SYSTEM_PROMPT,
    CODER_SYSTEM_PROMPT,
} from "./inference-config.js";
export type { LoadInferenceConfigOptions } from "./inference-config.js";

// --- Schemas ---
export {
    ActionDecisionSchema,
    ToolCallProposalSchema,
    EscalationDecisionSchema,
    UncertaintyReportSchema,
    PatchProposalSchema,
    TestFixResultSchema,
    RetrievalRequestSchema,
    RetrievalResultSchema,
    MemoryWriteCandidateSchema,
    SemanticCacheHitSchema,
    ModelFailureReportSchema,
    InferenceTraceSchema,
    type ActionDecision,
    type ToolCallProposal,
    type EscalationDecision,
    type UncertaintyReport,
    type PatchProposal,
    type TestFixResult,
    type RetrievalRequest,
    type RetrievalResult,
    type MemoryWriteCandidate,
    type SemanticCacheHit,
    type ModelFailureReport,
    type InferenceTrace,
} from "./schemas/inference-schemas.js";

// --- Types ---
export type {
    ModelRole,
    ModelCapability,
    ModelConfig,
    TaskType,
    InferenceRequest,
    InferenceMessage,
    InferenceResponse,
    EmbeddingRequest,
    EmbeddingResponse,
    RoutingRequest,
    RoutingDecision,
    InferenceProviderConfig,
    ModelMetrics,
} from "./types/inference-types.js";

export { DEFAULT_INFERENCE_CONFIG } from "./types/inference-types.js";
