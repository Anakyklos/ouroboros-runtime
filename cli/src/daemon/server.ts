/**
 * 🌐 Daemon Server
 * 
 * Fastify server com JSON-RPC 2.0 para o Ouroboros Daemon.
 * Roda em localhost:7777 por padrão.
 */

import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { EventBus, globalEventBus } from './event-bus.js';
import { RpcGateway } from './rpc-gateway.js';
import { DaemonProjection, type ProjectionClient } from './daemon-projection.js';
import { isAllowedDaemonEvent } from '../../../shared/daemon-event-contract.js';
import { GatewayOrchestrator } from '../orchestration/GatewayOrchestrator.js';
import type { StoragePort } from '../ports/storage.port.js';

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

export class DaemonServer {
    private app: FastifyInstance;
    private config: DaemonConfig;
    private eventBus: EventBus;
    private rpcGateway: RpcGateway;
    private gatewayOrchestrator: GatewayOrchestrator;
    private projection: DaemonProjection;
    private eventForwardingUnsubscribe: (() => void) | null = null;
    private isRunning = false;
    private initialized = false;

    constructor(
        storage: StoragePort,
        config: Partial<DaemonConfig> = {},
        eventBus: EventBus = globalEventBus
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.eventBus = eventBus;
        this.gatewayOrchestrator = new GatewayOrchestrator({}, eventBus);
        
        if (this.config.apiKey) {
            this.gatewayOrchestrator.initialize(this.config.apiKey);
        }
        
        this.rpcGateway = new RpcGateway(this.gatewayOrchestrator, storage, eventBus, this.config.apiKey);
        this.projection = new DaemonProjection({
            snapshot: (cursor) => ({
                ...this.rpcGateway.getProjectionSnapshot(),
                cursor,
            }),
            onDiagnostic: (diagnostic) => {
                this.eventBus.log('warn', `WebSocket protocol diagnostic: ${diagnostic.code}`, 'DaemonServer');
            },
        });

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
            this.projection.broadcast(forwarded.event, forwarded.data);
        });
    }

    private cleanupTransport(): void {
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

        this.app.get('/health', async () => {
            return { status: 'ok', timestamp: new Date().toISOString() };
        });

        this.app.get('/ws', { websocket: true }, (socket) => {
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

            const response = await this.rpcGateway.handleRequest({
                jsonrpc: '2.0',
                id: rpcRequest.id,
                method: rpcRequest.method,
                params: rpcRequest.params,
            });

            return response;
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
        } catch (err) {
            this.eventBus.log('error', `Failed to start daemon: ${err}`, 'DaemonServer');
            throw err;
        }
    }

    async stop(): Promise<void> {
        if (!this.isRunning) {
            this.cleanupTransport();
            return;
        }

        this.eventBus.emit('daemon', { type: 'shutting_down' });
        this.cleanupTransport();

        try {
            await this.app.close();
            this.isRunning = false;
            this.eventBus.emit('daemon', { type: 'stopped' });
            this.eventBus.log('info', 'Daemon stopped gracefully', 'DaemonServer');
        } catch (err) {
            this.isRunning = false;
            this.eventBus.log('error', `Error stopping daemon: ${err}`, 'DaemonServer');
            throw err;
        }
    }

    get running(): boolean {
        return this.isRunning;
    }

    get address(): string {
        return `http://${this.config.host}:${this.config.port}`;
    }
}
