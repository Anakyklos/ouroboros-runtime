/**
 * 💰 BudgetTracker Tests
 * 
 * Testa: pricing, recording, thresholds, summary, persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BudgetTracker } from '../adapters/budget-tracker.js';
import { EventBus } from '../daemon/event-bus.js';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB = '/tmp/budget-test.db';

describe('BudgetTracker', () => {
    let tracker: BudgetTracker;
    let eventBus: EventBus;

    beforeEach(async () => {
        // Clean up any previous test DB
        if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

        eventBus = new EventBus();
        tracker = new BudgetTracker(TEST_DB, 10.0, eventBus);
        await tracker.initialize();
    });

    afterEach(async () => {
        await tracker.close();
        if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    });

    // ============================================================
    // Cost Estimation
    // ============================================================

    describe('estimateCost', () => {
        it('estimates cost for known model (glm-4.7)', () => {
            // glm-4.7: $0.50/1M input, $0.50/1M output
            const cost = tracker.estimateCost('glm-4.7', 1000, 500);
            // (1000/1M * 0.5) + (500/1M * 0.5) = 0.0005 + 0.00025 = 0.00075
            expect(cost).toBeCloseTo(0.00075, 5);
        });

        it('estimates cost for Claude Sonnet', () => {
            // claude-sonnet-4: $3.00/1M input, $15.00/1M output
            const cost = tracker.estimateCost('claude-sonnet-4', 10_000, 2_000);
            // (10000/1M * 3) + (2000/1M * 15) = 0.03 + 0.03 = 0.06
            expect(cost).toBeCloseTo(0.06, 4);
        });

        it('strips provider prefix for matching', () => {
            // "anthropic/claude-sonnet-4" should match "claude-sonnet-4"
            const cost = tracker.estimateCost('anthropic/claude-sonnet-4', 10_000, 2_000);
            expect(cost).toBeCloseTo(0.06, 4);
        });

        it('uses fallback pricing for unknown models', () => {
            // Fallback: $1.00/1M input, $4.00/1M output
            const cost = tracker.estimateCost('unknown-model-xyz', 10_000, 5_000);
            // (10000/1M * 1) + (5000/1M * 4) = 0.01 + 0.02 = 0.03
            expect(cost).toBeCloseTo(0.03, 4);
        });
    });

    // ============================================================
    // Recording Usage
    // ============================================================

    describe('recordUsage', () => {
        it('records usage and returns record with calculated cost', async () => {
            const record = await tracker.recordUsage({
                model: 'glm-4.7',
                promptTokens: 5000,
                completionTokens: 1000,
                totalTokens: 6000,
                category: 'task',
            });

            expect(record.id).toBeTruthy();
            expect(record.timestamp).toBeInstanceOf(Date);
            expect(record.costUsd).toBeGreaterThan(0);
            expect(record.model).toBe('glm-4.7');
            expect(record.category).toBe('task');
        });

        it('associates usage with session when provided', async () => {
            const record = await tracker.recordUsage({
                sessionId: 'test-session-123',
                model: 'glm-4.7',
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
                category: 'task',
            });

            expect(record.sessionId).toBe('test-session-123');
        });

        it('emits log event on recording', async () => {
            const logs: string[] = [];
            eventBus.on('log', (evt) => {
                if (evt.source === 'BudgetTracker') logs.push(evt.message);
            });

            await tracker.recordUsage({
                model: 'glm-4.7',
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
                category: 'task',
            });

            expect(logs.length).toBeGreaterThanOrEqual(1);
            expect(logs.some(l => l.includes('💰'))).toBe(true);
        });
    });

    // ============================================================
    // Budget Summary
    // ============================================================

    describe('getSummary', () => {
        it('returns zero summary when no usage recorded', async () => {
            const summary = await tracker.getSummary();
            expect(summary.totalSpentUsd).toBe(0);
            expect(summary.totalCalls).toBe(0);
            expect(summary.totalTokens).toBe(0);
            expect(summary.budgetLimitUsd).toBe(10.0);
        });

        it('aggregates usage correctly', async () => {
            await tracker.recordUsage({
                model: 'glm-4.7',
                promptTokens: 10_000,
                completionTokens: 5_000,
                totalTokens: 15_000,
                category: 'task',
            });

            await tracker.recordUsage({
                model: 'glm-4.7',
                promptTokens: 20_000,
                completionTokens: 10_000,
                totalTokens: 30_000,
                category: 'consciousness',
            });

            const summary = await tracker.getSummary();
            expect(summary.totalCalls).toBe(2);
            expect(summary.totalTokens).toBe(45_000);
            expect(summary.totalSpentUsd).toBeGreaterThan(0);
            expect(summary.byCategory.task.calls).toBe(1);
            expect(summary.byCategory.consciousness.calls).toBe(1);
            expect(summary.byModel['glm-4.7'].calls).toBe(2);
        });

        it('calculates budget pct correctly', async () => {
            // Budget is $10.00, let's record something small
            await tracker.recordUsage({
                model: 'glm-4.7',
                promptTokens: 1_000,
                completionTokens: 500,
                totalTokens: 1_500,
                category: 'task',
            });

            const summary = await tracker.getSummary();
            expect(summary.budgetUsedPct).toBeGreaterThan(0);
            expect(summary.budgetUsedPct).toBeLessThan(1); // tiny amount
            expect(summary.remainingUsd).toBeGreaterThan(0);
        });
    });

    // ============================================================
    // Budget Limits & Thresholds
    // ============================================================

    describe('budget limits', () => {
        it('respects budget limit', () => {
            expect(tracker.getBudgetLimit()).toBe(10.0);
        });

        it('updates budget limit', () => {
            tracker.setBudgetLimit(50.0);
            expect(tracker.getBudgetLimit()).toBe(50.0);
        });

        it('reports budget not exceeded when within limit', async () => {
            const exceeded = await tracker.isBudgetExceeded();
            expect(exceeded).toBe(false);
        });

        it('reports unlimited budget when limit is 0', async () => {
            tracker.setBudgetLimit(0);
            const exceeded = await tracker.isBudgetExceeded();
            expect(exceeded).toBe(false); // 0 means no limit
        });

        it('emits warning alerts at thresholds', async () => {
            // Set tiny budget to trigger thresholds quickly
            tracker.setBudgetLimit(0.001);

            const alerts: string[] = [];
            eventBus.on('log', (evt) => {
                if (evt.source === 'BudgetTracker' && (evt.level === 'warn' || evt.level === 'error')) {
                    alerts.push(evt.message);
                }
            });

            await tracker.recordUsage({
                model: 'claude-sonnet-4',
                promptTokens: 100_000,
                completionTokens: 50_000,
                totalTokens: 150_000,
                category: 'task',
            });

            // Should have triggered multiple threshold alerts
            expect(alerts.length).toBeGreaterThanOrEqual(1);
        });
    });

    // ============================================================
    // Recent Usage
    // ============================================================

    describe('getRecentUsage', () => {
        it('returns recent records in order', async () => {
            await tracker.recordUsage({
                model: 'glm-4.7',
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
                category: 'task',
            });

            await tracker.recordUsage({
                model: 'claude-sonnet-4',
                promptTokens: 2000,
                completionTokens: 1000,
                totalTokens: 3000,
                category: 'review',
            });

            const recent = await tracker.getRecentUsage(10);
            expect(recent.length).toBe(2);
            // Most recent first
            expect(recent[0].model).toBe('claude-sonnet-4');
            expect(recent[1].model).toBe('glm-4.7');
        });

        it('respects limit parameter', async () => {
            for (let i = 0; i < 5; i++) {
                await tracker.recordUsage({
                    model: 'glm-4.7',
                    promptTokens: 100,
                    completionTokens: 50,
                    totalTokens: 150,
                    category: 'task',
                });
            }

            const recent = await tracker.getRecentUsage(3);
            expect(recent.length).toBe(3);
        });
    });

    // ============================================================
    // Persistence
    // ============================================================

    describe('persistence', () => {
        it('persists budget limit across restarts', async () => {
            tracker.setBudgetLimit(42.0);
            await tracker.close();

            // Re-open
            const tracker2 = new BudgetTracker(TEST_DB, 0, eventBus);
            await tracker2.initialize();

            expect(tracker2.getBudgetLimit()).toBe(42.0);
            await tracker2.close();
        });

        it('persists usage records across restarts', async () => {
            await tracker.recordUsage({
                model: 'glm-4.7',
                promptTokens: 5000,
                completionTokens: 2000,
                totalTokens: 7000,
                category: 'task',
            });

            await tracker.close();

            // Re-open
            const tracker2 = new BudgetTracker(TEST_DB, 10.0, eventBus);
            await tracker2.initialize();

            const summary = await tracker2.getSummary();
            expect(summary.totalCalls).toBe(1);
            expect(summary.totalTokens).toBe(7000);
            await tracker2.close();
        });
    });
});
