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
import fastifyWebsocket from '@fastify/websocket';
import type { SocketStream } from '@fastify/websocket';

export interface DaemonConfig {
    port: number;
    host: string;
    sessionToken?: string;
    apiKey?: string;
}

const DEFAULT_CONFIG: DaemonConfig = {
    port: 7777,
    host: '127.0.0.1',  // Localhost only for security
};

export class DaemonServer {
    private app: FastifyInstance;
    private config: DaemonConfig;
    private eventBus: EventBus;
    private rpcGateway: RpcGateway;
    private gatewayOrchestrator: GatewayOrchestrator;
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
        
        this.rpcGateway = new RpcGateway(this.gatewayOrchestrator, storage, eventBus, this.config.apiKey);

        this.app = Fastify({
            logger: false,
        });

        this.app.register(fastifyWebsocket);
        this.setupRoutes();
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
            });

            return response;
        });

        // WebSocket endpoint for real-time events
        this.app.register(async (fastify) => {
            fastify.get('/ws', { websocket: true }, (connection: SocketStream, req) => {
                // Subscribe to all events and push to client
                const onEvent = (payload: unknown) => {
                    if (connection.socket.readyState === 1) { // WebSocket.OPEN
                        connection.socket.send(JSON.stringify(payload));
                    }
                };
                
                const unsubscribe = this.eventBus.on('*' as any, onEvent as any);
                
                connection.socket.on('close', () => {
                    unsubscribe();
                });
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
