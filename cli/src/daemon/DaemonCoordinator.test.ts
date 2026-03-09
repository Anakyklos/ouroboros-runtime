/**
 * 🔄 DaemonCoordinator Tests
 * 
 * Testes de hardening: startup, shutdown, recovery, health check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DaemonCoordinator, createDaemonCoordinator } from './DaemonCoordinator.js';
import { EventBus } from './event-bus.js';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';

const TEST_ROOT = '/tmp/daemon-test-project';
const STATE_DIR = '.ouroboros';

describe('DaemonCoordinator', () => {
    let daemon: DaemonCoordinator;
    let eventBus: EventBus;

    beforeEach(() => {
        if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
        mkdirSync(TEST_ROOT, { recursive: true });

        eventBus = new EventBus();
        daemon = createDaemonCoordinator({
            projectRoot: TEST_ROOT,
            stateDir: STATE_DIR,
            budgetLimitUsd: 5.0,
            consciousness: { enabled: false }, // Disable for testing speed
            evolution: { enabled: false },
            registerSignalHandlers: false, // Don't mess with test process
        }, eventBus);
    });

    afterEach(async () => {
        try {
            await daemon.shutdown();
        } catch { /* ignore */ }
        if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
    });

    // ============================================================
    // Startup
    // ============================================================

    describe('startup', () => {
        it('starts successfully and reaches running status', async () => {
            await daemon.start();
            expect(daemon.currentStatus).toBe('running');
        });

        it('creates state directory', async () => {
            await daemon.start();
            expect(existsSync(`${TEST_ROOT}/${STATE_DIR}`)).toBe(true);
        });

        it('initializes all components', async () => {
            await daemon.start();
            expect(daemon.budgetTracker).toBeDefined();
            expect(daemon.consciousness).toBeDefined();
            expect(daemon.evolution).toBeDefined();
            expect(daemon.taskQueue).toBeDefined();
        });

        it('logs startup steps', async () => {
            const logs: string[] = [];
            eventBus.on('log', (evt) => {
                if (evt.source === 'DaemonCoordinator') {
                    logs.push(evt.message);
                }
            });

            await daemon.start();
            expect(logs.some(l => l.includes('started successfully'))).toBe(true);
        });

        it('ignores duplicate start calls', async () => {
            await daemon.start();
            await daemon.start(); // Should not throw
            expect(daemon.currentStatus).toBe('running');
        });
    });

    // ============================================================
    // Shutdown
    // ============================================================

    describe('shutdown', () => {
        it('shuts down gracefully', async () => {
            await daemon.start();
            await daemon.shutdown();
            expect(daemon.currentStatus).toBe('stopped');
        });

        it('persists queue state on shutdown', async () => {
            await daemon.start();

            // Enqueue something
            daemon.taskQueue!.enqueue('Test task', 5);

            await daemon.shutdown();

            // Check that state file exists
            const stateFile = `${TEST_ROOT}/${STATE_DIR}/queue-state.json`;
            expect(existsSync(stateFile)).toBe(true);

            const data = JSON.parse(readFileSync(stateFile, 'utf-8'));
            expect(data.tasks.length).toBe(1);
        });

        it('idempotent — multiple shutdowns are safe', async () => {
            await daemon.start();
            await daemon.shutdown();
            await daemon.shutdown(); // Should not throw
            expect(daemon.currentStatus).toBe('stopped');
        });
    });

    // ============================================================
    // Recovery
    // ============================================================

    describe('restart recovery', () => {
        it('restores queue state across restarts', async () => {
            // Start, enqueue, shutdown
            await daemon.start();
            daemon.taskQueue!.enqueue('Persisted task', 8);
            await daemon.shutdown();

            // Create new daemon, start again
            const daemon2 = createDaemonCoordinator({
                projectRoot: TEST_ROOT,
                stateDir: STATE_DIR,
                budgetLimitUsd: 5.0,
                consciousness: { enabled: false },
                evolution: { enabled: false },
                registerSignalHandlers: false,
            }, eventBus);

            await daemon2.start();

            expect(daemon2.taskQueue!.size).toBe(1);
            const task = daemon2.taskQueue!.peek();
            expect(task!.instruction).toBe('Persisted task');
            expect(task!.priority).toBe(8);

            await daemon2.shutdown();
        });

        it('handles missing state file gracefully', async () => {
            // Start without any previous state
            await daemon.start();
            expect(daemon.taskQueue!.size).toBe(0);
        });

        it('handles corrupt state file gracefully', async () => {
            // Create corrupt state file
            const stateDir = `${TEST_ROOT}/${STATE_DIR}`;
            mkdirSync(stateDir, { recursive: true });
            const { promises: fsPromises } = await import('node:fs');
            await fsPromises.writeFile(`${stateDir}/queue-state.json`, '{invalid json', 'utf-8');

            // Should not crash
            await daemon.start();
            expect(daemon.taskQueue!.size).toBe(0);
        });
    });

    // ============================================================
    // Health Check
    // ============================================================

    describe('health check', () => {
        it('returns health before start', () => {
            const health = daemon.getHealth();
            expect(health.status).toBe('uninitialized');
            expect(health.uptime).toBe(0);
        });

        it('returns health when running', async () => {
            await daemon.start();
            const health = daemon.getHealth();

            expect(health.status).toBe('running');
            expect(health.uptime).toBeGreaterThan(0);
            expect(health.components.budgetTracker).toBe(true);
            expect(health.components.eventBus).toBe(true);
            expect(health.lastCheckAt).toBeInstanceOf(Date);
        });

        it('returns health after stop', async () => {
            await daemon.start();
            await daemon.shutdown();
            const health = daemon.getHealth();

            expect(health.status).toBe('stopped');
        });
    });

    // ============================================================
    // Budget Integration
    // ============================================================

    describe('budget integration', () => {
        it('budget tracker has correct limit', async () => {
            await daemon.start();
            const summary = await daemon.budgetTracker!.getSummary();
            expect(summary.budgetLimitUsd).toBe(5.0);
        });

        it('budget persists across restarts', async () => {
            await daemon.start();

            await daemon.budgetTracker!.recordUsage({
                model: 'glm-4-flash',
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
                category: 'task',
            });

            await daemon.shutdown();

            // Restart
            const daemon2 = createDaemonCoordinator({
                projectRoot: TEST_ROOT,
                stateDir: STATE_DIR,
                budgetLimitUsd: 5.0,
                consciousness: { enabled: false },
                evolution: { enabled: false },
                registerSignalHandlers: false,
            }, eventBus);

            await daemon2.start();
            const summary = await daemon2.budgetTracker!.getSummary();
            expect(summary.totalCalls).toBe(1);
            expect(summary.totalSpentUsd).toBeGreaterThan(0);

            await daemon2.shutdown();
        });
    });

    // ============================================================
    // Factory
    // ============================================================

    describe('factory', () => {
        it('creates with defaults', () => {
            const d = createDaemonCoordinator({ projectRoot: TEST_ROOT, registerSignalHandlers: false });
            expect(d.currentStatus).toBe('uninitialized');
        });
    });
});
