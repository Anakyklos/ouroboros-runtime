import type { OuroborosAgentOptions } from "../../OuroborosAgent";
import { OuroborosAgent } from "../../OuroborosAgent";
import { FileSystemTool } from "../../infrastructure/adapters/tools/FileSystemTool";
import { ShellTool } from "../../infrastructure/adapters/tools/ShellTool";
import { GitHubTool } from "../../infrastructure/adapters/tools/GitHubTool";

/**
 * Automates the PR Review loop using the Auto-Claude PR Orchestrator persona.
 */
export class PRAgentWorkflow {
    private baseOptions: Omit<OuroborosAgentOptions, 'config'>;

    constructor(options: typeof this.baseOptions) {
        this.baseOptions = options;
    }

    /**
     * Triggers the PR review process for a given repository and PR number.
     * @param repo The repository in 'owner/repo' format.
     * @param prNumber The Pull Request number on GitHub.
     */
    async reviewPullRequest(repo: string, prNumber: number): Promise<string> {
        console.log(`[PRAgentWorkflow] Initializing PR Review for ${repo}#${prNumber}`);

        const agent = new OuroborosAgent({
            ...this.baseOptions,
            config: {
                agent_type: "github_pr_reviewer" as any,
                model: "claude-3-5-sonnet-20241022",
                max_iterations: 10,
                tools_enabled: ["file_system", "shell", "github"]
            },
            customTools: [new FileSystemTool(), new ShellTool(), new GitHubTool()]
        });

        // The system prompt logic for github_pr_reviewer will expect context on the PR it should audit.
        const taskDescription = `Perform a comprehensive code review on PR #${prNumber} for the repository '${repo}'.
1. Use the github tool to fetch the PR diff.
2. Analyze the changes. If needed, explore the local file system to understand the context.
3. Once your review is complete, use the github tool to post your final review comment back to the PR.`;

        const result = await agent.executeTask(taskDescription, {
            "Target PR": prNumber.toString(),
            "Target Repo": repo
        });

        return result;
    }
}
