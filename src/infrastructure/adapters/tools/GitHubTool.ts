import type { ITool } from "../../../core/ports/ITool";
import { z } from "zod";

export const GitHubArgsSchema = z.object({
    action: z.enum(["get_pr_diff", "post_pr_comment", "get_issue", "post_issue_comment"]).describe("The GitHub action to perform"),
    repo: z.string().describe("The repository name (e.g. 'owner/repo')"),
    number: z.number().describe("The PR or Issue number"),
    commentBody: z.string().optional().describe("The comment content, required if action is a post action")
});

export type GitHubArgs = z.infer<typeof GitHubArgsSchema>;

export class GitHubTool implements ITool {
    name = "github";
    description = "Interact with GitHub to read PR diffs, issues, and post comments.";
    schema = GitHubArgsSchema;

    private token: string;

    constructor(token?: string) {
        this.token = token || process.env.GITHUB_TOKEN || "";
    }

    async execute(args: GitHubArgs): Promise<string> {
        if (!this.token) {
            return "Error: GitHub action failed. No GITHUB_TOKEN provided or found in the environment.";
        }

        try {
            switch (args.action) {
                case "get_pr_diff":
                    return await this.getPRDiff(args.repo, args.number);
                case "get_issue":
                    return await this.getIssue(args.repo, args.number);
                case "post_pr_comment":
                case "post_issue_comment":
                    if (!args.commentBody) return "Error: commentBody is required for post actions.";
                    return await this.postComment(args.repo, args.number, args.commentBody);
                default:
                    return `Error: Unknown action ${args.action}`;
            }
        } catch (e: any) {
            return `GitHub API Error: ${e.message}`;
        }
    }

    private getHeaders() {
        return {
            "Accept": "application/vnd.github.v3+json",
            "Authorization": `Bearer ${this.token}`,
            "User-Agent": "Ouroboros-AutoClaude"
        };
    }

    private async getPRDiff(repo: string, prNumber: number): Promise<string> {
        const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
            headers: {
                ...this.getHeaders(),
                "Accept": "application/vnd.github.v3.diff"
            }
        });

        if (!response.ok) throw new Error(`Failed to fetch PR diff: ${response.statusText}`);
        return await response.text();
    }

    private async getIssue(repo: string, issueNumber: number): Promise<string> {
        const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
            headers: this.getHeaders()
        });

        if (!response.ok) throw new Error(`Failed to fetch issue: ${response.statusText}`);
        const data = await response.json() as any;
        return JSON.stringify({
            title: data.title,
            body: data.body,
            state: data.state,
            labels: data.labels.map((l: any) => l.name)
        }, null, 2);
    }

    private async postComment(repo: string, issueOrPrNumber: number, body: string): Promise<string> {
        // Both PRs and Issues share the same comment endpoint in GitHub API
        const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueOrPrNumber}/comments`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({ body })
        });

        if (!response.ok) throw new Error(`Failed to post comment: ${response.statusText}`);
        return `Comment posted successfully.`;
    }
}
