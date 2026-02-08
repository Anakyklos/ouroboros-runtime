/**
 * 🎭 Ouroboros Workflow Engine
 *
 * Tipos para definição e execução de workflows complexos.
 * Workflows são DAGs (Directed Acyclic Graphs) de steps.
 */

export type AgentType = 'wyvern' | 'amphisbaena' | 'leviathan' | 'basilisk';
export type StepType = 'single' | 'wave';
export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowMetadata {
    author: string;
    tags: string[];
    estimatedDuration?: string;
    createdAt?: string;
    updatedAt?: string;
}

export interface WorkflowVariable {
    name: string;
    value: unknown;
    description?: string;
    required?: boolean;
}

export interface WorkflowStep {
    id: string;
    name: string;
    description?: string;
    agent: AgentType;
    type: StepType;
    dependsOn?: string[];
    prompt: string;
    output?: string;
    timeout?: number;
    retryCount?: number;
    retryBackoff?: number;
    onContinue?: string;
}

export interface WorkflowSuccessCondition {
    step: string;
    condition: string;
}

export interface WorkflowFailureHandler {
    notify: AgentType[];
    action: 'pause' | 'retry' | 'abort';
    maxRetries?: number;
}

export interface Workflow {
    name: string;
    version: string;
    description: string;
    meta: WorkflowMetadata;
    variables: WorkflowVariable[];
    steps: WorkflowStep[];
    success: WorkflowSuccessCondition[];
    onFailure?: WorkflowFailureHandler;
}

export interface WorkflowContext {
    variables: Record<string, unknown>;
    outputs: Record<string, unknown>;
    stepResults: Record<string, unknown>;
}

export interface StepExecutionResult {
    stepId: string;
    status: StepStatus;
    output?: unknown;
    error?: string;
    durationMs: number;
    retryCount: number;
}

export interface WorkflowExecutionResult {
    workflowName: string;
    status: WorkflowStatus;
    startTime: string;
    endTime?: string;
    durationMs: number;
    steps: StepExecutionResult[];
    context: WorkflowContext;
}
