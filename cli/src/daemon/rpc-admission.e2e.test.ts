import { expect, it } from 'bun:test';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../adapters/sqlite.adapter.js';
import { SqliteMissionStore } from '../mission/sqlite-mission-store.js';
import { MissionEngine } from '../mission/mission-engine.js';
import { PlanPolicyValidator } from '../mission/policy.js';
import { FakeCapabilityResolver } from '../mission/testing.js';
import { EventBus } from './event-bus.js';
import {
    LocalControlAuthorizer,
    LocalControlCredentialStore,
} from './local-control-auth.js';
import { RpcGateway, type DaemonRpcGatewayPort } from './rpc-gateway.js';
import { DaemonServer } from './server.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
}

async function unusedLoopbackPort(): Promise<number> {
    const listener = createNetServer();
    await new Promise<void>((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback port');
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    return address.port;
}

it('enforces authenticated RPC capacity over loopback with SQLite and restores admission after settlement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ouroboros-rpc-admission-e2e-'));
    const port = await unusedLoopbackPort();
    const eventBus = new EventBus();
    const storage = new SqliteAdapter(join(directory, 'daemon.db'));
    const missionStore = new SqliteMissionStore(join(directory, 'missions.db'));
    const credentialStore = new LocalControlCredentialStore(join(directory, 'auth', 'clients.db'));
    const readToken = credentialStore.provision('rpc-read', ['mission.read'], Date.now() + 60_000).token;
    const controlToken = credentialStore.provision('rpc-control', ['mission.control'], Date.now() + 60_000).token;
    const authorizer = new LocalControlAuthorizer(credentialStore, []);
    const entered = deferred<void>();
    const release = deferred<void>();
    const gatewayCalls: string[] = [];
    let server: DaemonServer | undefined;

    try {
        await storage.initialize();
        await missionStore.initialize();
        const missionEngine = new MissionEngine({ store: missionStore, policy: new PlanPolicyValidator(new FakeCapabilityResolver()) });
        const mission = await missionEngine.createMission({
            intent: {
                requestId: 'rpc-admission-e2e', source: 'cli', originalIntent: 'bounded local test',
                constraints: [], acceptanceCriteria: [],
            },
            allowedCapabilityScope: { capabilityIds: [], allowedEffectClasses: [], allowedRefPrefixes: [] },
        });
        const delegate = new RpcGateway(storage, eventBus, missionStore, undefined, missionEngine);
        const gateway: DaemonRpcGatewayPort = {
            registerMethod: (name, handler) => delegate.registerMethod(name, handler),
            getProjectionSnapshot: (cursor) => delegate.getProjectionSnapshot(cursor),
            handleRequest: async (request) => {
                gatewayCalls.push(request.method);
                if (request.id === 'held-read') {
                    entered.resolve();
                    await release.promise;
                }
                return await delegate.handleRequest(request);
            },
        };
        server = new DaemonServer(
            storage,
            { port, host: '127.0.0.1', maxInFlightRpcOperations: 1 },
            eventBus,
            missionStore,
            gateway,
            missionEngine,
            undefined,
            authorizer,
        );
        await server.start();

        const heldRead = fetch(`http://127.0.0.1:${port}/rpc`, {
            method: 'POST',
            headers: { authorization: `Bearer ${readToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'held-read', method: 'system.version', params: {} }),
        });
        await entered.promise;

        const missionBefore = await missionStore.getMission(mission.missionId);
        const rejectedCommand = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: 'POST',
            headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 'saturated-command', method: 'local_control.command',
                params: {
                    protocolVersion: 1, operation: 'mission.pause', missionId: mission.missionId,
                    reason: 'capacity probe', pausedBy: 'test',
                },
            }),
        });
        expect(rejectedCommand.status).toBe(503);
        expect(await rejectedCommand.json()).toEqual({
            jsonrpc: '2.0',
            id: null,
            error: { code: 'SERVICE_UNAVAILABLE', message: 'RPC operation capacity is unavailable' },
        });
        expect(gatewayCalls).toEqual(['system.version']);
        expect((await missionStore.getMission(mission.missionId))?.state).toBe(missionBefore?.state);

        release.resolve();
        expect((await heldRead).status).toBe(200);
        const admittedCommand = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: 'POST',
            headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 'recovered-command', method: 'local_control.command',
                params: {
                    protocolVersion: 1, operation: 'mission.pause', missionId: mission.missionId,
                    reason: 'accepted after recovery', pausedBy: 'test',
                },
            }),
        });
        expect(admittedCommand.status).toBe(200);
        expect(gatewayCalls).toEqual(['system.version', 'local_control.command']);
        expect((await missionStore.getMission(mission.missionId))?.state).toBe('paused');
    } finally {
        release.resolve();
        await server?.stop();
        authorizer.close();
        credentialStore.close();
        await storage.close();
        await missionStore.close();
        await rm(directory, { recursive: true, force: true });
    }
});
