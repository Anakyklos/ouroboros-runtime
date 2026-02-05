/**
 * 🔬 Command Validation Strategy
 * 
 * Estratégia de validação que executa um comando shell e valida pelo exit code.
 * Segue protocolo Anti-Vibe: "Trust but Verify" - não confia no output do LLM,
 * valida programaticamente via execução real.
 * 
 * Inspirado em:
 * - OpenClaw/ClawedBot: validação objetiva por execução
 * - Pickle Rickle: loops de auto-refinamento
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ValidationStrategy, ValidationContext, ValidationResult } from "../types.js";

const execAsync = promisify(exec);

/**
 * Padrões de secrets a mascarar no output.
 * Previne vazamento de tokens/chaves nos logs.
 */
const SECRET_PATTERNS = [
    /ghp_[a-zA-Z0-9]{36}/g,           // GitHub PAT
    /sk-[a-zA-Z0-9]{48}/g,            // OpenAI API keys
    /Bearer\s+[a-zA-Z0-9._-]+/gi,     // Bearer tokens
    /password[=:]\s*\S+/gi,           // Passwords
    /api[_-]?key[=:]\s*\S+/gi,        // API keys genéricos
];

/**
 * Mascara secrets no output para evitar vazamentos.
 */
function sanitizeOutput(output: string): string {
    let sanitized = output;
    for (const pattern of SECRET_PATTERNS) {
        sanitized = sanitized.replace(pattern, "[REDACTED]");
    }
    return sanitized;
}

/**
 * Estratégia que valida executando um comando shell.
 * Sucesso = exit code 0.
 * 
 * @example
 * ```ts
 * const strategy = new CommandValidationStrategy("bun test");
 * const result = await strategy.validate({ workDir: "./project", taskId: "task-1", output: "" });
 * console.log(result.isValid); // true se exit code 0
 * ```
 */
export class CommandValidationStrategy implements ValidationStrategy {
    readonly name: string;
    private command: string;
    private timeoutMs: number;

    constructor(command: string, timeoutMs = 30000) {
        this.command = command;
        this.timeoutMs = timeoutMs;
        this.name = `CommandValidation(${command})`;
    }

    async validate(context: ValidationContext): Promise<ValidationResult> {
        const startTime = Date.now();

        try {
            const { stdout, stderr } = await execAsync(this.command, {
                cwd: context.workDir,
                timeout: this.timeoutMs,
                env: {
                    ...process.env,
                    // Previne output colorido que pode confundir parsing
                    FORCE_COLOR: "0",
                    NO_COLOR: "1",
                },
            });

            const durationMs = Date.now() - startTime;
            const sanitizedStdout = sanitizeOutput(stdout);
            const sanitizedStderr = sanitizeOutput(stderr);

            return {
                isValid: true,
                exitCode: 0,
                message: sanitizedStdout || "Validation passed.",
                details: {
                    command: this.command,
                    workDir: context.workDir,
                    durationMs,
                    stdout: sanitizedStdout,
                    stderr: sanitizedStderr,
                },
            };
        } catch (error: unknown) {
            const durationMs = Date.now() - startTime;
            const execError = error as {
                code?: number;
                stderr?: string;
                stdout?: string;
                killed?: boolean;
                signal?: string;
            };

            // Timeout detectado
            if (execError.killed && execError.signal === "SIGTERM") {
                return {
                    isValid: false,
                    exitCode: 124, // Standard timeout exit code
                    message: `Command timed out after ${this.timeoutMs}ms`,
                    details: {
                        command: this.command,
                        workDir: context.workDir,
                        durationMs,
                        timedOut: true,
                    },
                };
            }

            const sanitizedStderr = sanitizeOutput(execError.stderr || "");
            const sanitizedStdout = sanitizeOutput(execError.stdout || "");

            return {
                isValid: false,
                exitCode: execError.code ?? 1,
                message: sanitizedStderr || sanitizedStdout || String(error),
                details: {
                    command: this.command,
                    workDir: context.workDir,
                    durationMs,
                    stdout: sanitizedStdout,
                    stderr: sanitizedStderr,
                },
            };
        }
    }
}

// --- FACTORIES ---

/**
 * Factory para criar estratégia de testes com bun.
 */
export function createTestValidationStrategy(): CommandValidationStrategy {
    return new CommandValidationStrategy("bun test", 60000);
}

/**
 * Factory para criar estratégia de type-check com bun.
 */
export function createTypeCheckValidationStrategy(): CommandValidationStrategy {
    return new CommandValidationStrategy("bun run typecheck", 30000);
}

/**
 * Factory para criar estratégia de lint.
 */
export function createLintValidationStrategy(): CommandValidationStrategy {
    return new CommandValidationStrategy("bun run lint", 30000);
}

/**
 * Factory para criar estratégia customizada.
 */
export function createCustomValidationStrategy(
    command: string,
    timeoutMs = 30000
): CommandValidationStrategy {
    return new CommandValidationStrategy(command, timeoutMs);
}
