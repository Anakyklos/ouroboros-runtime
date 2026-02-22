import { ITool } from "../../../core/ports/ITool.js";
import { z } from "zod";
import { SandboxRunner, createSandboxRunner, type SandboxRunnerConfig, type SecurityViolation } from "./SandboxRunner.js";

export const SandboxArgsSchema = z.object({
    code: z.string().describe("Python code to execute in the sandbox"),
    timeoutMs: z.number().optional().describe("Execution timeout in milliseconds (default: 30000)"),
});

export type SandboxArgs = z.infer<typeof SandboxArgsSchema>;

/**
 * Enhanced error class for sandbox security violations
 */
export class SandboxSecurityError extends Error {
    public readonly violation: SecurityViolation;

    constructor(violation: SecurityViolation) {
        super(`Sandbox security violation: ${violation.message}`);
        this.name = 'SandboxSecurityError';
        this.violation = violation;
    }
}

export class SandboxTool implements ITool<SandboxArgs, string> {
    public readonly name = "sandbox";
    public readonly description = "Execute Python code safely in an isolated sandbox environment with resource limits and timeout enforcement.";
    public readonly schema = SandboxArgsSchema;

    private runner: SandboxRunner;

    constructor(config?: SandboxRunnerConfig) {
        this.runner = createSandboxRunner(config);

        // Listen for security violations
        this.runner.on('securityViolation', (violation: SecurityViolation) => {
            // Security violations are logged but not automatically thrown
            // They're already included in the execution result
        });
    }

    async execute(input: SandboxArgs): Promise<string> {
        try {
            // Ensure sandbox is started
            if (!this.runner.isAlive()) {
                await this.runner.start();
            }

            // Execute code with optional timeout override
            const result = await this.runner.execute(input.code, input.timeoutMs);

            // Check for security violations first
            if (result.error?.message.includes('security violation')) {
                const violations = this.runner.getSecurityViolations();
                if (violations.length > 0) {
                    throw new SandboxSecurityError(violations[violations.length - 1]);
                }
            }

            if (!result.success) {
                // Enhanced error reporting with security context
                const violations = this.runner.getSecurityViolations();
                const hasSecurityIssues = violations.length > 0;

                throw new Error(
                    `Sandbox execution failed (exit code: ${result.exitCode})${hasSecurityIssues ? ' [SECURITY]' : ''}\n` +
                    `STDOUT:\n${result.stdout || '(empty)'}\n` +
                    `STDERR:\n${result.stderr || '(empty)'}${
                        hasSecurityIssues ? `\nSecurity violations: ${violations.length} detected` : ''
                    }`
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
            if (error instanceof SandboxSecurityError) {
                // Re-throw security errors as-is
                throw error;
            }
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
     * Get all security violations recorded during this session
     */
    getSecurityViolations(): SecurityViolation[] {
        return this.runner.getSecurityViolations();
    }

    /**
     * Clear security violation history
     */
    clearSecurityViolations(): void {
        this.runner.clearSecurityViolations();
    }

    /**
     * Stop the sandbox and clean up resources
     */
    async dispose(): Promise<void> {
        await this.runner.stop();
    }
}
