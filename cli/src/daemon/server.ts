/**
 * 🌐 Daemon Server
 * 
 * Fastify server com JSON-RPC 2.0 para o Ouroboros Daemon.
 * Roda em localhost:7777 por padrão.
 */

import Fastify, { FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { ServerResponse } from 'node:http';
import { EventBus, globalEventBus } from './event-bus.js';
import { RpcGateway, type DaemonRpcGatewayPort } from './rpc-gateway.js';
import { DaemonProjection, type ProjectionClient } from './daemon-projection.js';
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

export interface DaemonConfig {
    port: number;
    host: string;
}

const DEFAULT_CONFIG: DaemonConfig = {
    port: 7777,
    host: '127.0.0.1',
};

const RPC_DRAIN_TIMEOUT_MS = 4_000;

class RpcDrainTimeoutError extends Error {
    constructor() {
        super('Accepted RPC response drain timed out');
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
    private rpcDrainWaiters: Array<() => void> = [];
    private appClosed = false;
    private readonly authorization?: LocalControlAuthorizationPort;
    private readonly websocketPrincipals = new Map<ProjectionClient, { socket: { close(code?: number, reason?: string): void }; principal: LocalControlAuthenticatedClient }>();
    private websocketAuthorizationTimer: ReturnType<typeof setInterval> | null = null;
    private readonly websocketPrincipalByRequest = new WeakMap<object, LocalControlAuthenticatedClient>();

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
        
        await this.app.register(websocket);
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
        this.websocketPrincipals.clear();
        this.app.server.closeAllConnections?.();
        this.app.server.closeIdleConnections?.();
    }

    private setupRoutes(): void {
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
                this.websocketPrincipalByRequest.set(request, principal);
            },
        }, (socket, request) => {
            if (!this.acceptingRpc) {
                socket.close(1001, 'Daemon is shutting down');
                return;
            }
            const principal = this.websocketPrincipalByRequest.get(request);
            if (!principal || !this.authorization?.isClientStillAuthorized(principal, 'mission.read')) {
                socket.close(1008, 'Not authorized');
                return;
            }
            const client = this.createAuthorizedProjectionClient(socket, principal);
            this.websocketPrincipals.set(client, { socket, principal });
            this.projection.connectClient(client);
            const disconnect = () => {
                this.projection.disconnectClient(client);
                this.websocketPrincipals.delete(client);
            };
            socket.on('close', disconnect);
            socket.on('error', disconnect);
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

            this.beginRpcRequest(reply.raw);
            try {
                const result = await this.rpcGateway.handleRequest({
                    jsonrpc: '2.0',
                    id: rpcRequest.id,
                    method: rpcRequest.method,
                    params: rpcRequest.params,
                });
                if (result.error) {
                    return {
                        jsonrpc: '2.0',
                        id: rpcRequest.id,
                        error: { code: result.error.code, message: 'The RPC request could not be completed' },
                    };
                }
                return result;
            } catch {
                return {
                    jsonrpc: '2.0',
                    id: rpcRequest.id,
                    error: { code: -32603, message: 'The RPC request could not be completed' },
                };
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

        if (!this.initialized) {
            await this.initialize();
        }

        if (!this.authorization?.hasActiveClients()) {
            throw new Error('Local-control authentication is not provisioned');
        }

        this.eventBus.emit('daemon', { type: 'starting', port: this.config.port });

        try {
            await this.app.listen({
                port: this.config.port,
                host: this.config.host,
            });

            this.isRunning = true;
            this.websocketAuthorizationTimer = setInterval(() => this.revalidateWebSocketClients(), 500);
            this.eventBus.emit('daemon', { type: 'ready', port: this.config.port });
            this.eventBus.log('info', `Daemon started on ${this.config.host}:${this.config.port}`, 'DaemonServer');
        } catch (error) {
            this.eventBus.log('error', 'Failed to start daemon listener', 'DaemonServer');
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.acceptingRpc = false;
        if (this.websocketAuthorizationTimer) {
            clearInterval(this.websocketAuthorizationTimer);
            this.websocketAuthorizationTimer = null;
        }
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

    private beginRpcRequest(response: ServerResponse): void {
        this.inFlightRpc += 1;
        let finished = false;
        const finishRpc = () => {
            if (finished) return;
            finished = true;
            this.inFlightResponses.delete(response);
            this.inFlightRpc -= 1;
            if (this.inFlightRpc === 0) {
                for (const resolve of this.rpcDrainWaiters.splice(0)) resolve();
            }
        };

        if (response.writableFinished || response.destroyed) {
            finishRpc();
            return;
        }
        this.inFlightResponses.add(response);
        response.once('finish', finishRpc);
        response.once('close', finishRpc);
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
        socket: { readyState: number; bufferedAmount: number; send(message: string): void; close(code?: number, reason?: string): void },
        principal: LocalControlAuthenticatedClient,
    ): ProjectionClient {
        const client: ProjectionClient = {
            get readyState() { return socket.readyState; },
            get bufferedAmount() { return socket.bufferedAmount; },
            send: (message) => {
                if (!this.authorization?.isClientStillAuthorized(principal, 'mission.read')) {
                    socket.close(1008, 'Authorization expired');
                    return;
                }
                socket.send(message);
            },
            close: () => socket.close(),
        };
        return client;
    }

    private revalidateWebSocketClients(): void {
        for (const [client, session] of this.websocketPrincipals) {
            if (this.authorization?.isClientStillAuthorized(session.principal, 'mission.read')) continue;
            this.projection.disconnectClient(client);
            session.socket.close(1008, 'Authorization expired');
            this.websocketPrincipals.delete(client);
        }
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
