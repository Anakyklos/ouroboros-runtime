import { describe, expect, it, mock } from 'bun:test';
import { DaemonServer } from './server.js';
import { EventBus } from './event-bus.js';
import type { DaemonRpcGatewayPort } from './rpc-gateway.js';
import { DaemonShutdownCoordinator } from './shutdown-coordinator.js';
import { MissionState, type Mission } from '../mission/contracts.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { FastifyInstance } from 'fastify';

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

function fastifyApp(server: DaemonServer): FastifyInstance {
    return (server as unknown as { app: FastifyInstance }).app;
}

function inFlightRpc(server: DaemonServer): number {
    return (server as unknown as { inFlightRpc: number }).inFlightRpc;
}

describe('RPC shutdown and pending Mission command', () => {
    it('keeps an accepted RPC counted until the Fastify response finishes', async () => {
        let reachedOnSend!: () => void;
        let releaseOnSend!: () => void;
        const onSendReached = new Promise<void>((resolve) => { reachedOnSend = resolve; });
        const onSendRelease = new Promise<void>((resolve) => { releaseOnSend = resolve; });
        const port = await freePort();
        const server = new DaemonServer({} as StoragePort, { port, host: '127.0.0.1' }, new EventBus());
        fastifyApp(server).addHook('onSend', async (request, _reply, payload) => {
            if ((request.body as { method?: string } | undefined)?.method === 'system.version') {
                reachedOnSend();
                await onSendRelease;
            }
            return payload;
        });
        await server.start();

        const responsePromise = fetch(`http://127.0.0.1:${port}/rpc`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'held-version', method: 'system.version' }),
        });
        try {
            await onSendReached;
            expect(inFlightRpc(server)).toBe(1);
            releaseOnSend();
            expect(await (await responsePromise).json()).toMatchObject({ result: { name: 'ouroboros-daemon' } });
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(inFlightRpc(server)).toBe(0);
        } finally {
            releaseOnSend();
            await responsePromise.catch(() => undefined);
            await server.stop();
        }
    });

    it('settles the response tracker after a handler fails before serialization', async () => {
        const port = await freePort();
        const failingGateway = {
            handleRequest: async () => { throw new Error('PRIVATE handler failure'); },
            getProjectionSnapshot: async () => ({}),
            registerMethod: () => {},
        } as unknown as DaemonRpcGatewayPort;
        const server = new DaemonServer(
            {} as StoragePort,
            { port, host: '127.0.0.1' },
            new EventBus(),
            undefined,
            failingGateway,
        );
        await server.start();

        try {
            const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 'failing-handler', method: 'system.version' }),
            });
            await response.arrayBuffer();
            expect(response.status).toBe(500);
            expect(inFlightRpc(server)).toBe(0);
        } finally {
            await server.stop();
        }
    });

    it('sends the retained shutdown response before closing either store', async () => {
        let reachedOnSend!: () => void;
        let releaseOnSend!: () => void;
        const onSendReached = new Promise<void>((resolve) => { reachedOnSend = resolve; });
        const onSendRelease = new Promise<void>((resolve) => { releaseOnSend = resolve; });
        const port = await freePort();
        const eventBus = new EventBus();
        let lifecycle!: DaemonShutdownCoordinator;
        let shutdownPromise: Promise<void> | undefined;
        const closeStorage = mock(async () => {});
        const closeMissionStore = mock(async () => {});
        const server = new DaemonServer(
            {} as StoragePort,
            { port, host: '127.0.0.1' },
            eventBus,
            undefined,
            undefined,
            undefined,
            () => { shutdownPromise = lifecycle.requestShutdown('RPC'); },
        );
        lifecycle = new DaemonShutdownCoordinator({
            stopServer: () => server.stop(),
            closeStorage,
            closeMissionStore,
            forceTerminate: mock(() => {}),
        });
        fastifyApp(server).addHook('onSend', async (request, _reply, payload) => {
            if ((request.body as { method?: string } | undefined)?.method === 'system.shutdown') {
                reachedOnSend();
                await onSendRelease;
            }
            return payload;
        });
        await server.start();

        const responsePromise = fetch(`http://127.0.0.1:${port}/rpc`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'held-shutdown', method: 'system.shutdown' }),
        });
        try {
            await onSendReached;
            expect(inFlightRpc(server)).toBe(1);
            expect(closeStorage).not.toHaveBeenCalled();
            expect(closeMissionStore).not.toHaveBeenCalled();
            releaseOnSend();
            expect(await (await responsePromise).json()).toMatchObject({
                jsonrpc: '2.0', id: 'held-shutdown', result: { status: 'shutting_down' },
            });
            await shutdownPromise;
            expect(inFlightRpc(server)).toBe(0);
            expect(closeStorage).toHaveBeenCalledTimes(1);
            expect(closeMissionStore).toHaveBeenCalledTimes(1);
        } finally {
            releaseOnSend();
            await responsePromise.catch(() => undefined);
            if (shutdownPromise) await shutdownPromise;
            else await server.stop();
        }
    });

    it('keeps stores open while a completed Mission command response is held in onSend', async () => {
        let reachedOnSend!: () => void;
        let releaseOnSend!: () => void;
        const onSendReached = new Promise<void>((resolve) => { reachedOnSend = resolve; });
        const onSendRelease = new Promise<void>((resolve) => { releaseOnSend = resolve; });
        const port = await freePort();
        const closeStorage = mock(async () => {});
        const closeMissionStore = mock(async () => {});
        const pauseMission = mock(async () => pausedMission());
        const authority = { pauseMission } as never;
        let lifecycle!: DaemonShutdownCoordinator;
        const server = new DaemonServer(
            {} as StoragePort,
            { port, host: '127.0.0.1' },
            new EventBus(),
            undefined,
            undefined,
            authority,
        );
        lifecycle = new DaemonShutdownCoordinator({
            stopServer: () => server.stop(),
            closeStorage,
            closeMissionStore,
            forceTerminate: mock(() => {}),
        });
        fastifyApp(server).addHook('onSend', async (request, _reply, payload) => {
            if ((request.body as { method?: string } | undefined)?.method === 'local_control.command') {
                reachedOnSend();
                await onSendRelease;
            }
            return payload;
        });
        await server.start();

        const commandResponsePromise = fetch(`http://127.0.0.1:${port}/rpc`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 'held-mission-response', method: 'local_control.command',
                params: {
                    protocolVersion: 1, operation: 'mission.pause',
                    missionId: 'pending-command-mission', reason: 'operator pause', pausedBy: 'test',
                },
            }),
        });
        let shutdownPromise: Promise<void> | undefined;
        try {
            await onSendReached;
            expect(pauseMission).toHaveBeenCalledTimes(1);
            expect(inFlightRpc(server)).toBe(1);
            shutdownPromise = lifecycle.requestShutdown('SIGTERM');

            const deadline = Date.now() + 1_000;
            while (Date.now() < deadline) {
                const health = await fetch(`http://127.0.0.1:${port}/health`);
                if (health.status === 503) break;
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            expect(closeStorage).not.toHaveBeenCalled();
            expect(closeMissionStore).not.toHaveBeenCalled();
            expect(inFlightRpc(server)).toBe(1);

            releaseOnSend();
            expect(await (await commandResponsePromise).json()).toMatchObject({
                result: { ok: true, operation: 'mission.pause', data: { state: 'paused' } },
            });
            await shutdownPromise;
            expect(inFlightRpc(server)).toBe(0);
            expect(closeStorage).toHaveBeenCalledTimes(1);
            expect(closeMissionStore).toHaveBeenCalledTimes(1);
        } finally {
            releaseOnSend();
            await commandResponsePromise.catch(() => undefined);
            if (shutdownPromise) await shutdownPromise;
            else await server.stop();
        }
    });

    it('reports an expired bounded drain as uncertain instead of graceful completion', async () => {
        let reachedOnSend!: () => void;
        let releaseOnSend!: () => void;
        const onSendReached = new Promise<void>((resolve) => { reachedOnSend = resolve; });
        const onSendRelease = new Promise<void>((resolve) => { releaseOnSend = resolve; });
        const port = await freePort();
        const eventBus = new EventBus();
        const logMessages: string[] = [];
        eventBus.on('log', (event) => logMessages.push(event.message));
        const server = new DaemonServer({} as StoragePort, { port, host: '127.0.0.1' }, eventBus);
        fastifyApp(server).addHook('onSend', async (request, _reply, payload) => {
            if ((request.body as { method?: string } | undefined)?.method === 'system.version') {
                reachedOnSend();
                await onSendRelease;
            }
            return payload;
        });
        await server.start();

        const responsePromise = fetch(`http://127.0.0.1:${port}/rpc`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'timeout-version', method: 'system.version' }),
        }).then((response) => response.arrayBuffer(), (error: unknown) => error);
        try {
            await onSendReached;
            await expect(server.stop()).rejects.toThrow('Accepted RPC response drain timed out');
            releaseOnSend();
            await responsePromise;
            const closeDeadline = Date.now() + 1_000;
            while (inFlightRpc(server) !== 0 && Date.now() < closeDeadline) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            expect(logMessages).toContain('RPC shutdown drain timed out; pending results may be unknown');
            expect(logMessages).toContain('Daemon transport closed after RPC drain timeout; pending results may be unknown');
            expect(logMessages).not.toContain('Daemon stopped gracefully');
            expect(inFlightRpc(server)).toBe(0);
        } finally {
            releaseOnSend();
            await responsePromise;
            await server.stop().catch(() => undefined);
        }
    });

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
