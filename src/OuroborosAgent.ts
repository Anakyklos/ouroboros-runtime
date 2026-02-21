import { AgentConfig } from "./core/domain/schemas/agent";
import { AgentLoop } from "./core/domain/AgentLoop";
import { IPromptManager, ILLMProvider, ITool } from "./core/ports";
import { RecoveryManager } from "./core/domain/services/RecoveryManager";
import { type BaseMessage, HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { FileSystemTool, GitTool, ShellTool } from "./infrastructure/adapters/tools";
import { PromptManager } from "./infrastructure/adapters/prompts/PromptManager";

export interface OuroborosAgentOptions {
    config: AgentConfig;
    llm: ILLMProvider;
    promptsDir?: string;
    customTools?: ITool[];
}

/**
 * Public Facade class for exposing unified agent functionality to the Ouroboros runtime.
 * This class orchestrates the underlying LangChain-based AgentLoop.
 */
export class OuroborosAgent {
    private agentLoop: AgentLoop;

    constructor(options: OuroborosAgentOptions) {
        // Default PromptManager points to the native prompts directory
        const promptManager = new PromptManager(options.promptsDir || "./src/prompts");

        // Core Ouroboros-native tools
        const defaultTools = [
            new FileSystemTool(),
            new GitTool(),
            new ShellTool()
        ];

        // Merge default and custom tools
        const allTools = [...defaultTools, ...(options.customTools || [])];

        this.agentLoop = new AgentLoop(
            options.config,
            options.llm,
            promptManager,
            allTools
        );
    }

    /**
     * Executes a task using the agent loop.
     * @param taskDescription The instruction or objective.
     * @param context Initial variables to inject into the system prompt.
     * @returns The final response from the agent.
     */
    async executeTask(taskDescription: string, context: Record<string, string> = {}): Promise<string> {
        return await this.agentLoop.run(taskDescription, context);
    }
}
