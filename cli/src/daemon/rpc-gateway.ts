/**
 * JSON-RPC surface for the headless executive control plane.
 * Legacy agent and delegate methods live in `legacy-rpc-gateway.ts` and are
 * only reachable when an application explicitly composes that gateway.
 */

import type { RpcPort, RpcRequest, RpcResponse, RpcMethodHandler } from '../ports/rpc.port.js';
import { RPC_ERROR_CODES } from '../ports/rpc.port.js';
import { SessionManager } from './session-manager.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { EventBus } from './event-bus.js';
import { DAEMON_EVENT_VERSION, type DaemonSnapshot } from '../../../shared/daemon-event-contract.js';
import { LocalControlReadService, currentLocalControlRuntimeIdentity } from './local-control-read.js';
import { projectDaemonStatus } from './durable-projection.js';
import type { MissionStore } from '../mission/ports.js';
import type { CapabilityRegistryApi } from '../capabilities/registry.js';
import { LocalControlCommandService, type MissionCommandAuthority } from './local-control-command.js';
import { SESSION_RPC_MAX_ITEMS } from '../../../shared/session-rpc-contract.js';
import { projectSessionGetResult, projectSessionListResult } from './session-rpc-projection.js';

export interface DaemonRpcGatewayPort extends RpcPort {
    getProjectionSnapshot(cursor?: number): Promise<DaemonSnapshot>;
}

/** Modern, provider independent JSON-RPC gateway used by default by DaemonServer. */
export class RpcGateway implements DaemonRpcGatewayPort {
    private readonly methods = new Map<string, RpcMethodHandler>();
    private readonly sessionManager: SessionManager;
    private readonly localControlRead: LocalControlReadService;
    private readonly localControlCommand?: LocalControlCommandService;
    private readonly onShutdownRequested?: () => void;

    constructor(
        storage: StoragePort,
        eventBus: EventBus,
        missionStore?: MissionStore,
        capabilityRegistry?: Pick<CapabilityRegistryApi, 'listDescriptors'>,
        missionCommandAuthority?: MissionCommandAuthority,
        onShutdownRequested?: () => void,
    ) {
        this.onShutdownRequested = onShutdownRequested;
        this.sessionManager = new SessionManager(storage, eventBus);
        this.localControlRead = new LocalControlReadService({
            getStatus: () => projectDaemonStatus(this.sessionManager.getStatusSnapshot()),
            getRuntimeIdentity: currentLocalControlRuntimeIdentity,
            missionStore,
            capabilityRegistry,
        });
        this.localControlCommand = missionCommandAuthority
            ? new LocalControlCommandService(missionCommandAuthority)
            : undefined;
        this.registerSystemMethods();
        this.registerReadOnlySessionMethods();
        this.registerDaemonControlMethods();
        this.registerLocalControlMethods();
    }

    registerMethod(name: string, handler: RpcMethodHandler): void {
        this.methods.set(name, handler);
    }

    /** Return the shared sanitized facts used by WebSocket handshake and resync. */
    async getProjectionSnapshot(cursor = 0): Promise<DaemonSnapshot> {
        const facts = await this.localControlRead.readProjectionFacts();
        return {
            protocolVersion: DAEMON_EVENT_VERSION,
            transportCapabilities: {
                orderedEvents: true,
                authoritativeSnapshot: true,
                resync: true,
                durableMissions: facts.durableProjectionAvailable,
                durableInvocations: facts.durableProjectionAvailable,
            },
            cursor,
            status: facts.status,
            capabilities: facts.status.capabilities,
            missions: facts.missions,
            invocations: facts.invocations,
            completeness: facts.completeness,
        };
    }

    async handleRequest(request: RpcRequest): Promise<RpcResponse> {
        const handler = this.methods.get(request.method);
        if (!handler) {
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                    message: 'Method not found',
                },
            };
        }

        try {
            return {
                jsonrpc: '2.0',
                id: request.id,
                result: await handler(request.params ?? {}),
            };
        } catch {
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: RPC_ERROR_CODES.INTERNAL_ERROR,
                    message: 'The RPC request could not be completed',
                },
            };
        }
    }

    private registerSystemMethods(): void {
        this.registerMethod('system.health', async () => ({
            status: 'healthy',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            timestamp: new Date().toISOString(),
        }));
        this.registerMethod('system.shutdown', async () => {
            try {
                this.onShutdownRequested?.();
            } catch {
                // The lifecycle owner reports its own sanitized failure.
            }
            return { status: 'shutting_down' };
        });
        this.registerMethod('system.version', async () => ({
            version: '1.0.0',
            name: 'ouroboros-daemon',
        }));
    }

    private registerReadOnlySessionMethods(): void {
        this.registerMethod('session.list', async (params) => projectSessionListResult(
            await this.sessionManager.listSessions(params.status as string | undefined, SESSION_RPC_MAX_ITEMS + 1),
        ));
        this.registerMethod('session.get', async (params) => {
            const session = await this.sessionManager.getSession(params.id as string);
            if (!session) throw new Error(`Session not found: ${params.id}`);
            return projectSessionGetResult(session);
        });
    }

    private registerDaemonControlMethods(): void {
        this.registerMethod('daemon.status', async () => this.sessionManager.getStatusSnapshot());
        this.registerMethod('daemon.setMode', async (params) => {
            const result = await this.sessionManager.setMode(params?.mode);
            if (
                result.operation === 'rejected_invalid_mode' ||
                result.operation === 'rejected_invalid_transition'
            ) {
                throw new Error(result.reason ?? `setMode rejected: ${result.operation}`);
            }
            return result;
        });
        this.registerMethod('daemon.emergencyBrake', async () => this.sessionManager.emergencyBrake());
    }

    private registerLocalControlMethods(): void {
        this.registerMethod('local_control.read', async (params) => this.localControlRead.read(params));
        this.registerMethod('local_control.command', async (params) =>
            this.localControlCommand
                ? this.localControlCommand.execute(params)
                : { ok: false, code: 'AUTHORITY_UNAVAILABLE', message: 'Mission command authority is unavailable' },
        );
    }
}
