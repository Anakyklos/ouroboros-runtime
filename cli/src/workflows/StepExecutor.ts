/**
 * 🎬 StepExecutor
 *
 * Executa steps individuais (single ou wave).
 * Conecta ao Ouroboros Daemon via HTTP.
 */

import type {
    WorkflowStep,
    StepStatus,
    AgentType,
} from './types/workflow-types.js';
import type { VariableStore } from './VariableStore.js';

export interface StepExecutionConfig {
    daemonUrl: string;
    timeoutMs: number;
    verbose: boolean;
}

export interface StepExecutionResult {
    stepId: string;
    status: StepStatus;
    output?: unknown;
    error?: string;
    durationMs: number;
    retryCount: number;
}

export class StepExecutor {
    private config: StepExecutionConfig;

    constructor(config: Partial<StepExecutionConfig> = {}) {
        this.config = {
            daemonUrl: config.daemonUrl || 'http://127.0.0.1:7777/rpc',
            timeoutMs: config.timeoutMs || 300000,
            verbose: config.verbose || false,
        };
    }

    async execute(
        step: WorkflowStep,
        variableStore: VariableStore
    ): Promise<StepExecutionResult> {
        const startTime = Date.now();
        let retryCount = 0;
        const maxRetries = step.retryCount || 0;

        while (retryCount <= maxRetries) {
            try {
                const result = await this.executeOnce(step, variableStore);
                return {
                    stepId: step.id,
                    status: result.status,
                    output: result.output,
                    error: result.error,
                    durationMs: Date.now() - startTime,
                    retryCount,
                };
            } catch (error) {
                retryCount++;

                if (retryCount > maxRetries) {
                    return {
                        stepId: step.id,
                        status: 'failed',
                        error: error instanceof Error ? error.message : String(error),
                        durationMs: Date.now() - startTime,
                        retryCount: retryCount - 1,
                    };
                }

                const backoffMs = step.retryBackoff || 1000 * retryCount;
                this.log(`Step ${step.id} failed, retrying in ${backoffMs}ms...`);
                await this.sleep(backoffMs);
            }
        }

        throw new Error('Should not reach here');
    }

    private async executeOnce(
        step: WorkflowStep,
        variableStore: VariableStore
    ): Promise<StepExecutionResult> {
        const prompt = variableStore.substitute(step.prompt);

        const agent = this.mapAgentType(step.agent);
        const stepType = step.type || 'single';

        if (stepType === 'wave') {
            return this.executeWave(step, prompt);
        } else {
            return this.executeSingle(step, agent, prompt);
        }
    }

    private async executeSingle(
        step: WorkflowStep,
        agent: string,
        prompt: string
    ): Promise<StepExecutionResult> {
        this.log(`Executing step: ${step.id} (${step.type}) via ${agent}`);

        const request = {
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'daemon.delegate',
            params: {
                agent,
                prompt,
            },
        };

        const response = await this.callDaemon(request);
        const result = response.result as { result: unknown };

        if (!result.result) {
            throw new Error('No result returned from daemon');
        }

        const daemonResult = result.result as { success?: boolean; content?: string };

        return {
            stepId: step.id,
            status: daemonResult.success !== false ? 'completed' : 'failed',
            output: step.output ? { [step.output]: daemonResult.content } : daemonResult.content,
            error: daemonResult.success === false ? daemonResult.content : undefined,
            durationMs: 0,
            retryCount: 0,
        };
    }

    private async executeWave(
        step: WorkflowStep,
        prompt: string
    ): Promise<StepExecutionResult> {
        const wavePrompt = `WAVE: ${prompt}`;

        this.log(`Executing wave step: ${step.id} (${step.type}) via ${step.agent}`);

        const request = {
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'daemon.delegate',
            params: {
                agent: step.agent,
                prompt: wavePrompt,
            },
        };

        const response = await this.callDaemon(request);
        const result = response.result as { result: unknown };

        if (!result.result) {
            throw new Error('No result returned from daemon');
        }

        const waveResult = result.result as { waveExecution?: { success: boolean } };

        return {
            stepId: step.id,
            status: waveResult.waveExecution?.success !== false ? 'completed' : 'failed',
            output: step.output ? { [step.output]: waveResult } : waveResult,
            error: waveResult.waveExecution?.success === false ? 'Wave execution failed' : undefined,
            durationMs: 0,
            retryCount: 0,
        };
    }

    private async callDaemon(request: Record<string, unknown>): Promise<Record<string, unknown>> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

        try {
            const response = await fetch(this.config.daemonUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(request),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Daemon returned status ${response.status}`);
            }

            const data = await response.json() as Record<string, unknown>;

            if (data.error) {
                throw new Error(`Daemon error: ${JSON.stringify(data.error)}`);
            }

            return data;
        } catch (error) {
            clearTimeout(timeoutId);

            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Step execution timed out after ${this.config.timeoutMs}ms`);
            }

            throw error;
        }
    }

    private mapAgentType(agent: AgentType): string {
        const mapping: Record<AgentType, string> = {
            wyvern: 'claude',
            amphisbaena: 'gemini',
            leviathan: 'glm',
            basilisk: 'jules',
        };

        return mapping[agent] || agent;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private log(message: string): void {
        if (this.config.verbose) {
            console.log(`[StepExecutor] ${message}`);
        }
    }
}

export function createStepExecutor(
    config?: Partial<StepExecutionConfig>
): StepExecutor {
    return new StepExecutor(config);
}
