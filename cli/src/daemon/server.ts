/**
 * 🌐 Daemon Server
 * 
 * Fastify server com JSON-RPC 2.0 para o Ouroboros Daemon.
 * Roda em localhost:7777 por padrão.
 */

import Fastify, { FastifyInstance } from 'fastify';
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

export interface DaemonConfig {
    port: number;
    host: string;
    sessionToken?: string;
    apiKey?: string;
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
    private rpcDrainWaiters: Array<() => void> = [];
    private appClosed = false;

    constructor(
        storage: StoragePort,
        config: Partial<DaemonConfig> = {},
        eventBus: EventBus = globalEventBus,
        missionStore?: MissionStore,
        rpcGateway?: DaemonRpcGatewayPort,
        missionCommandAuthority?: MissionCommandAuthority,
        onShutdownRequested?: () => void,
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
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
        this.app.server.closeAllConnections?.();
        this.app.server.closeIdleConnections?.();
    }

    private setupRoutes(): void {
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

        this.app.get('/ws', { websocket: true }, (socket) => {
            if (!this.acceptingRpc) {
                socket.close(1001, 'Daemon is shutting down');
                return;
            }
            const client = socket as unknown as ProjectionClient;
            this.projection.connectClient(client);
            socket.on('close', () => this.projection.disconnectClient(client));
            socket.on('error', () => this.projection.disconnectClient(client));
        });

        this.app.post('/rpc', async (request, reply) => {
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

            this.beginRpcRequest(reply.raw);
            return await this.rpcGateway.handleRequest({
                jsonrpc: '2.0',
                id: rpcRequest.id,
                method: rpcRequest.method,
                params: rpcRequest.params,
            });
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error('Daemon is already running');
        }

        if (!this.initialized) {
            await this.initialize();
        }

        this.eventBus.emit('daemon', { type: 'starting', port: this.config.port });

        try {
            await this.app.listen({
                port: this.config.port,
                host: this.config.host,
            });

            this.isRunning = true;
            this.eventBus.emit('daemon', { type: 'ready', port: this.config.port });
            this.eventBus.log('info', `Daemon started on ${this.config.host}:${this.config.port}`, 'DaemonServer');
        } catch (error) {
            this.eventBus.log('error', 'Failed to start daemon listener', 'DaemonServer');
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.acceptingRpc = false;
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
        this.cleanupTransport();

        try {
            await this.app.close();
            this.appClosed = true;
            this.isRunning = false;
            this.eventBus.emit('daemon', { type: 'stopped' });
            this.eventBus.log('info', 'Daemon stopped gracefully', 'DaemonServer');
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
            this.inFlightRpc -= 1;
            if (this.inFlightRpc === 0) {
                for (const resolve of this.rpcDrainWaiters.splice(0)) resolve();
            }
        };

        if (response.writableFinished || response.destroyed) {
            finishRpc();
            return;
        }
        response.once('finish', finishRpc);
        response.once('close', finishRpc);
    }

    get running(): boolean {
        return this.isRunning;
    }

    get address(): string {
        return `http://${this.config.host}:${this.config.port}`;
    }
}
