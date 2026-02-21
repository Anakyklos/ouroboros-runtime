import { HashlineEditTool } from "../../infrastructure/adapters/tools/HashlineEditTool";

import { OuroborosAgent, OuroborosAgentOptions } from "../../OuroborosAgent";

/**
 * Automates deep, autonomous code adjustments using the Hephaestus persona.
 */
export class HephaestusWorkerWorkflow {
    private baseOptions: Omit<OuroborosAgentOptions, 'config'>;

    constructor(options: typeof this.baseOptions) {
        this.baseOptions = options;
    }

    /**
     * Triggers the Hephaestus deep execution process.
     * @param objective The primary goal that Hephaestus needs to accomplish.
     * @param taskList Specific breakdown of tasks provided by Sisyphus.
     */
    async executeDeepWork(objective: string, taskList: string[]): Promise<string> {
        console.log(`[HephaestusWorkerWorkflow] Initializing deep work. Objective: ${objective}`);

        const agent = new OuroborosAgent({
            ...this.baseOptions,
            config: {
                agent_type: "hephaestus" as any,
                model: "claude-3-5-sonnet-20241022",
                max_iterations: 30, // Hephaestus runs deeper
                tools_enabled: ["file_system", "shell"]
            },
            customTools: [
                new HashlineEditTool(),
                ...(this.baseOptions.customTools || [])
            ]
        });

        const taskDescription = `Complete the following objective end-to-end without stopping for permission. 
Objective: ${objective}
Tasks: 
${taskList.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Important: You MUST use the hashline_edit tool to read files with hashes before applying any localized edits.`;

        const result = await agent.executeTask(taskDescription);

        return result;
    }
}
