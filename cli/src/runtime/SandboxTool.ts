import { ITool } from "../../../core/ports/ITool";
import { z } from "zod";
import { SandboxRunner, createSandboxRunner, type SandboxRunnerConfig } from "./SandboxRunner.js";

export const SandboxArgsSchema = z.object({
    code: z.string().describe("Python code to execute in the sandbox"),
    timeoutMs: z.number().optional().describe("Execution timeout in milliseconds (default: 30000)"),
});

export type SandboxArgs = z.infer<typeof SandboxArgsSchema>;

export class SandboxTool implements ITool<SandboxArgs, string> {
    public readonly name = "sandbox";
    public readonly description = "Execute Python code safely in an isolated sandbox environment with resource limits and timeout enforcement.";
    public readonly schema = SandboxArgsSchema;

    private runner: SandboxRunner;

    constructor(config?: SandboxRunnerConfig) {
        this.runner = createSandboxRunner(config);
    }

    async execute(input: SandboxArgs): Promise<string> {
        try {
            // Ensure sandbox is started
            if (!this.runner.isAlive()) {
                await this.runner.start();
            }

            // Execute code with optional timeout override
            const result = await this.runner.execute(input.code, input.timeoutMs);

            if (!result.success) {
                throw new Error(
                    `Sandbox execution failed (exit code: ${result.exitCode})\n` +
                    `STDOUT:\n${result.stdout}\n` +
                    `STDERR:\n${result.stderr}`
                );
            }

            // Return formatted output
            const output = [];
            if (result.stdout) {
                output.push(result.stdout);
            }
            if (result.stderr) {
                output.push(`Stderr: ${result.stderr}`);
            }
            output.push(`Execution completed in ${result.durationMs}ms`);

            return output.join('\n');
        } catch (error) {
            if (error instanceof Error) {
                throw error;
            }
            throw new Error(`Sandbox execution error: ${String(error)}`);
        }
    }

    /**
     * Get the underlying SandboxRunner instance for advanced usage
     */
    getRunner(): SandboxRunner {
        return this.runner;
    }

    /**
     * Stop the sandbox and clean up resources
     */
    async dispose(): Promise<void> {
        await this.runner.stop();
    }
}
