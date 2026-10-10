import { expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import type { RpcRequest, RpcResponse } from '../ports/rpc.port.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { LocalControlAuthenticatedClient } from '../../../shared/local-control-auth-contract.js';
import { EventBus } from './event-bus.js';
import { permissiveLocalControlTestAuth } from './local-control-test-auth.js';
import type { LocalControlAuthorizationPort } from './local-control-auth.js';
import type { DaemonRpcGatewayPort } from './rpc-gateway.js';
import { DaemonServer, type DaemonConfig } from './server.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
}

function appFor(server: DaemonServer): FastifyInstance {
    return (server as unknown as { app: FastifyInstance }).app;
}

function inFlightRpc(server: DaemonServer): number {
    return (server as unknown as { inFlightRpc: number }).inFlightRpc;
}

async function waitForCallCount(calls: RpcRequest[], target: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (calls.length < target) {
        if (Date.now() >= deadline) throw new Error(`Only ${calls.length} RPC requests reached the gateway`);
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

it('rejects the first authorized RPC above capacity before gateway dispatch', async () => {
    const capacity = 2;
    const enteredThird = deferred<void>();
    const admitted: Array<ReturnType<typeof deferred<RpcResponse>>> = [];
    const gatewayCalls: RpcRequest[] = [];
    const gateway: DaemonRpcGatewayPort = {
        registerMethod: () => {},
        getProjectionSnapshot: async () => ({}) as never,
        handleRequest: (request) => {
            const index = gatewayCalls.push(request) - 1;
            if (index === capacity) enteredThird.resolve();
            admitted[index] = deferred<RpcResponse>();
            return admitted[index]!.promise;
        },
    };
    const server = new DaemonServer(
        {} as StoragePort,
        { host: '127.0.0.1', port: 0, maxInFlightRpcOperations: capacity } as unknown as Partial<DaemonConfig>,
        new EventBus(),
        undefined,
        gateway,
        undefined,
        undefined,
        permissiveLocalControlTestAuth,
    );
    const request = {
        method: 'POST',
        url: '/rpc',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 'system.version', method: 'system.version', params: {} },
    } as const;

    try {
        await server.initialize();
        const app = appFor(server);
        await app.ready();
        const first = app.inject(request);
        const second = app.inject(request);
        await waitForCallCount(gatewayCalls, capacity);

        const overflow = app.inject({ ...request, payload: { ...request.payload, id: 'overflow' } });
        const outcome = await Promise.race([
            overflow.then((response) => ({ kind: 'response' as const, response })),
            enteredThird.promise.then(() => ({ kind: 'gateway' as const })),
        ]);

        expect(gatewayCalls).toHaveLength(capacity);
        expect(outcome.kind).toBe('response');
        if (outcome.kind === 'response') {
            expect(outcome.response.statusCode).toBe(503);
            expect(outcome.response.json()).toEqual({
                jsonrpc: '2.0',
                id: null,
                error: { code: 'SERVICE_UNAVAILABLE', message: 'RPC operation capacity is unavailable' },
            });
        }

        const complete = (index: number) => admitted[index]!.resolve({
            jsonrpc: '2.0',
            id: gatewayCalls[index]!.id,
            result: { name: 'ouroboros-daemon', version: '1.0.0' },
        });
        complete(0);
        await first;
        const retry = app.inject({ ...request, payload: { ...request.payload, id: 'retry' } });
        await waitForCallCount(gatewayCalls, capacity + 1);
        expect(gatewayCalls).toHaveLength(capacity + 1);
        complete(capacity);
        expect((await retry).statusCode).toBe(200);
        complete(1);
        await second;

        await Promise.all([first, second, overflow, retry]);
    } finally {
        for (let index = 0; index < gatewayCalls.length; index += 1) {
            admitted[index]?.resolve({
                jsonrpc: '2.0',
                id: gatewayCalls[index]!.id,
                result: { name: 'ouroboros-daemon', version: '1.0.0' },
            });
        }
        await server.stop();
    }
});

it('validates configured RPC capacity as a bounded positive integer', () => {
    for (const maxInFlightRpcOperations of [0, -1, 1.5, Number.NaN, 1_025]) {
        expect(() => new DaemonServer(
            {} as StoragePort,
            { host: '127.0.0.1', port: 0, maxInFlightRpcOperations },
            new EventBus(),
            undefined,
            undefined,
            undefined,
            undefined,
            permissiveLocalControlTestAuth,
        )).toThrow('maxInFlightRpcOperations must be an integer between 1 and 1024');
    }
});

it('keeps authentication, scope, revocation, unknown-method, and request validation ahead of saturation', async () => {
    const held = deferred<RpcResponse>();
    const entered = deferred<void>();
    const gatewayCalls: RpcRequest[] = [];
    const gateway: DaemonRpcGatewayPort = {
        registerMethod: () => {},
        getProjectionSnapshot: async () => ({}) as never,
        handleRequest: (request) => {
            gatewayCalls.push(request);
            entered.resolve();
            return held.promise;
        },
    };
    const authorization: LocalControlAuthorizationPort = {
        ...permissiveLocalControlTestAuth,
        authenticateBearer: (header) => {
            const token = header?.replace(/^Bearer /, '');
            if (!token) return null;
            const scopes = token === 'no-scope' ? [] : ['mission.read', 'mission.control', 'daemon.admin'];
            return { clientId: token, credentialVersion: 'test', scopes } as LocalControlAuthenticatedClient;
        },
        isClientStillAuthorized: (client) => client.clientId !== 'revoked',
    };
    const server = new DaemonServer(
        {} as StoragePort,
        { host: '127.0.0.1', port: 0, maxInFlightRpcOperations: 1 },
        new EventBus(),
        undefined,
        gateway,
        undefined,
        undefined,
        authorization,
    );
    const baseRequest = {
        method: 'POST',
        url: '/rpc',
        headers: { 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 'hold', method: 'system.version', params: {} },
    } as const;
    try {
        await server.initialize();
        const app = appFor(server);
        await app.ready();
        const admitted = app.inject({
            ...baseRequest,
            headers: { ...baseRequest.headers, authorization: 'Bearer valid' },
        });
        await entered.promise;

        const anonymous = await app.inject(baseRequest);
        const revoked = await app.inject({
            ...baseRequest,
            headers: { ...baseRequest.headers, authorization: 'Bearer revoked' },
        });
        const missingScope = await app.inject({
            ...baseRequest,
            headers: { ...baseRequest.headers, authorization: 'Bearer no-scope' },
            payload: { ...baseRequest.payload, method: 'system.shutdown' },
        });
        const unknown = await app.inject({
            ...baseRequest,
            headers: { ...baseRequest.headers, authorization: 'Bearer valid' },
            payload: { ...baseRequest.payload, method: 'unclassified.method' },
        });
        const malformed = await app.inject({
            ...baseRequest,
            headers: { ...baseRequest.headers, authorization: 'Bearer valid' },
            payload: { ...baseRequest.payload, jsonrpc: '1.0' },
        });

        expect(anonymous.statusCode).toBe(401);
        expect(revoked.statusCode).toBe(401);
        expect(missingScope.statusCode).toBe(403);
        expect(unknown.statusCode).toBe(403);
        expect(malformed.statusCode).toBe(400);
        expect(gatewayCalls).toHaveLength(1);

        held.resolve({
            jsonrpc: '2.0',
            id: 'hold',
            result: { name: 'ouroboros-daemon', version: '1.0.0' },
        });
        expect((await admitted).statusCode).toBe(200);
    } finally {
        held.resolve({
            jsonrpc: '2.0',
            id: 'hold',
            result: { name: 'ouroboros-daemon', version: '1.0.0' },
        });
        await server.stop();
    }
});

it('releases capacity once after gateway throws or returns a rejected response', async () => {
    let calls = 0;
    const gateway: DaemonRpcGatewayPort = {
        registerMethod: () => {},
        getProjectionSnapshot: async () => ({}) as never,
        handleRequest: async (request) => {
            calls += 1;
            if (calls === 1) throw new Error('PRIVATE database path and token');
            if (calls === 2) return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'private gateway detail' } };
            return { jsonrpc: '2.0', id: request.id, result: { name: 'ouroboros-daemon', version: '1.0.0' } };
        },
    };
    const server = new DaemonServer(
        {} as StoragePort,
        { host: '127.0.0.1', port: 0, maxInFlightRpcOperations: 1 },
        new EventBus(),
        undefined,
        gateway,
        undefined,
        undefined,
        permissiveLocalControlTestAuth,
    );
    try {
        await server.initialize();
        const app = appFor(server);
        await app.ready();
        const send = (id: string) => app.inject({
            method: 'POST',
            url: '/rpc',
            headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
            payload: { jsonrpc: '2.0', id, method: 'system.version', params: {} },
        });

        const thrown = await send('thrown');
        expect(thrown.statusCode).toBe(200);
        expect(thrown.body).not.toContain('PRIVATE');
        expect(inFlightRpc(server)).toBe(0);

        const rejected = await send('rejected');
        expect(rejected.statusCode).toBe(200);
        expect(rejected.body).not.toContain('private gateway detail');
        expect(inFlightRpc(server)).toBe(0);

        expect((await send('recovered')).statusCode).toBe(200);
        expect(calls).toBe(3);
        expect(inFlightRpc(server)).toBe(0);
    } finally {
        await server.stop();
    }
});
