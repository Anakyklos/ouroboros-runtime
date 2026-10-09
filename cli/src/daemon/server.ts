/**
 * 🌐 Daemon Server
 * 
 * Fastify server com JSON-RPC 2.0 para o Ouroboros Daemon.
 * Roda em localhost:7777 por padrão.
 */

import Fastify, { FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { EventBus, globalEventBus } from './event-bus.js';
import { RpcGateway, type DaemonRpcGatewayPort } from './rpc-gateway.js';
import { DaemonProjection, type ProjectionClient, type ProjectionClientReservation } from './daemon-projection.js';
import { projectInvocation, projectMission } from './durable-projection.js';
import {
    isAllowedDaemonEvent,
    isDaemonEventData,
    type AllowedDaemonEvent,
    type DaemonEventDataMap,
} from '../../../shared/daemon-event-contract.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { MissionMutation, MissionStore } from '../mission/ports.js';
import type { MissionCommandAuthority } from './local-control-command.js';
import {
    getBrowserSessionCookieName,
    requiredLocalControlScope,
    type LocalControlAuthorizationPort,
} from './local-control-auth.js';
import type { LocalControlAuthenticatedClient } from '../../../shared/local-control-auth-contract.js';
import { projectSessionGetResult, projectSessionListResult } from './session-rpc-projection.js';
import { isDaemonStatusProjection } from '../../../shared/daemon-event-contract.js';
import { sanitizeLocalControlReadResponse } from '../../../shared/local-control-read-contract.js';
import { projectDaemonStatus } from './durable-projection.js';

export interface DaemonConfig {
    port: number;
    host: string;
    maxProjectionClients?: number;
}

const DEFAULT_CONFIG: DaemonConfig = {
    port: 7777,
    host: '127.0.0.1',
};

const RPC_DRAIN_TIMEOUT_MS = 4_000;
const WEBSOCKET_CLOSE_TIMEOUT_MS = 30_000;
const RPC_FAILURE_MESSAGE = 'The RPC request could not be completed';

function safeGatewayError(error: unknown): { code: number; message: string } {
    if (typeof error !== 'object' || error === null) return { code: -32603, message: RPC_FAILURE_MESSAGE };
    const candidate = error as { code?: unknown };
    switch (candidate.code) {
        case -32601: return { code: -32601, message: RPC_FAILURE_MESSAGE };
        case -32602: return { code: -32602, message: RPC_FAILURE_MESSAGE };
        case -32001: return { code: -32001, message: RPC_FAILURE_MESSAGE };
        case -32002: return { code: -32002, message: RPC_FAILURE_MESSAGE };
        case -32003: return { code: -32003, message: RPC_FAILURE_MESSAGE };
        default: return { code: -32603, message: RPC_FAILURE_MESSAGE };
    }
}

function safeGatewayResult(method: string, params: Record<string, unknown> | undefined, result: unknown): unknown | null {
    if (!isRecord(result) || !Object.prototype.hasOwnProperty.call(result, 'result') || Object.prototype.hasOwnProperty.call(result, 'error')) return null;
    const value = result.result;
    switch (method) {
        case 'session.get': return projectSessionGetResult(value);
        case 'session.list': return projectSessionListResult(value);
        case 'daemon.status': {
            if (!isRecord(value)) return null;
            const projected = projectDaemonStatus(value as never);
            return isDaemonStatusProjection(projected) ? projected : null;
        }
        case 'local_control.read':
            return sanitizeLocalControlReadResponse(value, params?.operation) ?? null;
        case 'system.version':
            return isRecord(value) && Object.keys(value).length === 2 &&
                typeof value.name === 'string' && value.name === 'ouroboros-daemon' &&
                typeof value.version === 'string' && /^\d+\.\d+\.\d+$/.test(value.version)
                ? { name: value.name, version: value.version }
                : null;
        case 'system.health': {
            if (!isRecord(value) || Object.keys(value).length !== 4 || value.status !== 'healthy' || typeof value.uptime !== 'number' || !Number.isFinite(value.uptime) || value.uptime < 0 ||
                typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) return null;
            const memory = value.memory;
            if (!isRecord(memory)) return null;
            const memoryFields = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'];
            if (Object.keys(memory).length !== memoryFields.length) return null;
            if (!memoryFields.every((field) => typeof memory[field] === 'number' && Number.isFinite(memory[field]) && memory[field] >= 0)) return null;
            return { status: 'healthy', uptime: value.uptime, timestamp: value.timestamp, memory: Object.fromEntries(memoryFields.map((field) => [field, memory[field]])) };
        }
        default: return null;
    }
}

class RpcDrainTimeoutError extends Error {
    constructor() {
        super('Accepted RPC operation drain timed out');
        this.name = 'RpcDrainTimeoutError';
    }
}

export class DaemonServer {
    private app: FastifyInstance;
    private config: DaemonConfig;
    private eventBus: EventBus;
    private rpcGateway: DaemonRpcGatewayPort;
    private projection: DaemonProjection;
    private eventForwardingUnsubscribe: (() => void) | null = null;
    private missionMutationUnsubscribe: (() => void) | null = null;
    private isRunning = false;
    private initialized = false;
    private acceptingRpc = true;
    private inFlightRpc = 0;
    private inFlightResponses = new Set<ServerResponse>();
    private inFlightRpcOperations = new Set<{
        handlerSettled: boolean;
        responseSettled: boolean;
    }>();
    private rpcDrainWaiters: Array<() => void> = [];
    private appClosed = false;
    private readonly authorization?: LocalControlAuthorizationPort;
    private readonly websocketPrincipals = new Map<ProjectionClient, {
        socket: { close(code?: number, reason?: string): void; terminate(): void };
        principal: LocalControlAuthenticatedClient;
        closing: boolean;
    }>();
    private websocketAuthorizationTimer: ReturnType<typeof setInterval> | null = null;
    private readonly websocketAdmissionByRequest = new WeakMap<object, {
        principal: LocalControlAuthenticatedClient;
        reservation: ProjectionClientReservation;
        transport: Socket;
        rawRequest: FastifyRequest['raw'];
        onAbort: () => void;
    }>();

    constructor(
        storage: StoragePort,
        config: Partial<DaemonConfig> = {},
        eventBus: EventBus = globalEventBus,
        missionStore?: MissionStore,
        rpcGateway?: DaemonRpcGatewayPort,
        missionCommandAuthority?: MissionCommandAuthority,
        onShutdownRequested?: () => void,
        authorization?: LocalControlAuthorizationPort,
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.authorization = authorization;
        this.eventBus = eventBus;
        this.rpcGateway = rpcGateway ?? new RpcGateway(
            storage,
            eventBus,
            missionStore,
            undefined,
            missionCommandAuthority,
            onShutdownRequested,
        );
        this.projection = new DaemonProjection({
            maxClients: this.config.maxProjectionClients,
            snapshot: async (cursor) => ({
                ...await this.rpcGateway.getProjectionSnapshot(),
                cursor,
            }),
            onDiagnostic: (diagnostic) => {
                this.eventBus.log('warn', `WebSocket protocol diagnostic: ${diagnostic.code}`, 'DaemonServer');
            },
        });
        this.missionMutationUnsubscribe = missionStore?.onMutation?.((mutation) => {
            this.forwardDurableMutation(mutation);
        }) ?? null;

        this.app = Fastify({
            logger: false,
        });
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        
        await this.app.register(websocket, { options: { closeTimeout: WEBSOCKET_CLOSE_TIMEOUT_MS } });
        this.setupRoutes();
        this.setupEventForwarding();
        this.initialized = true;
    }

    private setupEventForwarding(): void {
        if (this.eventForwardingUnsubscribe) return;

        this.eventForwardingUnsubscribe = this.eventBus.on('*', (data) => {
            if (!data || typeof data !== 'object') return;
            const forwarded = data as { event?: unknown; data?: unknown };
            if (!isAllowedDaemonEvent(forwarded.event) || forwarded.event === 'snapshot') {
                return;
            }
            this.forwardPublicEvent(forwarded.event, forwarded.data);
        });
    }

    private forwardPublicEvent<E extends Exclude<AllowedDaemonEvent, 'snapshot'>>(
        event: E,
        data: unknown,
    ): void {
        if (event === 'log') {
            if (!data || typeof data !== 'object') return;
            const log = data as { level?: unknown; message?: unknown; source?: unknown };
            const normalized: DaemonEventDataMap['log'] = {
                level: log.level as DaemonEventDataMap['log']['level'],
                message: log.message as string,
                ...(typeof log.source === 'string' ? { source: log.source } : {}),
            };
            if (isDaemonEventData('log', normalized)) {
                this.projection.broadcast('log', normalized);
            }
            return;
        }

        if (isDaemonEventData(event, data)) {
            this.projection.broadcast(event, data);
        }
    }

    private forwardDurableMutation(mutation: MissionMutation): void {
        try {
            if (mutation.entity === 'mission') {
                this.eventBus.emit('mission', {
                    ...projectMission(mutation.mission),
                    kind: mutation.kind,
                });
                return;
            }

            const invocation = projectInvocation(mutation.invocation);
            const kind = mutation.kind === 'created'
                ? invocation.status === 'running' || invocation.status === 'dispatched'
                    ? 'started'
                    : 'waiting'
                : invocation.status === 'completed'
                    ? 'completed'
                    : invocation.status === 'failed'
                        ? 'failed'
                        : invocation.status === 'cancelled'
                            ? 'cancelled'
                            : invocation.status === 'running'
                                ? 'started'
                                : 'updated';
            this.eventBus.emit('capability_invocation', { ...invocation, kind });
        } catch {
            // A malformed durable row is never guessed onto the wire.
            this.eventBus.log('warn', 'Durable projection update omitted', 'DaemonServer');
        }
    }

    private cleanupTransport(): void {
        this.missionMutationUnsubscribe?.();
        this.missionMutationUnsubscribe = null;
        this.eventForwardingUnsubscribe?.();
        this.eventForwardingUnsubscribe = null;
        this.projection.closeClients();
        for (const session of this.websocketPrincipals.values()) {
            try { session.socket.terminate(); } catch { /* socket close/error owns admission release */ }
        }
        this.app.server.closeAllConnections?.();
        this.app.server.closeIdleConnections?.();
    }

    private releasePendingWebSocketAdmission(request: object): void {
        const admission = this.websocketAdmissionByRequest.get(request);
        if (!admission) return;
        this.websocketAdmissionByRequest.delete(request);
        admission.transport.off('close', admission.onAbort);
        admission.transport.off('end', admission.onAbort);
        admission.rawRequest.off('aborted', admission.onAbort);
        this.projection.releaseReservation(admission.reservation);
    }

    private setupRoutes(): void {
        this.app.addHook('onError', async (request) => {
            this.releasePendingWebSocketAdmission(request);
        });
        this.app.addHook('onResponse', async (request) => {
            this.releasePendingWebSocketAdmission(request);
        });
        this.app.addHook('onRequest', async (request, reply) => {
            const origin = request.headers.origin;
            if (origin !== undefined) {
                if (!this.authorization?.isAllowedOrigin(origin)) {
                    return sendBoundaryError(reply, 403, 'FORBIDDEN', 'The request is not allowed');
                }
                reply
                    .header('Access-Control-Allow-Origin', origin)
                    .header('Access-Control-Allow-Credentials', 'true')
                    .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                    .header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
                    .header('Access-Control-Max-Age', '600')
                    .header('Vary', 'Origin');
            }
            if (request.method === 'OPTIONS') {
                const requestedMethod = request.headers['access-control-request-method'];
                const requestedHeaders = request.headers['access-control-request-headers'] ?? '';
                const allowedHeaders = requestedHeaders.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
                if (
                    !origin || !this.authorization?.isAllowedOrigin(origin) ||
                    requestedMethod !== 'POST' ||
                    !allowedHeaders.every((header) => header === 'authorization' || header === 'content-type')
                ) {
                    return sendBoundaryError(reply, 403, 'FORBIDDEN', 'The request is not allowed');
                }
                return reply.code(204).send();
            }
        });

        this.app.get('/', async () => {
            return { 
                service: 'Ouroboros Daemon', 
                version: '1.0.0',
                endpoints: {
                    health: 'GET /health',
                    rpc: 'POST /rpc',
                    ws: 'WebSocket /ws'
                }
            };
        });

        this.app.get('/health', async (_request, reply) => {
            if (!this.acceptingRpc) return reply.code(503).send({ status: 'shutting_down' });
            return { status: 'ok', timestamp: new Date().toISOString() };
        });

        this.app.post('/auth/browser-session', async (request, reply) => {
            const session = this.authorization?.createBrowserSession(
                request.headers.authorization,
                request.headers.origin,
            );
            if (!session) return sendBoundaryError(reply, request.headers.origin ? 403 : 401, 'UNAUTHORIZED', 'Authentication is required');
            const secure = request.protocol === 'https' ? '; Secure' : '';
            reply.header(
                'Set-Cookie',
                `${getBrowserSessionCookieName()}=${session.cookie}; Path=/ws; HttpOnly; SameSite=Strict; Max-Age=${session.maxAge}${secure}`,
            );
            return reply.code(204).send();
        });

        this.app.get('/ws', {
            websocket: true,
            preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
                const origin = request.headers.origin;
                if (origin !== undefined && !this.authorization?.isAllowedOrigin(origin)) {
                    return sendBoundaryError(reply, 403, 'FORBIDDEN', 'The request is not allowed');
                }
                const principal = this.authenticateWebSocketRequest(request);
                if (!principal) return sendBoundaryError(reply, 401, 'UNAUTHORIZED', 'Authentication is required');
                if (!principal.scopes.includes('mission.read')) {
                    return sendBoundaryError(reply, 403, 'FORBIDDEN', 'The requested operation is not authorized');
                }
                if (!this.acceptingRpc) {
                    return sendBoundaryError(reply, 503, 'SERVICE_UNAVAILABLE', 'The daemon is not accepting WebSocket clients');
                }
                const reservation = this.projection.reserveClient();
                if (!reservation) {
                    return sendBoundaryError(reply, 503, 'SERVICE_UNAVAILABLE', 'WebSocket client capacity is unavailable');
                }
                const transport = request.raw.socket;
                const onAbort = () => this.releasePendingWebSocketAdmission(request);
                this.websocketAdmissionByRequest.set(request, { principal, reservation, transport, rawRequest: request.raw, onAbort });
                transport.once('close', onAbort);
                transport.once('end', onAbort);
                request.raw.once('aborted', onAbort);
            },
        }, (socket, request) => {
            const admission = this.websocketAdmissionByRequest.get(request);
            this.websocketAdmissionByRequest.delete(request);
            admission?.transport.off('close', admission.onAbort);
            admission?.transport.off('end', admission.onAbort);
            admission?.rawRequest.off('aborted', admission.onAbort);
            const rejectUpgradedClient = (code: number, reason: string) => {
                if (!admission) {
                    try { socket.terminate(); } catch { /* no reservation remains to retain */ }
                    return;
                }
                const rejectedClient: ProjectionClient = {
                    get readyState() { return socket.readyState; },
                    get bufferedAmount() { return socket.bufferedAmount; },
                    send: () => false,
                    close: () => socket.close(code, reason),
                };
                this.websocketPrincipals.set(rejectedClient, {
                    socket,
                    principal: admission.principal,
                    closing: true,
                });
                if (!this.projection.retainClosingClient(rejectedClient, admission.reservation)) {
                    let disconnected = false;
                    const releaseReservation = () => {
                        if (disconnected) return;
                        disconnected = true;
                        socket.off('close', releaseReservation);
                        socket.off('error', releaseReservation);
                        this.projection.releaseReservation(admission.reservation);
                        this.websocketPrincipals.delete(rejectedClient);
                        this.syncWebSocketAuthorizationTimer();
                    };
                    socket.once('close', releaseReservation);
                    socket.once('error', releaseReservation);
                    if (socket.readyState === 3) releaseReservation();
                    else {
                        try { socket.terminate(); } catch { /* transport callbacks own reservation release */ }
                    }
                    return;
                }
                let disconnected = false;
                const disconnect = () => {
                    if (disconnected) return;
                    disconnected = true;
                    socket.off('close', disconnect);
                    socket.off('error', disconnect);
                    this.projection.disconnectClient(rejectedClient);
                    this.websocketPrincipals.delete(rejectedClient);
                    this.syncWebSocketAuthorizationTimer();
                };
                socket.once('close', disconnect);
                socket.once('error', disconnect);
                try { socket.close(code, reason); } catch { socket.terminate(); }
            };
            if (!this.acceptingRpc) {
                rejectUpgradedClient(1001, 'Daemon is shutting down');
                return;
            }
            let stillAuthorized = false;
            try {
                stillAuthorized = Boolean(admission && this.authorization?.isClientStillAuthorized(admission.principal, 'mission.read'));
            } catch {
                this.eventBus.log('warn', 'WebSocket authorization check failed before projection admission', 'DaemonServer');
            }
            if (!admission || !stillAuthorized) {
                rejectUpgradedClient(1008, 'Not authorized');
                return;
            }
            if (socket.readyState !== 1) {
                rejectUpgradedClient(1011, 'WebSocket transport is not open');
                return;
            }
            const client = this.createAuthorizedProjectionClient(socket, admission.principal);
            const snapshot = this.projection.connectClient(client, admission.reservation);
            this.websocketPrincipals.set(client, { socket, principal: admission.principal, closing: false });
            this.syncWebSocketAuthorizationTimer();
            void snapshot.then((admitted) => {
                if (admitted) return;
                this.markWebSocketClientClosing(client);
                try { socket.close(1011, 'WebSocket client could not be admitted'); } catch { /* close/error owns cleanup */ }
            }).catch(() => {
                this.markWebSocketClientClosing(client);
                try { socket.close(1011, 'WebSocket projection failed'); } catch { /* close/error owns cleanup */ }
            });
            let disconnected = false;
            const disconnect = () => {
                if (disconnected) return;
                disconnected = true;
                socket.off('close', disconnect);
                socket.off('error', disconnect);
                this.projection.disconnectClient(client);
                this.websocketPrincipals.delete(client);
                this.syncWebSocketAuthorizationTimer();
            };
            socket.once('close', disconnect);
            socket.once('error', disconnect);
        });

        this.app.post('/rpc', async (request, reply) => {
            const principal = this.authorization?.authenticateBearer(request.headers.authorization) ?? null;
            if (!principal) return sendBoundaryError(reply, 401, 'UNAUTHORIZED', 'Authentication is required');

            if (!isRecord(request.body)) {
                return sendBoundaryError(reply, 400, 'INVALID_REQUEST', 'The RPC request is invalid');
            }
            const rpcRequest = request.body as {
                jsonrpc: string;
                id: string | number;
                method: string;
                params?: Record<string, unknown>;
            };

            if (rpcRequest.jsonrpc !== '2.0') {
                return reply.code(400).send({
                    jsonrpc: '2.0',
                    id: rpcRequest.id ?? null,
                    error: { code: -32600, message: 'Invalid Request: jsonrpc must be 2.0' }
                });
            }

            if (!this.acceptingRpc) {
                return reply.code(503).send({
                    jsonrpc: '2.0',
                    id: rpcRequest.id,
                    error: { code: -32000, message: 'Daemon is shutting down' },
                });
            }

            const requiredScope = requiredLocalControlScope(rpcRequest.method, rpcRequest.params ?? {});
            if (!requiredScope) {
                return sendBoundaryError(reply, 403, 'FORBIDDEN', 'The requested operation is not authorized');
            }
            if (!principal.scopes.includes(requiredScope)) {
                return sendBoundaryError(reply, 403, 'FORBIDDEN', 'The requested operation is not authorized');
            }
            if (!this.authorization?.isClientStillAuthorized(principal, requiredScope)) {
                return sendBoundaryError(reply, 401, 'UNAUTHORIZED', 'Authentication is required');
            }

            const handlerSettled = this.beginRpcRequest(reply.raw, request.raw, request.raw.socket);
            try {
                const result = await this.rpcGateway.handleRequest({
                    jsonrpc: '2.0',
                    id: rpcRequest.id,
                    method: rpcRequest.method,
                    params: rpcRequest.params,
                });
                if (!isRecord(result) || result.jsonrpc !== '2.0') {
                    return { jsonrpc: '2.0', id: rpcRequest.id, error: safeGatewayError(null) };
                }
                if (Object.prototype.hasOwnProperty.call(result, 'error')) {
                    return {
                        jsonrpc: '2.0',
                        id: rpcRequest.id,
                        error: safeGatewayError(result.error),
                    };
                }
                const protectedReadMethods = new Set([
                    'session.get', 'session.list', 'daemon.status', 'system.health', 'system.version', 'local_control.read',
                ]);
                if (protectedReadMethods.has(rpcRequest.method)) {
                    const safeResult = safeGatewayResult(rpcRequest.method, rpcRequest.params, result);
                    if (safeResult === null) {
                        return { jsonrpc: '2.0', id: rpcRequest.id, error: safeGatewayError(null) };
                    }
                    return {
                        jsonrpc: '2.0',
                        id: rpcRequest.id,
                        result: safeResult,
                    };
                }
                if (!Object.prototype.hasOwnProperty.call(result, 'result')) {
                    return { jsonrpc: '2.0', id: rpcRequest.id, error: safeGatewayError(null) };
                }
                return { jsonrpc: '2.0', id: rpcRequest.id, result: result.result };
            } catch {
                return {
                    jsonrpc: '2.0',
                    id: rpcRequest.id,
                    error: safeGatewayError(null),
                };
            } finally {
                handlerSettled();
            }
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error('Daemon is already running');
        }

        if (this.config.host !== '127.0.0.1' && this.config.host !== '::1') {
            throw new Error('The local-control daemon must bind to a loopback address');
        }

        try {
            if (!this.initialized) {
                await this.initialize();
            }

            if (!this.authorization?.hasActiveClients()) {
                throw new Error('Local-control authentication is not provisioned');
            }

            this.eventBus.emit('daemon', { type: 'starting', port: this.config.port });
            await this.app.listen({
                port: this.config.port,
                host: this.config.host,
            });

            this.isRunning = true;
            this.eventBus.emit('daemon', { type: 'ready', port: this.config.port });
            this.eventBus.log('info', `Daemon started on ${this.config.host}:${this.config.port}`, 'DaemonServer');
        } catch (error) {
            this.acceptingRpc = false;
            this.clearWebSocketAuthorizationTimer();
            this.cleanupTransport();
            if (!this.appClosed) {
                try {
                    await this.app.close();
                    this.appClosed = true;
                } catch {
                    this.eventBus.log('error', 'Error closing daemon resources after startup failure', 'DaemonServer');
                }
            }
            this.isRunning = false;
            this.eventBus.log('error', 'Failed to start daemon listener', 'DaemonServer');
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.acceptingRpc = false;
        this.clearWebSocketAuthorizationTimer();
        if (!this.isRunning) {
            this.cleanupTransport();
            if (!this.appClosed) {
                try {
                    await this.app.close();
                    this.appClosed = true;
                } catch (error) {
                    this.eventBus.log('error', 'Error closing daemon resources', 'DaemonServer');
                    throw error;
                }
            }
            return;
        }

        this.eventBus.emit('daemon', { type: 'shutting_down' });
        const drained = await this.waitForRpcDrain();
        if (!drained) {
            for (const response of this.inFlightResponses) response.destroy();
        }
        this.cleanupTransport();

        try {
            await this.app.close();
            this.appClosed = true;
            this.isRunning = false;
            if (drained) {
                this.eventBus.emit('daemon', { type: 'stopped' });
                this.eventBus.log('info', 'Daemon stopped gracefully', 'DaemonServer');
            } else {
                this.eventBus.log('warn', 'Daemon transport closed after RPC drain timeout; pending results may be unknown', 'DaemonServer');
            }
        } catch (error) {
            this.isRunning = false;
            this.eventBus.log('error', 'Error stopping daemon resources', 'DaemonServer');
            throw error;
        }
        if (!drained) throw new RpcDrainTimeoutError();
    }

    private async waitForRpcDrain(): Promise<boolean> {
        if (this.inFlightRpc === 0) return true;
        return await new Promise<boolean>((resolve) => {
            const finish = () => {
                if (timeout) clearTimeout(timeout);
                resolve(true);
            };
            const timeout = setTimeout(() => {
                this.rpcDrainWaiters = this.rpcDrainWaiters.filter((waiter) => waiter !== finish);
                this.eventBus.log('warn', 'RPC shutdown drain timed out; pending results may be unknown', 'DaemonServer');
                resolve(false);
            }, RPC_DRAIN_TIMEOUT_MS);
            this.rpcDrainWaiters.push(finish);
        });
    }

    private beginRpcRequest(response: ServerResponse, request: IncomingMessage, transport: Socket): () => void {
        this.inFlightRpc += 1;
        const operation = {
            handlerSettled: false,
            responseSettled: response.writableFinished || response.destroyed,
        };
        this.inFlightRpcOperations.add(operation);
        const settleIfComplete = () => {
            if (!operation.handlerSettled || !operation.responseSettled) return;
            this.inFlightRpcOperations.delete(operation);
            this.inFlightRpc -= 1;
            if (this.inFlightRpc === 0) {
                for (const resolve of this.rpcDrainWaiters.splice(0)) resolve();
            }
        };

        const finishResponse = () => {
            if (operation.responseSettled) return;
            operation.responseSettled = true;
            this.inFlightResponses.delete(response);
            response.off('finish', finishResponse);
            response.off('close', finishResponse);
            request.off('aborted', finishResponse);
            transport.off('close', finishResponse);
            transport.off('error', finishResponse);
            settleIfComplete();
        };
        if (!operation.responseSettled) {
            this.inFlightResponses.add(response);
            response.once('finish', finishResponse);
            response.once('close', finishResponse);
            request.once('aborted', finishResponse);
            transport.once('close', finishResponse);
            transport.once('error', finishResponse);
        }

        let handlerWasSettled = false;
        return () => {
            if (handlerWasSettled) return;
            handlerWasSettled = true;
            operation.handlerSettled = true;
            settleIfComplete();
        };
    }

    get running(): boolean {
        return this.isRunning;
    }

    get address(): string {
        return `http://${this.config.host}:${this.config.port}`;
    }

    private authenticateWebSocketRequest(request: FastifyRequest): LocalControlAuthenticatedClient | null {
        const origin = request.headers.origin;
        if (origin !== undefined && !this.authorization?.isAllowedOrigin(origin)) return null;
        const authorization = request.headers.authorization;
        if (authorization !== undefined) return this.authorization?.authenticateBearer(authorization) ?? null;
        return this.authorization?.authenticateBrowserSession(request.headers.cookie, origin) ?? null;
    }

    private createAuthorizedProjectionClient(
        socket: { readyState: number; bufferedAmount: number; send(message: string): void; close(code?: number, reason?: string): void; terminate(): void },
        principal: LocalControlAuthenticatedClient,
    ): ProjectionClient {
        const client: ProjectionClient = {
            get readyState() { return socket.readyState; },
            get bufferedAmount() { return socket.bufferedAmount; },
            send: (message) => {
                if (!this.authorization?.isClientStillAuthorized(principal, 'mission.read')) {
                    this.markWebSocketClientClosing(client);
                    socket.close(1008, 'Authorization expired');
                    return false;
                }
                socket.send(message);
                return true;
            },
            close: () => {
                this.markWebSocketClientClosing(client);
                socket.close();
            },
        };
        return client;
    }

    private revalidateWebSocketClients(): void {
        for (const [client, session] of this.websocketPrincipals) {
            if (session.closing) continue;
            try {
                if (this.authorization?.isClientStillAuthorized(session.principal, 'mission.read')) continue;
            } catch {
                this.eventBus.log('warn', 'WebSocket authorization revalidation failed', 'DaemonServer');
            }
            this.markWebSocketClientClosing(client);
            try {
                session.socket.close(1008, 'Authorization expired');
            } catch {
                this.eventBus.log('warn', 'WebSocket client could not be closed after authorization failure', 'DaemonServer');
            }
        }
        this.syncWebSocketAuthorizationTimer();
    }

    private syncWebSocketAuthorizationTimer(): void {
        if ([...this.websocketPrincipals.values()].some((session) => !session.closing)) {
            if (this.websocketAuthorizationTimer === null) {
                this.websocketAuthorizationTimer = setInterval(() => this.revalidateWebSocketClients(), 500);
            }
            return;
        }
        this.clearWebSocketAuthorizationTimer();
    }

    private markWebSocketClientClosing(client: ProjectionClient): void {
        const session = this.websocketPrincipals.get(client);
        if (!session || session.closing) return;
        session.closing = true;
        this.projection.markClientClosing(client);
        this.syncWebSocketAuthorizationTimer();
    }

    private clearWebSocketAuthorizationTimer(): void {
        if (this.websocketAuthorizationTimer === null) return;
        clearInterval(this.websocketAuthorizationTimer);
        this.websocketAuthorizationTimer = null;
    }
}

function sendBoundaryError(reply: FastifyReply, status: number, code: string, message: string) {
    return reply.code(status).send({
        jsonrpc: '2.0',
        id: null,
        error: { code, message },
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
