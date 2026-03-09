/**
 * 🚦 RPC Gateway
 * 
 * Handler para JSON-RPC 2.0 requests.
 * Roteia métodos para handlers apropriados.
 */

import type { RpcPort, RpcRequest, RpcResponse, RpcMethodHandler } from '../ports/rpc.port.js';
import { RPC_ERROR_CODES } from '../ports/rpc.port.js';
import { SessionManager } from './session-manager.js';
import { GatewayOrchestrator } from '../orchestration/GatewayOrchestrator.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { EventBus } from './event-bus.js';
import type { GeminiModel } from '../bridges/GeminiCliBridge.js';
import { createAgent } from '../providers/agent-loop.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Orchestrator } from '../orchestration/Orchestrator.js';
import { WaveExecutor } from '../orchestration/WaveExecutor.js';
import type { WaveTask, WaveExecutionResult } from '../orchestration/wave-types.js';

export class RpcGateway implements RpcPort {
    private methods: Map<string, RpcMethodHandler> = new Map();
    private gatewayOrchestrator: GatewayOrchestrator;
    private sessionManager: SessionManager;

    constructor(
        gatewayOrchestrator: GatewayOrchestrator,
        storage: StoragePort,
        eventBus: EventBus,
        apiKey?: string
    ) {
        this.gatewayOrchestrator = gatewayOrchestrator;
        this.sessionManager = new SessionManager(storage, eventBus, apiKey);
        this.registerSystemMethods();
        this.registerSessionMethods();
        this.registerAgentMethods();
        this.registerDaemonMethods();
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

    private async parseWaveTasks(prompt: string): Promise<WaveTask[]> {
        const apiKey = this.loadZAIKey();

        const parser = createAgent({
            apiKey,
            workingDirectory: process.cwd(),
            verbose: false,
        });

        const parsePrompt = `You are a task parser. Convert the following user prompt into a JSON array of WaveTask objects.

User prompt: ${prompt}

Return ONLY valid JSON array with this structure:
[
  {
    "id": "task-1",
    "name": "Task Name",
    "description": "Task description",
    "dependsOn": ["task-0"],
    "instruction": "What the agent should do"
  }
]

Rules:
- id: unique, kebab-case
- dependsOn: array of task ids this task depends on (optional)
- instruction: what the agent should execute
- Return ONLY JSON, no markdown, no explanation
- If no tasks needed, return empty array: []
`;

        const parseResult = await parser.run(parsePrompt);

        if (!parseResult.success || !parseResult.content) {
            throw new Error(`Failed to parse wave tasks: ${parseResult.content ?? 'No response from parser'}`);
        }

        const jsonContent = this.extractJsonArray(parseResult.content);

        try {
            const tasks = JSON.parse(jsonContent) as WaveTask[];

            if (!Array.isArray(tasks)) {
                throw new Error('Parsed result is not an array');
            }

            // Validate each task has required fields
            for (const task of tasks) {
                this.validateWaveTask(task);
            }

            return tasks;
        } catch (error) {
            throw new Error(`Invalid JSON in parsed tasks: ${error instanceof Error ? error.message : String(error)}\nContent: ${jsonContent}`);
        }
    }

    /**
     * Extract JSON array from LLM response, handling various formats:
     * - Plain JSON array
     * - Markdown code blocks (```json, ``` json, ```)
     * - JSON embedded in explanatory text
     */
    private extractJsonArray(content: string): string {
        // Strategy 1: Try to find JSON in markdown code block
        const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (codeBlockMatch) {
            const extracted = codeBlockMatch[1].trim();
            if (extracted.startsWith('[')) {
                return extracted;
            }
        }

        // Strategy 2: Find the first [ and last ] to extract array
        const firstBracket = content.indexOf('[');
        const lastBracket = content.lastIndexOf(']');
        
        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
            const extracted = content.slice(firstBracket, lastBracket + 1);
            // Quick validation: try parsing it
            try {
                JSON.parse(extracted);
                return extracted;
            } catch {
                // Fall through to next strategy
            }
        }

        // Strategy 3: Clean common markdown artifacts and try raw content
        const cleaned = content
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/g, '')
            .trim();
        
        return cleaned;
    }

    /**
     * Validate a WaveTask has all required fields with correct types.
     */
    private validateWaveTask(task: unknown): asserts task is WaveTask {
        if (!task || typeof task !== 'object') {
            throw new Error(`Invalid task: expected object, got ${typeof task}`);
        }

        const t = task as Record<string, unknown>;

        if (!t.id || typeof t.id !== 'string') {
            throw new Error(`Invalid task: missing or invalid 'id' field: ${JSON.stringify(task)}`);
        }

        if (t.name !== undefined && typeof t.name !== 'string') {
            throw new Error(`Invalid task '${t.id}': 'name' must be a string`);
        }

        if (t.instruction !== undefined && typeof t.instruction !== 'string') {
            throw new Error(`Invalid task '${t.id}': 'instruction' must be a string`);
        }

        if (t.dependsOn !== undefined) {
            if (!Array.isArray(t.dependsOn)) {
                throw new Error(`Invalid task '${t.id}': 'dependsOn' must be an array`);
            }
            for (const dep of t.dependsOn) {
                if (typeof dep !== 'string') {
                    throw new Error(`Invalid task '${t.id}': 'dependsOn' must contain only strings`);
                }
            }
        }
    }

    private loadZAIKey(): string {
        // 1. Env var (produção)
        if (process.env.ZAI_API_KEY) {
            return process.env.ZAI_API_KEY;
        }

        // 2. Arquivo .secrets (novo padrão)
        const secretsPath = join(process.cwd(), '.secrets');
        if (existsSync(secretsPath)) {
            const content = readFileSync(secretsPath, 'utf-8');
            const match = content.match(/z\.ai api key:\s*(.+)/);
            if (match) {
                return match[1].trim();
            }
        }

        // 3. Arquivo Apikeys (legacy)
        const apiKeyPath = join(process.cwd(), 'Apikeys');
        if (existsSync(apiKeyPath)) {
            const content = readFileSync(apiKeyPath, 'utf-8');
            const match = content.match(/z\.ai api key:\s*(.+)/);
            if (match) {
                return match[1].trim();
            }
        }

        // 4. Erro se não encontrar
        throw new Error(
            'Z.AI API key not found. Set ZAI_API_KEY env var or create .secrets file.'
        );
    }

    private registerDaemonMethods(): void {
        // daemon.delegate - Delegate task to specific agent
        this.registerMethod('daemon.delegate', async (params) => {
            const agent = params.agent as string;
            const prompt = params.prompt as string;
            const context = params.context as string | object | undefined;

            try {
                let result: unknown;

                switch (agent) {
                    case 'gemini':
                        result = await this.gatewayOrchestrator.delegateToGemini(
                            prompt,
                            params.model as GeminiModel ?? 'flash'
                        );
                        break;
                    case 'claude':
                    case 'antigravity':
                        result = await this.gatewayOrchestrator.delegateToAntigravity(
                            prompt,
                            context as string | undefined
                        );
                        break;
                    case 'jules':
                        result = await this.gatewayOrchestrator.delegateToJules(
                            prompt,
                            context as string | undefined
                        );
                        break;
                    case 'glm': {
                        // Wave Mode: Check if prompt starts with "WAVE:"
                        if (prompt.trim().toUpperCase().startsWith('WAVE:')) {
                            const wavePrompt = prompt.trim().substring(5).trim();

                            const tasks = await this.parseWaveTasks(wavePrompt);

                            if (tasks.length === 0) {
                                result = {
                                    mode: 'wave',
                                    tasks: [],
                                    message: 'No tasks to execute',
                                };
                            } else {
                                const apiKey = this.loadZAIKey();
                                const orchestrator = new Orchestrator();
                                orchestrator.initialize(apiKey);
                                const waveExecutor = new WaveExecutor(orchestrator);

                                const waveResult: WaveExecutionResult = await waveExecutor.execute(tasks);

                                result = {
                                    mode: 'wave',
                                    waveExecution: {
                                        success: waveResult.success,
                                        totalWaves: waveResult.waves.length,
                                        totalDuration: waveResult.totalDuration,
                                        successfulTasks: waveResult.successfulTasks,
                                        failedTasks: waveResult.failedTasks,
                                        skippedTasks: waveResult.skippedTasks,
                                    },
                                    tasks: tasks.map(t => ({
                                        id: t.id,
                                        name: t.name,
                                        description: t.description,
                                        dependsOn: t.dependsOn,
                                    })),
                                };
                            }
                        } else {
                            // Standard Mode: Use AgentLoop
                            const apiKey = this.loadZAIKey();

                            const leviathan = createAgent({
                                apiKey,
                                workingDirectory: process.cwd(),
                                verbose: true,
                            });

                            const agentResult = await leviathan.run(prompt);

                            result = {
                                success: agentResult.success,
                                content: agentResult.content,
                                toolCallsCount: agentResult.toolCallsCount,
                                durationMs: agentResult.durationMs,
                                totalTokens: agentResult.totalTokens,
                            };
                        }
                        break;
                    }
                    default:
                        throw new Error(`Unknown agent: ${agent}`);
                }

                return {
                    status: 'success',
                    agent,
                    result,
                    timestamp: new Date().toISOString(),
                };
            } catch (error) {
                throw new Error(
                    `Delegation to ${agent} failed: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        });

        // daemon.list_agents - List available agents
        this.registerMethod('daemon.list_agents', async () => {
            const availability = await this.gatewayOrchestrator.checkBridgeAvailability();

            // Check if GLM API key is available
            let glmStatus: 'available' | 'unavailable' = 'available';
            try {
                this.loadZAIKey();
            } catch {
                glmStatus = 'unavailable';
            }

            return {
                agents: {
                    gemini: availability.gemini ? 'available' : 'unavailable',
                    antigravity: availability.antigravity ? 'available' : 'unavailable',
                    claude: availability.antigravity ? 'available' : 'unavailable',
                    jules: availability.jules ? 'available' : 'unavailable',
                    glm: glmStatus,
                },
                timestamp: new Date().toISOString(),
            };
        });
    }
}
