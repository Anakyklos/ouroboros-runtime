/**
 * 🔄 AgentLoop
 * 
 * Loop de execução do agente com tool calling.
 * Envia prompt para Z.AI, executa tools, retorna resultado.
 */

import { EventBus, globalEventBus, type ThoughtEvent } from '../daemon/event-bus.js';
import type { BudgetPort, BudgetCategory } from '../ports/budget.port.js';
import {
    DirectZAIProvider,
    createDirectZAI,
    type Message,
    type ToolCall,
    type DirectZAIConfig
} from './direct-zai.js';
import {
    ToolExecutor,
    createToolExecutor,
    type ToolExecutorConfig
} from './tool-executor.js';

// ============================================================
// Types
// ============================================================

export interface AgentResult {
    success: boolean;
    content: string;
    toolCallsCount: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    durationMs: number;
}

export interface AgentLoopConfig {
    /** Max iterations to prevent infinite loops (default: 20) */
    maxIterations?: number;
    /** System prompt for the agent */
    systemPrompt?: string;
    /** Temperature for generation (default: 0.3 for coding) */
    temperature?: number;
    /** Verbose logging */
    verbose?: boolean;
}

// ============================================================
// Default System Prompt
// ============================================================

const DEFAULT_SYSTEM_PROMPT = `You are an expert software engineer assistant.

## Your Capabilities
You have access to tools for file system operations and command execution:
- read_file: Read file contents
- write_file: Create or update files
- run_command: Execute shell commands
- list_directory: List directory contents
- grep_search: Search for patterns in files

## Guidelines
1. Always read existing files before modifying them to understand context
2. Create parent directories if needed before writing files
3. Validate your changes by reading the file after writing
4. Use run_command to verify builds, run tests, etc.
5. Be concise in responses but thorough in implementation

## Response Format
When completing a task:
1. Explain what you're doing briefly
2. Execute the necessary tool calls
3. Confirm the result
`;

// ============================================================
// AgentLoop
// ============================================================

export class AgentLoop {
    private provider: DirectZAIProvider;
    private executor: ToolExecutor;
    private eventBus: EventBus;
    private budgetTracker?: BudgetPort;
    private budgetCategory: BudgetCategory;
    private config: Required<AgentLoopConfig>;

    constructor(
        provider: DirectZAIProvider,
        executor: ToolExecutor,
        config?: AgentLoopConfig,
        eventBus?: EventBus,
        budgetTracker?: BudgetPort,
        budgetCategory?: BudgetCategory
    ) {
        this.provider = provider;
        this.executor = executor;
        this.eventBus = eventBus ?? globalEventBus;
        this.budgetTracker = budgetTracker;
        this.budgetCategory = budgetCategory ?? 'task';
        this.config = {
            maxIterations: config?.maxIterations ?? 20,
            systemPrompt: config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
            temperature: config?.temperature ?? 0.3,
            verbose: config?.verbose ?? false,
        };
    }

    /**
     * Run the agent with a prompt until completion or max iterations.
     * When `signal` aborts, in-flight provider chat is aborted and no new tools start.
     */
    async run(prompt: string, sessionId?: string, signal?: AbortSignal): Promise<AgentResult> {
        const startTime = Date.now();
        let totalToolCalls = 0;
        let totalTokens = 0;
        let totalCostUsd = 0;

        const throwIfAborted = () => {
            if (signal?.aborted) {
                const err = new Error("AgentLoop aborted");
                err.name = "AbortError";
                throw err;
            }
        };

        // Initialize message history
        const messages: Message[] = [
            { role: 'system', content: this.config.systemPrompt },
            { role: 'user', content: prompt },
        ];

        const tools = this.executor.getToolDefinitions();

        this.log('info', `Starting agent loop with prompt: "${prompt.substring(0, 50)}..."`);
        this.emitThought('reasoning', `Processing task: ${prompt.substring(0, 100)}...`);

        for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
            throwIfAborted();
            this.log('debug', `Iteration ${iteration + 1}/${this.config.maxIterations}`);

            // Call Z.AI (propagates abort to fetch)
            const response = await this.provider.chat(messages, tools, {
                temperature: this.config.temperature,
                signal,
            });

            if (response.usage) {
                totalTokens += response.usage.total_tokens;

                // Record usage in BudgetTracker
                if (this.budgetTracker) {
                    try {
                        const record = await this.budgetTracker.recordUsage({
                            sessionId,
                            model: this.provider.modelName ?? 'unknown',
                            promptTokens: response.usage.prompt_tokens,
                            completionTokens: response.usage.completion_tokens,
                            totalTokens: response.usage.total_tokens,
                            category: this.budgetCategory,
                        });
                        totalCostUsd += record.costUsd;
                    } catch (err) {
                        this.log('warn', `Failed to record budget usage: ${err}`);
                    }
                }
            }

            const choice = response.choices[0];
            if (!choice) {
                return {
                    success: false,
                    content: 'No response from model',
                    toolCallsCount: totalToolCalls,
                    totalTokens,
                    durationMs: Date.now() - startTime,
                };
            }

            // Add assistant message to history
            messages.push(choice.message);

            // Check if we need to execute tool calls
            if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
                const toolCalls = choice.message.tool_calls;
                totalToolCalls += toolCalls.length;

                this.log('info', `Executing ${toolCalls.length} tool call(s)`);

                // Execute each tool call — no new tools after abort
                for (const call of toolCalls) {
                    throwIfAborted();
                    this.log('debug', `Tool: ${call.function.name}`);
                    this.emitThought('tool_call', `Calling ${call.function.name}`, {
                        toolName: call.function.name,
                        args: call.function.arguments,
                    });

                    const result = await this.executor.execute(call);

                    this.emitThought('tool_result',
                        result.success
                            ? `${call.function.name} completed`
                            : `${call.function.name} failed: ${result.error}`,
                        { success: result.success, outputLength: result.output.length }
                    );

                    // Add tool result to messages
                    messages.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        content: result.success
                            ? result.output
                            : `Error: ${result.error}`,
                    });
                }

                // Continue the loop to let the model process tool results
                continue;
            }

            // No more tool calls - we're done
            if (choice.finish_reason === 'stop') {
                this.log('info', `Completed in ${iteration + 1} iteration(s), ${totalToolCalls} tool call(s)`);
                this.emitThought('decision', `Task completed successfully`, {
                    iterations: iteration + 1,
                    toolCalls: totalToolCalls,
                });

                return {
                    success: true,
                    content: choice.message.content ?? '',
                    toolCallsCount: totalToolCalls,
                    totalTokens,
                    estimatedCostUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
                    durationMs: Date.now() - startTime,
                };
            }

            // Handle other finish reasons
            if (choice.finish_reason === 'length') {
                this.log('warn', 'Response truncated due to length');
                return {
                    success: false,
                    content: choice.message.content ?? 'Response truncated',
                    toolCallsCount: totalToolCalls,
                    totalTokens,
                    durationMs: Date.now() - startTime,
                };
            }
        }

        // Max iterations reached
        this.log('error', 'Max iterations reached');
        return {
            success: false,
            content: 'Max iterations reached without completion',
            toolCallsCount: totalToolCalls,
            totalTokens,
            durationMs: Date.now() - startTime,
        };
    }

    /**
     * Get conversation history for debugging
     */
    getSystemPrompt(): string {
        return this.config.systemPrompt;
    }

    // ============================================================
    // Private
    // ============================================================

    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        if (this.config.verbose) {
            this.eventBus.log(level, message, 'AgentLoop');
        }
    }

    private emitThought(
        type: ThoughtEvent['type'],
        content: string,
        metadata?: Record<string, unknown>
    ): void {
        this.eventBus.emit('thought', {
            type,
            content,
            metadata,
            timestamp: new Date(),
        });
    }
}

// ============================================================
// Factory
// ============================================================

export interface CreateAgentOptions {
    apiKey?: string;
    workingDirectory: string;
    systemPrompt?: string;
    verbose?: boolean;
}

/**
 * Create a fully configured AgentLoop
 */
export function createAgent(options: CreateAgentOptions): AgentLoop {
    const provider = createDirectZAI({
        apiKey: options.apiKey,
        verbose: options.verbose,
    });

    const executor = createToolExecutor({
        workingDirectory: options.workingDirectory,
        verbose: options.verbose,
    });

    return new AgentLoop(provider, executor, {
        systemPrompt: options.systemPrompt,
        verbose: options.verbose,
    });
}
