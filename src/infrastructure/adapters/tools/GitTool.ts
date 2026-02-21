import { ITool } from "../../../core/ports/ITool";
import { z } from "zod";

export const GitArgsSchema = z.object({
    command: z.string().describe("Git command to execute (e.g., 'status', 'add .', 'commit -m \"msg\"')"),
    cwd: z.string().optional().describe("Working directory to execute the command in"),
});

export type GitArgs = z.infer<typeof GitArgsSchema>;

export class GitTool implements ITool<GitArgs, string> {
    public readonly name = "git";
    public readonly description = "Execute git commands using Bun.spawn.";
    public readonly schema = GitArgsSchema;

    async execute(input: GitArgs): Promise<string> {
        // Basic argument parsing, robust implementations might use shlex-like parsing
        const args = ["git", ...input.command.split(" ").filter(s => s.trim() !== '')];

        // Bun.spawn usage
        const proc = Bun.spawn(args, {
            cwd: input.cwd || process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
        });

        await proc.exited;

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = proc.exitCode;

        if (exitCode !== 0) {
            throw new Error(`Git command failed with exit code ${exitCode}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
        }

        return stdout || stderr || "Success";
    }
}
