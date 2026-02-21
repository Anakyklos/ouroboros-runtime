/**
 * 🧪 Test Validation Strategy
 *
 * Estratégia de validação especializada para execução de testes.
 * Segue protocolo Anti-Vibe: "Trust but Verify" - executa testes reais
 * e parsing do output para métricas detalhadas.
 *
 * Inspirado em:
 * - OpenClaw/ClawedBot: validação objetiva por execução
 * - Pickle Rickle: loops de auto-refinamento com feedback
 * - CommandValidationStrategy: padrão base de execução shell
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
 * Resultado da execução de testes com métricas detalhadas.
 */
export interface TestMetrics {
    /** Número total de testes executados */
    total: number;
    /** Número de testes que passaram */
    passed: number;
    /** Número de testes que falharam */
    failed: number;
    /** Número de testes pulados */
    skipped: number;
    /** Tempo total de execução em ms */
    durationMs: number;
    /** Lista de testes que falharam */
    failures: string[];
    /** Lista de testes que passaram (se disponível) */
    successes?: string[];
}

/**
 * Faz parse do output de testes bun para extrair métricas.
 */
function parseTestOutput(stdout: string, stderr: string): TestMetrics {
    const metrics: TestMetrics = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
        failures: [],
        successes: [],
    };

    // Parse do output do bun test
    const output = stdout + stderr;

    // Busca por padrões como "✓ 1 test passed" ou "1 pass, 0 fail"
    const passMatch = output.match(/(\d+)\s+(?:pass|passed|success)/i);
    const failMatch = output.match(/(\d+)\s+(?:fail|failed|error)/i);
    const skipMatch = output.match(/(\d+)\s+(?:skip|skipped)/i);
    const durationMatch = output.match(/(\d+)ms/);

    if (passMatch) metrics.passed = parseInt(passMatch[1], 10);
    if (failMatch) metrics.failed = parseInt(failMatch[1], 10);
    if (skipMatch) metrics.skipped = parseInt(skipMatch[1], 10);
    if (durationMatch) metrics.durationMs = parseInt(durationMatch[1], 10);

    metrics.total = metrics.passed + metrics.failed + metrics.skipped;

    // Extrai nomes dos testes que falharam
    const failureLines = output.split('\n').filter(line =>
        line.includes('❌') ||
        line.includes('FAIL:') ||
        line.includes('Error:') ||
        line.includes('failed')
    );
    metrics.failures = failureLines.map(line => line.trim()).filter(Boolean);

    // Extrai nomes dos testes que passaram (se disponível)
    const successLines = output.split('\n').filter(line =>
        line.includes('✓') ||
        line.includes('✅') ||
        line.includes('pass')
    );
    metrics.successes = successLines
        .map(line => line.trim())
        .filter(line => !line.includes('tests passed') && line.length > 0)
        .slice(0, 50); // Limita para evitar output muito grande

    return metrics;
}

/**
 * Estratégia de validação especializada para testes.
 *
 * Diferente do CommandValidationStrategy genérico, esta estratégia:
 * - Faz parse do output de testes para extrair métricas
 * - Retorna informações detalhadas sobre testes que falharam
 * - Formata mensagens com resumo executivo dos resultados
 *
 * @example
 * ```ts
 * const strategy = new TestValidationStrategy();
 * const result = await strategy.validate({ workDir: "./project", taskId: "task-1", output: "" });
 * console.log(result.details?.metrics); // { total: 10, passed: 9, failed: 1, ... }
 * ```
 */
export class TestValidationStrategy implements ValidationStrategy {
    readonly name: string;
    private command: string;
    private timeoutMs: number;
    private testPattern?: RegExp;

    constructor(command?: string, timeoutMs = 60000, testPattern?: RegExp) {
        this.command = command || "bun test";
        this.timeoutMs = timeoutMs;
        this.testPattern = testPattern;
        this.name = `TestValidation(${this.command})`;
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
                    // Suppresdo warnings do Node para manter output limpo
                    NODE_NO_WARNINGS: "1",
                },
            });

            const durationMs = Date.now() - startTime;
            const sanitizedStdout = sanitizeOutput(stdout);
            const sanitizedStderr = sanitizeOutput(stderr);

            // Parse das métricas de teste
            const metrics = parseTestOutput(sanitizedStdout, sanitizedStderr);
            const isValid = metrics.failed === 0 && metrics.total > 0;

            // Formata mensagem de resumo
            const summary = this.formatSummary(metrics, isValid);

            return {
                isValid,
                exitCode: 0,
                message: summary,
                details: {
                    command: this.command,
                    workDir: context.workDir,
                    durationMs,
                    metrics,
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
                    exitCode: 124,
                    message: `Test execution timed out after ${this.timeoutMs}ms`,
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

            // Tenta extrair métricas mesmo do erro
            const metrics = parseTestOutput(sanitizedStdout, sanitizedStderr);

            return {
                isValid: false,
                exitCode: execError.code ?? 1,
                message: sanitizedStderr || sanitizedStdout || String(error),
                details: {
                    command: this.command,
                    workDir: context.workDir,
                    durationMs,
                    metrics,
                    stdout: sanitizedStdout,
                    stderr: sanitizedStderr,
                },
            };
        }
    }

    /**
     * Formata um resumo executivo dos resultados dos testes.
     */
    private formatSummary(metrics: TestMetrics, isValid: boolean): string {
        const emoji = isValid ? "✅" : "❌";
        const status = isValid ? "passed" : "failed";

        let summary = `${emoji} Tests ${status}: `;

        if (metrics.total > 0) {
            summary += `${metrics.passed}/${metrics.total} passed`;

            if (metrics.skipped > 0) {
                summary += `, ${metrics.skipped} skipped`;
            }

            if (metrics.failed > 0) {
                summary += `, ${metrics.failed} failed`;
            }

            if (metrics.durationMs > 0) {
                summary += ` (${metrics.durationMs}ms)`;
            }
        } else {
            summary += "no tests found";
        }

        if (metrics.failures.length > 0) {
            summary += `\n\nFailures:\n${metrics.failures.slice(0, 5).join("\n")}`;
            if (metrics.failures.length > 5) {
                summary += `\n... and ${metrics.failures.length - 5} more`;
            }
        }

        return summary;
    }
}

// --- FACTORIES ---

/**
 * Factory para criar estratégia de testes padrão com bun.
 */
export function createBunTestStrategy(): TestValidationStrategy {
    return new TestValidationStrategy("bun test", 60000);
}

/**
 * Factory para criar estratégia de testes com filtro de padrão.
 */
export function createPatternTestStrategy(
    pattern: string,
    timeoutMs = 60000
): TestValidationStrategy {
    const command = `bun test ${pattern}`;
    const regex = new RegExp(pattern, "i");
    return new TestValidationStrategy(command, timeoutMs, regex);
}

/**
 * Factory para criar estratégia de testes de cobertura.
 */
export function createCoverageTestStrategy(): TestValidationStrategy {
    return new TestValidationStrategy("bun test --coverage", 90000);
}

/**
 * Factory para criar estratégia de testes customizada.
 */
export function createCustomTestStrategy(
    command: string,
    timeoutMs = 60000
): TestValidationStrategy {
    return new TestValidationStrategy(command, timeoutMs);
}
