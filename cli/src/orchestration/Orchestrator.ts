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

/**
 * Orchestrator - Coordena execução de subagentes com auto-correção.
 */
export class Orchestrator {
    private agentLoop: AgentLoop | null = null;
    private config: OrchestratorConfig;
    private memory: MemoryManager;
    private eventBus: EventBus;
    private isPaused = false;
    private resumeResolver: (() => void) | null = null;
    private memoryRetriever: MemoryRetriever;

    constructor(config: Partial<OrchestratorConfig> = {}, eventBus?: EventBus) {
        this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
        this.memory = new MemoryManager();
        this.memoryRetriever = createMemoryRetriever();
        this.eventBus = eventBus ?? globalEventBus;
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
     * Pause execution loop.
     */
    pause(): void {
        this.isPaused = true;
        this.log('info', '⏸️ Paused');
    }

    /**
     * Resume execution loop.
     */
    resume(): void {
        this.isPaused = false;
        if (this.resumeResolver) {
            this.resumeResolver();
            this.resumeResolver = null;
        }
        this.log('info', '▶️ Resumed');
    }

    /**
     * Wait until resumed (if paused).
     */
    private async waitIfPaused(): Promise<void> {
        if (!this.isPaused) return;
        await new Promise<void>((resolve) => {
            this.resumeResolver = resolve;
        });
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

        this.log('info', `🎯 Starting task: ${task.id}`);
        this.log('info', `   Persona: ${task.persona}`);
        this.log('info', `   Max retries: ${this.config.maxRetries}`);

        while (retryCount < this.config.maxRetries) {
            // Check pause state before each iteration
            await this.waitIfPaused();
            try {
                // 1. Build prompt com Anti-Vibe protocol
                const phase = PERSONA_PHASE_MAP[task.persona];
                const prompt = await this.buildPrompt(task, lastError, contextHistory);

                // 2. Validate phase gate (blocks EXECUTION without spec)
                // Skip if configured for simple tasks
                if (!this.config.skipPhaseValidation) {
                    await this.validatePhase(phase);
                }

                // 3. Execute via AgentLoop
                this.log('info', `\n🔄 Attempt ${retryCount + 1}/${this.config.maxRetries}`);
                const result = await this.executeWithTimeout(prompt);

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

                    // 5.2 Sucesso confirmado (heurística + validação programática)
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
                    this.memory.saveTaskResult(task.id, taskResult);
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
        this.memory.saveTaskResult(task.id, failResult);
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
     */
    private async validatePhase(phase: WorkflowPhase): Promise<void> {
        try {
            await validatePhaseGate(phase);
        } catch (err) {
            // Re-throw with more context
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Anti-Vibe Phase Gate Error: ${message}`);
        }
    }

    /**
     * Execute prompt via AgentLoop.
     */
    private async executeWithTimeout(prompt: string): Promise<AgentResult> {
        if (!this.agentLoop) {
            throw new Error('Orchestrator not initialized. Call initialize(apiKey) first.');
        }
        return this.agentLoop.run(prompt);
    }

    /**
     * Log message if verbose mode enabled.
     */
    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        if (this.config.verbose) {
            this.eventBus.log(level, message, 'Orchestrator');
        }
    }
}

/**
 * Factory function para criar Orchestrator.
 */
export function createOrchestrator(config?: Partial<OrchestratorConfig>): Orchestrator {
    return new Orchestrator(config);
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
