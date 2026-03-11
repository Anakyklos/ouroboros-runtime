/**
 * 🧪 RPC Gateway Tests
 * 
 * Tests for JSON-RPC 2.0 handler methods.
 */

import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';
import { RpcGateway } from './rpc-gateway.js';
import { RPC_ERROR_CODES } from '../ports/rpc.port.js';
import type { RpcRequest } from '../ports/rpc.port.js';
import type { StoragePort } from '../ports/storage.port.js';
import { EventBus } from './event-bus.js';
import type { GatewayOrchestrator } from '../orchestration/GatewayOrchestrator.js';

describe('RpcGateway', () => {
    let gateway: RpcGateway;
    let mockStorage: StoragePort;
    let mockEventBus: EventBus;
    let mockOrchestrator: GatewayOrchestrator;

    beforeEach(() => {
        mockEventBus = new EventBus();

        mockStorage = {
            createSession: mock(async (data) => ({
                ...data,
                id: 'session-123',
                createdAt: new Date(),
                updatedAt: new Date(),
                status: data.status ?? 'active',
                contextSnapshot: data.contextSnapshot ?? '',
                metadata: data.metadata ?? {},
            })),
            getSession: mock(async (id: string) => {
                if (id === 'existing-session') {
                    return {
                        id: 'existing-session',
                        createdAt: new Date(),
                        updatedAt: new Date(),
                        status: 'active',
                        contextSnapshot: '',
                        metadata: {},
                    };
                }
                return null;
            }),
            updateSession: mock(async () => {}),
            listSessions: mock(async () => [
                {
                    id: 'session-1',
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    status: 'active',
                    contextSnapshot: '',
                    metadata: {},
                },
            ]),
            deleteSession: mock(async () => {}),
            appendLog: mock(async () => ({
                id: 'log-1',
                sessionId: 'session-1',
                timestamp: new Date(),
                type: 'input',
                content: '',
            })),
            getLogs: mock(async () => []),
            initialize: mock(async () => {}),
            close: mock(async () => {}),
        };

        mockOrchestrator = {
            delegateToGemini: mock(async () => ({ output: 'gemini response' })),
            delegateToAntigravity: mock(async () => ({ output: 'antigravity response' })),
            delegateToJules: mock(async () => ({ output: 'jules response' })),
            checkBridgeAvailability: mock(async () => ({
                gemini: true,
                antigravity: true,
                jules: false,
            })),
        } as unknown as GatewayOrchestrator;

        gateway = new RpcGateway(mockOrchestrator, mockStorage, mockEventBus);
    });

    describe('handleRequest', () => {
        it('should return METHOD_NOT_FOUND for unknown methods', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'unknown.method',
            };

            const response = await gateway.handleRequest(request);

            expect(response.error).toBeDefined();
            expect(response.error?.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
            expect(response.error?.message).toContain('unknown.method');
        });

        it('should return result for valid method calls', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'system.health',
            };

            const response = await gateway.handleRequest(request);

            expect(response.error).toBeUndefined();
            expect(response.result).toBeDefined();
            expect((response.result as Record<string, unknown>).status).toBe('healthy');
        });

        it('should return INTERNAL_ERROR when handler throws', async () => {
            // Register a method that throws
            gateway.registerMethod('test.throws', async () => {
                throw new Error('Test error message');
            });

            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'test.throws',
            };

            const response = await gateway.handleRequest(request);

            expect(response.error).toBeDefined();
            expect(response.error?.code).toBe(RPC_ERROR_CODES.INTERNAL_ERROR);
            expect(response.error?.message).toBe('Test error message');
        });

        it('should handle non-Error throws gracefully', async () => {
            gateway.registerMethod('test.throws_string', async () => {
                throw 'string error';
            });

            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'test.throws_string',
            };

            const response = await gateway.handleRequest(request);

            expect(response.error).toBeDefined();
            expect(response.error?.code).toBe(RPC_ERROR_CODES.INTERNAL_ERROR);
            expect(response.error?.message).toBe('Unknown error');
        });

        it('should preserve request id in response', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 'custom-id-123',
                method: 'system.health',
            };

            const response = await gateway.handleRequest(request);

            expect(response.id).toBe('custom-id-123');
            expect(response.jsonrpc).toBe('2.0');
        });
    });

    describe('system methods', () => {
        it('system.health should return status and metrics', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'system.health',
            };

            const response = await gateway.handleRequest(request);
            const result = response.result as Record<string, unknown>;

            expect(result.status).toBe('healthy');
            expect(typeof result.uptime).toBe('number');
            expect(result.memory).toBeDefined();
            expect(typeof result.timestamp).toBe('string');
        });

        it('system.version should return version info', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'system.version',
            };

            const response = await gateway.handleRequest(request);
            const result = response.result as Record<string, unknown>;

            expect(result.version).toBe('1.0.0');
            expect(result.name).toBe('ouroboros-daemon');
        });

        it('system.shutdown should return shutting_down status', async () => {
            // Mock process.exit to prevent actual exit
            const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);

            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'system.shutdown',
            };

            const response = await gateway.handleRequest(request);
            const result = response.result as Record<string, unknown>;

            expect(result.status).toBe('shutting_down');

            // Restore
            exitSpy.mockRestore();
        });
    });

    describe('session methods', () => {
        it('session.create should create a new session', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'session.create',
                params: {
                    context: 'test context',
                    metadata: { key: 'value' },
                },
            };

            const response = await gateway.handleRequest(request);
            const result = response.result as Record<string, unknown>;

            expect(result.sessionId).toBe('session-123');
            expect(mockStorage.createSession).toHaveBeenCalled();
        });

        it('session.create should work without params', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'session.create',
            };

            const response = await gateway.handleRequest(request);

            expect(response.error).toBeUndefined();
            expect((response.result as Record<string, unknown>).sessionId).toBeDefined();
        });

        it('session.list should return sessions array', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'session.list',
            };

            const response = await gateway.handleRequest(request);
            const result = response.result as Record<string, unknown>;

            expect(result.sessions).toBeDefined();
            expect(Array.isArray(result.sessions)).toBe(true);
        });

        it('session.list should filter by status', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'session.list',
                params: { status: 'active' },
            };

            await gateway.handleRequest(request);

            expect(mockStorage.listSessions).toHaveBeenCalledWith({ status: 'active' });
        });

        it('session.get should return session by id', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'session.get',
                params: { id: 'existing-session' },
            };

            const response = await gateway.handleRequest(request);
            const result = response.result as Record<string, unknown>;

            expect(result.session).toBeDefined();
            expect((result.session as Record<string, unknown>).id).toBe('existing-session');
        });

        it('session.get should throw for non-existent session', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'session.get',
                params: { id: 'non-existent' },
            };

            const response = await gateway.handleRequest(request);

            expect(response.error).toBeDefined();
            expect(response.error?.message).toContain('Session not found');
        });
    });

    describe('daemon methods', () => {
        it('daemon.list_agents should return agent availability', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'daemon.list_agents',
            };

            const response = await gateway.handleRequest(request);
            const result = response.result as Record<string, unknown>;
            const agents = result.agents as Record<string, string>;

            expect(agents.gemini).toBe('available');
            expect(agents.antigravity).toBe('available');
            expect(agents.jules).toBe('unavailable');
            expect(result.timestamp).toBeDefined();
        });

        it('daemon.delegate should delegate to gemini', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'daemon.delegate',
                params: {
                    agent: 'gemini',
                    prompt: 'test prompt',
                    model: 'flash',
                },
            };

            const response = await gateway.handleRequest(request);
            const result = response.result as Record<string, unknown>;

            expect(result.status).toBe('success');
            expect(result.agent).toBe('gemini');
            expect(mockOrchestrator.delegateToGemini).toHaveBeenCalledWith('test prompt', 'flash');
        });

        it('daemon.delegate should delegate to antigravity for claude', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'daemon.delegate',
                params: {
                    agent: 'claude',
                    prompt: 'test prompt',
                },
            };

            const response = await gateway.handleRequest(request);
            const result = response.result as Record<string, unknown>;

            expect(result.status).toBe('success');
            expect(result.agent).toBe('claude');
            expect(mockOrchestrator.delegateToAntigravity).toHaveBeenCalled();
        });

        it('daemon.delegate should delegate to jules', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'daemon.delegate',
                params: {
                    agent: 'jules',
                    prompt: 'test prompt',
                    context: 'test context',
                },
            };

            const response = await gateway.handleRequest(request);
            const result = response.result as Record<string, unknown>;

            expect(result.status).toBe('success');
            expect(result.agent).toBe('jules');
            expect(mockOrchestrator.delegateToJules).toHaveBeenCalledWith('test prompt', 'test context');
        });

        it('daemon.delegate should throw for unknown agent', async () => {
            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'daemon.delegate',
                params: {
                    agent: 'unknown_agent',
                    prompt: 'test prompt',
                },
            };

            const response = await gateway.handleRequest(request);

            expect(response.error).toBeDefined();
            expect(response.error?.message).toContain('unknown_agent');
        });
    });

    describe('registerMethod', () => {
        it('should register custom methods', async () => {
            gateway.registerMethod('custom.method', async (params) => {
                return { echo: params.message };
            });

            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'custom.method',
                params: { message: 'hello' },
            };

            const response = await gateway.handleRequest(request);
            const result = response.result as Record<string, unknown>;

            expect(result.echo).toBe('hello');
        });

        it('should override existing methods', async () => {
            gateway.registerMethod('system.health', async () => {
                return { status: 'custom' };
            });

            const request: RpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'system.health',
            };

            const response = await gateway.handleRequest(request);
            const result = response.result as Record<string, unknown>;

            expect(result.status).toBe('custom');
        });
    });

    describe('extractJsonArray (via private access)', () => {
        // Access private method for testing
        const getExtractor = (gw: RpcGateway) => 
            (gw as unknown as { extractJsonArray: (content: string) => string }).extractJsonArray.bind(gw);

        it('should extract JSON from plain array', () => {
            const extract = getExtractor(gateway);
            const input = '[{"id": "task-1"}]';
            expect(extract(input)).toBe('[{"id": "task-1"}]');
        });

        it('should extract JSON from markdown code block', () => {
            const extract = getExtractor(gateway);
            const input = '```json\n[{"id": "task-1"}]\n```';
            expect(JSON.parse(extract(input))).toEqual([{ id: 'task-1' }]);
        });

        it('should extract JSON from code block without language', () => {
            const extract = getExtractor(gateway);
            const input = '```\n[{"id": "task-1"}]\n```';
            expect(JSON.parse(extract(input))).toEqual([{ id: 'task-1' }]);
        });

        it('should extract JSON embedded in text', () => {
            const extract = getExtractor(gateway);
            const input = 'Here is the result:\n[{"id": "task-1"}]\nThat is all.';
            expect(JSON.parse(extract(input))).toEqual([{ id: 'task-1' }]);
        });

        it('should handle empty array', () => {
            const extract = getExtractor(gateway);
            const input = '[]';
            expect(extract(input)).toBe('[]');
        });
    });

    describe('validateWaveTask (via private access)', () => {
        const getValidator = (gw: RpcGateway) =>
            (gw as unknown as { validateWaveTask: (task: unknown) => void }).validateWaveTask.bind(gw);

        it('should accept valid task with all fields', () => {
            const validate = getValidator(gateway);
            expect(() => validate({
                id: 'task-1',
                name: 'Test Task',
                description: 'A test',
                instruction: 'Do something',
                dependsOn: ['task-0'],
            })).not.toThrow();
        });

        it('should accept minimal task with only id', () => {
            const validate = getValidator(gateway);
            expect(() => validate({ id: 'task-1' })).not.toThrow();
        });

        it('should reject task without id', () => {
            const validate = getValidator(gateway);
            expect(() => validate({ name: 'No ID' })).toThrow(/missing or invalid 'id'/);
        });

        it('should reject task with non-string id', () => {
            const validate = getValidator(gateway);
            expect(() => validate({ id: 123 })).toThrow(/missing or invalid 'id'/);
        });

        it('should reject task with non-array dependsOn', () => {
            const validate = getValidator(gateway);
            expect(() => validate({ id: 'task-1', dependsOn: 'task-0' })).toThrow(/must be an array/);
        });

        it('should reject task with non-string items in dependsOn', () => {
            const validate = getValidator(gateway);
            expect(() => validate({ id: 'task-1', dependsOn: [123] })).toThrow(/must contain only strings/);
        });

        it('should reject null task', () => {
            const validate = getValidator(gateway);
            expect(() => validate(null)).toThrow(/expected object/);
        });
    });
});
