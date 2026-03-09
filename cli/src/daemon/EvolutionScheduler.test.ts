/**
 * 🧬 EvolutionScheduler Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
    EvolutionScheduler,
    createEvolutionScheduler,
    createEvolutionProposal,
    type EvolutionProposal
} from './EvolutionScheduler.js';
import { EventBus } from './event-bus.js';
import { BudgetTracker } from '../adapters/budget-tracker.js';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/evolution-budget-test.db';

describe('EvolutionScheduler', () => {
    let scheduler: EvolutionScheduler;
    let eventBus: EventBus;
    let budgetTracker: BudgetTracker;

    const mockProposal: EvolutionProposal = createEvolutionProposal(
        'test_coverage',
        'Add missing tests for event-bus module',
        ['cli/src/daemon/event-bus.ts'],
        2,
        7,
    );

    beforeEach(async () => {
        if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

        eventBus = new EventBus();
        budgetTracker = new BudgetTracker(TEST_DB, 10.0, eventBus);
        await budgetTracker.initialize();

        scheduler = createEvolutionScheduler(
            {
                enabled: true,
                intervalMs: 100,
                maxEvolutionsPerDay: 5,
                maxConsecutiveFailures: 3,
                minBudgetReservePct: 20,
                projectRoot: '/tmp',
                createGitSnapshot: false,
            },
            eventBus,
            budgetTracker,
        );
    });

    afterEach(async () => {
        scheduler.stop();
        await budgetTracker.close();
        if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    });

    // ============================================================
    // Lifecycle
    // ============================================================

    describe('lifecycle', () => {
        it('starts in idle state', () => {
            expect(scheduler.currentState).toBe('idle');
        });

        it('starts when enabled', () => {
            scheduler.start();
            expect(scheduler.currentState).toBe('idle');
        });

        it('does not start when disabled', () => {
            const disabled = createEvolutionScheduler({ enabled: false }, eventBus);
            disabled.start();
            expect(disabled.currentState).toBe('idle');
        });

        it('stops cleanly', () => {
            scheduler.start();
            scheduler.stop();
            expect(scheduler.currentState).toBe('idle');
        });
    });

    // ============================================================
    // Evolution Execution
    // ============================================================

    describe('evolve', () => {
        it('executes successful evolution', async () => {
            scheduler.setExecutor(async () => ({
                success: true,
                output: 'Tests added successfully',
            }));
            scheduler.setValidator(async () => ({
                isValid: true,
                message: 'All tests pass',
            }));

            const result = await scheduler.evolve(mockProposal);
            expect(result.success).toBe(true);
            expect(result.proposal.type).toBe('test_coverage');
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        it('fails when executor returns failure', async () => {
            scheduler.setExecutor(async () => ({
                success: false,
                output: '',
                error: 'Compilation error',
            }));
            scheduler.setValidator(async () => ({ isValid: true, message: 'ok' }));

            const result = await scheduler.evolve(mockProposal);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Compilation error');
        });

        it('fails when validator rejects', async () => {
            scheduler.setExecutor(async () => ({
                success: true,
                output: 'Code modified',
            }));
            scheduler.setValidator(async () => ({
                isValid: false,
                message: 'Tests fail after evolution',
            }));

            const result = await scheduler.evolve(mockProposal);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Anti-Vibe gate failed');
        });

        it('fails without executor (but with validator, ADR-03)', async () => {
            scheduler.setValidator(async () => ({ isValid: true, message: 'ok' }));
            const result = await scheduler.evolve(mockProposal);
            expect(result.success).toBe(false);
            expect(result.error).toContain('No executor');
        });

        it('fails without validator (ADR-03 enforcement)', async () => {
            const result = await scheduler.evolve(mockProposal);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Anti-Vibe validator');
        });
    });

    // ============================================================
    // Circuit Breaker
    // ============================================================

    describe('circuit breaker', () => {
        it('trips after max consecutive failures', async () => {
            scheduler.setExecutor(async () => ({
                success: false,
                output: '',
                error: 'fail',
            }));
            scheduler.setValidator(async () => ({ isValid: true, message: 'ok' }));

            // 3 consecutive failures
            await scheduler.evolve(mockProposal);
            await scheduler.evolve(mockProposal);
            await scheduler.evolve(mockProposal);

            expect(scheduler.isCircuitBroken).toBe(true);
            expect(scheduler.currentState).toBe('disabled');
        });

        it('blocks evolution when circuit is broken', async () => {
            scheduler.setExecutor(async () => ({
                success: false,
                output: '',
                error: 'fail',
            }));
            scheduler.setValidator(async () => ({ isValid: true, message: 'ok' }));

            for (let i = 0; i < 3; i++) {
                await scheduler.evolve(mockProposal);
            }

            // Trying to evolve should fail
            const result = await scheduler.evolve(mockProposal);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Circuit breaker');
        });

        it('resets after manual reset()', async () => {
            scheduler.setExecutor(async () => ({
                success: false,
                output: '',
                error: 'fail',
            }));
            scheduler.setValidator(async () => ({ isValid: true, message: 'ok' }));

            for (let i = 0; i < 3; i++) {
                await scheduler.evolve(mockProposal);
            }

            expect(scheduler.isCircuitBroken).toBe(true);
            scheduler.reset();
            expect(scheduler.isCircuitBroken).toBe(false);
            expect(scheduler.failureCount).toBe(0);
        });

        it('resets failure counter on success', async () => {
            let callCount = 0;
            scheduler.setExecutor(async () => {
                callCount++;
                if (callCount <= 2) {
                    return { success: false, output: '', error: 'fail' };
                }
                return { success: true, output: 'ok' };
            });
            scheduler.setValidator(async () => ({ isValid: true, message: 'ok' }));

            await scheduler.evolve(mockProposal);
            await scheduler.evolve(mockProposal);
            expect(scheduler.failureCount).toBe(2);

            await scheduler.evolve(mockProposal);
            expect(scheduler.failureCount).toBe(0);
        });
    });

    // ============================================================
    // Rate Limiting
    // ============================================================

    describe('rate limiting', () => {
        it('enforces max evolutions per day', async () => {
            const limited = createEvolutionScheduler(
                {
                    enabled: true,
                    maxEvolutionsPerDay: 2,
                    maxConsecutiveFailures: 10,
                    minBudgetReservePct: 0,
                    projectRoot: '/tmp',
                    createGitSnapshot: false,
                    intervalMs: 100,
                },
                eventBus,
            );

            limited.setExecutor(async () => ({
                success: true,
                output: 'ok',
            }));
            limited.setValidator(async () => ({ isValid: true, message: 'ok' }));

            await limited.evolve(mockProposal);
            await limited.evolve(mockProposal);

            // Third should be rate limited
            const result = await limited.evolve(mockProposal);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Daily evolution limit');

            limited.stop();
        });
    });

    // ============================================================
    // Budget Reserve
    // ============================================================

    describe('budget reserve', () => {
        it('blocks when budget reserve is too low', async () => {
            // Set small budget and exhaust most of it
            budgetTracker.setBudgetLimit(0.001);
            await budgetTracker.recordUsage({
                model: 'claude-sonnet-4',
                promptTokens: 100_000,
                completionTokens: 50_000,
                totalTokens: 150_000,
                category: 'task',
            });

            scheduler.setExecutor(async () => ({
                success: true,
                output: 'ok',
            }));

            const result = await scheduler.evolve(mockProposal);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Budget reserve too low');
        });
    });

    // ============================================================
    // Factory & Helpers
    // ============================================================

    describe('createEvolutionProposal', () => {
        it('creates proposal with defaults', () => {
            const p = createEvolutionProposal('cleanup', 'Remove dead code');
            expect(p.id).toContain('evo_');
            expect(p.type).toBe('cleanup');
            expect(p.risk).toBe(3);
            expect(p.impact).toBe(5);
        });

        it('clamps risk and impact values', () => {
            const p = createEvolutionProposal('refactor', 'Big refactor', [], 15, -2);
            expect(p.risk).toBe(10);
            expect(p.impact).toBe(1);
        });
    });

    describe('history', () => {
        it('tracks evolution history', async () => {
            scheduler.setExecutor(async () => ({
                success: true,
                output: 'done',
            }));
            scheduler.setValidator(async () => ({ isValid: true, message: 'ok' }));

            await scheduler.evolve(mockProposal);
            expect(scheduler.recentHistory.length).toBe(1);
            expect(scheduler.recentHistory[0].success).toBe(true);
        });
    });
});
