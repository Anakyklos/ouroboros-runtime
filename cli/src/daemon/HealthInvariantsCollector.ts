/**
 * 🏥 Health Invariants Collector
 * 
 * Coleta checks de saúde do sistema para injetar no prompt LLM.
 * O LLM interpreta os checks e decide se/como agir.
 * 
 * Inspirado por _build_health_invariants() do razzant/ouroboros context.py.
 * 
 * Princípio: "LLM-first self-detection" — código detecta anomalias,
 * LLM decide a ação. Sem lógica de decisão hardcoded.
 */

import type { BudgetPort } from '../ports/budget.port.js';
import type { PriorityTaskQueue } from '../orchestration/PriorityTaskQueue.js';
import type { EvolutionScheduler } from './EvolutionScheduler.js';
import type { DaemonCoordinator } from './DaemonCoordinator.js';

// ============================================================
// Types
// ============================================================

export interface HealthCheck {
    status: 'OK' | 'WARNING' | 'CRITICAL';
    category: string;
    message: string;
}

export interface HealthInvariantsConfig {
    /** Threshold de budget drift em % (default: 10) */
    budgetDriftThresholdPct: number;
    /** Custo máximo por task antes de alertar em USD (default: 5) */
    highCostTaskThresholdUsd: number;
    /** Queue depth máximo antes de alertar (default: 20) */
    maxQueueDepth: number;
    /** Idade máxima de identity.md em horas (default: 24) */
    staleIdentityHours: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthInvariantsConfig = {
    budgetDriftThresholdPct: 10,
    highCostTaskThresholdUsd: 5,
    maxQueueDepth: 20,
    staleIdentityHours: 24,
};

// ============================================================
// Health Invariants Collector
// ============================================================

export class HealthInvariantsCollector {
    private config: HealthInvariantsConfig;
    private budgetTracker?: BudgetPort;
    private taskQueue?: PriorityTaskQueue;
    private evolution?: EvolutionScheduler;

    constructor(
        config?: Partial<HealthInvariantsConfig>,
        budgetTracker?: BudgetPort,
        taskQueue?: PriorityTaskQueue,
        evolution?: EvolutionScheduler,
    ) {
        this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
        this.budgetTracker = budgetTracker;
        this.taskQueue = taskQueue;
        this.evolution = evolution;
    }

    // ============================================================
    // Collect
    // ============================================================

    /**
     * Coleta todos os health checks e retorna seção markdown
     * pronta para injetar no prompt do LLM.
     */
    async collect(): Promise<string> {
        const checks = await this.runAllChecks();
        if (checks.length === 0) return '';

        const lines = checks.map(c => {
            const icon = c.status === 'OK' ? '✅' : c.status === 'WARNING' ? '⚠️' : '🚨';
            return `- ${icon} ${c.status}: ${c.category} — ${c.message}`;
        });

        return `## Health Invariants\n\n${lines.join('\n')}`;
    }

    /**
     * Roda todos os checks e retorna array estruturado.
     */
    async runAllChecks(): Promise<HealthCheck[]> {
        const checks: HealthCheck[] = [];

        checks.push(...await this.checkBudget());
        checks.push(...this.checkQueue());
        checks.push(...this.checkEvolution());

        return checks;
    }

    // ============================================================
    // Individual Checks
    // ============================================================

    private async checkBudget(): Promise<HealthCheck[]> {
        if (!this.budgetTracker) return [];
        const checks: HealthCheck[] = [];

        try {
            const summary = await this.budgetTracker.getSummary();

            // Budget usage
            if (summary.budgetLimitUsd > 0) {
                if (summary.budgetUsedPct >= 95) {
                    checks.push({
                        status: 'CRITICAL',
                        category: 'budget',
                        message: `Budget nearly exhausted: ${summary.budgetUsedPct.toFixed(1)}% used ($${summary.totalSpentUsd.toFixed(2)}/$${summary.budgetLimitUsd.toFixed(2)})`,
                    });
                } else if (summary.budgetUsedPct >= 80) {
                    checks.push({
                        status: 'WARNING',
                        category: 'budget',
                        message: `Budget usage high: ${summary.budgetUsedPct.toFixed(1)}% ($${summary.totalSpentUsd.toFixed(2)}/$${summary.budgetLimitUsd.toFixed(2)})`,
                    });
                } else {
                    checks.push({
                        status: 'OK',
                        category: 'budget',
                        message: `Budget: ${summary.budgetUsedPct.toFixed(1)}% used ($${summary.totalSpentUsd.toFixed(2)}/$${summary.budgetLimitUsd.toFixed(2)})`,
                    });
                }
            }

            // High-cost tasks check
            const recent = await this.budgetTracker.getRecentUsage(10);
            const highCost = recent.filter(r => r.costUsd > this.config.highCostTaskThresholdUsd);
            if (highCost.length > 0) {
                checks.push({
                    status: 'WARNING',
                    category: 'high_cost_task',
                    message: `${highCost.length} recent call(s) exceeded $${this.config.highCostTaskThresholdUsd}: ${highCost.map(r => `$${r.costUsd.toFixed(2)}`).join(', ')}`,
                });
            }
        } catch {
            // Budget check failed silently
        }

        return checks;
    }

    private checkQueue(): HealthCheck[] {
        if (!this.taskQueue) return [];
        const checks: HealthCheck[] = [];

        const depth = this.taskQueue.size;
        if (depth >= this.config.maxQueueDepth) {
            checks.push({
                status: 'WARNING',
                category: 'queue_depth',
                message: `Task queue depth is ${depth} (threshold: ${this.config.maxQueueDepth})`,
            });
        } else {
            checks.push({
                status: 'OK',
                category: 'queue_depth',
                message: `Task queue: ${depth} pending`,
            });
        }

        // Check for timed-out tasks
        const running = this.taskQueue.runningTasks;
        if (running.length > 0) {
            checks.push({
                status: 'OK',
                category: 'running_tasks',
                message: `${running.length} task(s) running`,
            });
        }

        return checks;
    }

    private checkEvolution(): HealthCheck[] {
        if (!this.evolution) return [];
        const checks: HealthCheck[] = [];

        if (this.evolution.isCircuitBroken) {
            checks.push({
                status: 'CRITICAL',
                category: 'evolution',
                message: `Evolution circuit breaker TRIPPED (${this.evolution.failureCount} consecutive failures)`,
            });
        } else {
            checks.push({
                status: 'OK',
                category: 'evolution',
                message: `Evolution: ${this.evolution.todayEvolutions} today, state=${this.evolution.currentState}`,
            });
        }

        return checks;
    }
}

// ============================================================
// Factory
// ============================================================

export function createHealthInvariantsCollector(
    config?: Partial<HealthInvariantsConfig>,
    budgetTracker?: BudgetPort,
    taskQueue?: PriorityTaskQueue,
    evolution?: EvolutionScheduler,
): HealthInvariantsCollector {
    return new HealthInvariantsCollector(config, budgetTracker, taskQueue, evolution);
}
