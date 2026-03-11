/**
 * 🚦 Quality Gate Registry
 *
 * Registro centralizado para gerenciar quality gates do sistema.
 * Parte do protocolo Anti-Vibe: centraliza validações de qualidade
 * para uso consistente em todo o sistema.
 *
 * Inspirado em:
 * - PromotionManager: gerenciamento de estratégias de validação
 * - Orchestrator: padrão registry para componentes
 * - CommandValidationStrategy: estratégias de validação
 */

import type { ValidationStrategy, ValidationContext, ValidationResult } from "../types.js";
import { QualityGateType } from "../promotion-types.js";
import { CommandValidationStrategy } from "./CommandValidationStrategy.js";
import { TestValidationStrategy } from "./TestValidationStrategy.js";

// Re-export QualityGateType for convenience
export { QualityGateType } from "../promotion-types.js";

/**
 * Configuração de um quality gate registrado.
 */
export interface QualityGateConfig {
    /** Tipo do quality gate */
    type: QualityGateType;
    /** Estratégia de validação a ser executada */
    strategy: ValidationStrategy;
    /** Se este gate é obrigatório (default: true) */
    required: boolean;
    /** Ordem de execução (menor = antes) */
    priority: number;
    /** Se o gate está habilitado */
    enabled: boolean;
    /** Timeout em ms para execução deste gate */
    timeoutMs: number;
}

/**
 * Resultado da execução de um quality gate.
 */
export interface QualityGateResult {
    /** Tipo do gate executado */
    type: QualityGateType;
    /** Resultado da validação */
    result: ValidationResult;
    /** Timestamp de execução */
    timestamp: Date;
    /** Se o gate é obrigatório */
    required: boolean;
}

/**
 * Resultado da execução de múltiplos quality gates.
 */
export interface QualityGatesReport {
    /** Resultados individuais de cada gate */
    results: QualityGateResult[];
    /** Se todos os gates obrigatórios passaram */
    passed: boolean;
    /** Gates que falharam */
    failed: QualityGateResult[];
    /** Gates que passaram */
    succeeded: QualityGateResult[];
    /** Gates que foram pulados (não obrigatórios e falharam) */
    skipped: QualityGateResult[];
    /** Tempo total de execução em ms */
    totalDurationMs: number;
}

/**
 * Registry centralizado para gerenciar quality gates.
 *
 * @example
 * ```ts
 * const registry = new QualityGateRegistry();
 * registry.registerDefaultGates();
 *
 * const report = await registry.runAllGates({
 *     workDir: "./project",
 *     taskId: "task-1",
 *     output: "",
 * });
 *
 * if (!report.passed) {
 *     console.log("Quality gates failed:", report.failed);
 * }
 * ```
 */
export class QualityGateRegistry {
    private gates: Map<QualityGateType, QualityGateConfig>;
    private verbose: boolean;

    constructor(verbose = false) {
        this.gates = new Map();
        this.verbose = verbose;
    }

    /**
     * Registra um quality gate.
     */
    registerGate(config: QualityGateConfig): void {
        this.gates.set(config.type, config);
        this.log('debug', `📝 Registered gate: ${config.type} (priority: ${config.priority})`);
    }

    /**
     * Remove um quality gate do registry.
     */
    unregisterGate(type: QualityGateType): boolean {
        const removed = this.gates.delete(type);
        if (removed) {
            this.log('debug', `🗑️ Unregistered gate: ${type}`);
        }
        return removed;
    }

    /**
     * Retorna a configuração de um gate específico.
     */
    getGate(type: QualityGateType): QualityGateConfig | undefined {
        return this.gates.get(type);
    }

    /**
     * Retorna todos os gates registrados.
     */
    getAllGates(): QualityGateConfig[] {
        return Array.from(this.gates.values());
    }

    /**
     * Retorna apenas os gates habilitados.
     */
    getEnabledGates(): QualityGateConfig[] {
        return this.getAllGates()
            .filter(gate => gate.enabled)
            .sort((a, b) => a.priority - b.priority);
    }

    /**
     * Retorna os gates obrigatórios.
     */
    getRequiredGates(): QualityGateConfig[] {
        return this.getEnabledGates()
            .filter(gate => gate.required);
    }

    /**
     * Habilita ou desabilita um gate.
     */
    setGateEnabled(type: QualityGateType, enabled: boolean): void {
        const gate = this.gates.get(type);
        if (gate) {
            gate.enabled = enabled;
            this.log('debug', `${enabled ? '✅' : '⛔'} Gate ${type} ${enabled ? 'enabled' : 'disabled'}`);
        }
    }

    /**
     * Define uma estratégia customizada para um gate existente.
     */
    setGateStrategy(type: QualityGateType, strategy: ValidationStrategy): void {
        const gate = this.gates.get(type);
        if (gate) {
            gate.strategy = strategy;
            this.log('debug', `🔧 Updated strategy for gate: ${type}`);
        }
    }

    /**
     * Executa um gate específico.
     */
    async runGate(
        type: QualityGateType,
        context: ValidationContext
    ): Promise<QualityGateResult> {
        const gate = this.gates.get(type);
        if (!gate) {
            throw new Error(`Quality gate not registered: ${type}`);
        }

        if (!gate.enabled) {
            throw new Error(`Quality gate is disabled: ${type}`);
        }

        this.log('info', `🚦 Running gate: ${type}`);

        const startTime = Date.now();
        const result = await gate.strategy.validate(context);
        const durationMs = Date.now() - startTime;

        this.log('info', `   ${result.isValid ? '✅' : '❌'} ${type}: ${result.message}`);

        return {
            type,
            result,
            timestamp: new Date(),
            required: gate.required,
        };
    }

    /**
     * Executa todos os gates habilitados na ordem de prioridade.
     *
     * Para a execução se um gate obrigatório falhar.
     * Gates não obrigatórios que falham são marcados como skipped.
     */
    async runAllGates(context: ValidationContext): Promise<QualityGatesReport> {
        const startTime = Date.now();
        const results: QualityGateResult[] = [];
        const gates = this.getEnabledGates();

        this.log('info', `🚀 Running ${gates.length} quality gates...`);

        for (const gate of gates) {
            const gateStartTime = Date.now();

            try {
                const result = await gate.strategy.validate(context);
                const durationMs = Date.now() - gateStartTime;

                results.push({
                    type: gate.type,
                    result,
                    timestamp: new Date(),
                    required: gate.required,
                });

                // Se um gate obrigatório falhou, para a execução
                if (!result.isValid && gate.required) {
                    this.log('warn', `⛔ Required gate ${gate.type} failed, stopping execution`);
                    break;
                }
            } catch (error) {
                const durationMs = Date.now() - gateStartTime;
                const errorResult: ValidationResult = {
                    isValid: false,
                    message: error instanceof Error ? error.message : String(error),
                    exitCode: 1,
                };

                results.push({
                    type: gate.type,
                    result: errorResult,
                    timestamp: new Date(),
                    required: gate.required,
                });

                // Se um gate obrigatório lançou erro, para a execução
                if (gate.required) {
                    this.log('error', `💥 Required gate ${gate.type} threw error, stopping execution`);
                    break;
                }
            }
        }

        const totalDurationMs = Date.now() - startTime;

        // Separa resultados
        const failed = results.filter(r => !r.result.isValid);
        const succeeded = results.filter(r => r.result.isValid);
        const requiredFailed = failed.filter(r => r.required);
        const skipped = failed.filter(r => !r.required);

        const passed = requiredFailed.length === 0;

        this.log('info', `🏁 Quality gates ${passed ? '✅ passed' : '❌ failed'} in ${totalDurationMs}ms`);

        return {
            results,
            passed,
            failed,
            succeeded,
            skipped,
            totalDurationMs,
        };
    }

    /**
     * Registra os quality gates padrão do sistema.
     *
     * Configura gates para: TEST, TYPE_CHECK, LINT, COVERAGE.
     * Usa CommandValidationStrategy para TYPE_CHECK e LINT.
     * Usa TestValidationStrategy para TEST e COVERAGE.
     */
    registerDefaultGates(): void {
        // Test gate - usa TestValidationStrategy para parsing detalhado
        this.registerGate({
            type: QualityGateType.TEST,
            strategy: new TestValidationStrategy("bun test", 60000),
            required: true,
            priority: 1,
            enabled: true,
            timeoutMs: 60000,
        });

        // Type-check gate
        this.registerGate({
            type: QualityGateType.TYPE_CHECK,
            strategy: new CommandValidationStrategy("bun run typecheck", 30000),
            required: true,
            priority: 2,
            enabled: true,
            timeoutMs: 30000,
        });

        // Lint gate
        this.registerGate({
            type: QualityGateType.LINT,
            strategy: new CommandValidationStrategy("bun run lint", 30000),
            required: false, // Lint é aviso, não bloqueia
            priority: 3,
            enabled: true,
            timeoutMs: 30000,
        });

        // Coverage gate - opcional, desabilitado por padrão
        this.registerGate({
            type: QualityGateType.COVERAGE,
            strategy: new TestValidationStrategy("bun test --coverage", 90000),
            required: false,
            priority: 4,
            enabled: false, // Desabilitado por padrão (pode ser lento)
            timeoutMs: 90000,
        });

        this.log('info', '✅ Default quality gates registered');
    }

    /**
     * Limpa todos os gates registrados.
     */
    clear(): void {
        this.gates.clear();
        this.log('debug', '🗑️ Cleared all gates');
    }

    /**
     * Retorna estatísticas dos gates registrados.
     */
    getStats(): {
        total: number;
        enabled: number;
        disabled: number;
        required: number;
        optional: number;
    } {
        const gates = this.getAllGates();
        return {
            total: gates.length,
            enabled: gates.filter(g => g.enabled).length,
            disabled: gates.filter(g => !g.enabled).length,
            required: gates.filter(g => g.required).length,
            optional: gates.filter(g => !g.required).length,
        };
    }

    /**
     * Log message se verbose mode enabled.
     */
    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        if (this.verbose) {
            const prefix = {
                debug: '🔍',
                info: 'ℹ️',
                warn: '⚠️',
                error: '❌',
            }[level];
            console.log(`${prefix} [QualityGateRegistry] ${message}`);
        }
    }
}

// --- FACTORIES ---

/**
 * Factory para criar QualityGateRegistry com gates padrão.
 */
export function createQualityGateRegistry(
    verbose = true,
    registerDefaults = true
): QualityGateRegistry {
    const registry = new QualityGateRegistry(verbose);
    if (registerDefaults) {
        registry.registerDefaultGates();
    }
    return registry;
}

/**
 * Factory para criar QualityGateRegistry customizado.
 */
export function createCustomQualityGateRegistry(
    gates: QualityGateConfig[],
    verbose = false
): QualityGateRegistry {
    const registry = new QualityGateRegistry(verbose);
    for (const gate of gates) {
        registry.registerGate(gate);
    }
    return registry;
}

/**
 * Factory para criar QualityGateRegistry mínimo (apenas testes obrigatórios).
 */
export function createMinimalQualityGateRegistry(): QualityGateRegistry {
    const registry = new QualityGateRegistry(false);

    // Apenas TEST e TYPE_CHECK são obrigatórios
    registry.registerGate({
        type: QualityGateType.TEST,
        strategy: new TestValidationStrategy("bun test", 60000),
        required: true,
        priority: 1,
        enabled: true,
        timeoutMs: 60000,
    });

    registry.registerGate({
        type: QualityGateType.TYPE_CHECK,
        strategy: new CommandValidationStrategy("bun run typecheck", 30000),
        required: true,
        priority: 2,
        enabled: true,
        timeoutMs: 30000,
    });

    return registry;
}
