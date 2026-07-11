import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SessionManager } from './session-manager.js';
import { EventBus } from './event-bus.js';
import type { StoragePort } from '../ports/storage.port.js';
import { Orchestrator } from '../orchestration/Orchestrator.js';
import { createTask } from '../orchestration/index.js';
import { PersonaType, TaskStatus } from '../orchestration/types.js';

// Subclass to expose protected methods for testing
class TestSessionManager extends SessionManager {
    public addTaskForTest(sessionId: string, taskId: string, promise: Promise<void>) {
        this.addTask(sessionId, taskId, promise);
    }

    public hasActiveTasksForTest(sessionId: string): boolean {
        return this.hasActiveTasks(sessionId);
    }

    public attachOrchestrator(sessionId: string, orchestrator: Orchestrator) {
        this.attachOrchestratorForTest(sessionId, orchestrator);
    }

    public activeSessionIds() {
        return this.getActiveSessionIdsForTest();
    }
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
    let manager: TestSessionManager;
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
            createCheckpoint: mock(async (sessionId: string) => ({
                id: 'cp-1',
                sessionId,
                checkpointNumber: 1,
                state: {},
                createdAt: new Date(),
            })),
            deleteOldCheckpoints: mock(async () => {}),
            getLatestCheckpoint: mock(async () => null),
            listWaves: mock(async () => []),
            saveWave: mock(async () => ({ id: 'w1', sessionId: 's', waveNumber: 1, status: 'pending', taskCount: 0, completedCount: 0, taskData: [] })),
            saveMemory: mock(async (m) => ({ ...m, id: 'm1', createdAt: new Date() })),
            listMemory: mock(async () => []),
        } as unknown as StoragePort;
        manager = new TestSessionManager(mockStorage, mockEventBus);
    });

    it('cleanupSession should wait for all tasks and clear activeTasks', async () => {
        const sessionId = 'session-1';

        // Create controllable tasks
        const task1 = createDeferred();
        const task2 = createDeferred();

        manager.addTaskForTest(sessionId, 'task_session-1_1', task1.promise);
        manager.addTaskForTest(sessionId, 'task_session-1_2', task2.promise);

        // Add a task from another session
        const otherSessionId = 'session-other';
        const otherSessionTask = createDeferred();
        manager.addTaskForTest(otherSessionId, 'task_other_1', otherSessionTask.promise);

        // Start cleanup (it should wait)
        const cleanupPromise = manager.cleanupSession(sessionId);

        // Verify tasks are still tracked (cleanup is pending)
        expect(manager.hasActiveTasksForTest(sessionId)).toBe(true);
        expect(manager.hasActiveTasksForTest(otherSessionId)).toBe(true);

        // Resolve tasks
        task1.resolve();
        task2.resolve();

        // Wait for cleanup to finish
        await cleanupPromise;

        // Verify tasks are removed
        expect(manager.hasActiveTasksForTest(sessionId)).toBe(false);
        // Other session remains
        expect(manager.hasActiveTasksForTest(otherSessionId)).toBe(true);
    });

    it('cleanupSession should handle rejected tasks gracefully', async () => {
        const sessionId = 'session-1';

        // Create a rejected task
        const task1 = createDeferred();

        manager.addTaskForTest(sessionId, 'task_session-1_1', task1.promise);

        const cleanupPromise = manager.cleanupSession(sessionId);

        // Reject it
        task1.reject(new Error('Task failed'));

        // This should not throw
        await cleanupPromise;

        expect(manager.hasActiveTasksForTest(sessionId)).toBe(false);
    });

    it('cleanupSession should handle tasks added concurrently during cleanup', async () => {
        const sessionId = 'session-race';

        const taskA = createDeferred();
        manager.addTaskForTest(sessionId, 'task_A', taskA.promise);

        const cleanupPromise = manager.cleanupSession(sessionId);

        // Add Task B while cleanup is waiting for A
        const taskB = createDeferred();
        manager.addTaskForTest(sessionId, 'task_B', taskB.promise);

        // Resolve A -> cleanup loop continues, finds B
        taskA.resolve();

        // Resolve B -> cleanup loop finishes
        taskB.resolve();

        await cleanupPromise;

        expect(manager.hasActiveTasksForTest(sessionId)).toBe(false);
    });

    it('cleanupSession should stop after max iterations and log warning', async () => {
        const sessionId = 'session-infinite';

        // Spy on log
        const logSpy = mock();
        (manager as any).eventBus.log = logSpy;

        // We simulate iterations by adding tasks manually before resolving current ones
        // Iteration 1 starts. Waits for T1.
        const t1 = createDeferred();
        manager.addTaskForTest(sessionId, 't1', t1.promise);

        const cleanupPromise = manager.cleanupSession(sessionId);

        // Loop is waiting for t1.
        // Add t2. Resolve t1.
        const t2 = createDeferred();
        manager.addTaskForTest(sessionId, 't2', t2.promise);
        t1.resolve();

        // Iteration 2 setup
        await new Promise(r => setTimeout(r, 0)); // Let loop tick
        const t3 = createDeferred();
        manager.addTaskForTest(sessionId, 't3', t3.promise);
        t2.resolve();

        // Iteration 3
        await new Promise(r => setTimeout(r, 0));
        const t4 = createDeferred();
        manager.addTaskForTest(sessionId, 't4', t4.promise);
        t3.resolve();

        // Iteration 4 (should be > max 3)
        await new Promise(r => setTimeout(r, 0));
        t4.resolve();

        await cleanupPromise;

        const calls = logSpy.mock.calls;
        const warnCall = calls.find((c: any[]) => c[0] === 'warn' && (c[1].includes('cleanupSession iteration') || c[1].includes('Force removing')));
        expect(warnCall).toBeDefined();

        expect(manager.hasActiveTasksForTest(sessionId)).toBe(false);
    });

    it('SessionManager should respect custom configuration', async () => {
        // Create manager with small timeout and max iterations
        const config = { maxCleanupIterations: 2, cleanupTimeoutMs: 10 };
        const customManager = new TestSessionManager(mockStorage, mockEventBus, undefined, config);
        const sessionId = 'session-config';

        // Add a task that NEVER resolves (deferred)
        const task = createDeferred();
        customManager.addTaskForTest(sessionId, 'task_config_1', task.promise);

        // Also spy logs to verify timeout warning
        const logSpy = mock();
        (customManager as any).eventBus.log = logSpy;

        const start = Date.now();
        await customManager.cleanupSession(sessionId);
        const end = Date.now();

        // Should finish around 10ms (timeout)
        // Allowing 30ms margin
        expect(end - start).toBeLessThan(30);
        expect(customManager.hasActiveTasksForTest(sessionId)).toBe(false);

        const calls = logSpy.mock.calls;
        const timeoutCall = calls.find((c: any[]) => c[0] === 'warn' && c[1].includes('timed out'));
        expect(timeoutCall).toBeDefined();
    });

    it('rejects non-positive checkpointIntervalMs and falls back to default', () => {
        const zero = new TestSessionManager(mockStorage, mockEventBus, undefined, {
            checkpointIntervalMs: 0,
        });
        const negative = new TestSessionManager(mockStorage, mockEventBus, undefined, {
            checkpointIntervalMs: -100,
        });
        const valid = new TestSessionManager(mockStorage, mockEventBus, undefined, {
            checkpointIntervalMs: 15_000,
        });

        expect((zero as any).checkpointIntervalMs).toBe(30_000);
        expect((negative as any).checkpointIntervalMs).toBe(30_000);
        expect((valid as any).checkpointIntervalMs).toBe(15_000);
    });

    it('rejects maxCheckpoints < 1 and falls back to default', () => {
        const zero = new TestSessionManager(mockStorage, mockEventBus, undefined, {
            maxCheckpoints: 0,
        });
        const negative = new TestSessionManager(mockStorage, mockEventBus, undefined, {
            maxCheckpoints: -2,
        });
        const valid = new TestSessionManager(mockStorage, mockEventBus, undefined, {
            maxCheckpoints: 3,
        });

        expect((zero as any).maxCheckpoints).toBe(5);
        expect((negative as any).maxCheckpoints).toBe(5);
        expect((valid as any).maxCheckpoints).toBe(3);
    });

    describe('operational controls (issue #37)', () => {
        it('status reports real zero activity, not scenic constants', () => {
            const status = manager.getStatusSnapshot();
            expect(status.processStatus).toBe('alive');
            expect(status.mode).toBe('running');
            expect(status.activeSessions.available).toBe(true);
            if (status.activeSessions.available) expect(status.activeSessions.value).toBe(0);
            expect(status.activeTasks.available).toBe(true);
            if (status.activeTasks.available) expect(status.activeTasks.value).toBe(0);
            expect(status.activeWaves.available).toBe(true);
            if (status.activeWaves.available) expect(status.activeWaves.value).toBe(0);
            // tokens must not pretend to be zero usage
            expect(status.tokensUsed.available).toBe(false);
            expect(status.capabilities.tokenMetrics).toBe(false);
            expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
        });

        it('status counts live tasks and sessions', () => {
            const orch = new Orchestrator({ verbose: false, skipPhaseValidation: true }, mockEventBus);
            manager.attachOrchestrator('sess-a', orch);
            manager.addTaskForTest('sess-a', 't1', createDeferred().promise);
            manager.addTaskForTest('sess-a', 't2', createDeferred().promise);

            const status = manager.getStatusSnapshot();
            if (status.activeSessions.available) expect(status.activeSessions.value).toBe(1);
            if (status.activeTasks.available) expect(status.activeTasks.value).toBe(2);
        });

        it('status does not count terminal sessions with no live tasks', () => {
            const orch = new Orchestrator({ verbose: false, skipPhaseValidation: true }, mockEventBus);
            manager.attachOrchestrator('done-sess', orch);
            // no tasks → not live
            const status = manager.getStatusSnapshot();
            if (status.activeSessions.available) expect(status.activeSessions.value).toBe(0);
            if (status.activeTasks.available) expect(status.activeTasks.value).toBe(0);
        });

        it('setMode applies valid modes and rejects unknown', async () => {
            const bad = await manager.setMode('turbo');
            expect(bad.operation).toBe('rejected_invalid_mode');
            expect(bad.resultingMode).toBe('running');
            expect(manager.getMode()).toBe('running');

            const ok = await manager.setMode('pause');
            expect(ok.operation).toBe('applied');
            expect(ok.previousMode).toBe('running');
            expect(ok.resultingMode).toBe('pause');
            expect(manager.getMode()).toBe('pause');

            const same = await manager.setMode('pause');
            expect(same.operation).toBe('unchanged');
            expect(manager.getMode()).toBe('pause');
        });

        it('setMode pause pauses attached orchestrators', async () => {
            const orch = new Orchestrator({ verbose: false, skipPhaseValidation: true }, mockEventBus);
            const pauseSpy = mock(() => {});
            orch.pause = pauseSpy;
            manager.attachOrchestrator('sess-pause', orch);

            await manager.setMode('pause');
            expect(pauseSpy).toHaveBeenCalled();
        });

        it('emergencyBrake with no work returns no_active_work', async () => {
            const result = await manager.emergencyBrake();
            expect(result.outcome).toBe('no_active_work');
            expect(result.complete).toBe(true);
            expect(result.interruptedCount).toBe(0);
            expect(manager.getMode()).toBe('pause');
        });

        it('emergencyBrake cancels live work and settles tasks', async () => {
            const orch = new Orchestrator({ verbose: false, skipPhaseValidation: true }, mockEventBus);
            const cancelSpy = mock((..._args: unknown[]) => {
                // real cancel still runs
            });
            const realCancel = orch.cancel.bind(orch);
            orch.cancel = (reason?: string) => {
                cancelSpy(reason);
                realCancel(reason);
            };

            manager.attachOrchestrator('sess-live', orch);
            const deferred = createDeferred();
            // When cancel fires, settle the tracked promise (simulates cooperative cancel)
            orch.cancel = (reason?: string) => {
                cancelSpy(reason);
                realCancel(reason);
                deferred.resolve();
            };
            manager.addTaskForTest('sess-live', 'task-1', deferred.promise);

            const first = await manager.emergencyBrake();
            expect(first.outcome).toBe('all_stopped');
            expect(first.complete).toBe(true);
            expect(first.interruptedCount).toBe(1);
            expect(cancelSpy).toHaveBeenCalled();
            expect(manager.getMode()).toBe('pause');
            expect(mockStorage.updateSession).toHaveBeenCalled();
        });

        it('emergencyBrake is idempotent when already braked and idle', async () => {
            await manager.emergencyBrake();
            const again = await manager.emergencyBrake();
            expect(again.outcome).toBe('already_stopped');
            expect(again.complete).toBe(true);
            expect(again.interruptedCount).toBe(0);
        });

        it('emergencyBrake reports partial when persist fails', async () => {
            (mockStorage.updateSession as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('db write failed');
            });
            const orch = new Orchestrator({ verbose: false, skipPhaseValidation: true }, mockEventBus);
            manager.attachOrchestrator('sess-fail', orch);
            const d = createDeferred();
            const realCancel = orch.cancel.bind(orch);
            orch.cancel = (r?: string) => {
                realCancel(r);
                d.resolve();
            };
            manager.addTaskForTest('sess-fail', 't1', d.promise);

            const result = await manager.emergencyBrake();
            expect(result.complete).toBe(false);
            expect(result.outcome).toBe('partial');
            expect(result.failedCount).toBe(1);
            expect(result.sessions[0]?.persistOk).toBe(false);
        });

        it('emergencyBrake skips terminal sessions without rewriting status', async () => {
            (mockStorage.getSession as ReturnType<typeof mock>).mockImplementation(async (id: string) => {
                if (id === 'terminal-sess') {
                    return {
                        id: 'terminal-sess',
                        status: 'completed',
                        createdAt: new Date(),
                        updatedAt: new Date(),
                        contextSnapshot: '',
                        metadata: {},
                    };
                }
                return null;
            });
            const orch = new Orchestrator({ verbose: false, skipPhaseValidation: true }, mockEventBus);
            manager.attachOrchestrator('terminal-sess', orch);
            // Simulate stale task entry pointing at terminal session
            manager.addTaskForTest('terminal-sess', 'stale', createDeferred().promise);

            const result = await manager.emergencyBrake();
            const entry = result.sessions.find((s) => s.sessionId === 'terminal-sess');
            expect(entry?.status).toBe('skipped');
            // Must not force completed → paused
            const pauseCalls = (mockStorage.updateSession as ReturnType<typeof mock>).mock.calls.filter(
                (c: unknown[]) => c[0] === 'terminal-sess' && (c[1] as { status?: string })?.status === 'paused'
            );
            expect(pauseCalls.length).toBe(0);
        });

        it('Orchestrator.cancel settles in-flight loopUntilSuccess as CANCELLED', async () => {
            const orch = new Orchestrator(
                { verbose: false, skipPhaseValidation: true, maxRetries: 3 },
                mockEventBus
            );
            // Hang execute forever until cancel races it out
            (orch as unknown as { executeWithTimeout: (p: string) => Promise<unknown> }).executeWithTimeout =
                () => new Promise(() => {});

            const task = createTask('hang forever', PersonaType.DEVELOPER, { id: 'hang-1' });
            const running = orch.loopUntilSuccess(task);
            await new Promise((r) => setTimeout(r, 30));
            orch.cancel('test brake');
            const result = await running;
            expect(result.status).toBe(TaskStatus.CANCELLED);
            expect(result.error).toMatch(/cancel/i);
        });

        it('sendInput removes tasks from metrics on resolve and reject', async () => {
            const orch = new Orchestrator({ verbose: false, skipPhaseValidation: true }, mockEventBus);
            manager.attachOrchestrator('session-1', orch);

            orch.loopUntilSuccess = mock(async () => ({
                status: TaskStatus.SUCCESS,
                output: 'ok',
                retryCount: 0,
                persona: PersonaType.DEVELOPER,
                durationMs: 1,
                contextHistory: [],
            }));

            await manager.sendInput('session-1', 'do work');
            // allow finally to run
            await new Promise((r) => setTimeout(r, 10));
            let snap = manager.getStatusSnapshot();
            if (snap.activeTasks.available) expect(snap.activeTasks.value).toBe(0);

            orch.loopUntilSuccess = mock(async () => {
                throw new Error('boom');
            });
            // re-attach after releaseSessionRuntime on completed
            manager.attachOrchestrator('session-1', orch);
            await manager.sendInput('session-1', 'fail work');
            await new Promise((r) => setTimeout(r, 10));
            snap = manager.getStatusSnapshot();
            if (snap.activeTasks.available) expect(snap.activeTasks.value).toBe(0);
        });
    });
});
