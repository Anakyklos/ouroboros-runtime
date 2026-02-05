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
} from "./types.js";
