/**
 * 🔌 Agent Port
 * 
 * Interface para execução de agentes.
 * Abstrai o provider (DirectZAI, etc) do core.
 */

export interface AgentInput {
    prompt: string;
    sessionId: string;
    context?: string;
}

export interface AgentOutput {
    success: boolean;
    output: string;
    error?: string;
    executionTimeMs: number;
}

export interface AgentPort {
    execute(input: AgentInput): Promise<AgentOutput>;
    interrupt(sessionId: string): Promise<void>;
    isRunning(sessionId: string): boolean;
}
