/**
 * 🛡️ InferenceGuardrails
 *
 * Guardrails obrigatórios para a camada de inferência:
 * - Validação de JSON
 * - Validação de escopo de patch
 * - Bloqueio de comandos destrutivos
 * - Limite de iterações
 */

import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// Blocked Patterns
// ============================================================================

/**
 * Comandos shell destrutivos bloqueados por padrão.
 */
const DESTRUCTIVE_COMMANDS = [
    "rm -rf /",
    "rm -rf ~",
    "rm -rf /*",
    "dd if=",
    "mkfs.",
    ":(){:|:&};:",
    "chmod -R 777 /",
    "chmod -R 000 /",
    "chown -R",
    "shutdown",
    "reboot",
    "init 0",
    "halt",
    "poweroff",
    "kill -9 1",
    "kill -9 -1",
    "> /dev/sda",
    "wget | sh",
    "curl | sh",
    "wget | bash",
    "curl | bash",
    "eval(",
    "npm publish",
    "git push --force origin main",
    "git push -f origin main",
    "DROP TABLE",
    "DROP DATABASE",
    "TRUNCATE",
    "DELETE FROM",
];

/**
 * Extensões de arquivo que não devem ser editadas por modelos.
 */
const PROTECTED_FILE_PATTERNS = [
    ".env",
    ".env.local",
    ".env.production",
    ".secrets",
    "id_rsa",
    "id_ed25519",
    ".pem",
    ".key",
    ".p12",
    "password",
    "credentials",
];

// ============================================================================
// InferenceGuardrails
// ============================================================================

export class InferenceGuardrails {
    private eventBus: EventBus;
    private iterationCounts: Map<string, number> = new Map();
    private projectRoot: string;

    constructor(eventBus?: EventBus, projectRoot?: string) {
        this.eventBus = eventBus ?? globalEventBus;
        this.projectRoot = projectRoot ?? process.cwd();
    }

    /**
     * Valida se uma string é JSON válido e opcionalmente valida com schema Zod.
     */
    validateJSON<T>(
        output: string,
        schema?: { safeParse: (data: unknown) => { success: boolean; error?: { message: string }; data?: T } },
    ): { valid: boolean; parsed?: T; error?: string } {
        let parsed: unknown;

        try {
            parsed = JSON.parse(output);
        } catch (error) {
            // Try to extract JSON from mixed content
            const match = output.match(/\{[\s\S]*\}/);
            if (match) {
                try {
                    parsed = JSON.parse(match[0]);
                } catch {
                    return { valid: false, error: `Invalid JSON: ${(error as Error).message}` };
                }
            } else {
                return { valid: false, error: `Invalid JSON: ${(error as Error).message}` };
            }
        }

        if (schema) {
            const result = schema.safeParse(parsed);
            if (!result.success) {
                return {
                    valid: false,
                    error: `Schema validation failed: ${result.error?.message}`,
                };
            }
            return { valid: true, parsed: result.data };
        }

        return { valid: true, parsed: parsed as T };
    }

    /**
     * Valida se um patch opera dentro de caminhos permitidos.
     */
    validatePatchScope(
        filePath: string,
        allowedPaths: string[],
    ): { valid: boolean; reason: string } {
        // Check protected files
        for (const pattern of PROTECTED_FILE_PATTERNS) {
            if (filePath.toLowerCase().includes(pattern.toLowerCase())) {
                return { valid: false, reason: `Protected file pattern: ${pattern}` };
            }
        }

        // Check allowed paths (if specified)
        if (allowedPaths.length > 0) {
            const isAllowed = allowedPaths.some(allowed =>
                filePath.startsWith(allowed) || filePath.includes(allowed),
            );

            if (!isAllowed) {
                return {
                    valid: false,
                    reason: `File "${filePath}" is outside allowed paths: ${allowedPaths.join(", ")}`,
                };
            }
        }

        // Block absolute paths outside project root
        if (filePath.startsWith("/") && !filePath.startsWith(this.projectRoot)) {
            return { valid: false, reason: `Absolute path outside project root: ${this.projectRoot}` };
        }

        return { valid: true, reason: "Path is within scope" };
    }

    /**
     * Verifica se um comando shell é destrutivo.
     */
    isDestructiveCommand(command: string): { destructive: boolean; reason: string } {
        const normalized = command.toLowerCase().trim();

        for (const pattern of DESTRUCTIVE_COMMANDS) {
            if (normalized.includes(pattern.toLowerCase())) {
                return {
                    destructive: true,
                    reason: `Blocked destructive pattern: "${pattern}"`,
                };
            }
        }

        // Check for pipe to shell
        if (/\|\s*(sh|bash|zsh|eval)\b/.test(normalized)) {
            return {
                destructive: true,
                reason: "Pipe to shell interpreter detected",
            };
        }

        return { destructive: false, reason: "Command appears safe" };
    }

    /**
     * Verifica e incrementa contagem de iterações.
     * Retorna false se o limite foi atingido.
     */
    checkIterationLimit(contextId: string, maxIterations: number): { allowed: boolean; count: number } {
        const count = (this.iterationCounts.get(contextId) ?? 0) + 1;
        this.iterationCounts.set(contextId, count);

        if (count > maxIterations) {
            this.log("warn", `Iteration limit reached for ${contextId}: ${count}/${maxIterations}`);
            return { allowed: false, count };
        }

        return { allowed: true, count };
    }

    /**
     * Reseta contagem de iterações para um contexto.
     */
    resetIterations(contextId: string): void {
        this.iterationCounts.delete(contextId);
    }

    /**
     * Valida um patch completo: JSON, escopo, e conteúdo.
     */
    validatePatchProposal(
        patchJson: string,
        allowedPaths: string[] = [],
    ): { valid: boolean; errors: string[] } {
        const errors: string[] = [];

        // Validate JSON
        const jsonResult = this.validateJSON(patchJson);
        if (!jsonResult.valid) {
            errors.push(`Invalid JSON: ${jsonResult.error}`);
            return { valid: false, errors };
        }

        const patch = jsonResult.parsed as Record<string, unknown>;

        // Validate required fields
        if (!patch.filePath || typeof patch.filePath !== "string") {
            errors.push("Missing or invalid filePath");
        } else {
            const scopeCheck = this.validatePatchScope(patch.filePath as string, allowedPaths);
            if (!scopeCheck.valid) {
                errors.push(scopeCheck.reason);
            }
        }

        if (!patch.patchedSnippet || typeof patch.patchedSnippet !== "string") {
            errors.push("Missing or invalid patchedSnippet");
        }

        if (!patch.explanation || typeof patch.explanation !== "string") {
            errors.push("Missing explanation");
        }

        return { valid: errors.length === 0, errors };
    }

    // ========================================================================
    // Private
    // ========================================================================

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[Guardrails] ${message}`, "InferenceGuardrails");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createInferenceGuardrails(eventBus?: EventBus): InferenceGuardrails {
    return new InferenceGuardrails(eventBus);
}
