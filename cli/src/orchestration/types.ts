/**
 * 🎭 Orchestration Types
 * 
 * Tipos centralizados para o sistema de orquestração multi-agente.
 */

import type { WorkflowPhase } from "../utils/anti-vibe.js";

// --- ENUMS ---

/**
 * Personas que o subagente pode assumir.
 * Cada persona mapeia para uma WorkflowPhase do Anti-Vibe.
 */
export enum PersonaType {
    /** Planeja arquitetura, não executa código */
    ARCHITECT = "ARCHITECT",
    /** Implementa código seguindo spec */
    DEVELOPER = "DEVELOPER",
    /** Verifica qualidade e code review */
    REVIEWER = "REVIEWER",
    /** Executa testes e valida comportamento */
    TESTER = "TESTER",
}

/**
 * Status do resultado de uma task.
 */
export enum TaskStatus {
    SUCCESS = "SUCCESS",
    FAILURE = "FAILURE",
    PENDING = "PENDING",
    NEEDS_HUMAN = "NEEDS_HUMAN",
    /** Cooperative cancel (emergency brake / abort). */
    CANCELLED = "CANCELLED",
}

// --- INTERFACES ---

/**
 * Entrada no histórico de contexto.
 */
export interface ContextEntry {
    /** Timestamp da tentativa */
    timestamp: Date;
    /** Prompt enviado */
    prompt: string;
    /** Output recebido */
    output: string;
    /** Erro (se houver) */
    error?: string;
    /** Persona que executou */
    persona: PersonaType;
}

/**
 * Resultado de execução do subagente.
 */
export interface TaskResult {
    /** Status final da execução */
    status: TaskStatus;
    /** Output completo do subagente */
    output: string;
    /** Mensagem de erro (se houver) */
    error?: string;
    /** Número de tentativas até este resultado */
    retryCount: number;
    /** Persona que executou a task */
    persona: PersonaType;
    /** Duração da execução em ms */
    durationMs: number;
    /** Histórico de todas as tentativas (evita "loop de amnésia") */
    contextHistory: ContextEntry[];
    /** ID da task pai (para rastreabilidade multi-agente) */
    parentTaskId?: string;
}

/**
 * Definição de uma task para o Orchestrator.
 */
export interface OrchestratorTask {
    /** Identificador único da task */
    id: string;
    /** Prompt/instrução para o subagente */
    instruction: string;
    /** Persona que deve executar */
    persona: PersonaType;
    /** Contexto adicional (arquivos, specs, etc) */
    context?: string;
    /** Working directory para execução */
    workDir?: string;
    /** Estratégia de validação programática (opcional) */
    validationStrategy?: ValidationStrategy;
}

/**
 * Configuração do Orchestrator.
 */
export interface OrchestratorConfig {
    /** Número máximo de retries antes de escalar para humano */
    maxRetries: number;
    /** Se true, requer aprovação HumanLayer antes de execução */
    requireApproval: boolean;
    /** Callback para solicitar aprovação (se requireApproval=true) */
    onApprovalRequired?: (task: OrchestratorTask) => Promise<boolean>;
    /** Habilita logs detalhados */
    verbose: boolean;
    /** Timeout em ms para cada execução */
    timeoutMs: number;
    /** Se true, pula validação Anti-Vibe (para tarefas simples de teste) */
    skipPhaseValidation: boolean;
}

/**
 * Mapeamento de Persona → WorkflowPhase.
 * Define qual fase do Anti-Vibe cada persona opera.
 */
export const PERSONA_PHASE_MAP: Record<PersonaType, WorkflowPhase> = {
    [PersonaType.ARCHITECT]: "SPECIFICATION" as WorkflowPhase,
    [PersonaType.DEVELOPER]: "EXECUTION" as WorkflowPhase,
    [PersonaType.REVIEWER]: "RESEARCH" as WorkflowPhase,
    [PersonaType.TESTER]: "RESEARCH" as WorkflowPhase,
};

/**
 * Cadeia de escalonamento entre personas.
 * Se persona X falha, escala para persona Y.
 */
export const ESCALATION_CHAIN: Record<PersonaType, PersonaType | null> = {
    [PersonaType.DEVELOPER]: PersonaType.REVIEWER,
    [PersonaType.REVIEWER]: PersonaType.ARCHITECT,
    [PersonaType.ARCHITECT]: null, // Escala para humano
    [PersonaType.TESTER]: PersonaType.DEVELOPER,
};

/**
 * Contexto de validação passado para a estratégia.
 * Inspirado no OpenClaw - fornece contexto completo para validação.
 */
export interface ValidationContext {
    /** Diretório de trabalho para execução de comandos */
    workDir: string;
    /** ID da task sendo validada */
    taskId: string;
    /** Output do agente a ser validado */
    output: string;
    /** Contexto adicional (opcional) */
    additionalContext?: string;
}

/**
 * Resultado de uma validação.
 */
export interface ValidationResult {
    /** Se a validação passou */
    isValid: boolean;
    /** Mensagem descritiva do resultado */
    message: string;
    /** Exit code do comando (para CommandValidationStrategy) */
    exitCode?: number;
    /** Detalhes adicionais */
    details?: Record<string, unknown>;
}

/**
 * Interface para estratégias de validação programática.
 * Permite validar resultado sem depender de heurísticas de texto.
 * 
 * Padrão Strategy - cada implementação define sua lógica:
 * - CommandValidationStrategy: executa comando shell, valida exit code
 * - TypeCheckValidationStrategy: roda bun check (futuro)
 * - TestValidationStrategy: roda suite de testes (futuro)
 */
export interface ValidationStrategy {
    /** Nome da estratégia */
    name: string;
    /** Executa validação com contexto completo */
    validate(context: ValidationContext): Promise<ValidationResult>;
}

/**
 * Configuração padrão do Orchestrator.
 */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
    maxRetries: 3,
    requireApproval: true,
    verbose: true,
    timeoutMs: 300_000, // 5 minutos - GLM 4.7 pode demorar para tarefas com arquivos
    skipPhaseValidation: false, // true para tarefas simples de teste
};

/**
 * Indicadores de sucesso no output do subagente.
 */
export const SUCCESS_INDICATORS = [
    "✅",
    "SUCCESS",
    "DONE",
    "completed successfully",
    "all tests passed",
];

/**
 * Indicadores de falha no output do subagente.
 */
export const FAILURE_INDICATORS = [
    "❌",
    "ERROR",
    "FAILED",
    "Exception",
    "Traceback",
    "SyntaxError",
    "TypeError",
    "ReferenceError",
];
