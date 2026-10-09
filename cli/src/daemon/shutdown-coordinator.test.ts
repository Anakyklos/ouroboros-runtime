import { describe, expect, it, mock } from 'bun:test';
import { DaemonShutdownCoordinator } from './shutdown-coordinator.js';

describe('DaemonShutdownCoordinator', () => {
    it('coalesces concurrent requests and closes every resource once in order', async () => {
        const order: string[] = [];
        const coordinator = new DaemonShutdownCoordinator({
            stopServer: async () => { order.push('server'); },
            closeStorage: async () => { order.push('storage'); },
            closeMissionStore: async () => { order.push('mission-store'); },
            forceTerminate: mock(() => {}),
        });

        await Promise.all([
            coordinator.requestShutdown('SIGTERM'),
            coordinator.requestShutdown('SIGINT'),
            coordinator.requestShutdown('RPC'),
        ]);

        expect(order).toEqual(['server', 'storage', 'mission-store']);
    });

    it('leaves both stores open when RPC quiescence is not proved and reports only sanitized facts', async () => {
        const closeStorage = mock(async () => { throw new Error('PRIVATE PATH / secret-token'); });
        const closeMissionStore = mock(async () => {});
        const diagnostics: unknown[] = [];
        const coordinator = new DaemonShutdownCoordinator({
            stopServer: async () => { throw new Error('PRIVATE SOCKET'); },
            closeStorage,
            closeMissionStore,
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
            forceTerminate: mock(() => {}),
        });

        await coordinator.requestShutdown('RPC');

        expect(closeStorage).not.toHaveBeenCalled();
        expect(closeMissionStore).not.toHaveBeenCalled();
        expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE');
        expect(JSON.stringify(diagnostics)).not.toContain('secret-token');
        expect(diagnostics).toContainEqual({ stage: 'storage', outcome: 'timed_out' });
        expect(diagnostics).toContainEqual({ stage: 'mission_store', outcome: 'timed_out' });
    });

    it('continues independent store closure after a proven-safe close error without exposing details', async () => {
        const closeStorage = mock(async () => { throw new Error('PRIVATE PATH / secret-token'); });
        const closeMissionStore = mock(async () => {});
        const diagnostics: unknown[] = [];
        const coordinator = new DaemonShutdownCoordinator({
            stopServer: async () => {},
            closeStorage,
            closeMissionStore,
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
            forceTerminate: mock(() => {}),
        });

        await coordinator.requestShutdown('RPC');

        expect(closeStorage).toHaveBeenCalledTimes(1);
        expect(closeMissionStore).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(diagnostics)).toContain('storage');
        expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE');
        expect(JSON.stringify(diagnostics)).not.toContain('secret-token');
    });

    it('leaves stores open after a bounded server drain timeout and marks forced termination explicitly', async () => {
        const forceTerminate = mock(() => {});
        const setExitCode = mock((_code: number) => {});
        const closeStorage = mock(async () => {});
        const closeMissionStore = mock(async () => {});
        const coordinator = new DaemonShutdownCoordinator({
            stopServer: () => new Promise<void>(() => {}),
            closeStorage,
            closeMissionStore,
            forceTerminate,
            setExitCode,
            stepTimeoutMs: 10,
            forceTerminationTimeoutMs: 40,
        });

        await coordinator.requestShutdown('SIGTERM');

        expect(closeStorage).not.toHaveBeenCalled();
        expect(closeMissionStore).not.toHaveBeenCalled();
        expect(forceTerminate).toHaveBeenCalledTimes(1);
        expect(setExitCode).toHaveBeenCalledWith(1);
    });

    it('does not close MissionStore when a scheduling pass misses its drain bound', async () => {
        const closeMissionStore = mock(async () => {});
        const diagnostics: unknown[] = [];
        const coordinator = new DaemonShutdownCoordinator({
            stopServer: async () => {},
            stopMissionScheduler: () => new Promise<void>(() => {}),
            closeStorage: async () => {},
            closeMissionStore,
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
            forceTerminate: mock(() => {}),
            stepTimeoutMs: 10,
            forceTerminationTimeoutMs: 40,
        });

        await coordinator.requestShutdown('SIGTERM');

        expect(closeMissionStore).not.toHaveBeenCalled();
        expect(diagnostics).toContainEqual({ stage: 'mission_scheduler', outcome: 'timed_out' });
        expect(diagnostics).toContainEqual({ stage: 'mission_store', outcome: 'timed_out' });
    });
});
