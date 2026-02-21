import { ILLMProvider, LLMMessage, ITool, IPromptManager } from "../ports";
import { AgentConfig } from "./schemas";
import { ResponseParser } from "./ResponseParser";
import { DynamicPromptBuilder } from "./services/DynamicPromptBuilder";

export class AgentLoop {
    private config: AgentConfig;
    private llm: ILLMProvider;
    private promptManager: IPromptManager;
    private tools: ITool[];
    private conversationHistory: LLMMessage[] = [];

    constructor(
        config: AgentConfig,
        llm: ILLMProvider,
        promptManager: IPromptManager,
        tools: ITool[]
    ) {
        this.config = config;
        this.llm = llm;
        this.promptManager = promptManager;

        // Filter tools based on config
        this.tools = tools.filter(t => this.config.tools_enabled.includes(t.name));
    }

    async run(taskDescription: string, initialContext: Record<string, string>): Promise<string> {
        // Render the initial prompt
        const baseSystemPrompt = await this.promptManager.renderPrompt(this.config.agent_type, initialContext);

        // Enhance prompt with dynamic context and tools
        const promptBuilder = new DynamicPromptBuilder();
        const systemPromptContent = promptBuilder.buildSystemPrompt({
            basePrompt: baseSystemPrompt,
            tools: this.tools,
            context: initialContext,
            // projectType could be injected here if analyzing the repository
        });

        // Set system message
        this.conversationHistory = [
            { role: "system", content: systemPromptContent },
            { role: "user", content: taskDescription }
        ];

        let currentIteration = 0;
        const maxIterations = this.config.max_iterations;

        while (currentIteration < maxIterations) {
            // PERCEIVE & THINK
            const response = await this.llm.chat(this.conversationHistory, this.tools.length > 0 ? this.tools : undefined);

            this.conversationHistory.push({
                role: "assistant",
                content: response.content
            });

            // ACT
            if (response.toolCalls && response.toolCalls.length > 0) {
                // We have tools to execute
                const toolResults = await ResponseParser.executeToolCalls(response.toolCalls, this.tools);

                // Add tool results to context
                this.conversationHistory.push({
                    role: "user",
                    content: `Tool executions completed. Results:\n${toolResults.join("\n\n")}\nPlease continue.`
                });
            } else {
                // No tools called, agent has finished (assuming text output is final answer)
                return response.content;
            }

            currentIteration++;
        }

        throw new Error(`AgentLoop hit maximum iterations (${maxIterations})`);
    }
}
