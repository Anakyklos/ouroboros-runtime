/**
 * 🚦 RPC Gateway
 * 
 * Handler para JSON-RPC 2.0 requests.
 * Roteia métodos para handlers apropriados.
 */

import type { RpcPort, RpcRequest, RpcResponse, RpcMethodHandler } from '../ports/rpc.port.js';
import { RPC_ERROR_CODES } from '../ports/rpc.port.js';
import type { SessionManager } from './session-manager.js';

export class RpcGateway implements RpcPort {
    private methods: Map<string, RpcMethodHandler> = new Map();
    private sessionManager: SessionManager;

    constructor(sessionManager: SessionManager) {
        this.sessionManager = sessionManager;
        this.registerSystemMethods();
        this.registerSessionMethods();
        this.registerAgentMethods();
    }

    registerMethod(name: string, handler: RpcMethodHandler): void {
        this.methods.set(name, handler);
    }

    async handleRequest(request: RpcRequest): Promise<RpcResponse> {
        const handler = this.methods.get(request.method);

        if (!handler) {
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                    message: `Method not found: ${request.method}`,
                },
            };
        }

        try {
            const result = await handler(request.params ?? {});
            return {
                jsonrpc: '2.0',
                id: request.id,
                result,
            };
        } catch (err) {
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: RPC_ERROR_CODES.INTERNAL_ERROR,
                    message: err instanceof Error ? err.message : 'Unknown error',
                },
            };
        }
    }

    private registerSystemMethods(): void {
        // system.health - Returns daemon status
        this.registerMethod('system.health', async () => {
            return {
                status: 'healthy',
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                timestamp: new Date().toISOString(),
            };
        });

        // system.shutdown - Graceful shutdown
        this.registerMethod('system.shutdown', async () => {
            // Schedule shutdown after response
            setTimeout(() => process.exit(0), 100);
            return { status: 'shutting_down' };
        });

        // system.version - Returns version info
        this.registerMethod('system.version', async () => {
            return {
                version: '1.0.0',
                name: 'ouroboros-daemon',
            };
        });
    }

    private registerSessionMethods(): void {
        // session.create - Create new session
        this.registerMethod('session.create', async (params) => {
            const session = await this.sessionManager.createSession({
                status: 'active',
                contextSnapshot: params.context as string ?? '',
                metadata: params.metadata as Record<string, unknown> ?? {},
            });
            return { sessionId: session.id };
        });

        // session.list - List all sessions
        this.registerMethod('session.list', async (params) => {
            const sessions = await this.sessionManager.listSessions(
                params.status as string | undefined
            );
            return { sessions };
        });

        // session.get - Get session by ID
        this.registerMethod('session.get', async (params) => {
            const session = await this.sessionManager.getSession(params.id as string);
            if (!session) {
                throw new Error(`Session not found: ${params.id}`);
            }
            return { session };
        });

        // session.attach - Attach to existing session
        this.registerMethod('session.attach', async (params) => {
            const session = await this.sessionManager.attachSession(params.id as string);
            return { session };
        });
    }

    private registerAgentMethods(): void {
        // agent.input - Send input to agent
        this.registerMethod('agent.input', async (params) => {
            const result = await this.sessionManager.sendInput(
                params.sessionId as string,
                params.prompt as string
            );
            return { status: 'task_started', taskId: result.taskId };
        });

        // agent.interrupt - Interrupt agent execution
        this.registerMethod('agent.interrupt', async (params) => {
            await this.sessionManager.interruptSession(params.sessionId as string);
            return { status: 'interrupted' };
        });

        // agent.resume - Resume paused agent execution
        this.registerMethod('agent.resume', async (params) => {
            await this.sessionManager.resumeSession(params.sessionId as string);
            return { status: 'resumed' };
        });
    }
}
