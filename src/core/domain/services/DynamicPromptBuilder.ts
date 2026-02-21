import { ITool } from "../../ports/ITool";

export interface BuildPromptOptions {
    basePrompt: string;
    tools: ITool[];
    context?: Record<string, string>;
    projectType?: string; // e.g. "React", "Electron", "CLI"
}

/**
 * Service to dynamically build the System Prompt for the OuroborosAgent.
 * Unifies ideas from 'oh-my-opencode' (injecting available skills/tools dynamically)
 * and 'Auto-Claude' (injecting project-specific context).
 */
export class DynamicPromptBuilder {

    /**
     * Builds the final system prompt by merging the base persona prompt with dynamic environmental data.
     */
    public buildSystemPrompt(options: BuildPromptOptions): string {
        let finalPrompt = options.basePrompt;

        // 1. Inject Project Context if provided
        if (options.context && Object.keys(options.context).length > 0) {
            const contextSection = this.buildContextSection(options.context);
            finalPrompt = `${contextSection}\n\n---\n\n${finalPrompt}`;
        }

        // 2. Inject Built-in and Custom Tools
        if (options.tools && options.tools.length > 0) {
            const toolsSection = this.buildToolsSection(options.tools);
            finalPrompt = `${finalPrompt}\n\n---\n\n${toolsSection}`;
        }

        // 3. Inject Project Type rules if applicable
        if (options.projectType) {
            const rulesSection = this.buildProjectRulesSection(options.projectType);
            finalPrompt = `${finalPrompt}\n\n---\n\n${rulesSection}`;
        }

        return finalPrompt;
    }

    private buildContextSection(context: Record<string, string>): string {
        let section = `## EXECUTION CONTEXT\n\n`;
        for (const [key, value] of Object.entries(context)) {
            section += `- **${key}**: ${value}\n`;
        }
        return section;
    }

    private buildToolsSection(tools: ITool[]): string {
        let section = `## DYNAMIC TOOLSET CAPABILITIES\n\n`;
        section += `You have been equipped with the following specific tools for this session. You must prefer using these over general commands when applicable.\n\n`;

        for (const tool of tools) {
            section += `### \`${tool.name}\`\n`;
            section += `${tool.description}\n\n`;

            // Special guidance inherited from OpenCode's HashlineEdit
            if (tool.name === 'hashline_edit') {
                section += `> **CRITICAL**: Before using \`hashline_edit\`, you MUST read the target file first to obtain the LINE#ID hashes. Do not guess the hashes.\n\n`;
            }
        }

        return section;
    }

    private buildProjectRulesSection(projectType: string): string {
        let section = `## PROJECT SPECIFIC RULES: ${projectType}\n\n`;

        switch (projectType.toLowerCase()) {
            case 'react':
            case 'nextjs':
            case 'electron':
                section += `- **UI Verification REQUIRED**: Any changes to frontend components MUST be visually verified if possible.\n`;
                break;
            case 'api':
                section += `- **API Verification REQUIRED**: Any changes to endpoints must be verified with curl or automated tests.\n`;
                break;
            default:
                section += `- **Standard Verification**: Ensure all code compiles and unit tests pass.\n`;
        }

        return section;
    }
}
