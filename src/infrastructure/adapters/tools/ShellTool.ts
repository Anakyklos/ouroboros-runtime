import { ITool } from "../../../core/ports/ITool";
import { z } from "zod";

export const ShellArgsSchema = z.object({
    command: z.string().describe("Shell command to execute"),
    cwd: z.string().optional().describe("Working directory for the command"),
});

export type ShellArgs = z.infer<typeof ShellArgsSchema>;

export class ShellTool implements ITool<ShellArgs, string> {
    public readonly name = "shell";
    public readonly description = "Execute shell commands safely using Bun.spawn.";
    public readonly schema = ShellArgsSchema;

    async execute(input: ShellArgs): Promise<string> {
        const proc = Bun.spawn(["sh", "-c", input.command], {
            cwd: input.cwd || process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
        });

        await proc.exited;

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();

        if (proc.exitCode !== 0) {
            throw new Error(`Command failed with code ${proc.exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
        }

        return stdout || (stderr ? `Command completed with exit code 0. (Stderr: ${stderr})` : 'Success');
    }
}
