/**
 * 🌐 Daemon Server
 * 
 * Fastify server com JSON-RPC 2.0 para o Ouroboros Daemon.
 * Roda em localhost:7777 por padrão.
 */

import Fastify, { FastifyInstance } from 'fastify';
import { EventBus, globalEventBus } from './event-bus.js';
import { RpcGateway } from './rpc-gateway.js';
import { GatewayOrchestrator } from '../orchestration/GatewayOrchestrator.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { DaemonConfig } from '../ports/rpc.port.js';
import { SessionManager } from './session-manager.js';
import fastifyWebsocket from '@fastify/websocket';
import type { RawData, WebSocket } from 'ws';

const DEFAULT_CONFIG: DaemonConfig = {
    port: 7777,
    host: '127.0.0.1',  // Localhost only for security
    apiKey: process.env.DAEMON_API_KEY || 'ouroboros_dev_key'
};

export class DaemonServer {
    private app: FastifyInstance;
    private config: DaemonConfig;
    private eventBus: EventBus;
    private rpcGateway: RpcGateway;
    private gatewayOrchestrator: GatewayOrchestrator;
    private sessionManager: SessionManager;
    private isRunning = false;

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

        this.sessionManager = new SessionManager(storage, eventBus);
        this.rpcGateway = new RpcGateway(
            this.gatewayOrchestrator,
            storage,
            eventBus,
            this.sessionManager,
            this.config
        );

        this.app = Fastify({
            logger: false,
        });

        this.app.register(fastifyWebsocket);
        this.setupRoutes();

        this.app.ready(() => {
            console.log('[DaemonServer] Routes registered:');
            console.log(this.app.printRoutes());
        });
    }
    private setupRoutes(): void {
        // Health check
        this.app.get('/health', async () => {
            return { status: 'ok', timestamp: new Date().toISOString() };
        });

        // JSON-RPC endpoint
        this.app.post('/rpc', async (request, reply) => {
            const rpcRequest = request.body as {
                jsonrpc: string;
                id: string | number;
                method: string;
                params?: Record<string, unknown>;
                apiKey?: string;
            };

            // Validate JSON-RPC format
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
                apiKey: rpcRequest.apiKey
            });

            return response;
        });

        // JSON-RPC via WebSocket (Unified RPC + Events)
        this.app.register(async (fastify) => {
            fastify.get('/rpc-ws', { websocket: true }, (connection: any, req: any) => {
                console.log(`[DaemonServer] WebSocket connection reached /rpc-ws from ${req.ip}`);
                // connection in @fastify/websocket v11 is SocketStream
                const socket = connection.socket || connection;
                this.rpcGateway.handleConnection(socket, req);
            });
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error('Daemon is already running');
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
            return;
        }

        this.eventBus.emit('daemon', { type: 'shutting_down' });

        try {
            await this.app.close();
            this.isRunning = false;
            this.eventBus.emit('daemon', { type: 'stopped' });
            this.eventBus.log('info', 'Daemon stopped gracefully', 'DaemonServer');
        } catch (err) {
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
