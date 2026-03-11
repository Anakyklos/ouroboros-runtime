/**
 * 🧠 BackgroundConsciousness Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BackgroundConsciousness, createBackgroundConsciousness } from './BackgroundConsciousness.js';
import { EventBus } from './event-bus.js';
import { BudgetTracker } from '../adapters/budget-tracker.js';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';

const TEST_DB = '/tmp/consciousness-budget-test.db';
const TEST_PROJECT = '/tmp/consciousness-test-project';

describe('BackgroundConsciousness', () => {
    let consciousness: BackgroundConsciousness;
    let eventBus: EventBus;
    let budgetTracker: BudgetTracker;

    beforeEach(async () => {
        // Clean up
        if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
        if (existsSync(TEST_PROJECT)) rmSync(TEST_PROJECT, { recursive: true });
        mkdirSync(TEST_PROJECT, { recursive: true });

        eventBus = new EventBus();
        budgetTracker = new BudgetTracker(TEST_DB, 10.0, eventBus);
        await budgetTracker.initialize();

        consciousness = createBackgroundConsciousness(
            {
                intervalMs: 100, // Very fast for testing
                maxRoundsPerCycle: 3,
                budgetCapPct: 10,
                model: 'glm-4-flash',
                enabled: true,
                projectRoot: TEST_PROJECT,
            },
            eventBus,
            budgetTracker
        );
    });

    afterEach(async () => {
        consciousness.stop();
        await budgetTracker.close();
        if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
        if (existsSync(TEST_PROJECT)) rmSync(TEST_PROJECT, { recursive: true });
    });

    // ============================================================
    // Lifecycle
    // ============================================================

    describe('lifecycle', () => {
        it('starts in stopped state', () => {
            expect(consciousness.currentState).toBe('stopped');
            expect(consciousness.isRunning).toBe(false);
        });

        it('starts and moves to idle state', () => {
            consciousness.start();
            expect(consciousness.isRunning).toBe(true);
            expect(consciousness.currentState).toBe('idle');
        });

        it('stops cleanly', () => {
            consciousness.start();
            consciousness.stop();
            expect(consciousness.isRunning).toBe(false);
            expect(consciousness.currentState).toBe('stopped');
        });

        it('pauses and resumes', () => {
            consciousness.start();
            consciousness.pause();
            expect(consciousness.isPaused).toBe(true);
            expect(consciousness.currentState).toBe('paused');

            consciousness.resume();
            expect(consciousness.isPaused).toBe(false);
            expect(consciousness.currentState).toBe('idle');
        });

        it('does not start when disabled', () => {
            const disabled = createBackgroundConsciousness(
                { enabled: false, projectRoot: TEST_PROJECT },
                eventBus
            );
            disabled.start();
            expect(disabled.isRunning).toBe(false);
        });
    });

    // ============================================================
    // Thinking
    // ============================================================

    describe('thinking', () => {
        it('produces a thought', async () => {
            consciousness.start();
            const thought = await consciousness.think();

            expect(thought).not.toBeNull();
            expect(thought!.timestamp).toBeInstanceOf(Date);
            expect(thought!.content).toBeTruthy();
            expect(consciousness.totalCycles).toBe(1);
        });

        it('returns null when paused', async () => {
            consciousness.start();
            consciousness.pause();
            const thought = await consciousness.think();
            expect(thought).toBeNull();
        });

        it('returns null when stopped', async () => {
            const thought = await consciousness.think();
            expect(thought).toBeNull();
        });

        it('accumulates thoughts', async () => {
            consciousness.start();
            await consciousness.think();
            await consciousness.think();
            await consciousness.think();

            expect(consciousness.recentThoughts.length).toBe(3);
            expect(consciousness.totalCycles).toBe(3);
        });

        it('emits thought events', async () => {
            const thoughts: string[] = [];
            eventBus.on('thought', (evt) => {
                if (evt.metadata?.source === 'consciousness') {
                    thoughts.push(evt.content);
                }
            });

            consciousness.start();
            await consciousness.think();

            expect(thoughts.length).toBe(1);
        });
    });

    // ============================================================
    // Observations
    // ============================================================

    describe('observations', () => {
        it('accepts and processes observations', async () => {
            consciousness.start();
            consciousness.injectObservation('User seems to struggle with auth module');

            const thought = await consciousness.think();
            expect(thought).not.toBeNull();
            expect(thought!.content).toContain('observation');
        });
    });

    // ============================================================
    // Auto-Pause on Tasks
    // ============================================================

    describe('auto-pause', () => {
        it('pauses when task starts', () => {
            consciousness.start();
            expect(consciousness.currentState).toBe('idle');

            eventBus.emit('task', {
                type: 'started',
                sessionId: 'test-session',
                data: { status: 'active' },
            });

            expect(consciousness.isPaused).toBe(true);
        });

        it('resumes when task completes', () => {
            consciousness.start();

            eventBus.emit('task', {
                type: 'started',
                sessionId: 'test-session',
                data: {},
            });
            expect(consciousness.isPaused).toBe(true);

            eventBus.emit('task', {
                type: 'completed',
                sessionId: 'test-session',
                data: {},
            });
            expect(consciousness.isPaused).toBe(false);
            expect(consciousness.currentState).toBe('idle');
        });
    });

    // ============================================================
    // Budget Integration
    // ============================================================

    describe('budget awareness', () => {
        it('respects budget cap', async () => {
            // Set a very small budget and exhaust consciousness allowance
            budgetTracker.setBudgetLimit(0.001); // $0.001 total

            // Record enough consciousness usage to exceed 10% cap
            await budgetTracker.recordUsage({
                model: 'claude-sonnet-4',
                promptTokens: 100_000,
                completionTokens: 50_000,
                totalTokens: 150_000,
                category: 'consciousness',
            });

            consciousness.start();
            const thought = await consciousness.think();

            // Should have been blocked by budget
            expect(thought).toBeNull();
        });
    });

    // ============================================================
    // Factory
    // ============================================================

    describe('factory', () => {
        it('creates with defaults', () => {
            const c = createBackgroundConsciousness(
                { projectRoot: TEST_PROJECT },
                eventBus
            );
            expect(c).toBeInstanceOf(BackgroundConsciousness);
            expect(c.currentState).toBe('stopped');
        });

        it('creates with custom config', () => {
            const c = createBackgroundConsciousness(
                {
                    intervalMs: 60_000,
                    model: 'gemini-2.0-flash',
                    budgetCapPct: 20,
                    projectRoot: TEST_PROJECT,
                },
                eventBus,
                budgetTracker
            );
            expect(c).toBeInstanceOf(BackgroundConsciousness);
        });
    });
});
