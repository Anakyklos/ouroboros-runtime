/**
 * 🎯 Orchestrator
 * 
 * Sistema de orquestração multi-agente com loop de auto-correção.
 * Coordena subagentes seguindo o protocolo Anti-Vibe.
 */

import {
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
import { AgentLoop, createAgent, type AgentResult } from "../providers/agent-loop.js";
import {
    WorkflowPhase,
    buildAntiVibePrompt,
    validatePhaseGate,
} from "../utils/anti-vibe.js";
import { MemoryManager } from "./MemoryManager.js";
import { MemoryRetriever, createMemoryRetriever } from "./MemoryRetriever.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";
import { getWorkspacePath } from "../utils/ouroboros.js";
import { QualityGateRegistry, createQualityGateRegistry, type QualityGatesReport } from "./strategies/QualityGateRegistry.js";
import { SpecValidator, createDefaultSpecValidator } from "./validators/SpecValidator.js";

/**
 * Orchestrator - Coordena execução de subagentes com auto-correção.
 */
/** Thrown when emergency brake / cancel aborts an in-flight attempt. */
export class OrchestratorCancelledError extends Error {
    constructor(message = "Orchestrator cancelled") {
        super(message);
        this.name = "OrchestratorCancelledError";
    }
}

export class Orchestrator {
    private agentLoop: AgentLoop | null = null;
    private config: OrchestratorConfig;
    private memory: MemoryManager;
    private eventBus: EventBus;
    private isPaused = false;
    private resumeResolver: (() => void) | null = null;
    /** Cooperative cancel — aborts waitIfPaused and provider fetch via AbortSignal. */
    private cancelled = false;
    private cancelReject: ((err: OrchestratorCancelledError) => void) | null = null;
    /** Per-run abort controller (new for each loopUntilSuccess). */
    private runAbort: AbortController | null = null;
    private memoryRetriever: MemoryRetriever;
    private qualityGateRegistry: QualityGateRegistry;
    private enableQualityGates: boolean;
    private specValidator: SpecValidator;

    constructor(config: Partial<OrchestratorConfig> = {}, eventBus?: EventBus) {
        this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
        this.memory = new MemoryManager();
        this.memoryRetriever = createMemoryRetriever();

        // Initialize quality gate registry (disabled by default, can be enabled via config)
        this.enableQualityGates = (config as any).enableQualityGates ?? false;
        this.qualityGateRegistry = createQualityGateRegistry(
            this.config.verbose,
            this.enableQualityGates // only register defaults if enabled
        );

        // Initialize spec validator for enhanced phase gate validation
        this.specValidator = createDefaultSpecValidator();

        if (eventBus) {
            this.eventBus = eventBus;
        } else {
            // No EventBus provided: create local instance with console logging
            this.eventBus = new EventBus();
            this.eventBus.on('log', (event) => {
                const timestamp = event.timestamp.toISOString();
                const prefix = `[${timestamp}] [${event.source || 'Orchestrator'}]`;
                switch (event.level) {
                    case 'debug':
                        if (this.config.verbose) console.debug(prefix, event.message);
                        break;
                    case 'info':
                        console.log(prefix, event.message);
                        break;
                    case 'warn':
                        console.warn(prefix, event.message);
                        break;
                    case 'error':
                        console.error(prefix, event.message);
                        break;
                }
            });
        }
    }

    /**
     * Initialize the agent loop with API key.
     * Must be called before executing tasks.
     */
    initialize(apiKey: string): void {
        this.agentLoop = createAgent({
            apiKey,
            workingDirectory: getWorkspacePath(),
            verbose: this.config.verbose,
        });
        this.log('info', '✅ Orchestrator initialized with DirectZAI');
    }

    /**
     * Pause execution loop (between iterations only, unless cancel is used).
     */
    pause(): void {
        this.isPaused = true;
        this.log('info', '⏸️ Paused');
    }

    /**
     * Resume execution loop. Clears cooperative cancel so a new task can run.
     */
    resume(): void {
        this.cancelled = false;
        this.isPaused = false;
        if (this.resumeResolver) {
            this.resumeResolver();
            this.resumeResolver = null;
        }
        this.log('info', '▶️ Resumed');
    }

    /**
     * Cooperative cancel: unblocks pause waits and races in-flight execute
     * so loopUntilSuccess can settle as CANCELLED without waiting for the provider.
     */
    cancel(reason = "Emergency brake"): void {
        this.cancelled = true;
        this.isPaused = true;
        try {
            this.runAbort?.abort(reason);
        } catch {
            /* ignore double-abort */
        }
        if (this.resumeResolver) {
            this.resumeResolver();
            this.resumeResolver = null;
        }
        if (this.cancelReject) {
            this.cancelReject(new OrchestratorCancelledError(reason));
            this.cancelReject = null;
        }
        this.log('warn', `🛑 Cancelled: ${reason}`);
    }

    /** Active abort signal for the current run (tests / diagnostics). */
    get currentRunSignal(): AbortSignal | null {
        return this.runAbort?.signal ?? null;
    }

    isCancelled(): boolean {
        return this.cancelled;
    }

    /**
     * Wait until resumed (if paused). Cancel resolves the wait so the loop can exit.
     */
    private async waitIfPaused(): Promise<void> {
        if (this.cancelled) {
            throw new OrchestratorCancelledError();
        }
        if (!this.isPaused) return;
        await new Promise<void>((resolve, reject) => {
            this.resumeResolver = () => {
                if (this.cancelled) {
                    reject(new OrchestratorCancelledError());
                } else {
                    resolve();
                }
            };
        });
    }

    private cancelledResult(task: OrchestratorTask, startTime: number, contextHistory: ContextEntry[]): TaskResult {
        return {
            status: TaskStatus.CANCELLED,
            output: "",
            error: "Cancelled by emergency brake",
            retryCount: 0,
            persona: task.persona,
            durationMs: Date.now() - startTime,
            contextHistory,
        };
    }

    /**
     * Loop principal de execução com retry automático.
     * Executa task até sucesso ou max retries.
     * Mantém contextHistory para evitar "loop de amnésia".
     */
    async loopUntilSuccess(task: OrchestratorTask): Promise<TaskResult> {
        let retryCount = 0;
        let lastError: string | undefined;
        const startTime = Date.now();
        const contextHistory: ContextEntry[] = [];
        // Fresh abort controller per run so concurrent runs are not silently supported —
        // SessionManager must serialize; this still replaces any previous run's controller.
        this.runAbort = new AbortController();
        this.cancelled = false;

        this.log('info', `🎯 Starting task: ${task.id}`);
        this.log('info', `   Persona: ${task.persona}`);
        this.log('info', `   Max retries: ${this.config.maxRetries}`);

        // Check for approval
        if (this.config.requireApproval) {
            this.log('info', `🔒 Waiting for approval for task: ${task.id}`);
            if (this.config.onApprovalRequired) {
                const approved = await this.config.onApprovalRequired(task);
                if (!approved) {
                    this.log('warn', `⛔ Task rejected by user: ${task.id}`);
                    return {
                        status: TaskStatus.FAILURE,
                        output: "Task rejected by user approval",
                        retryCount: 0,
                        persona: task.persona,
                        durationMs: Date.now() - startTime,
                        contextHistory: []
                    };
                }
                this.log('info', `✅ Task approved: ${task.id}`);
            } else {
                this.log('warn', `⚠️ requireApproval is true but no callback provided. Proceeding.`);
            }
        }

        while (retryCount < this.config.maxRetries) {
            if (this.cancelled) {
                return this.cancelledResult(task, startTime, contextHistory);
            }
            // Check pause state before each iteration
            try {
                await this.waitIfPaused();
            } catch (e) {
                if (e instanceof OrchestratorCancelledError) {
                    return this.cancelledResult(task, startTime, contextHistory);
                }
                throw e;
            }
            try {
                // 1. Build prompt com Anti-Vibe protocol
                const phase = PERSONA_PHASE_MAP[task.persona];
                const prompt = await this.buildPrompt(task, lastError, contextHistory);

                // 2. Validate phase gate (blocks EXECUTION without spec)
                // Skip if configured for simple tasks
                if (!this.config.skipPhaseValidation) {
                    await this.validatePhase(phase, task.workDir);
                }

                // 3. Execute via AgentLoop — race cancel so brake can settle without waiting for provider
                this.log('info', `\n🔄 Attempt ${retryCount + 1}/${this.config.maxRetries}`);
                const cancelRace = new Promise<never>((_, reject) => {
                    if (this.cancelled) {
                        reject(new OrchestratorCancelledError());
                        return;
                    }
                    this.cancelReject = reject;
                });
                let result;
                try {
                    result = await Promise.race([
                        this.executeWithTimeout(prompt),
                        cancelRace,
                    ]);
                } catch (e) {
                    this.cancelReject = null;
                    if (e instanceof OrchestratorCancelledError || this.cancelled) {
                        return this.cancelledResult(task, startTime, contextHistory);
                    }
                    throw e;
                } finally {
                    this.cancelReject = null;
                }
                if (this.cancelled) {
                    return this.cancelledResult(task, startTime, contextHistory);
                }

                // 4. Add to context history (evita loop de amnésia)
                contextHistory.push({
                    timestamp: new Date(),
                    prompt,
                    output: result.content,
                    error: undefined,
                    persona: task.persona,
                });

                // 5. Evaluate result (heurística de texto)
                const evaluation = this.evaluateResult(result);

                if (evaluation.status === TaskStatus.SUCCESS) {
                    // 5.1 NOVO: Validação programática (se disponível)
                    // Protocolo Anti-Vibe: "Trust but Verify"
                    if (task.validationStrategy) {
                        this.log('info', `🔬 Running programmatic validation: ${task.validationStrategy.name}`);

                        const validationResult = await task.validationStrategy.validate({
                            workDir: task.workDir || process.cwd(),
                            taskId: task.id,
                            output: result.content,
                            additionalContext: task.context,
                        });

                        if (!validationResult.isValid) {
                            this.log('error', `❌ Validation failed (exit code ${validationResult.exitCode}): ${validationResult.message}`);
                            lastError = validationResult.message;

                            // Add validation failure to context history
                            contextHistory.push({
                                timestamp: new Date(),
                                prompt: `[VALIDATION] ${task.validationStrategy.name}`,
                                output: "",
                                error: validationResult.message,
                                persona: task.persona,
                            });

                            retryCount++;
                            continue; // Volta para o loop de retry
                        }

                        this.log('info', `✅ Validation passed: ${validationResult.message}`);
                    }

                    // 5.2 NOVO: Quality Gates automáticos para fase EXECUTION
                    // Protocolo Anti-Vibe: qualidade obrigatória após EXECUTION
                    if (this.enableQualityGates && phase === WorkflowPhase.EXECUTION) {
                        this.log('info', `🚦 Running quality gates for EXECUTION phase task`);

                        const qualityReport = await this.runQualityGates(task);

                        if (!qualityReport.passed) {
                            // Quality gates failed - treat as validation failure
                            const failedGates = qualityReport.failed.map(f => f.type).join(', ');
                            lastError = `Quality gates failed: ${failedGates}`;

                            this.log('error', `❌ Quality gates failed: ${failedGates}`);

                            // Add quality gate failure to context history
                            contextHistory.push({
                                timestamp: new Date(),
                                prompt: `[QUALITY_GATES]`,
                                output: "",
                                error: lastError,
                                persona: task.persona,
                            });

                            retryCount++;
                            continue; // Volta para o loop de retry
                        }

                        this.log('info', `✅ Quality gates passed (${qualityReport.succeeded.length} gates) in ${qualityReport.totalDurationMs}ms`);
                    }

                    // 5.3 Sucesso confirmado (heurística + validação programática + quality gates)
                    this.log('info', `✅ Task completed successfully!`);
                    const taskResult: TaskResult = {
                        status: TaskStatus.SUCCESS,
                        output: result.content,
                        retryCount,
                        persona: task.persona,
                        durationMs: Date.now() - startTime,
                        contextHistory,
                    };
                    // Save to persistent memory (OpenClaw-inspired)
                    await this.memory.saveTaskResult(task.id, taskResult);
                    return taskResult;
                }

                // 6. Handle failure - extract error and prepare retry
                lastError = evaluation.error || "Unknown error";
                this.log('warn', `❌ Attempt failed: ${lastError}`);

                // 7. Auto-fix issues
                const fixedInstruction = this.fixIssues(task.instruction, lastError);
                task = { ...task, instruction: fixedInstruction };

                retryCount++;

            } catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
                this.log('error', `💥 Exception: ${lastError}`);
                contextHistory.push({
                    timestamp: new Date(),
                    prompt: task.instruction,
                    output: "",
                    error: lastError,
                    persona: task.persona,
                });
                retryCount++;
            }
        }

        // Max retries exceeded - try escalation before going to human
        const escalateTo = ESCALATION_CHAIN[task.persona];
        if (escalateTo) {
            this.log('info', `\n🔼 Escalating from ${task.persona} to ${escalateTo}`);
            const escalatedTask: OrchestratorTask = {
                ...task,
                id: `${task.id}_escalated`,
                persona: escalateTo,
                context: `Previous persona (${task.persona}) failed after ${retryCount} attempts.\nLast error: ${lastError}\n\n${task.context || ""}`,
            };
            return this.loopUntilSuccess(escalatedTask);
        }

        // No escalation possible - go to human
        this.log('warn', `\n🆘 Max retries exceeded. Escalating to human.`);
        const failResult: TaskResult = {
            status: TaskStatus.NEEDS_HUMAN,
            output: "",
            error: lastError,
            retryCount,
            persona: task.persona,
            durationMs: Date.now() - startTime,
            contextHistory,
        };
        // Save failure to memory for learning
        await this.memory.saveTaskResult(task.id, failResult);
        return failResult;
    }

    /**
     * Avalia resultado do subagente.
     * Detecta sucesso/falha baseado em indicadores no output.
     */
    evaluateResult(result: AgentResult): { status: TaskStatus; error?: string } {
        const output = result.content.toLowerCase();

        // Check explicit failure first
        if (!result.success) {
            return {
                status: TaskStatus.FAILURE,
                error: "Execution failed",
            };
        }

        // Check for failure indicators in output
        for (const indicator of FAILURE_INDICATORS) {
            if (result.content.includes(indicator)) {
                // Extract error context (line containing the indicator)
                const errorLine = result.content
                    .split("\n")
                    .find((line: string) => line.includes(indicator));
                return {
                    status: TaskStatus.FAILURE,
                    error: errorLine || `Output contains failure indicator: ${indicator}`,
                };
            }
        }

        // Check for success indicators
        for (const indicator of SUCCESS_INDICATORS) {
            if (output.includes(indicator.toLowerCase())) {
                return { status: TaskStatus.SUCCESS };
            }
        }

        // No clear indicators - assume success if no errors
        return { status: TaskStatus.SUCCESS };
    }

    /**
     * Gera prompt corrigido baseado no erro anterior.
     * Adiciona contexto de erro para guiar o subagente.
     */
    fixIssues(originalInstruction: string, error: string): string {
        const fixPrompt = `
⚠️ PREVIOUS ATTEMPT FAILED with error:
\`\`\`
${error}
\`\`\`

Please fix the issue and try again. Original task:
${originalInstruction}

IMPORTANT: Analyze the error carefully before proceeding.
`;
        return fixPrompt.trim();
    }

    // --- PRIVATE HELPERS ---

    /**
     * Build prompt with Anti-Vibe context injection.
     * Inclui contextHistory para dar memória ao agente.
     */
    private async buildPrompt(
        task: OrchestratorTask,
        previousError?: string,
        contextHistory: ContextEntry[] = [],
        memoryContext?: string
    ): Promise<string> {
        let prompt = task.instruction;

        // Add retrieved memory context (from MemoryRetriever)
        if (memoryContext) {
            prompt = `${memoryContext}\n\n---\n\n${prompt}`;
        }

        // Add context if provided
        if (task.context) {
            prompt = `${task.context}\n\n---\n\n${prompt}`;
        }

        // Add history summary to avoid "amnesia loop"
        if (contextHistory.length > 0) {
            const historySum = contextHistory.slice(-3).map((entry, i) =>
                `Attempt ${i + 1}: ${entry.error ? `FAILED (${entry.error})` : 'Executed'}`
            ).join('\n');
            prompt = `Previous attempts:\n${historySum}\n\n---\n\n${prompt}`;
        }

        // If retrying, use fixIssues to add error context
        if (previousError) {
            prompt = this.fixIssues(prompt, previousError);
        }

        // Apply Anti-Vibe protocol (or skip for simple tasks)
        if (this.config.skipPhaseValidation) {
            // Simple mode: just return the prompt with persona hint
            const phase = PERSONA_PHASE_MAP[task.persona];
            return `[Mode: ${phase}]\n\n${prompt}`;
        }

        const phase = PERSONA_PHASE_MAP[task.persona];
        return await buildAntiVibePrompt(prompt, phase);
    }

    /**
     * Validate Anti-Vibe phase gate.
     * For EXECUTION phase, also validates spec content using SpecValidator.
     */
    private async validatePhase(phase: WorkflowPhase, workDir?: string): Promise<void> {
        try {
            // Basic phase gate validation (checks spec file existence)
            await validatePhaseGate(phase);

            // Enhanced spec validation for EXECUTION phase
            // Protocolo Anti-Vibe: "Trust but Verify"
            if (phase === WorkflowPhase.EXECUTION) {
                this.log('info', `🔬 Running enhanced spec validation for EXECUTION phase`);

                const validationResult = await this.specValidator.validate({
                    workDir: workDir || process.cwd(),
                    taskId: `phase-gate-${Date.now()}`,
                    output: "",
                    additionalContext: "",
                });

                if (!validationResult.isValid) {
                    // Spec validation failed - block execution
                    const errorMsg = `Spec validation failed: ${validationResult.message}`;
                    this.log('error', `❌ ${errorMsg}`);
                    throw new Error(errorMsg);
                }

                this.log('info', `✅ Spec validation passed`);
            }
        } catch (err) {
            // Re-throw with more context
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Anti-Vibe Phase Gate Error: ${message}`);
        }
    }

    /**
     * Run quality gates for a task.
     * Returns report with pass/fail status for all gates.
     */
    private async runQualityGates(task: OrchestratorTask): Promise<QualityGatesReport> {
        this.log('info', `🚦 Executing quality gates for task: ${task.id}`);

        const report = await this.qualityGateRegistry.runAllGates({
            workDir: task.workDir || process.cwd(),
            taskId: task.id,
            output: "", // Quality gates check the project state, not specific output
            additionalContext: task.context,
        });

        return report;
    }

    /**
     * Execute prompt via AgentLoop with the current run's AbortSignal.
     */
    private async executeWithTimeout(prompt: string): Promise<AgentResult> {
        if (!this.agentLoop) {
            throw new Error('Orchestrator not initialized. Call initialize(apiKey) first.');
        }
        try {
            return await this.agentLoop.run(prompt, undefined, this.runAbort?.signal);
        } catch (e) {
            const name = e instanceof Error ? e.name : "";
            const msg = e instanceof Error ? e.message : String(e);
            if (name === "AbortError" || /abort/i.test(msg) || this.cancelled) {
                throw new OrchestratorCancelledError(msg || "Provider aborted");
            }
            throw e;
        }
    }

    /**
     * Log message if verbose mode enabled.
     */
    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        if (this.config.verbose) {
            this.eventBus.log(level, message, 'Orchestrator');
        }
    }

    /**
     * Enable or disable automatic quality gates for EXECUTION phase tasks.
     */
    setQualityGatesEnabled(enabled: boolean): void {
        this.enableQualityGates = enabled;
        this.log('info', `${enabled ? '✅' : '⛔'} Quality gates ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Get the quality gate registry instance for custom configuration.
     */
    getQualityGateRegistry(): QualityGateRegistry {
        return this.qualityGateRegistry;
    }
}

/**
 * Factory function para criar Orchestrator.
 */
export function createOrchestrator(config?: Partial<OrchestratorConfig>, eventBus?: EventBus): Orchestrator {
    return new Orchestrator(config, eventBus);
}

/**
 * Helper para criar uma task rapidamente.
 */
export function createTask(
    instruction: string,
    persona: PersonaType = PersonaType.DEVELOPER,
    options: Partial<OrchestratorTask> = {}
): OrchestratorTask {
    return {
        id: `task_${Date.now()}`,
        instruction,
        persona,
        ...options,
    };
}
