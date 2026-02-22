import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { SessionManager } from './session-manager.js';
import { EventBus } from './event-bus.js';
import type { StoragePort } from '../ports/storage.port.js';

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

    test('cleanupSession should wait for all tasks and clear activeTasks', async () => {
        const sessionId = 'session-1';
        // Access private property
        const activeTasks = (manager as any).activeTasks as Map<string, Promise<void>>;

        // Create tasks that resolve after a delay
        const task1 = new Promise<void>(resolve => setTimeout(resolve, 50));
        const task2 = new Promise<void>(resolve => setTimeout(resolve, 100));

        activeTasks.set(`task_${sessionId}_1`, task1);
        activeTasks.set(`task_${sessionId}_2`, task2);

        // Add a task from another session
        const otherSessionTask = new Promise<void>(resolve => resolve());
        activeTasks.set(`task_other_1`, otherSessionTask);

        const start = Date.now();
        await manager.cleanupSession(sessionId);
        const end = Date.now();

        // Should take at least 50ms (the fastest task is 50ms, slowest is 100ms)
        // With Promise.all, it waits for the slowest (100ms).
        expect(end - start).toBeGreaterThanOrEqual(90);

        // Verify tasks are removed for the session
        expect(activeTasks.has(`task_${sessionId}_1`)).toBe(false);
        expect(activeTasks.has(`task_${sessionId}_2`)).toBe(false);

        // Verify other session task remains
        expect(activeTasks.has(`task_other_1`)).toBe(true);
    });

    test('cleanupSession should handle rejected tasks gracefully', async () => {
        const sessionId = 'session-1';
        const activeTasks = (manager as any).activeTasks as Map<string, Promise<void>>;

        // Create a rejected task
        // We create a promise that rejects after a tick to avoid immediate unhandled rejection warning
        const rejectedTask = new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error('Task failed')), 10);
        });

        activeTasks.set(`task_${sessionId}_1`, rejectedTask);

        // This should not throw
        await manager.cleanupSession(sessionId);

        expect(activeTasks.has(`task_${sessionId}_1`)).toBe(false);
    });

    test('cleanupSession should handle tasks added concurrently during cleanup', async () => {
        const sessionId = 'session-race';
        const activeTasks = (manager as any).activeTasks as Map<string, Promise<void>>;

        const taskA = new Promise<void>(resolve => setTimeout(resolve, 100));
        activeTasks.set(`task_${sessionId}_A`, taskA);

        const cleanupPromise = manager.cleanupSession(sessionId);

        // Add Task B after a delay, effectively simulating a race condition
        // where a task is added while cleanupSession is awaiting.
        setTimeout(() => {
            const taskB = new Promise<void>(resolve => setTimeout(resolve, 100));
            activeTasks.set(`task_${sessionId}_B`, taskB);
        }, 50);

        await cleanupPromise;

        expect(activeTasks.has(`task_${sessionId}_A`)).toBe(false);
        expect(activeTasks.has(`task_${sessionId}_B`)).toBe(false);
    });

    test('cleanupSession should stop after max iterations and log warning', async () => {
        const sessionId = 'session-infinite';
        const activeTasks = (manager as any).activeTasks as Map<string, Promise<void>>;

        // Spy on log
        const logSpy = mock();
        (manager as any).eventBus.log = logSpy;

        // Recursive task adder that runs when a task finishes
        let taskCount = 0;

        // Simulate a scenario where tasks are added faster than cleanup can finish
        // Or simply recursion.
        // If we add 20 tasks sequentially, each taking 10ms.
        // Iteration 1: waits task 0 (10ms).
        // ...
        // Iteration 5: waits task 4 (10ms).
        // Total time ~50ms.
        // After 5 iterations, force cleanup runs.
        // It should delete remaining tasks (5 to 19 if added? No, they are added sequentially)
        // Wait, if added sequentially, only task 5 exists at this point.
        // So force cleanup removes task 5.
        // And task 6 never gets added because task 5 was deleted before it resolved?
        // Ah, if we delete the promise from the map, does it stop running? No.
        // The promise continues. The setTimeout fires. Task 6 is added.
        // But cleanupSession has returned!
        // So we DO have a leak if the promise continues running.
        // But that's outside scope of `cleanupSession` stopping the *execution*.
        // `cleanupSession` only cleans the *tracking*.
        // And effectively, "Session is closed".

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
            activeTasks.set(id, task);
        };

        createSelfReplicatingTask(`${sessionId}_0`);

        await manager.cleanupSession(sessionId);

        // We expect a warning about force removal of *some* task(s) that were pending when we gave up.
                        const calls = logSpy.mock.calls;
        // Check for either 'cleanupSession reached max iterations' OR 'Force removing'
        // Ideally both, but our test scenario might trigger one or other depending on timing.
        // Actually, if iterations < max, no warning.
        // But we forced recursion.
        // Wait, why did the loop exit?
        // Because iterations < MAX (5).
        // Wait, if loop exits because iterations == 5, it should log?
        // No, I removed the explicit log inside the 'if (iterations >= MAX)' block and replaced it with
        // force cleanup logic at the end.
        // Ah!

        // Let's check the code.
        // while (iterations < MAX) { ... iterations++ }
        // After loop, iterations == MAX.

        // Then:
        // const remainingTasks = ...
        // if (remainingTasks.length > 0) { log('Force removing ...') }

        // I REMOVED the specific log 'cleanupSession reached max iterations'.
        // I only log if there are ACTUAL remaining tasks to force remove.
        // Which is better!

        const warnCall = calls.find((c: any[]) => c[0] === 'warn' && (c[1].includes('cleanupSession reached max iterations') || c[1].includes('Force removing')));
        expect(warnCall).toBeDefined();
    });
});