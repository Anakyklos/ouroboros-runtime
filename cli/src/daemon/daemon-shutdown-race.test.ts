import { describe, expect, it, mock } from 'bun:test';
import { DaemonServer } from './server.js';
import { EventBus } from './event-bus.js';
import { DaemonShutdownCoordinator } from './shutdown-coordinator.js';
import { MissionState, type Mission } from '../mission/contracts.js';
import type { StoragePort } from '../ports/storage.port.js';

function pausedMission(): Mission {
    return {
        missionId: 'pending-command-mission', schemaVersion: 1, source: 'operator',
        originalIntent: 'Pause a mission', sanitizedOriginalIntent: 'Pause a mission',
        originalIntentRef: 'sha256:pending-command', interpretedObjective: 'Pause a mission',
        constraints: [], acceptanceCriteria: [], budgetPolicy: {},
        allowedCapabilityScope: { capabilityIds: [], allowedEffectClasses: [], allowedRefPrefixes: [] },
        approvalRequirements: [], contextRefs: [], state: MissionState.PAUSED,
        currentPlanRevisionId: null, invocationRefs: [], evidenceRefs: [], criterionVerifications: [],
        unresolvedQuestions: [], createdAt: '2026-10-07T00:00:00.000Z',
        updatedAt: '2026-10-07T00:00:01.000Z', recoveryMetadata: { recovered: false, recoveryCount: 0 },
        pauseMetadata: { reason: 'operator pause', pausedBy: 'test', pausedAt: '2026-10-07T00:00:01.000Z' },
    };
}

async function freePort(): Promise<number> {
    const net = await import('node:net');
    const listener = net.createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('No port assigned');
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    return address.port;
}

describe('RPC shutdown and pending Mission command', () => {
    it('closes admission, waits for the real command response, and then closes both stores', async () => {
        let startCommand!: () => void;
        let finishCommand!: (mission: Mission) => void;
        const commandStarted = new Promise<void>((resolve) => { startCommand = resolve; });
        const commandResult = new Promise<Mission>((resolve) => { finishCommand = resolve; });
        const pauseMission = mock(async () => {
            startCommand();
            return await commandResult;
        });
        const authority = { pauseMission } as never;
        const port = await freePort();
        const eventBus = new EventBus();
        let lifecycle!: DaemonShutdownCoordinator;
        const storageClosed = mock(async () => {});
        const missionStoreClosed = mock(async () => {});
        const server = new DaemonServer(
            {} as StoragePort,
            { port, host: '127.0.0.1' },
            eventBus,
            undefined,
            undefined,
            authority,
            () => { void lifecycle.requestShutdown('RPC'); },
        );
        lifecycle = new DaemonShutdownCoordinator({
            stopServer: () => server.stop(),
            closeStorage: storageClosed,
            closeMissionStore: missionStoreClosed,
            forceTerminate: mock(() => {}),
        });
        await server.start();

        const commandResponsePromise = fetch(`http://127.0.0.1:${port}/rpc`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 'pending-command', method: 'local_control.command',
                params: {
                    protocolVersion: 1, operation: 'mission.pause',
                    missionId: 'pending-command-mission', reason: 'operator pause', pausedBy: 'test',
                },
            }),
        });
        await commandStarted;
        const shutdownResponse = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'shutdown', method: 'system.shutdown' }),
        });
        expect(await shutdownResponse.json()).toMatchObject({ result: { status: 'shutting_down' } });

        const admissionDeadline = Date.now() + 1_000;
        let admissionResponse: Response | undefined;
        while (Date.now() < admissionDeadline) {
            admissionResponse = await fetch(`http://127.0.0.1:${port}/rpc`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 'new-request', method: 'system.health' }),
            });
            if (admissionResponse.status === 503) break;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(admissionResponse?.status).toBe(503);
        const pending = await Promise.race([
            commandResponsePromise.then(() => 'completed' as const),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10)),
        ]);
        expect(pending).toBe('pending');

        finishCommand(pausedMission());
        const commandResponse = await commandResponsePromise;
        expect(await commandResponse.json()).toMatchObject({ result: { ok: true, operation: 'mission.pause', data: { state: 'paused' } } });
        await lifecycle.requestShutdown('SIGTERM');
        expect(storageClosed).toHaveBeenCalledTimes(1);
        expect(missionStoreClosed).toHaveBeenCalledTimes(1);
    });
});
