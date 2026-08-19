/**
 * 🔍 Multi-Model Review Strategy
 *
 * Quality gate que obtém uma revisão remota independente e nunca transforma
 * indisponibilidade do provider em um parecer sobre o conteúdo revisado.
 */

import { z } from 'zod';
import type { ValidationStrategy, ValidationContext, ValidationResult } from '../types.js';
import type { BudgetPort } from '../../ports/budget.port.js';

// ============================================================
// Types
// ============================================================

export interface MultiModelReviewConfig {
    /** Provider atualmente suportado por esta estratégia. */
    provider?: string;
    /** Modelo a usar para review (deve ser diferente do modelo de execução). */
    reviewModel: string;
    /** API key para o modelo de review (se diferente). */
    apiKey?: string;
    /** Base URL do provider de review. Quando omitida, usa o endpoint Z.AI oficial. */
    baseUrl?: string;
    /** Timeout interno da requisição em ms. */
    timeoutMs: number;
    /** Severidade mínima para falhar o gate em uma revisão remota aprovada. */
    minSeverityToFail: 'error' | 'warning' | 'info';
    /** Se usa BudgetTracker para registrar custo do review. */
    budgetTracker?: BudgetPort;
    /** Fallback local opt-in; nunca satisfaz o gate remoto obrigatório. */
    allowHeuristicFallback?: boolean;
    /** Sinal de cancelamento externo opcional para chamadas diretas. */
    signal?: AbortSignal;
    /** Relógio injetável para o parsing determinístico de HTTP-date. */
    now?: () => number;
}

export const DEFAULT_REVIEW_CONFIG: MultiModelReviewConfig = {
    provider: 'zai',
    reviewModel: 'glm-4-flash',
    timeoutMs: 60_000,
    minSeverityToFail: 'error',
    allowHeuristicFallback: false,
};

export interface ReviewFinding {
    severity: 'error' | 'warning' | 'info';
    category: string;
    message: string;
    suggestion?: string;
    location?: string;
}

export interface RemoteReviewSource {
    type: 'remote';
    provider: string;
    model: string;
    baseUrl: string;
    credentialSource: 'explicit' | 'ZAI_API_KEY' | 'ZHIPU_API_KEY' | 'none';
}

export interface HeuristicReviewSource {
    type: 'heuristic';
}

export type ReviewUnavailableReason =
    | 'missing_credentials'
    | 'invalid_configuration'
    | 'authentication'
    | 'authorization'
    | 'rate_limited'
    | 'provider_unavailable'
    | 'timeout'
    | 'cancelled'
    | 'network_error'
    | 'invalid_response'
    | 'parsing'
    | 'validation'
    | 'accounting_error';

export interface RemoteReviewOutcome {
    kind: 'review';
    verdict: 'approved' | 'changes_requested' | 'rejected';
    findings: ReviewFinding[];
    summary: string;
    source: RemoteReviewSource;
}

export interface AdvisoryReviewOutcome {
    kind: 'advisory';
    verdict: 'approved' | 'changes_requested';
    findings: ReviewFinding[];
    summary: string;
    source: HeuristicReviewSource;
}

export interface UnavailableReviewOutcome {
    kind: 'unavailable';
    reason: ReviewUnavailableReason;
    retryable: boolean;
    retryAfterMs?: number;
    source: RemoteReviewSource;
    message: string;
    httpStatus?: number;
    advisory?: AdvisoryReviewOutcome;
}

export type ReviewOutcome = RemoteReviewOutcome | UnavailableReviewOutcome | AdvisoryReviewOutcome;

/** Mantém o nome histórico exportado, agora com a semântica discriminada. */
export type ReviewReport = ReviewOutcome;

interface RemoteEnvelope {
    content: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

interface Credential {
    value: string;
    source: Exclude<RemoteReviewSource['credentialSource'], 'none'>;
}

const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
const SUPPORTED_ZAI_MODELS = new Set(['glm-4-flash', 'glm-4.7', 'glm-4-plus', 'glm-4']);
const CODE_DELIMITER = '```';
const SANITIZED_DELIMITER = '\u0060\u200b\u0060\u200b\u0060';
const SEVERITY_RANK: Record<ReviewFinding['severity'], number> = {
    info: 1,
    warning: 2,
    error: 3,
};

const reviewFindingSchema = z.object({
    severity: z.enum(['error', 'warning', 'info']),
    category: z.string().min(1),
    message: z.string().min(1),
    suggestion: z.string().optional(),
    location: z.string().optional(),
}).strict();

const reviewPayloadSchema = z.object({
    verdict: z.enum(['approved', 'changes_requested', 'rejected']),
    summary: z.string().min(1),
    findings: z.array(reviewFindingSchema),
}).strict();

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
     * Valida o output de uma task usando uma revisão remota confiável.
     * O segundo argumento é opcional para permitir cancelamento sem alterar o
     * ValidationContext compartilhado pelas demais estratégias.
     */
    async validate(context: ValidationContext, externalSignal?: AbortSignal): Promise<ValidationResult> {
        const outcome = await this.performReview(context, externalSignal);
        return this.outcomeToResult(outcome);
    }

    /**
     * Executa o review e retorna um outcome explicitamente discriminado.
     */
    async performReview(context: ValidationContext, externalSignal?: AbortSignal): Promise<ReviewOutcome> {
        const source = this.remoteSource();
        const configurationError = this.validateConfiguration(source);
        if (configurationError) {
            return this.withOptionalAdvisory(context, configurationError);
        }

        const credential = this.resolveCredential();
        if (!credential) {
            return this.withOptionalAdvisory(context, this.unavailable(
                'missing_credentials',
                false,
                source,
                'Remote review credentials are not configured.',
            ));
        }

        const signal = externalSignal ?? this.config.signal;
        if (signal?.aborted) {
            return this.withOptionalAdvisory(context, this.unavailable(
                'cancelled',
                false,
                source,
                'Remote review was cancelled by the caller.',
            ));
        }

        try {
            const response = await this.fetchReview(source, credential.value, context, signal);
            if (response.kind === 'unavailable') {
                return this.withOptionalAdvisory(context, response);
            }

            const extracted = this.extractEnvelope(response.envelope);
            if (!extracted) {
                return this.withOptionalAdvisory(context, this.unavailable(
                    'invalid_response',
                    false,
                    source,
                    'The remote review response did not contain a usable review envelope.',
                ));
            }

            if (this.config.budgetTracker) {
                if (!extracted.usage) {
                    return this.withOptionalAdvisory(context, this.unavailable(
                        'accounting_error',
                        false,
                        source,
                        'Remote review usage was missing or invalid; the review result was not promoted.',
                    ));
                }
                try {
                    await this.config.budgetTracker.recordUsage({
                        model: source.model,
                        promptTokens: extracted.usage.prompt_tokens,
                        completionTokens: extracted.usage.completion_tokens,
                        totalTokens: extracted.usage.total_tokens,
                        category: 'review',
                    });
                } catch {
                    return this.withOptionalAdvisory(context, this.unavailable(
                        'accounting_error',
                        false,
                        source,
                        'Remote review accounting failed; the review result was not promoted.',
                    ));
                }
            }

            return this.parseReviewResponse(extracted.content, source, credential.value);
        } catch {
            return this.withOptionalAdvisory(context, this.unavailable(
                'network_error',
                true,
                source,
                'The remote review transport failed before a reliable response was obtained.',
            ));
        }
    }

    // ============================================================
    // Configuration and transport
    // ============================================================

    private remoteSource(): RemoteReviewSource {
        const baseUrl = this.normalizedBaseUrl();
        const credential = this.resolveCredential();
        return {
            type: 'remote',
            provider: this.config.provider ?? 'zai',
            model: this.config.reviewModel,
            baseUrl,
            credentialSource: credential?.source ?? 'none',
        };
    }

    private normalizedBaseUrl(): string {
        return (this.config.baseUrl ?? DEFAULT_ZAI_BASE_URL).replace(/\/+$/, '');
    }

    private validateConfiguration(source: RemoteReviewSource): UnavailableReviewOutcome | undefined {
        if (source.provider !== 'zai' || !source.model.trim() || !Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs <= 0) {
            return this.unavailable(
                'invalid_configuration',
                false,
                source,
                'The remote review provider configuration is invalid.',
            );
        }

        try {
            const parsedUrl = new URL(source.baseUrl);
            if (parsedUrl.protocol !== 'https:' && !this.isExplicitTestEndpoint(parsedUrl)) {
                return this.unavailable(
                    'invalid_configuration',
                    false,
                    source,
                    'The remote review base URL must use HTTPS unless explicitly configured for a test endpoint.',
                );
            }
        } catch {
            return this.unavailable(
                'invalid_configuration',
                false,
                source,
                'The remote review base URL is invalid.',
            );
        }

        if (!this.config.baseUrl && !SUPPORTED_ZAI_MODELS.has(source.model)) {
            return this.unavailable(
                'invalid_configuration',
                false,
                source,
                'The selected model is not compatible with the default Z.AI review endpoint.',
            );
        }

        if (this.config.baseUrl && !SUPPORTED_ZAI_MODELS.has(source.model)) {
            return this.unavailable(
                'invalid_configuration',
                false,
                source,
                'The selected model is not in the supported Z.AI review model set.',
            );
        }

        return undefined;
    }

    private isExplicitTestEndpoint(url: URL): boolean {
        return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname.endsWith('.test');
    }

    private resolveCredential(): Credential | undefined {
        if (this.config.apiKey) {
            return { value: this.config.apiKey, source: 'explicit' };
        }
        if (process.env.ZAI_API_KEY) {
            return { value: process.env.ZAI_API_KEY, source: 'ZAI_API_KEY' };
        }
        if (process.env.ZHIPU_API_KEY) {
            return { value: process.env.ZHIPU_API_KEY, source: 'ZHIPU_API_KEY' };
        }
        return undefined;
    }

    private async fetchReview(
        source: RemoteReviewSource,
        apiKey: string,
        context: ValidationContext,
        externalSignal?: AbortSignal,
    ): Promise<{ kind: 'response'; envelope: unknown } | UnavailableReviewOutcome> {
        const controller = new AbortController();
        let timedOut = false;
        let cancelledExternally = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.config.timeoutMs);
        const onExternalAbort = () => {
            cancelledExternally = true;
            controller.abort();
        };

        if (externalSignal) {
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }

        try {
            let response: Response;
            try {
                response = await fetch(`${source.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                        model: source.model,
                        messages: [
                            { role: 'system', content: REVIEW_SYSTEM_PROMPT },
                            { role: 'user', content: this.buildReviewPrompt(context) },
                        ],
                        temperature: 0.2,
                        max_tokens: 2048,
                        stream: false,
                    }),
                    signal: controller.signal,
                });
            } catch {
                if (cancelledExternally || externalSignal?.aborted) {
                    return this.unavailable('cancelled', false, source, 'Remote review was cancelled by the caller.');
                }
                if (timedOut) {
                    return this.unavailable('timeout', true, source, 'The remote review request timed out.');
                }
                return this.unavailable('network_error', true, source, 'The remote review transport failed before an HTTP response.');
            }

            if (!response.ok) {
                return this.httpFailure(response, source);
            }

            let body: string;
            try {
                body = await response.text();
            } catch {
                if (cancelledExternally || externalSignal?.aborted) {
                    return this.unavailable('cancelled', false, source, 'Remote review was cancelled by the caller.');
                }
                if (timedOut) {
                    return this.unavailable('timeout', true, source, 'The remote review request timed out.');
                }
                return this.unavailable('network_error', true, source, 'The remote review response body could not be read.');
            }

            try {
                return { kind: 'response', envelope: JSON.parse(body) as unknown };
            } catch {
                return this.unavailable(
                    'parsing',
                    false,
                    source,
                    'The remote review response could not be decoded as JSON.',
                );
            }
        } finally {
            clearTimeout(timeoutId);
            externalSignal?.removeEventListener('abort', onExternalAbort);
        }
    }

    private httpFailure(response: Response, source: RemoteReviewSource): UnavailableReviewOutcome {
        if (response.status === 401) {
            return this.unavailable('authentication', false, source, 'The remote review provider rejected authentication.', response.status);
        }
        if (response.status === 403) {
            return this.unavailable('authorization', false, source, 'The remote review provider rejected authorization.', response.status);
        }
        if (response.status === 429) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const retryAfterMs = retryAfterHeader
                ? this.parseRetryAfter(retryAfterHeader)
                : undefined;
            return this.unavailable('rate_limited', true, source, 'The remote review provider rate limited the request.', response.status, retryAfterMs);
        }
        if (response.status >= 500 && response.status <= 599) {
            return this.unavailable('provider_unavailable', true, source, 'The remote review provider is unavailable.', response.status);
        }
        return this.unavailable('provider_unavailable', false, source, 'The remote review provider returned an unsuccessful HTTP response.', response.status);
    }

    private parseRetryAfter(value: string): number | undefined {
        const trimmed = value.trim();
        if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
            return Math.max(0, Math.round(Number(trimmed) * 1000));
        }
        const dateMs = Date.parse(trimmed);
        if (Number.isNaN(dateMs)) {
            return undefined;
        }
        return Math.max(0, dateMs - (this.config.now?.() ?? Date.now()));
    }

    // ============================================================
    // Prompt and response handling
    // ============================================================

    private buildReviewPrompt(context: ValidationContext): string {
        const sanitizedOutput = this.sanitizeDelimitedContent(context.output.substring(0, 8000));
        const sanitizedAdditionalContext = context.additionalContext
            ? this.sanitizeDelimitedContent(context.additionalContext)
            : undefined;

        return `## Task ID: ${context.taskId}

## Code Output to Review
${CODE_DELIMITER}
${sanitizedOutput}
${CODE_DELIMITER}

${sanitizedAdditionalContext ? `## Additional Context\n${sanitizedAdditionalContext}` : ''}

Please review the code above and provide your assessment.`;
    }

    private sanitizeDelimitedContent(content: string): string {
        return content.replaceAll(CODE_DELIMITER, SANITIZED_DELIMITER);
    }

    private extractEnvelope(value: unknown): RemoteEnvelope | undefined {
        if (!this.isRecord(value) || !Array.isArray(value.choices)) {
            return undefined;
        }
        const firstChoice = value.choices[0];
        if (!this.isRecord(firstChoice) || !this.isRecord(firstChoice.message) || typeof firstChoice.message.content !== 'string' || !firstChoice.message.content.trim()) {
            return undefined;
        }

        const usage = this.parseUsage(value.usage);
        return { content: firstChoice.message.content, usage };
    }

    private parseUsage(value: unknown): RemoteEnvelope['usage'] {
        if (!this.isRecord(value)) {
            return undefined;
        }
        const promptTokens = value.prompt_tokens;
        const completionTokens = value.completion_tokens;
        const totalTokens = value.total_tokens;
        if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens) || typeof completionTokens !== 'number' || !Number.isFinite(completionTokens) || typeof totalTokens !== 'number' || !Number.isFinite(totalTokens)) {
            return undefined;
        }
        return {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
        };
    }

    private parseReviewResponse(content: string, source: RemoteReviewSource, credential: string): ReviewOutcome {
        const jsonCandidate = this.findJsonCandidate(content);
        if (!jsonCandidate) {
            return this.unavailable('parsing', false, source, 'The remote review content did not contain a JSON object.');
        }

        let decoded: unknown;
        try {
            decoded = JSON.parse(jsonCandidate);
        } catch {
            return this.unavailable('parsing', false, source, 'The remote review content contained invalid JSON.');
        }

        const parsed = reviewPayloadSchema.safeParse(decoded);
        if (!parsed.success) {
            return this.unavailable('validation', false, source, 'The remote review JSON did not satisfy the required schema.');
        }

        return {
            kind: 'review',
            verdict: parsed.data.verdict,
            findings: parsed.data.findings.map(finding => ({
                ...finding,
                category: this.redactSensitiveText(finding.category, credential),
                message: this.redactSensitiveText(finding.message, credential),
                ...(finding.suggestion === undefined ? {} : { suggestion: this.redactSensitiveText(finding.suggestion, credential) }),
                ...(finding.location === undefined ? {} : { location: this.redactSensitiveText(finding.location, credential) }),
            })),
            summary: this.redactSensitiveText(parsed.data.summary, credential),
            source,
        };
    }

    private redactSensitiveText(text: string, credential: string): string {
        return credential.length > 0 ? text.split(credential).join('[REDACTED]') : text;
    }

    private findJsonCandidate(content: string): string | undefined {
        const start = content.indexOf('{');
        if (start < 0) {
            try {
                const decoded: unknown = JSON.parse(content);
                return this.isRecord(decoded) ? content : undefined;
            } catch {
                return undefined;
            }
        }

        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < content.length; index += 1) {
            const character = content[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (character === '\\') {
                    escaped = true;
                } else if (character === '"') {
                    inString = false;
                }
                continue;
            }
            if (character === '"') {
                inString = true;
            } else if (character === '{') {
                depth += 1;
            } else if (character === '}') {
                depth -= 1;
                if (depth === 0) {
                    return content.substring(start, index + 1);
                }
            }
        }
        return undefined;
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    // ============================================================
    // Heuristic advisory and ValidationResult conversion
    // ============================================================

    private heuristicReview(context: ValidationContext): AdvisoryReviewOutcome {
        const findings: ReviewFinding[] = [];
        const output = context.output;

        const unsafeCastMarker = ['as', 'any'].join(' ');
        if (output.includes('any') && output.includes(unsafeCastMarker)) {
            findings.push({
                severity: 'warning',
                category: 'type_safety',
                message: 'Uses an unsafe any cast — potential type safety issue',
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

        if (/\bcatch\s*\(/.test(output)) {
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

        if (output.includes('eval(') || output.includes('Function(')) {
            findings.push({
                severity: 'error',
                category: 'security',
                message: 'Uses eval() or Function() — potential code injection vulnerability',
                suggestion: 'Use safer alternatives',
            });
        }

        const hasHardcodedCreds = output.split('\n').some(line =>
            /password|secret|api.?key/i.test(line) && /['"][^'"]{8,}['"]/.test(line),
        );
        if (hasHardcodedCreds) {
            findings.push({
                severity: 'error',
                category: 'security',
                message: 'Possible hardcoded credentials detected',
                suggestion: 'Use environment variables',
            });
        }

        const hasErrors = findings.some(finding => finding.severity === 'error');
        return {
            kind: 'advisory',
            verdict: hasErrors ? 'changes_requested' : 'approved',
            findings,
            summary: hasErrors
                ? `Found ${findings.filter(finding => finding.severity === 'error').length} error(s) requiring attention`
                : findings.length > 0
                    ? `Found ${findings.length} suggestions for improvement`
                    : 'Code looks clean, no significant issues detected',
            source: { type: 'heuristic' },
        };
    }

    private withOptionalAdvisory(context: ValidationContext, outcome: UnavailableReviewOutcome): UnavailableReviewOutcome {
        if (!this.config.allowHeuristicFallback) {
            return outcome;
        }
        return { ...outcome, advisory: this.heuristicReview(context) };
    }

    private unavailable(
        reason: ReviewUnavailableReason,
        retryable: boolean,
        source: RemoteReviewSource,
        message: string,
        httpStatus?: number,
        retryAfterMs?: number,
    ): UnavailableReviewOutcome {
        return {
            kind: 'unavailable',
            reason,
            retryable,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            source,
            message,
            ...(httpStatus === undefined ? {} : { httpStatus }),
        };

    }

    private outcomeToResult(outcome: ReviewOutcome): ValidationResult {
        if (outcome.kind === 'unavailable') {
            return {
                isValid: false,
                message: `Remote review unavailable: ${outcome.message}`,
                exitCode: 1,
                details: {
                    kind: outcome.kind,
                    reason: outcome.reason,
                    retryable: outcome.retryable,
                    ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
                    ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
                    source: outcome.source,
                    message: outcome.message,
                    ...(outcome.advisory ? { advisory: outcome.advisory } : {}),
                    qualityGateSatisfied: false,
                },
            };
        }

        if (outcome.kind === 'advisory') {
            return {
                isValid: false,
                message: `Heuristic advisory: ${outcome.summary}`,
                exitCode: 1,
                details: {
                    kind: outcome.kind,
                    verdict: outcome.verdict,
                    findings: outcome.findings,
                    summary: outcome.summary,
                    source: outcome.source,
                    qualityGateSatisfied: false,
                },
            };
        }

        const isValid = outcome.verdict === 'approved' && !outcome.findings.some(finding =>
            SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[this.config.minSeverityToFail],
        );
        const errorCount = outcome.findings.filter(finding => finding.severity === 'error').length;
        const warningCount = outcome.findings.filter(finding => finding.severity === 'warning').length;
        const message = `[${outcome.source.provider}/${outcome.source.model}] ${outcome.summary} (${errorCount} errors, ${warningCount} warnings)`;

        return {
            isValid,
            ...(isValid ? {} : { exitCode: 1 }),
            message,
            details: {
                kind: outcome.kind,
                verdict: outcome.verdict,
                findings: outcome.findings,
                summary: outcome.summary,
                source: outcome.source,
                qualityGateSatisfied: isValid,
            },
        };
    }
}

// ============================================================
// Factory
// ============================================================

export function createMultiModelReviewStrategy(
    config?: Partial<MultiModelReviewConfig>,
): MultiModelReviewStrategy {
    return new MultiModelReviewStrategy(config);
}
