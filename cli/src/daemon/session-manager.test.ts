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

        // Create tasks that resolve after a delay
        const task1 = new Promise<void>(resolve => setTimeout(resolve, 50));
        const task2 = new Promise<void>(resolve => setTimeout(resolve, 100));

        setTask(manager, sessionId, `task_${sessionId}_1`, task1);
        setTask(manager, sessionId, `task_${sessionId}_2`, task2);

        // Add a task from another session
        const otherSessionId = 'session-other';
        const otherSessionTask = new Promise<void>(resolve => resolve());
        setTask(manager, otherSessionId, `task_${otherSessionId}_1`, otherSessionTask);

        const start = Date.now();
        await manager.cleanupSession(sessionId);
        const end = Date.now();

        // Should take at least 50ms (the fastest task is 50ms, slowest is 100ms)
        // With Promise.all, it waits for the slowest (100ms).
        expect(end - start).toBeGreaterThanOrEqual(90);

        // Verify tasks are removed for the session
        expect(getActiveTasks(manager).has(sessionId)).toBe(false);

        // Verify other session task remains
        expect(getActiveTasks(manager).has(otherSessionId)).toBe(true);
        expect(getActiveTasks(manager).get(otherSessionId)!.has(`task_${otherSessionId}_1`)).toBe(true);
    });

    it('cleanupSession should handle rejected tasks gracefully', async () => {
        const sessionId = 'session-1';

        // Create a rejected task
        const rejectedTask = new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error('Task failed')), 10);
        });

        setTask(manager, sessionId, `task_${sessionId}_1`, rejectedTask);

        // This should not throw
        await manager.cleanupSession(sessionId);

        expect(getActiveTasks(manager).has(sessionId)).toBe(false);
    });

    it('cleanupSession should handle tasks added concurrently during cleanup', async () => {
        const sessionId = 'session-race';

        const taskA = new Promise<void>(resolve => setTimeout(resolve, 100));
        setTask(manager, sessionId, `task_${sessionId}_A`, taskA);

        const cleanupPromise = manager.cleanupSession(sessionId);

        // Add Task B after a delay
        setTimeout(() => {
            const taskB = new Promise<void>(resolve => setTimeout(resolve, 100));
            setTask(manager, sessionId, `task_${sessionId}_B`, taskB);
        }, 50);

        await cleanupPromise;

        expect(getActiveTasks(manager).has(sessionId)).toBe(false);
    });

    it('cleanupSession should stop after max iterations and log warning', async () => {
        const sessionId = 'session-infinite';

        // Spy on log
        const logSpy = mock();
        (manager as any).eventBus.log = logSpy;

        // Recursive task adder
        let taskCount = 0;

        const createSelfReplicatingTask = (id: string) => {
            const task = new Promise<void>(resolve => {
                setTimeout(() => {
                    resolve();
                    if (taskCount < 20) {
                        taskCount++;
                        createSelfReplicatingTask(`${sessionId}_${taskCount}`);
                    }
                }, 10);
            });
            setTask(manager, sessionId, id, task);
        };

        createSelfReplicatingTask(`${sessionId}_0`);

        await manager.cleanupSession(sessionId);

        const calls = logSpy.mock.calls;
        // Check for 'Force removing' log which happens after max iterations (default 3)
        const warnCall = calls.find((c: any[]) => c[0] === 'warn' && (c[1].includes('cleanupSession iteration') || c[1].includes('Force removing')));
        expect(warnCall).toBeDefined();

        // It should have cleaned up forcefully
        expect(getActiveTasks(manager).has(sessionId)).toBe(false);
    });

    it('SessionManager should respect custom configuration', async () => {
        // Create manager with small timeout and max iterations
        const config = { maxCleanupIterations: 2, cleanupTimeoutMs: 10 };
        const customManager = new SessionManager(mockStorage, mockEventBus, undefined, config);
        const sessionId = 'session-config';

        // Add a task that takes longer than timeout (50ms > 10ms)
        const slowTask = new Promise<void>(resolve => setTimeout(resolve, 50));
        setTask(customManager, sessionId, `task_${sessionId}_1`, slowTask);

        // Also spy logs to verify timeout warning
        const logSpy = mock();
        (customManager as any).eventBus.log = logSpy;

        const start = Date.now();
        await customManager.cleanupSession(sessionId);
        const end = Date.now();

        // Should finish around 10ms (timeout) instead of 50ms
        expect(end - start).toBeLessThan(30);
        expect(getActiveTasks(customManager).has(sessionId)).toBe(false);

        const calls = logSpy.mock.calls;
        const timeoutCall = calls.find((c: any[]) => c[0] === 'warn' && c[1].includes('timed out'));
        expect(timeoutCall).toBeDefined();
    });
});
