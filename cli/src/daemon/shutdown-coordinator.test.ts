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

    it('attempts both stores after a previous close fails and reports only sanitized stage facts', async () => {
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

        expect(closeStorage).toHaveBeenCalledTimes(1);
        expect(closeMissionStore).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE');
        expect(JSON.stringify(diagnostics)).not.toContain('secret-token');
    });

    it('continues after a bounded close timeout and marks forced termination explicitly', async () => {
        const forceTerminate = mock(() => {});
        const closeMissionStore = mock(async () => {});
        const coordinator = new DaemonShutdownCoordinator({
            stopServer: () => new Promise<void>(() => {}),
            closeStorage: async () => {},
            closeMissionStore,
            forceTerminate,
            stepTimeoutMs: 10,
            forceTerminationTimeoutMs: 40,
        });

        await coordinator.requestShutdown('SIGTERM');

        expect(closeMissionStore).toHaveBeenCalledTimes(1);
        expect(forceTerminate).toHaveBeenCalledTimes(1);
    });
});
