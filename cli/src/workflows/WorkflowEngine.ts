/**
 * 🎭 WorkflowEngine
 *
 * Orquestra execução de workflows complexos.
 * Resolve DAG de dependências e executa steps em ordem correta.
 */

import type {
    Workflow,
    WorkflowStatus,
    WorkflowContext,
    WorkflowStep,
    StepExecutionResult,
    WorkflowExecutionResult,
} from './types/workflow-types.js';
import { WorkflowParser } from './WorkflowParser.js';
import { VariableStore } from './VariableStore.js';
import { StepExecutor, type StepExecutionConfig } from './StepExecutor.js';

export interface WorkflowEngineConfig {
    daemonUrl: string;
    timeoutMs: number;
    verbose: boolean;
}

export class WorkflowEngine {
    private config: WorkflowEngineConfig;
    private executor: StepExecutor;

    constructor(config: Partial<WorkflowEngineConfig> = {}) {
        this.config = {
            daemonUrl: config.daemonUrl || 'http://127.0.0.1:7777/rpc',
            timeoutMs: config.timeoutMs || 300000,
            verbose: config.verbose || false,
        };

        const executorConfig: Partial<StepExecutionConfig> = {
            daemonUrl: this.config.daemonUrl,
            timeoutMs: this.config.timeoutMs,
            verbose: this.config.verbose,
        };

        this.executor = new StepExecutor(executorConfig);
    }

    async execute(
        workflow: Workflow,
        initialVariables: Record<string, unknown> = {}
    ): Promise<WorkflowExecutionResult> {
        const startTime = new Date().toISOString();
        let status: WorkflowStatus = 'running';

        const startTimeMs = Date.now();

        try {
            const variableStore = WorkflowParser.createVariableStore(workflow, initialVariables);

            const substitutedWorkflow = WorkflowParser.substituteVariables(
                workflow,
                initialVariables
            );

            const orderedSteps = this.resolveExecutionOrder(substitutedWorkflow);

            this.log(`🎭 Executing workflow: ${workflow.name}`);
            this.log(`   Steps: ${orderedSteps.length}`);
            this.log(`   Variables: ${Object.keys(initialVariables).join(', ') || 'none'}`);

            const stepResults: StepExecutionResult[] = [];
            const failedStepIds: string[] = [];

            for (const step of orderedSteps) {
                const shouldSkip = failedStepIds.some(failed =>
                    step.dependsOn?.includes(failed)
                );

                if (shouldSkip) {
                    this.log(`⏭️ Skipping step: ${step.id} (dependency failed)`);
                    stepResults.push({
                        stepId: step.id,
                        status: 'skipped',
                        durationMs: 0,
                        retryCount: 0,
                    });
                    continue;
                }

                this.log(`▶️ Executing step: ${step.id}`);
                const result = await this.executor.execute(step, variableStore);
                stepResults.push(result);

                if (result.output && step.output) {
                    variableStore.setOutput(step.id, step.output, result.output);
                }

                variableStore.setStepResult(step.id, result);

                if (result.status === 'failed') {
                    failedStepIds.push(step.id);
                    this.log(`❌ Step failed: ${step.id} - ${result.error}`);

                    if (workflow.onFailure?.action === 'abort') {
                        this.log(`🛑 Aborting workflow due to step failure`);
                        status = 'failed';
                        break;
                    }
                } else if (step.onContinue) {
                    this.log(`🔄 Executing onContinue: ${step.onContinue}`);
                }
            }

            const success = this.checkSuccessConditions(workflow, stepResults);
            status = success ? 'completed' : 'failed';

            const durationMs = Date.now() - startTimeMs;

            return {
                workflowName: workflow.name,
                status,
                startTime,
                endTime: new Date().toISOString(),
                durationMs,
                steps: stepResults,
                context: variableStore.getContext(),
            };
        } catch (error) {
            const durationMs = Date.now() - startTimeMs;

            return {
                workflowName: workflow.name,
                status: 'failed',
                startTime,
                endTime: new Date().toISOString(),
                durationMs,
                steps: [],
                context: { variables: {}, outputs: {}, stepResults: {} },
            };
        }
    }

    private resolveExecutionOrder(workflow: Workflow): WorkflowStep[] {
        const steps = workflow.steps;
        const inDegree = new Map<string, number>();
        const adjacency = new Map<string, string[]>();
        const stepMap = new Map<string, WorkflowStep>();

        for (const step of steps) {
            stepMap.set(step.id, step);
            inDegree.set(step.id, 0);
            adjacency.set(step.id, []);
        }

        for (const step of steps) {
            for (const dep of step.dependsOn || []) {
                adjacency.get(dep)?.push(step.id);
                inDegree.set(step.id, (inDegree.get(step.id) || 0) + 1);
            }
        }

        const queue: WorkflowStep[] = [];
        for (const [stepId, degree] of inDegree) {
            if (degree === 0) {
                queue.push(stepMap.get(stepId)!);
            }
        }

        const result: WorkflowStep[] = [];
        while (queue.length > 0) {
            const step = queue.shift()!;
            result.push(step);

            for (const dependent of adjacency.get(step.id) || []) {
                inDegree.set(dependent, (inDegree.get(dependent) || 0) - 1);
                if (inDegree.get(dependent) === 0) {
                    queue.push(stepMap.get(dependent)!);
                }
            }
        }

        if (result.length !== steps.length) {
            throw new Error('Circular dependency detected in workflow');
        }

        return result;
    }

    private checkSuccessConditions(
        workflow: Workflow,
        stepResults: StepExecutionResult[]
    ): boolean {
        if (workflow.success.length === 0) {
            const allSucceeded = stepResults.every(r => r.status === 'completed');
            return allSucceeded;
        }

        for (const condition of workflow.success) {
            const stepResult = stepResults.find(r => r.stepId === condition.step);

            if (!stepResult) {
                this.log(`⚠️ Step not found: ${condition.step}`);
                return false;
            }

            if (stepResult.status !== 'completed') {
                this.log(`⚠️ Step failed: ${condition.step}`);
                return false;
            }

            try {
                const evalResult = this.evaluateCondition(condition.condition, stepResult);
                if (!evalResult) {
                    this.log(`⚠️ Condition failed: ${condition.condition}`);
                    return false;
                }
            } catch (error) {
                this.log(`⚠️ Error evaluating condition: ${error}`);
                return false;
            }
        }

        return true;
    }

    private evaluateCondition(condition: string, stepResult: StepExecutionResult): boolean {
        if (condition === "result.success == true") {
            return stepResult.status === 'completed';
        }

        return false;
    }

    private log(message: string): void {
        if (this.config.verbose) {
            console.log(`[WorkflowEngine] ${message}`);
        }
    }
}

export function createWorkflowEngine(
    config?: Partial<WorkflowEngineConfig>
): WorkflowEngine {
    return new WorkflowEngine(config);
}
