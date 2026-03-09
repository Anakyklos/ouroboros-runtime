/**
 * 🏥 HealthInvariantsCollector Tests
 * 📝 ScratchpadManager Tests
 * 📬 TaskMailbox Tests
 * 🔄 SafeRestart Tests
 * 
 * Tests combinados para Features H, I, J, K.
 * Cada feature tem sua própria describe block.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { HealthInvariantsCollector, createHealthInvariantsCollector } from '../daemon/HealthInvariantsCollector.js';
import { ScratchpadManager, createScratchpadManager } from './ScratchpadManager.js';
import { TaskMailbox, createTaskMailbox } from './TaskMailbox.js';
import { SafeRestart, createSafeRestart } from '../daemon/SafeRestart.js';
import { PriorityTaskQueue, createPriorityTaskQueue } from './PriorityTaskQueue.js';
import { EventBus } from '../daemon/event-bus.js';
import { BudgetTracker } from '../adapters/budget-tracker.js';
import { EvolutionScheduler, createEvolutionScheduler } from '../daemon/EvolutionScheduler.js';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';

const TEST_ROOT = '/tmp/tier1-test';
const TEST_DB = '/tmp/tier1-budget-test.db';

// ============================================================
// Feature H: HealthInvariantsCollector
// ============================================================

describe('HealthInvariantsCollector', () => {
    let collector: HealthInvariantsCollector;
    let eventBus: EventBus;
    let budgetTracker: BudgetTracker;
    let taskQueue: PriorityTaskQueue;
    let evolution: EvolutionScheduler;

    beforeEach(async () => {
        if (existsSync(TEST_DB)) rmSync(TEST_DB);
        eventBus = new EventBus();
        budgetTracker = new BudgetTracker(TEST_DB, 10.0, eventBus);
        await budgetTracker.initialize();
        taskQueue = createPriorityTaskQueue({}, eventBus);
        evolution = createEvolutionScheduler({ enabled: false }, eventBus);

        collector = createHealthInvariantsCollector(
            {},
            budgetTracker,
            taskQueue,
            evolution,
        );
    });

    afterEach(async () => {
        await budgetTracker.close();
        if (existsSync(TEST_DB)) rmSync(TEST_DB);
    });

    it('collects all health checks', async () => {
        const checks = await collector.runAllChecks();
        expect(checks.length).toBeGreaterThan(0);
        expect(checks.every(c => c.status && c.category && c.message)).toBe(true);
    });

    it('generates markdown output', async () => {
        const md = await collector.collect();
        expect(md).toContain('Health Invariants');
        expect(md).toContain('budget');
    });

    it('detects high budget usage', async () => {
        budgetTracker.setBudgetLimit(0.001);
        await budgetTracker.recordUsage({
            model: 'glm-4-flash',
            promptTokens: 100_000,
            completionTokens: 50_000,
            totalTokens: 150_000,
            category: 'task',
        });

        const checks = await collector.runAllChecks();
        const budgetCheck = checks.find(c => c.category === 'budget');
        expect(budgetCheck?.status).toBe('CRITICAL');
    });

    it('detects queue depth warning', async () => {
        const deepCollector = createHealthInvariantsCollector(
            { maxQueueDepth: 2 },
            undefined,
            taskQueue,
        );
        taskQueue.enqueue('Task 1');
        taskQueue.enqueue('Task 2');
        taskQueue.enqueue('Task 3');

        const checks = await deepCollector.runAllChecks();
        const queueCheck = checks.find(c => c.category === 'queue_depth');
        expect(queueCheck?.status).toBe('WARNING');
    });

    it('detects evolution circuit breaker', async () => {
        const brokenEvo = createEvolutionScheduler(
            { enabled: true, maxConsecutiveFailures: 1 },
            eventBus,
        );
        brokenEvo.setExecutor(async () => ({ success: false, output: '', error: 'fail' }));
        brokenEvo.setValidator(async () => ({ isValid: true, message: 'ok' }));
        await brokenEvo.evolve({
            id: 'test', type: 'cleanup', description: 'test',
            affectedFiles: [], risk: 1, impact: 1, createdAt: new Date(),
        });

        const evoCollector = createHealthInvariantsCollector({}, undefined, undefined, brokenEvo);
        const checks = await evoCollector.runAllChecks();
        const evoCheck = checks.find(c => c.category === 'evolution');
        expect(evoCheck?.status).toBe('CRITICAL');
    });
});

// ============================================================
// Feature I: ScratchpadManager
// ============================================================

describe('ScratchpadManager', () => {
    let manager: ScratchpadManager;
    const SCRATCH_ROOT = '/tmp/scratchpad-test';

    beforeEach(() => {
        if (existsSync(SCRATCH_ROOT)) rmSync(SCRATCH_ROOT, { recursive: true });
        manager = createScratchpadManager({ projectRoot: SCRATCH_ROOT });
    });

    afterEach(() => {
        if (existsSync(SCRATCH_ROOT)) rmSync(SCRATCH_ROOT, { recursive: true });
    });

    it('creates default scratchpad on first load', () => {
        const content = manager.loadScratchpad();
        expect(content).toContain('Scratchpad');
        expect(existsSync(manager.scratchpadPath)).toBe(true);
    });

    it('creates default identity on first load', () => {
        const content = manager.loadIdentity();
        expect(content).toContain('Who I Am');
        expect(existsSync(manager.identityPath)).toBe(true);
    });

    it('writes and reads scratchpad', () => {
        manager.writeScratchpad('# My Notes\n\nImportant stuff here.');
        const content = manager.loadScratchpad();
        expect(content).toContain('Important stuff');
    });

    it('appends to scratchpad', () => {
        manager.writeScratchpad('Line 1');
        manager.appendScratchpad('Line 2');
        const content = manager.loadScratchpad();
        expect(content).toContain('Line 1');
        expect(content).toContain('Line 2');
    });

    it('clears scratchpad to default', () => {
        manager.writeScratchpad('custom content');
        manager.clearScratchpad();
        const content = manager.loadScratchpad();
        expect(content).toContain('empty');
    });

    it('records journal entries', () => {
        manager.writeScratchpad('Notes');
        manager.appendScratchpad('More');

        const journal = manager.readJournal();
        expect(journal.length).toBeGreaterThanOrEqual(2);
        expect(journal[0].file).toBe('scratchpad');
    });

    it('builds context section for ContextBuilder', () => {
        manager.writeScratchpad('Work notes');
        manager.writeIdentity('I am a test agent');

        const context = manager.buildContextSection();
        expect(context).toContain('Identity');
        expect(context).toContain('Scratchpad');
        expect(context).toContain('test agent');
    });
});

// ============================================================
// Feature J: TaskMailbox
// ============================================================

describe('TaskMailbox', () => {
    let mailbox: TaskMailbox;
    const MAILBOX_ROOT = '/tmp/mailbox-test';

    beforeEach(() => {
        if (existsSync(MAILBOX_ROOT)) rmSync(MAILBOX_ROOT, { recursive: true });
        mailbox = createTaskMailbox({ projectRoot: MAILBOX_ROOT });
    });

    afterEach(() => {
        if (existsSync(MAILBOX_ROOT)) rmSync(MAILBOX_ROOT, { recursive: true });
    });

    it('writes and drains messages', () => {
        mailbox.write('task-1', 'Hello from owner');
        mailbox.write('task-1', 'Second message');

        const messages = mailbox.drain('task-1');
        expect(messages.length).toBe(2);
        expect(messages[0]).toBe('Hello from owner');
    });

    it('deduplicates with seenIds', () => {
        mailbox.write('task-1', 'First');

        const seen = new Set<string>();
        const first = mailbox.drain('task-1', seen);
        expect(first.length).toBe(1);

        // Second drain should return nothing (already seen)
        const second = mailbox.drain('task-1', seen);
        expect(second.length).toBe(0);

        // New message should appear
        mailbox.write('task-1', 'New message');
        const third = mailbox.drain('task-1', seen);
        expect(third.length).toBe(1);
    });

    it('separates mailboxes per task', () => {
        mailbox.write('task-a', 'For A');
        mailbox.write('task-b', 'For B');

        expect(mailbox.drain('task-a')).toEqual(['For A']);
        expect(mailbox.drain('task-b')).toEqual(['For B']);
    });

    it('returns empty for non-existent mailbox', () => {
        expect(mailbox.drain('nonexistent')).toEqual([]);
    });

    it('cleans up after task completion', () => {
        mailbox.write('task-1', 'msg');
        expect(mailbox.hasPending('task-1')).toBe(true);

        mailbox.cleanup('task-1');
        expect(mailbox.hasPending('task-1')).toBe(false);
    });

    it('lists active mailboxes', () => {
        mailbox.write('task-a', 'A');
        mailbox.write('task-b', 'B');

        const active = mailbox.listActiveMailboxes();
        expect(active).toContain('task-a');
        expect(active).toContain('task-b');
    });

    it('readAll returns structured messages', () => {
        mailbox.write('task-1', 'Hello', { priority: 'high' });
        const messages = mailbox.readAll('task-1');
        expect(messages.length).toBe(1);
        expect(messages[0].msgId).toBeTruthy();
        expect(messages[0].text).toBe('Hello');
        expect(messages[0].metadata?.priority).toBe('high');
    });
});

// ============================================================
// Feature K: SafeRestart
// ============================================================

describe('SafeRestart', () => {
    let restart: SafeRestart;
    const RESTART_ROOT = '/tmp/restart-test';

    beforeEach(() => {
        if (existsSync(RESTART_ROOT)) rmSync(RESTART_ROOT, { recursive: true });
        mkdirSync(RESTART_ROOT, { recursive: true });
        restart = createSafeRestart({
            projectRoot: RESTART_ROOT,
            stateDir: '.ouroboros',
        });
    });

    afterEach(() => {
        if (existsSync(RESTART_ROOT)) rmSync(RESTART_ROOT, { recursive: true });
    });

    describe('detectInterruptedWork', () => {
        it('returns no interrupted work on clean state', () => {
            const info = restart.detectInterruptedWork();
            expect(info.hasInterruptedWork).toBe(false);
            expect(info.pendingTaskCount).toBe(0);
        });

        it('detects queue with pending tasks', () => {
            const stateDir = `${RESTART_ROOT}/.ouroboros`;
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(`${stateDir}/queue-state.json`, JSON.stringify({
                tasks: [
                    { status: 'pending', priority: 5, instruction: 'Build feature X' },
                    { status: 'running', priority: 8, instruction: 'Fix bug Y' },
                ],
            }));

            const info = restart.detectInterruptedWork();
            expect(info.hasInterruptedWork).toBe(true);
            expect(info.pendingTaskCount).toBe(2);
        });

        it('detects active scratchpad', () => {
            const memDir = `${RESTART_ROOT}/.ouroboros/memory`;
            mkdirSync(memDir, { recursive: true });
            writeFileSync(`${memDir}/scratchpad.md`, '# Active Work\n\nWorking on feature X');

            const info = restart.detectInterruptedWork();
            expect(info.hasInterruptedWork).toBe(true);
            expect(info.scratchpadPreview).toContain('feature X');
        });

        it('detects rescue snapshots', () => {
            const rescueDir = `${RESTART_ROOT}/.ouroboros/rescue/2026-01-01_crash`;
            mkdirSync(rescueDir, { recursive: true });

            const info = restart.detectInterruptedWork();
            expect(info.hasInterruptedWork).toBe(true);
            expect(info.details.some(d => d.includes('rescue snapshot'))).toBe(true);
        });
    });

    describe('createRescueSnapshot', () => {
        it('creates rescue directory with manifest', () => {
            // Can't test git-based rescue without a git repo,
            // but test the structure creation
            const result = restart.createRescueSnapshot('test-rescue');
            expect(result.success).toBe(true);
            expect(result.rescueDir).toBeTruthy();
        });
    });
});
