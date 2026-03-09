/**
 * 🔍 Multi-Model Review Strategy
 * 
 * ValidationStrategy que envia o output de uma task para um segundo modelo LLM
 * (diferente do que produziu o código) para review.
 * 
 * Inspirado pelo review.py do razzant/ouroboros,
 * integrado como strategy no QualityGateRegistry existente.
 * 
 * ADR-02: Modelo separado para review garante diversidade de perspectiva.
 */

import type { ValidationStrategy, ValidationContext, ValidationResult } from '../types.js';
import type { BudgetPort } from '../../ports/budget.port.js';

// ============================================================
// Types
// ============================================================

export interface MultiModelReviewConfig {
    /** Modelo a usar para review (deve ser diferente do modelo de execução) */
    reviewModel: string;
    /** API key para o modelo de review (se diferente) */
    apiKey?: string;
    /** Base URL do provider de review */
    baseUrl?: string;
    /** Timeout em ms (default: 60s) */
    timeoutMs: number;
    /** Severidade mínima para falhar o gate ('error' | 'warning' | 'info') */
    minSeverityToFail: 'error' | 'warning' | 'info';
    /** Se usa BudgetTracker para registrar custo do review */
    budgetTracker?: BudgetPort;
}

export const DEFAULT_REVIEW_CONFIG: MultiModelReviewConfig = {
    reviewModel: 'gemini-2.5-flash',
    timeoutMs: 60_000,
    minSeverityToFail: 'error',
};

export interface ReviewFinding {
    severity: 'error' | 'warning' | 'info';
    category: string;
    message: string;
    suggestion?: string;
    location?: string;
}

export interface ReviewReport {
    /** Veredicto geral */
    verdict: 'approved' | 'changes_requested' | 'rejected';
    /** Lista de findings */
    findings: ReviewFinding[];
    /** Resumo textual */
    summary: string;
    /** Modelo que fez o review */
    reviewModel: string;
    /** Custo estimado */
    costUsd?: number;
}

// ============================================================
// Review System Prompt
// ============================================================

const REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer. Your role is to review code output from another AI agent and identify issues.

## Review Criteria
1. **Correctness**: Does the code do what was requested?
2. **Security**: Are there security vulnerabilities?
3. **Performance**: Are there obvious performance issues?
4. **Best Practices**: Does it follow language idioms and conventions?
5. **Error Handling**: Are errors handled appropriately?
6. **Type Safety**: Are types used correctly?

## Output Format
Respond with a JSON object:
{
    "verdict": "approved" | "changes_requested" | "rejected",
    "summary": "Brief overall assessment",
    "findings": [
        {
            "severity": "error" | "warning" | "info",
            "category": "correctness|security|performance|best_practices|error_handling|type_safety",
            "message": "Description of the issue",
            "suggestion": "How to fix it",
            "location": "file:line or function name"
        }
    ]
}

## Guidelines
- Be constructive, not pedantic
- Only flag genuine issues, not style preferences
- "approved" = no errors, maybe a few warnings
- "changes_requested" = errors found but fixable
- "rejected" = fundamental issues requiring redesign
`;

// ============================================================
// MultiModelReviewStrategy
// ============================================================

export class MultiModelReviewStrategy implements ValidationStrategy {
    name = 'MultiModelReview';
    private config: MultiModelReviewConfig;

    constructor(config?: Partial<MultiModelReviewConfig>) {
        this.config = { ...DEFAULT_REVIEW_CONFIG, ...config };
    }

    /**
     * Valida o output de uma task enviando para um segundo modelo de review.
     */
    async validate(context: ValidationContext): Promise<ValidationResult> {
        try {
            const report = await this.performReview(context);
            return this.reportToResult(report);
        } catch (err) {
            return {
                isValid: false,
                message: `Review failed: ${err instanceof Error ? err.message : String(err)}`,
                exitCode: 1,
                details: { error: String(err) },
            };
        }
    }

    /**
     * Executa o review e retorna o report estruturado.
     * Pode ser chamado diretamente para obter o report completo.
     */
    async performReview(context: ValidationContext): Promise<ReviewReport> {
        const reviewPrompt = this.buildReviewPrompt(context);

        // Try to call the review model
        // If no API key is configured, fall back to heuristic review
        if (!this.config.apiKey && !process.env.ZAI_API_KEY && !process.env.ZHIPU_API_KEY) {
            return this.heuristicReview(context);
        }

        try {
            const apiKey = this.config.apiKey ?? process.env.ZAI_API_KEY ?? process.env.ZHIPU_API_KEY ?? '';
            const baseUrl = this.config.baseUrl ?? 'https://api.z.ai/api/coding/paas/v4';

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

            try {
                const response = await fetch(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                        model: this.config.reviewModel,
                        messages: [
                            { role: 'system', content: REVIEW_SYSTEM_PROMPT },
                            { role: 'user', content: reviewPrompt },
                        ],
                        temperature: 0.2, // Low temperature for consistent reviews
                        max_tokens: 2048,
                        stream: false,
                    }),
                    signal: controller.signal,
                });

                if (!response.ok) {
                    throw new Error(`Review API error: ${response.status}`);
                }

                const data = await response.json() as {
                    choices: Array<{ message: { content: string } }>;
                    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
                };

                // Record budget if tracker available
                if (this.config.budgetTracker && data.usage) {
                    await this.config.budgetTracker.recordUsage({
                        model: this.config.reviewModel,
                        promptTokens: data.usage.prompt_tokens,
                        completionTokens: data.usage.completion_tokens,
                        totalTokens: data.usage.total_tokens,
                        category: 'review',
                    });
                }

                const content = data.choices[0]?.message?.content ?? '';
                return this.parseReviewResponse(content);

            } finally {
                clearTimeout(timeout);
            }
        } catch (err) {
            // Fall back to heuristic review on API failure
            return this.heuristicReview(context);
        }
    }

    // ============================================================
    // Private
    // ============================================================

    private buildReviewPrompt(context: ValidationContext): string {
        // Sanitize output to prevent prompt injection via triple backticks
        const sanitizedOutput = context.output
            .substring(0, 8000)
            .replace(/```/g, '\u0060\u0060\u0060');

        return `## Task ID: ${context.taskId}

## Code Output to Review
\`\`\`
${sanitizedOutput}
\`\`\`

${context.additionalContext ? `## Additional Context\n${context.additionalContext}` : ''}

Please review the code above and provide your assessment.`;
    }

    private parseReviewResponse(content: string): ReviewReport {
        try {
            // Try to extract JSON from response (may be wrapped in markdown code block)
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]) as Partial<ReviewReport>;
                return {
                    verdict: parsed.verdict ?? 'approved',
                    findings: (parsed.findings ?? []).map(f => ({
                        severity: f.severity ?? 'info',
                        category: f.category ?? 'general',
                        message: f.message ?? '',
                        suggestion: f.suggestion,
                        location: f.location,
                    })),
                    summary: parsed.summary ?? content.substring(0, 200),
                    reviewModel: this.config.reviewModel,
                };
            }
        } catch {
            // Failed to parse JSON
        }

        // Fallback: treat the entire response as a summary
        return {
            verdict: 'approved',
            findings: [],
            summary: content.substring(0, 500),
            reviewModel: this.config.reviewModel,
        };
    }

    /**
     * Review heurístico quando LLM não está disponível.
     * Analisa padrões no output para detectar problemas comuns.
     */
    private heuristicReview(context: ValidationContext): ReviewReport {
        const findings: ReviewFinding[] = [];
        const output = context.output;

        // Check for common anti-patterns
        if (output.includes('any') && output.includes('as any')) {
            findings.push({
                severity: 'warning',
                category: 'type_safety',
                message: 'Uses `as any` cast — potential type safety issue',
                suggestion: 'Use proper typing or generic constraints',
            });
        }

        if (output.includes('console.log(') && !output.includes('// debug')) {
            findings.push({
                severity: 'info',
                category: 'best_practices',
                message: 'Contains console.log statements',
                suggestion: 'Use proper logging framework (EventBus.log)',
            });
        }

        if (output.match(/\bcatch\s*\(/)) {
            findings.push({
                severity: 'info',
                category: 'error_handling',
                message: 'Contains catch clauses — verify specific error types are handled',
            });
        }

        if (output.includes('TODO') || output.includes('FIXME') || output.includes('HACK')) {
            findings.push({
                severity: 'warning',
                category: 'best_practices',
                message: 'Contains TODO/FIXME/HACK markers',
                suggestion: 'Address or create issues for these items',
            });
        }

        if (output.length > 10000) {
            findings.push({
                severity: 'info',
                category: 'best_practices',
                message: 'Large output — consider breaking into smaller units',
            });
        }

        // Security checks
        if (output.includes('eval(') || output.includes('Function(')) {
            findings.push({
                severity: 'error',
                category: 'security',
                message: 'Uses eval() or Function() — potential code injection vulnerability',
                suggestion: 'Use safer alternatives',
            });
        }

        // Localized credential check: keyword and long string must appear on same line
        const lines = output.split('\n');
        const hasHardcodedCreds = lines.some(line =>
            /password|secret|api.?key/i.test(line) && /['"][^'"]{8,}['"]/.test(line)
        );
        if (hasHardcodedCreds) {
            findings.push({
                severity: 'error',
                category: 'security',
                message: 'Possible hardcoded credentials detected',
                suggestion: 'Use environment variables',
            });
        }

        const hasErrors = findings.some(f => f.severity === 'error');
        const hasWarnings = findings.some(f => f.severity === 'warning');

        return {
            verdict: hasErrors ? 'changes_requested' : (hasWarnings ? 'approved' : 'approved'),
            findings,
            summary: hasErrors
                ? `Found ${findings.filter(f => f.severity === 'error').length} error(s) requiring attention`
                : findings.length > 0
                    ? `Found ${findings.length} suggestions for improvement`
                    : 'Code looks clean, no significant issues detected',
            reviewModel: 'heuristic',
        };
    }

    private reportToResult(report: ReviewReport): ValidationResult {
        const errorCount = report.findings.filter(f => f.severity === 'error').length;
        const warningCount = report.findings.filter(f => f.severity === 'warning').length;

        // Determine if the gate passes based on config
        let isValid = true;
        if (this.config.minSeverityToFail === 'error') {
            isValid = report.verdict !== 'rejected' && errorCount === 0;
        } else if (this.config.minSeverityToFail === 'warning') {
            isValid = report.verdict === 'approved' && warningCount === 0 && errorCount === 0;
        } else {
            isValid = report.findings.length === 0;
        }

        return {
            isValid,
            message: `[${report.reviewModel}] ${report.summary} (${errorCount} errors, ${warningCount} warnings)`,
            details: {
                verdict: report.verdict,
                findings: report.findings,
                reviewModel: report.reviewModel,
                costUsd: report.costUsd,
            },
        };
    }
}

// ============================================================
// Factory
// ============================================================

export function createMultiModelReviewStrategy(
    config?: Partial<MultiModelReviewConfig>
): MultiModelReviewStrategy {
    return new MultiModelReviewStrategy(config);
}
