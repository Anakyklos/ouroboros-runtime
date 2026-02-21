/**
 * 📊 Validation Reporter
 *
 * Formatador de resultados de validação para relatórios claros de qualidade.
 * Parte do protocolo Anti-Vibe: visibilidade clara dos resultados dos gates.
 *
 * Inspirado no MemoryManager:
 * - Formatação legível para humanos
 * - Suporte a Markdown para logging
 * - Emojis para indicação visual rápida
 */

import type { ValidationResult } from "./types.js";
import type { QualityGateResult, QualityGatesReport } from "./strategies/QualityGateRegistry.js";
import type { PromotionValidation } from "./promotion-types.js";

// --- FORMATTERS ---

/**
 * Retorna o emoji apropriado para um resultado de validação.
 */
function getValidationEmoji(isValid: boolean, required: boolean): string {
    if (isValid) {
        return "✅";
    }
    return required ? "❌" : "⚠️";
}

/**
 * Formata timestamp para exibição.
 */
function formatTimestamp(date: Date): string {
    if (isNaN(date.getTime())) {
        return 'Invalid Date';
    }
    // Safer formatting: HH:MM:SS
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

/**
 * Formata duração em ms para exibição legível.
 */
function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${ms}ms`;
    }
    return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Formata um único ValidationResult para console.
 */
function formatValidationResult(
    result: ValidationResult,
    label: string,
    required = true
): string {
    const emoji = getValidationEmoji(result.isValid, required);
    const reqLabel = required ? "" : " (optional)";

    return `  ${emoji} ${label}${reqLabel}: ${result.message}`;
}

/**
 * Formata um QualityGateResult para console.
 */
function formatQualityGateResult(gate: QualityGateResult): string {
    const emoji = getValidationEmoji(gate.result.isValid, gate.required);
    const time = formatTimestamp(gate.timestamp);
    const reqLabel = gate.required ? "" : " (optional)";
    const duration = gate.result.details?.durationMs
        ? ` - ${formatDuration(gate.result.details.durationMs as number)}`
        : "";

    return `  ${emoji} ${gate.type}${reqLabel}: ${gate.result.message}${duration}`;
}

/**
 * Formata um PromotionValidation para console.
 */
function formatPromotionValidation(validation: PromotionValidation): string {
    const emoji = getValidationEmoji(validation.result.isValid, true);
    const time = formatTimestamp(validation.timestamp);

    return `  ${emoji} ${validation.type}: ${validation.result.message}`;
}

/**
 * Serializa ValidationResult para Markdown.
 */
function validationResultToMarkdown(
    result: ValidationResult,
    label: string,
    required = true
): string {
    const emoji = getValidationEmoji(result.isValid, required);
    const reqLabel = required ? "" : " (optional)";

    let md = `
### ${label} ${emoji}${reqLabel}

- **Status**: ${result.isValid ? "PASS" : "FAIL"}
`;

    if (result.exitCode !== undefined) {
        md += `- **Exit Code**: ${result.exitCode}\n`;
    }

    md += `- **Message**: ${result.message}\n`;

    if (result.details) {
        md += `\n<details>
<summary>Details</summary>

```json
${JSON.stringify(result.details, null, 2)}
```

</details>
`;
    }

    return md;
}

/**
 * Serializa QualityGateResult para Markdown.
 */
function qualityGateResultToMarkdown(gate: QualityGateResult): string {
    const emoji = getValidationEmoji(gate.result.isValid, gate.required);
    const reqLabel = gate.required ? "" : " (optional)";

    let md = `
### ${gate.type} ${emoji}${reqLabel}

- **Status**: ${gate.result.isValid ? "PASS" : "FAIL"}
- **Time**: ${formatTimestamp(gate.timestamp)}
`;

    if (gate.result.exitCode !== undefined) {
        md += `- **Exit Code**: ${gate.result.exitCode}\n`;
    }

    md += `- **Message**: ${gate.result.message}\n`;

    if (gate.result.details) {
        md += `\n<details>
<summary>Details</summary>

```json
${JSON.stringify(gate.result.details, null, 2)}
```

</details>
`;
    }

    return md;
}

/**
 * Serializa QualityGatesReport completo para Markdown.
 */
function qualityGatesReportToMarkdown(report: QualityGatesReport): string {
    const statusEmoji = report.passed ? "✅" : "❌";
    const statusText = report.passed ? "PASSED" : "FAILED";

    let md = `
# Quality Gates Report ${statusEmoji}

## Summary

- **Status**: ${statusText}
- **Total Gates**: ${report.results.length}
- **Passed**: ${report.succeeded.length}
- **Failed**: ${report.failed.length}
- **Skipped**: ${report.skipped.length}
- **Duration**: ${formatDuration(report.totalDurationMs)}

`;

    // Gates que passaram
    if (report.succeeded.length > 0) {
        md += `## ✅ Passed Gates\n`;
        report.succeeded.forEach(gate => {
            md += qualityGateResultToMarkdown(gate);
        });
        md += `\n`;
    }

    // Gates que falharam
    if (report.failed.length > 0) {
        md += `## ❌ Failed Gates\n`;
        report.failed.forEach(gate => {
            md += qualityGateResultToMarkdown(gate);
        });
        md += `\n`;
    }

    // Gates pulados (opcionais que falharam)
    if (report.skipped.length > 0) {
        md += `## ⚠️ Skipped Gates (optional, failed)\n`;
        report.skipped.forEach(gate => {
            md += qualityGateResultToMarkdown(gate);
        });
        md += `\n`;
    }

    md += `---\n`;
    return md;
}

/**
 * Serializa PromotionValidation[] para Markdown.
 */
function promotionValidationsToMarkdown(
    validations: PromotionValidation[],
    sourcePath: string
): string {
    const allPassed = validations.every(v => v.result.isValid);
    const statusEmoji = allPassed ? "✅" : "❌";
    const statusText = allPassed ? "PASSED" : "FAILED";

    let md = `
# Promotion Validation: ${sourcePath} ${statusEmoji}

## Summary

- **Status**: ${statusText}
- **Validations**: ${validations.length}
- **Passed**: ${validations.filter(v => v.result.isValid).length}
- **Failed**: ${validations.filter(v => !v.result.isValid).length}

`;

    validations.forEach(validation => {
        md += qualityGateResultToMarkdown({
            type: validation.type,
            result: validation.result,
            timestamp: validation.timestamp,
            required: true,
        });
    });

    md += `---\n`;
    return md;
}

// --- REPORTER CLASS ---

/**
 * Reporter para resultados de validação de qualidade.
 *
 * Fornece formatação clara e consistente para relatórios de validação,
 * tanto para console quanto para logging em Markdown.
 */
export class ValidationReporter {
    private verbose: boolean;

    constructor(verbose = true) {
        this.verbose = verbose;
    }

    /**
     * Reporta um único ValidationResult para o console.
     */
    reportValidationResult(
        result: ValidationResult,
        label: string,
        required = true
    ): void {
        const message = formatValidationResult(result, label, required);
        console.log(message);

        if (!result.isValid && this.verbose && result.details) {
            console.log(`     Details:`, result.details);
        }
    }

    /**
     * Reporta um QualityGateResult para o console.
     */
    reportQualityGateResult(gate: QualityGateResult): void {
        const message = formatQualityGateResult(gate);
        console.log(message);

        if (!gate.result.isValid && this.verbose && gate.result.details) {
            console.log(`     Details:`, gate.result.details);
        }
    }

    /**
     * Reporta um QualityGatesReport completo para o console.
     */
    reportQualityGates(report: QualityGatesReport): void {
        const statusEmoji = report.passed ? "✅" : "❌";
        const statusText = report.passed ? "PASSED" : "FAILED";

        console.log(`\n${statusEmoji} Quality Gates: ${statusText}`);
        console.log(`   Duration: ${formatDuration(report.totalDurationMs)}`);
        console.log(`   Passed: ${report.succeeded.length}/${report.results.length}`);

        if (report.failed.length > 0) {
            console.log(`\n❌ Failed Gates:`);
            report.failed.forEach(gate => {
                this.reportQualityGateResult(gate);
            });
        }

        if (report.skipped.length > 0) {
            console.log(`\n⚠️ Skipped (optional) Gates:`);
            report.skipped.forEach(gate => {
                this.reportQualityGateResult(gate);
            });
        }
    }

    /**
     * Reporta uma PromotionValidation para o console.
     */
    reportPromotionValidation(validation: PromotionValidation): void {
        const message = formatPromotionValidation(validation);
        console.log(message);

        if (!validation.result.isValid && this.verbose && validation.result.details) {
            console.log(`     Details:`, validation.result.details);
        }
    }

    /**
     * Reporta múltiplas PromotionValidation para o console.
     */
    reportPromotionValidations(
        validations: PromotionValidation[],
        sourcePath: string
    ): void {
        const allPassed = validations.every(v => v.result.isValid);
        const statusEmoji = allPassed ? "✅" : "❌";
        const statusText = allPassed ? "PASSED" : "FAILED";

        console.log(`\n${statusEmoji} Promotion Validation: ${sourcePath}`);
        console.log(`   Status: ${statusText}`);
        console.log(`   Validations: ${validations.filter(v => v.result.isValid).length}/${validations.length}`);

        validations.forEach(validation => {
            this.reportPromotionValidation(validation);
        });
    }

    /**
     * Gera Markdown para um único ValidationResult.
     */
    toMarkdown(result: ValidationResult, label: string, required = true): string {
        return validationResultToMarkdown(result, label, required);
    }

    /**
     * Gera Markdown para um QualityGatesReport completo.
     */
    toQualityGatesMarkdown(report: QualityGatesReport): string {
        return qualityGatesReportToMarkdown(report);
    }

    /**
     * Gera Markdown para PromotionValidation[].
     */
    toPromotionMarkdown(validations: PromotionValidation[], sourcePath: string): string {
        return promotionValidationsToMarkdown(validations, sourcePath);
    }

    /**
     * Habilita ou desabilita logs detalhados.
     */
    setVerbose(verbose: boolean): void {
        this.verbose = verbose;
    }
}

// --- FACTORIES ---

/**
 * Factory function para criar ValidationReporter.
 */
export function createValidationReporter(verbose?: boolean): ValidationReporter {
    return new ValidationReporter(verbose);
}

/**
 * Factory para criar reporter silencioso (apenas erros).
 */
export function createQuietReporter(): ValidationReporter {
    return new ValidationReporter(false);
}
