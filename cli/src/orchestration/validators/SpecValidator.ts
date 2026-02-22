/**
 * 📋 Spec Validator
 *
 * Validador que verifica se a especificação contém todas as seções obrigatórias
 * antes de permitir a transição para a fase EXECUTION. Segue protocolo Anti-Vibe:
 * "Trust but Verify" - não confia que o LLM escreveu uma spec completa,
 * valida programaticamente a existência de seções obrigatórias.
 *
 * Inspirado em:
 * - OpenClaw/ClawedBot: validação objetiva por análise de conteúdo
 * - Pickle Rickle: loops de auto-refinamento com feedback
 * - CommandValidationStrategy: padrão de validação com contexto completo
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidationStrategy, ValidationContext, ValidationResult } from "../types.js";

/**
 * Seções obrigatórias que devem estar presentes na spec.
 * Baseado no Architect Specification Workflow.
 */
const REQUIRED_SPEC_SECTIONS = [
    { title: "🎯 Objetivo", required: true },
    { title: "💡 Contexto e Justificativa", required: true },
    { title: "🚀 Plano de Implementação", required: true },
    { title: "✅ Critérios de Aceitação / Verificação", required: true },
];

/**
 * Seções opcionais que são boas práticas mas não obrigatórias.
 */
const OPTIONAL_SPEC_SECTIONS = [
    { title: "🚧 Possíveis Riscos e Desafios", required: false },
];

/**
 * Configuração do validador de spec.
 */
export interface SpecValidatorConfig {
    /** Caminho do arquivo spec relativo ao workDir */
    specPath?: string;
    /** Se true, requer que a spec esteja marcada como aprovada */
    requireApproval?: boolean;
    /** Padrões que indicam aprovação da spec */
    approvalPatterns?: string[];
}

/**
 * Resultado detalhado da validação de spec.
 */
export interface SpecValidationDetails {
    /** Caminho completo do arquivo spec */
    specFilePath: string;
    /** Se o arquivo spec existe */
    specExists: boolean;
    /** Seções obrigatórias encontradas */
    foundSections: string[];
    /** Seções obrigatórias faltando */
    missingSections: string[];
    /** Se a spec está marcada como aprovada */
    isApproved: boolean;
    /** Conteúdo completo da spec (truncado em logs) */
    specContent?: string;
    /** Todas as seções encontradas (incluindo opcionais) */
    allSections: string[];
}

/**
 * Validador que verifica se a especificação está completa antes da EXECUTION.
 *
 * Este validador:
 * - Verifica existência do arquivo spec
 * - Confirma presença de seções obrigatórias
 * - Opcionalmente verifica se a spec está aprovada
 * - Fornece feedback claro sobre o que está faltando
 *
 * @example
 * ```ts
 * const validator = new SpecValidator();
 * const result = await validator.validate({
 *     workDir: "./project",
 *     taskId: "task-1",
 *     output: "",
 * });
 * console.log(result.isValid); // true se todas as seções obrigatórias existirem
 * ```
 */
export class SpecValidator implements ValidationStrategy {
    readonly name: string;
    private specPath: string;
    private requireApproval: boolean;
    private approvalPatterns: string[];

    constructor(config?: SpecValidatorConfig) {
        this.specPath = config?.specPath ?? ".auto-claude/spec.md";
        this.requireApproval = config?.requireApproval ?? true;
        this.approvalPatterns = config?.approvalPatterns ?? [
            "✅",
            "APPROVED",
            "APROVADO",
            "[x]",
            "[X]",
        ];
        this.name = `SpecValidator(${this.specPath})`;
    }

    async validate(context: ValidationContext): Promise<ValidationResult> {
        const startTime = Date.now();

        try {
            const specFilePath = join(context.workDir, this.specPath);

            // Tenta ler o arquivo spec
            const specContent = await this.readSpecFile(specFilePath);
            const durationMs = Date.now() - startTime;

            if (!specContent) {
                // Arquivo não existe
                const details: SpecValidationDetails = {
                    specFilePath,
                    specExists: false,
                    foundSections: [],
                    missingSections: REQUIRED_SPEC_SECTIONS.filter(s => s.required).map(s => s.title),
                    isApproved: false,
                    allSections: [],
                };

                return {
                    isValid: false,
                    exitCode: 1,
                    message: this.formatMissingFileMessage(details),
                    details: {
                        workDir: context.workDir,
                        durationMs,
                        spec: details,
                    },
                };
            }

            // Analisa o conteúdo da spec
            const validation = this.validateSpecContent(specContent);
            const durationMsAfterAnalysis = Date.now() - startTime;

            const details: SpecValidationDetails = {
                specFilePath,
                specExists: true,
                foundSections: validation.foundSections,
                missingSections: validation.missingSections,
                isApproved: validation.isApproved,
                specContent: specContent.substring(0, 500), // Primeiros 500 chars para logs
                allSections: validation.allSections,
            };

            // Determina se a validação passou
            const hasAllRequiredSections = validation.missingSections.length === 0;
            const approvalRequiredMet = !this.requireApproval || validation.isApproved;
            const isValid = hasAllRequiredSections && approvalRequiredMet;

            return {
                isValid,
                exitCode: isValid ? 0 : 1,
                message: this.formatValidationMessage(isValid, details),
                details: {
                    workDir: context.workDir,
                    durationMs: durationMsAfterAnalysis,
                    spec: details,
                },
            };
        } catch (error: unknown) {
            const durationMs = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : String(error);

            return {
                isValid: false,
                exitCode: 1,
                message: `Spec validation failed: ${errorMessage}`,
                details: {
                    workDir: context.workDir,
                    durationMs,
                    error: errorMessage,
                },
            };
        }
    }

    /**
     * Tenta ler o arquivo spec. Retorna null se não existir.
     */
    private async readSpecFile(filePath: string): Promise<string | null> {
        try {
            const content = await readFile(filePath, "utf-8");
            return content;
        } catch {
            return null;
        }
    }

    /**
     * Valida o conteúdo da spec verificando seções obrigatórias e aprovação.
     */
    private validateSpecContent(content: string): {
        foundSections: string[];
        missingSections: string[];
        isApproved: boolean;
        allSections: string[];
    } {
        const foundSections: string[] = [];
        const missingSections: string[] = [];
        const allSections: string[] = [];

        // Verifica seções obrigatórias
        for (const section of REQUIRED_SPEC_SECTIONS) {
            const sectionPattern = new RegExp(
                `##\\s+${section.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
                "i"
            );

            if (sectionPattern.test(content)) {
                foundSections.push(section.title);
            } else if (section.required) {
                missingSections.push(section.title);
            }
        }

        // Verifica seções opcionais (para informativo)
        for (const section of OPTIONAL_SPEC_SECTIONS) {
            const sectionPattern = new RegExp(
                `##\\s+${section.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
                "i"
            );

            if (sectionPattern.test(content)) {
                allSections.push(section.title);
            }
        }

        // Adiciona seções obrigatórias encontradas à lista de todas as seções
        allSections.push(...foundSections);

        // Verifica se a spec está aprovada
        const isApproved = this.checkApproval(content);

        return {
            foundSections,
            missingSections,
            isApproved,
            allSections,
        };
    }

    /**
     * Verifica se a spec está marcada como aprovada.
     */
    private checkApproval(content: string): boolean {
        const upperContent = content.toUpperCase();

        for (const pattern of this.approvalPatterns) {
            if (upperContent.includes(pattern.toUpperCase())) {
                return true;
            }
        }

        return false;
    }

    /**
     * Formata mensagem quando o arquivo spec não existe.
     */
    private formatMissingFileMessage(details: SpecValidationDetails): string {
        let message = "❌ Spec validation failed\n";
        message += `   📁 Spec file not found: ${this.specPath}\n`;
        message += `   💡 Create a spec with all required sections before EXECUTION phase.\n`;
        message += `\n   Required sections:\n`;
        for (const section of REQUIRED_SPEC_SECTIONS.filter(s => s.required)) {
            message += `      - ${section.title}\n`;
        }

        return message.trim();
    }

    /**
     * Formata mensagem de resultado da validação.
     */
    private formatValidationMessage(isValid: boolean, details: SpecValidationDetails): string {
        const emoji = isValid ? "✅" : "❌";
        const status = isValid ? "passed" : "failed";

        let message = `${emoji} Spec validation ${status}\n`;
        message += `   📁 Spec file: ${this.specPath}\n`;
        message += `   📊 Found sections: ${details.foundSections.length}/${REQUIRED_SPEC_SECTIONS.length}\n`;

        if (details.foundSections.length > 0) {
            message += `   ✅ Present:\n`;
            for (const section of details.foundSections) {
                message += `      - ${section}\n`;
            }
        }

        if (details.missingSections.length > 0) {
            message += `   ❌ Missing:\n`;
            for (const section of details.missingSections) {
                message += `      - ${section}\n`;
            }
        }

        if (this.requireApproval) {
            const approvalEmoji = details.isApproved ? "✅" : "❌";
            const approvalStatus = details.isApproved ? "approved" : "not approved";
            message += `   ${approvalEmoji} Spec status: ${approvalStatus}\n`;
        }

        if (details.allSections.length > REQUIRED_SPEC_SECTIONS.length) {
            message += `   ℹ️  Additional sections found: ${details.allSections.length - REQUIRED_SPEC_SECTIONS.length}\n`;
        }

        return message.trim();
    }
}

// --- FACTORIES ---

/**
 * Factory para criar validador com configuração padrão.
 */
export function createDefaultSpecValidator(): SpecValidator {
    return new SpecValidator();
}

/**
 * Factory para criar validador com caminho de spec customizado.
 */
export function createCustomPathSpecValidator(specPath: string): SpecValidator {
    return new SpecValidator({ specPath });
}

/**
 * Factory para criar validador que não requer aprovação.
 */
export function createSpecContentValidator(): SpecValidator {
    return new SpecValidator({ requireApproval: false });
}

/**
 * Factory para criar validador com padrões de aprovação customizados.
 */
export function createCustomApprovalSpecValidator(approvalPatterns: string[]): SpecValidator {
    return new SpecValidator({ approvalPatterns });
}

/**
 * Factory para criar validador completamente customizado.
 */
export function createCustomSpecValidator(config: SpecValidatorConfig): SpecValidator {
    return new SpecValidator(config);
}
