/**
 * 🎯 Orchestration Module
 * 
 * Exports for multi-agent orchestration system.
 */

export {
    Orchestrator,
    createOrchestrator,
    createTask,
} from "./Orchestrator.js";

export {
    MemoryManager,
    createMemoryManager,
} from "./MemoryManager.js";

// Validation Strategies
export {
    CommandValidationStrategy,
    createTestValidationStrategy,
    createTypeCheckValidationStrategy,
    createLintValidationStrategy,
    createCustomValidationStrategy,
} from "./strategies/index.js";

// Promotion Manager (Anti-Vibe Quality Gates)
export {
    PromotionManager,
    createPromotionManager,
} from "./PromotionManager.js";

export {
    ValidationReporter,
    createValidationReporter,
    createQuietReporter,
} from "./ValidationReporter.js";

export {
    PromotionStatus,
    QualityGateType,
    DEFAULT_PROMOTION_CONFIG,
    QUALITY_GATE_COMMANDS,
    type PromotionCandidate,
    type PromotionConfig,
    type PromotionResult,
    type PromotionState,
    type ApprovalCallback,
    type PromotionValidation,
} from "./promotion-types.js";

export {
    PersonaType,
    TaskStatus,
    PERSONA_PHASE_MAP,
    ESCALATION_CHAIN,
    DEFAULT_ORCHESTRATOR_CONFIG,
    SUCCESS_INDICATORS,
    FAILURE_INDICATORS,
    type TaskResult,
    type OrchestratorTask,
    type OrchestratorConfig,
    type ContextEntry,
    type ValidationStrategy,
    type ValidationResult,
    type ValidationContext,
} from "./types.js";

