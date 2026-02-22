import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SessionManager } from './session-manager.js';
import { EventBus } from './event-bus.js';
import type { StoragePort } from '../ports/storage.port.js';

// Helper to access private activeTasks map
function getActiveTasks(manager: SessionManager): Map<string, Map<string, Promise<void>>> {
    return (manager as any).activeTasks;
}

function setTask(manager: SessionManager, sessionId: string, taskId: string, promise: Promise<void>) {
    const activeTasks = getActiveTasks(manager);
    if (!activeTasks.has(sessionId)) {
        activeTasks.set(sessionId, new Map());
    }
    activeTasks.get(sessionId)!.set(taskId, promise);
}


function createDeferred() {
    let resolve!: () => void;
    let reject!: (err?: any) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('SessionManager', () => {
    let manager: SessionManager;
    let mockStorage: StoragePort;
    let mockEventBus: EventBus;

    beforeEach(() => {
        mockEventBus = new EventBus();
        mockStorage = {
            createSession: mock(async (data) => ({ ...data, id: 'session-1', createdAt: new Date(), updatedAt: new Date(), status: 'active', contextSnapshot: '', metadata: {} })),
            getSession: mock(async () => null),
            updateSession: mock(async () => {}),
            listSessions: mock(async () => []),
            deleteSession: mock(async () => {}),
            appendLog: mock(async () => ({ id: 'log-1', sessionId: 'session-1', timestamp: new Date(), type: 'input', content: '' })),
            getLogs: mock(async () => []),
            initialize: mock(async () => {}),
            close: mock(async () => {}),
        };
        manager = new SessionManager(mockStorage, mockEventBus);
    });

                it('cleanupSession should wait for all tasks and clear activeTasks', async () => {
        const sessionId = 'session-1';

        // Create controllable tasks
        const task1 = createDeferred();
        const task2 = createDeferred();

        setTask(manager, sessionId, 'task_session-1_1', task1.promise);
        setTask(manager, sessionId, 'task_session-1_2', task2.promise);

        // Start cleanup (it should wait)
        const cleanupPromise = manager.cleanupSession(sessionId);

        // Verify tasks are still tracked (cleanup is pending)
        expect(manager.hasActiveTasks(sessionId)).toBe(true);

        // Resolve tasks
        task1.resolve();
        task2.resolve();

        // Wait for cleanup to finish
        await cleanupPromise;

        // Verify tasks are removed
        expect(manager.hasActiveTasks(sessionId)).toBe(false);
    });

        it('cleanupSession should handle rejected tasks gracefully', async () => {
        const sessionId = 'session-1';

        // Create a rejected task
        const task1 = createDeferred();

        setTask(manager, sessionId, 'task_session-1_1', task1.promise);

        const cleanupPromise = manager.cleanupSession(sessionId);

        // Reject it
        // We defer rejection to ensure cleanup has subscribed (it does immediately)
        task1.reject(new Error('Task failed'));

        // This should not throw
        await cleanupPromise;

        expect(manager.hasActiveTasks(sessionId)).toBe(false);
    });

        it('cleanupSession should handle tasks added concurrently during cleanup', async () => {
        const sessionId = 'session-race';

        const taskA = createDeferred();
        setTask(manager, sessionId, 'task_A', taskA.promise);

        const cleanupPromise = manager.cleanupSession(sessionId);

        // Add Task B while cleanup is waiting for A
        const taskB = createDeferred();
        setTask(manager, sessionId, 'task_B', taskB.promise);

        // Resolve A -> cleanup loop continues, finds B
        taskA.resolve();

        // Resolve B -> cleanup loop finishes
        taskB.resolve();

        await cleanupPromise;

        expect(manager.hasActiveTasks(sessionId)).toBe(false);
    });

        it('cleanupSession should stop after max iterations and log warning', async () => {
        const sessionId = 'session-infinite';

        // Spy on log
        const logSpy = mock();
        (manager as any).eventBus.log = logSpy;

        // We simulate iterations by adding tasks manually before resolving current ones
        // Iteration 1 starts. Waits for T1.
        const t1 = createDeferred();
        setTask(manager, sessionId, 't1', t1.promise);

        const cleanupPromise = manager.cleanupSession(sessionId);

        // Loop is waiting for t1.
        // Add t2. Resolve t1.
        const t2 = createDeferred();
        setTask(manager, sessionId, 't2', t2.promise);
        t1.resolve();

        // Loop iterates (2). Waits for t2.
        // Add t3. Resolve t2.
        // We need to wait for microtasks? Since we control resolution, the loop logic happens in reaction.
        // But we need to ensure 't2' is picked up. It is picked up because we added it before resolving t1?
        // No, we added it, then resolved t1.
        // t1 resolution triggers Promise.all resolution.
        // Loop continues. Finds t2.

        // Wait, does 't1.resolve()' immediately trigger loop continuation? No, it's async.
        // But inside this test function, we are synchronous.
        // We need to allow the loop to proceed.
        // A simple 'await new Promise(r => setTimeout(r, 0))' or just assume queuing is enough?
        // Let's assume queuing works but we need to chain properly.

        // Actually, we can just pre-populate enough depth if we want?
        // No, 'activeTasks' is snapshot at start of loop.
        // So T2 must be in map when loop restarts.

        // Iteration 2 setup
        await new Promise(r => setTimeout(r, 0)); // Let loop tick?
        const t3 = createDeferred();
        setTask(manager, sessionId, 't3', t3.promise);
        t2.resolve();

        // Iteration 3
        await new Promise(r => setTimeout(r, 0));
        const t4 = createDeferred();
        setTask(manager, sessionId, 't4', t4.promise);
        t3.resolve();

        // Iteration 4 (should be > max 3)
        await new Promise(r => setTimeout(r, 0));
        t4.resolve();

        // Max iterations default is 3.
        // 1: t1
        // 2: t2
        // 3: t3
        // 4: t4 -> should be skipped/force removed?
        // Actually, if max is 3.
        // Loop runs 3 times.
        // After 3rd time, loop condition fails.
        // Then force cleanup runs.
        // If we added t4 during 3rd iteration wait, it remains.
        // Force cleanup should see t4 and delete it.

        await cleanupPromise;

        const calls = logSpy.mock.calls;
        const warnCall = calls.find((c: any[]) => c[0] === 'warn' && (c[1].includes('cleanupSession iteration') || c[1].includes('Force removing')));
        expect(warnCall).toBeDefined();

        expect(manager.hasActiveTasks(sessionId)).toBe(false);
    });

        it('SessionManager should respect custom configuration', async () => {
        // Create manager with small timeout and max iterations
        const config = { maxCleanupIterations: 2, cleanupTimeoutMs: 10 };
        const customManager = new SessionManager(mockStorage, mockEventBus, undefined, config);
        const sessionId = 'session-config';

        // Add a task that NEVER resolves (deferred)
        const task = createDeferred();
        setTask(customManager, sessionId, 'task_config_1', task.promise);

        // Also spy logs to verify timeout warning
        const logSpy = mock();
        (customManager as any).eventBus.log = logSpy;

        const start = Date.now();
        await customManager.cleanupSession(sessionId);
        const end = Date.now();

        // Should finish around 10ms (timeout)
        // Allowing 30ms margin
        expect(end - start).toBeLessThan(30);
        expect(customManager.hasActiveTasks(sessionId)).toBe(false);

        const calls = logSpy.mock.calls;
        const timeoutCall = calls.find((c: any[]) => c[0] === 'warn' && c[1].includes('timed out'));
        expect(timeoutCall).toBeDefined();
    });
});