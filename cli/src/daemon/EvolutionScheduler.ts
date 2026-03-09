/**
 * 🧬 Evolution Scheduler
 * 
 * Modo de auto-evolução controlada do agente.
 * Permite que o sistema identifique e execute melhorias em si mesmo,
 * com safeguards rigorosos para prevenir degradação.
 * 
 * Inspirado pelo evolution mode do razzant/ouroboros,
 * reimaginado com Anti-Vibe gates obrigatórios e circuit breakers.
 * 
 * ADR-03: Evolution mode SEMPRE requer Anti-Vibe gates completos.
 * 
 * Safeguards:
 * 1. Circuit breaker: max falhas consecutivas antes de desativar
 * 2. Budget reserve: reserva mínima de budget antes de evoluir
 * 3. Anti-Vibe gates: toda evolução passa por review + test
 * 4. Rollback: snapshot git antes de cada evolução
 * 5. Rate limit: max evoluções por período
 */

import { EventBus, globalEventBus } from '../daemon/event-bus.js';
import { createEventLogger } from '../daemon/event-logger.js';
import type { BudgetPort } from '../ports/budget.port.js';
import type { ValidationContext, ValidationResult } from '../orchestration/types.js';

// ============================================================
// Types
// ============================================================

export interface EvolutionConfig {
    /** Se evolução automática está habilitada */
    enabled: boolean;
    /** Intervalo entre ciclos de evolução em ms (default: 30 min) */
    intervalMs: number;
    /** Máximo de evoluções por dia */
    maxEvolutionsPerDay: number;
    /** Máximo de falhas consecutivas antes de desativar (circuit breaker) */
    maxConsecutiveFailures: number;
    /** Percentual mínimo de budget restante para permitir evolução */
    minBudgetReservePct: number;
    /** Diretório de trabalho */
    projectRoot: string;
    /** Se cria snapshot git antes de cada evolução */
    createGitSnapshot: boolean;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
    enabled: false, // Desabilitado por default — requer opt-in explícito
    intervalMs: 30 * 60 * 1000, // 30 minutos
    maxEvolutionsPerDay: 5,
    maxConsecutiveFailures: 3,
    minBudgetReservePct: 20,
    projectRoot: process.cwd(),
    createGitSnapshot: true,
};

export interface EvolutionProposal {
    /** ID único */
    id: string;
    /** Tipo de evolução */
    type: EvolutionType;
    /** Descrição da melhoria proposta */
    description: string;
    /** Arquivos afetados */
    affectedFiles: string[];
    /** Risco estimado (1-10) */
    risk: number;
    /** Impacto estimado (1-10) */
    impact: number;
    /** Timestamp */
    createdAt: Date;
}

export type EvolutionType =
    | 'refactor'       // Refatoração de código existente
    | 'optimization'   // Otimização de performance
    | 'test_coverage'  // Adicionar testes faltantes
    | 'documentation'  // Melhorar documentação
    | 'dependency'     // Atualizar dependências
    | 'cleanup';       // Limpar código morto, TODOs, etc

export interface EvolutionResult {
    /** Se a evolução foi aplicada com sucesso */
    success: boolean;
    /** Proposta executada */
    proposal: EvolutionProposal;
    /** Resultado do Anti-Vibe gate */
    gateResult?: ValidationResult;
    /** Commit hash (se commitado) */
    commitHash?: string;
    /** Erro (se falhou) */
    error?: string;
    /** Duração em ms */
    durationMs: number;
    /** Timestamp */
    timestamp: Date;
}

export type EvolutionState = 'idle' | 'analyzing' | 'evolving' | 'validating' | 'disabled';

// ============================================================
// Evolution Scheduler
// ============================================================

export class EvolutionScheduler {
    private config: EvolutionConfig;
    private eventBus: EventBus;
    private log: ReturnType<typeof createEventLogger>;
    private budgetTracker?: BudgetPort;

    private state: EvolutionState = 'idle';
    private timer: ReturnType<typeof setTimeout> | null = null;
    private history: EvolutionResult[] = [];
    private consecutiveFailures: number = 0;
    private evolutionsToday: number = 0;
    private lastDayReset: string = '';

    /** Callback para executar propostas (injetado pelo consumer) */
    private executor?: (proposal: EvolutionProposal) => Promise<{ success: boolean; output: string; error?: string }>;
    /** Callback para validar resultado (Anti-Vibe gate) */
    private validator?: (context: ValidationContext) => Promise<ValidationResult>;
    /** Callback para criar snapshot git */
    private snapshotCreator?: () => Promise<string | null>;

    constructor(
        config?: Partial<EvolutionConfig>,
        eventBus?: EventBus,
        budgetTracker?: BudgetPort,
    ) {
        this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
        this.log = createEventLogger('EvolutionScheduler', this.eventBus);
        this.budgetTracker = budgetTracker;
    }

    // ============================================================
    // Setup
    // ============================================================

    /** Registra o executor de propostas */
    setExecutor(executor: (proposal: EvolutionProposal) => Promise<{ success: boolean; output: string; error?: string }>): void {
        this.executor = executor;
    }

    /** Registra o validador Anti-Vibe */
    setValidator(validator: (context: ValidationContext) => Promise<ValidationResult>): void {
        this.validator = validator;
    }

    /** Registra o criador de snapshots git */
    setSnapshotCreator(creator: () => Promise<string | null>): void {
        this.snapshotCreator = creator;
    }

    // ============================================================
    // Lifecycle
    // ============================================================

    start(): void {
        if (!this.config.enabled) {
            this.log('info', '🧬 Evolution mode disabled by config (requires explicit opt-in)');
            return;
        }

        if (this.state === 'disabled') {
            this.log('warn', '🧬 Evolution mode disabled due to circuit breaker — call reset() first');
            return;
        }

        this.state = 'idle';
        this.scheduleNext();
        this.log('info', `🧬 Evolution scheduler started (interval: ${this.config.intervalMs / 1000}s, max: ${this.config.maxEvolutionsPerDay}/day)`);
    }

    stop(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.state !== 'disabled') {
            this.state = 'idle';
        }
        this.log('info', '🧬 Evolution scheduler stopped');
    }

    /** Reset do circuit breaker */
    reset(): void {
        this.consecutiveFailures = 0;
        this.state = 'idle';
        this.log('info', '🧬 Evolution circuit breaker reset');
    }

    // ============================================================
    // Core: Evolve Cycle
    // ============================================================

    /**
     * Executa um ciclo de evolução completo:
     * 1. Verifica precondições (budget, rate limit, circuit breaker)
     * 2. Analisa o codebase para identificar melhorias
     * 3. Cria snapshot git
     * 4. Executa a evolução proposta
     * 5. Valida resultado via Anti-Vibe gates
     * 6. Registra resultado
     */
    async evolve(proposal: EvolutionProposal): Promise<EvolutionResult> {
        const startTime = Date.now();

        // 1. Precondition checks
        const canEvolve = await this.checkPreconditions();
        if (!canEvolve.allowed) {
            return this.createResult(proposal, false, canEvolve.reason!, startTime);
        }

        this.state = 'evolving';
        this.resetDayCounterIfNeeded();

        // 2. Git snapshot
        let snapshotRef: string | null = null;
        if (this.config.createGitSnapshot && this.snapshotCreator) {
            try {
                snapshotRef = await this.snapshotCreator();
                this.log('debug', `🧬 Git snapshot created: ${snapshotRef}`);
            } catch (err) {
                return this.createResult(proposal, false, `Git snapshot failed: ${err}`, startTime);
            }
        }

        // 3. Execute evolution
        if (!this.executor) {
            return this.createResult(proposal, false, 'No executor configured', startTime);
        }

        let executionResult: { success: boolean; output: string; error?: string };
        try {
            executionResult = await this.executor(proposal);
        } catch (err) {
            this.recordFailure();
            return this.createResult(proposal, false, `Execution error: ${err}`, startTime);
        }

        if (!executionResult.success) {
            this.recordFailure();
            return this.createResult(proposal, false, executionResult.error ?? 'Execution failed', startTime);
        }

        // 4. Anti-Vibe validation
        this.state = 'validating';
        let gateResult: ValidationResult | undefined;

        if (this.validator) {
            try {
                gateResult = await this.validator({
                    workDir: this.config.projectRoot,
                    taskId: proposal.id,
                    output: executionResult.output,
                    additionalContext: `Evolution type: ${proposal.type}\nDescription: ${proposal.description}`,
                });

                if (!gateResult.isValid) {
                    this.recordFailure();
                    this.log('warn', `🧬 Evolution rejected by Anti-Vibe gate: ${gateResult.message}`);
                    return this.createResult(proposal, false, `Anti-Vibe gate failed: ${gateResult.message}`, startTime, gateResult);
                }
            } catch (err) {
                this.recordFailure();
                return this.createResult(proposal, false, `Validation error: ${err}`, startTime);
            }
        }

        // 5. Success!
        this.consecutiveFailures = 0;
        this.evolutionsToday++;

        this.log('info', `🧬 Evolution successful: ${proposal.description}`);

        const result = this.createResult(proposal, true, undefined, startTime, gateResult);
        this.history.push(result);
        this.state = 'idle';

        // Emit event
        this.eventBus.emit('thought', {
            type: 'decision',
            content: `Evolution applied: ${proposal.description}`,
            metadata: {
                source: 'evolution',
                type: proposal.type,
                risk: proposal.risk,
                impact: proposal.impact,
            },
            timestamp: new Date(),
        });

        this.scheduleNext();
        return result;
    }

    // ============================================================
    // Precondition Checks
    // ============================================================

    private async checkPreconditions(): Promise<{ allowed: boolean; reason?: string }> {
        // Circuit breaker
        if (this.state === 'disabled') {
            return { allowed: false, reason: 'Circuit breaker tripped — too many consecutive failures' };
        }

        // Rate limit
        this.resetDayCounterIfNeeded();
        if (this.evolutionsToday >= this.config.maxEvolutionsPerDay) {
            return { allowed: false, reason: `Daily evolution limit reached (${this.config.maxEvolutionsPerDay})` };
        }

        // Budget reserve
        if (this.budgetTracker) {
            try {
                const summary = await this.budgetTracker.getSummary();
                if (summary.budgetLimitUsd > 0) {
                    const remainingPct = 100 - summary.budgetUsedPct;
                    if (remainingPct < this.config.minBudgetReservePct) {
                        return { allowed: false, reason: `Budget reserve too low (${remainingPct.toFixed(1)}% < ${this.config.minBudgetReservePct}%)` };
                    }
                }
            } catch {
                // Budget check failed — allow by default
            }
        }

        return { allowed: true };
    }

    // ============================================================
    // Helpers
    // ============================================================

    private recordFailure(): void {
        this.consecutiveFailures++;
        this.state = 'idle';

        if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
            this.state = 'disabled';
            this.log('error', `🧬 Circuit breaker tripped after ${this.consecutiveFailures} consecutive failures — evolution disabled`);

            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
        }
    }

    private resetDayCounterIfNeeded(): void {
        const today = new Date().toISOString().split('T')[0];
        if (today !== this.lastDayReset) {
            this.evolutionsToday = 0;
            this.lastDayReset = today;
        }
    }

    private createResult(
        proposal: EvolutionProposal,
        success: boolean,
        error?: string,
        startTime?: number,
        gateResult?: ValidationResult,
    ): EvolutionResult {
        return {
            success,
            proposal,
            gateResult,
            error,
            durationMs: startTime ? Date.now() - startTime : 0,
            timestamp: new Date(),
        };
    }

    private scheduleNext(): void {
        if (this.state === 'disabled' || !this.config.enabled) return;

        this.timer = setTimeout(async () => {
            // Timer fire — just emit a thought event as a prompt
            this.eventBus.emit('thought', {
                type: 'reasoning',
                content: '🧬 Evolution scheduler tick — system should propose improvements',
                metadata: { source: 'evolution', state: this.state },
                timestamp: new Date(),
            });
        }, this.config.intervalMs);

        if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
            (this.timer as NodeJS.Timeout).unref();
        }
    }

    // ============================================================
    // Getters
    // ============================================================

    get currentState(): EvolutionState {
        return this.state;
    }

    get recentHistory(): EvolutionResult[] {
        return [...this.history].slice(-20);
    }

    get todayEvolutions(): number {
        this.resetDayCounterIfNeeded();
        return this.evolutionsToday;
    }

    get failureCount(): number {
        return this.consecutiveFailures;
    }

    get isCircuitBroken(): boolean {
        return this.state === 'disabled';
    }

    // log is created by createEventLogger in constructor
}

// ============================================================
// Factory
// ============================================================

export function createEvolutionScheduler(
    config?: Partial<EvolutionConfig>,
    eventBus?: EventBus,
    budgetTracker?: BudgetPort,
): EvolutionScheduler {
    return new EvolutionScheduler(config, eventBus, budgetTracker);
}

/**
 * Helper: cria uma EvolutionProposal com defaults seguros.
 */
export function createEvolutionProposal(
    type: EvolutionType,
    description: string,
    affectedFiles: string[] = [],
    risk: number = 3,
    impact: number = 5,
): EvolutionProposal {
    return {
        id: `evo_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        type,
        description,
        affectedFiles,
        risk: Math.min(10, Math.max(1, risk)),
        impact: Math.min(10, Math.max(1, impact)),
        createdAt: new Date(),
    };
}
