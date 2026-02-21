import { OuroborosAgent, OuroborosAgentOptions } from "../../OuroborosAgent";

/**
 * Automates intent-gating and orchestration using the Sisyphus persona.
 */
export class SisyphusOrchestratorWorkflow {
    private baseOptions: Omit<OuroborosAgentOptions, 'config'>;

    constructor(options: typeof this.baseOptions) {
        this.baseOptions = options;
    }

    /**
     * Triggers the Sisyphus orchestration process.
     * @param userPrompt The initial request or goal from the user.
     * @param projectContext Context about the project to help Sisyphus understand the scope.
     */
    async orchestrate(userPrompt: string, projectContext: string): Promise<string> {
        console.log(`[SisyphusOrchestratorWorkflow] Analyzing intent for: ${userPrompt}`);

        const agent = new OuroborosAgent({
            ...this.baseOptions,
            config: {
                agent_type: "sisyphus" as any,
                model: "claude-3-5-sonnet-20241022",
                max_iterations: 15,
                tools_enabled: ["file_system", "shell"]
            }
        });

        const taskDescription = `Analyze the following user prompt to determine its true intent (Code Modification, Knowledge Query, etc.). Break down the necessary work into atomic sub-tasks.
User Prompt: ${userPrompt}`;

        const result = await agent.executeTask(taskDescription, {
            "Project Context": projectContext
        });

        return result;
    }
}
