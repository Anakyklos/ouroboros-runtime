import type { OuroborosAgentOptions } from "../../OuroborosAgent";
import { OuroborosAgent } from "../../OuroborosAgent";
import { WebSearchTool } from "../../infrastructure/adapters/tools/WebSearchTool";
import { GitHubTool } from "../../infrastructure/adapters/tools/GitHubTool";

/**
 * Automates the Issue Triage loop using the Auto-Claude Issue Triager persona.
 */
export class IssueTriagerWorkflow {
    private baseOptions: Omit<OuroborosAgentOptions, 'config'>;

    constructor(options: typeof this.baseOptions) {
        this.baseOptions = options;
    }

    /**
     * Triggers the Issue triage process for a given repository and Issue number.
     * @param repo The repository in 'owner/repo' format.
     * @param issueNumber The Issue number on GitHub.
     */
    async triageIssue(repo: string, issueNumber: number): Promise<string> {
        console.log(`[IssueTriagerWorkflow] Initializing Triager for ${repo}#${issueNumber}`);

        const agent = new OuroborosAgent({
            ...this.baseOptions,
            config: {
                agent_type: "github_issue_triager" as any,
                model: "claude-3-5-sonnet-20241022",
                max_iterations: 8,
                tools_enabled: ["file_system", "shell", "github", "web_search"]
            },
            customTools: [new GitHubTool(), new WebSearchTool()]
        });

        const taskDescription = `Triage issue #${issueNumber} for the repository '${repo}'.
1. Use the github tool to fetch the issue details (title, body, labels).
2. Read the body carefully to understand the context. Use web search or local file system if needed to trace where the bug or feature request lies.
3. Formulate an initial response identifying the likely root cause or necessary code changes.
4. Use the github tool to post this initial assessment comment back to the issue.`;

        const result = await agent.executeTask(taskDescription, {
            "Target Issue": issueNumber.toString(),
            "Target Repo": repo
        });

        return result;
    }
}
