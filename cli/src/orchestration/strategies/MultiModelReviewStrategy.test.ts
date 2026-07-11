/**
 * 🔍 MultiModelReviewStrategy Tests
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, jest } from 'bun:test';
import { MultiModelReviewStrategy, createMultiModelReviewStrategy } from './MultiModelReviewStrategy.js';
import type { ValidationContext } from '../types.js';

describe('MultiModelReviewStrategy', () => {
    let strategy: MultiModelReviewStrategy;
    let originalFetch: any;

    beforeEach(() => {
        strategy = createMultiModelReviewStrategy({
            reviewModel: 'gemini-2.0-flash',
            minSeverityToFail: 'error',
            allowHeuristicFallback: false,
        });
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    const createContext = (output: string): ValidationContext => ({
        workDir: '/tmp/test',
        taskId: 'test-task-1',
        output,
    });

    const mockFetchSuccess = (json: any) => {
        global.fetch = async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: JSON.stringify(json) } }],
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
            }),
        } as any);
    };

    const mockFetchError = (status: number) => {
        global.fetch = async () => ({
            ok: false,
            status,
        } as any);
    };

    // ============================================================
    // Basic Validation (Heuristic - with fallback enabled)
    // ============================================================

    describe('heuristic validation', () => {
        it('approves clean code with heuristic fallback', async () => {
            const heuristicStrategy = createMultiModelReviewStrategy({
                allowHeuristicFallback: true,
            });
            const result = await heuristicStrategy.validate(createContext(`
                function add(a: number, b: number): number {
                    return a + b;
                }
            `));

            expect(result.isValid).toBe(true);
            expect(result.message).toContain('clean');
            expect(result.details?.reviewModel).toBe('heuristic');
        });

        it('flags eval() as security error in heuristic', async () => {
            const heuristicStrategy = createMultiModelReviewStrategy({
                allowHeuristicFallback: true,
            });
            const result = await heuristicStrategy.validate(createContext(`
                function execute(code: string) {
                    return eval(code);
                }
            `));

            expect(result.isValid).toBe(false);
            expect(result.details?.verdict).toBe('changes_requested');
            expect(result.details?.reviewModel).toBe('heuristic');
        });
    });

    // ============================================================
    // LLM Review - Success cases
    // ============================================================

    describe('performReview with LLM', () => {
        beforeEach(() => {
            process.env.ZAI_API_KEY = 'test-key';
        });

        afterEach(() => {
            delete process.env.ZAI_API_KEY;
        });

        it('approves code when LLM approves', async () => {
            mockFetchSuccess({
                verdict: 'approved',
                summary: 'Code is excellent',
                findings: []
            });

            const report = await strategy.performReview(createContext('some code'));

            expect(report.verdict).toBe('approved');
            expect(report.summary).toBe('Code is excellent');
            expect(report.findings).toHaveLength(0);
        });

        it('requests changes when LLM finds errors', async () => {
            mockFetchSuccess({
                verdict: 'changes_requested',
                summary: 'Found some issues',
                findings: [
                    {
                        severity: 'error',
                        category: 'security',
                        message: 'SQL Injection vulnerability',
                        suggestion: 'Use parameterized queries'
                    }
                ]
            });

            const report = await strategy.performReview(createContext('vulnerable code'));

            expect(report.verdict).toBe('changes_requested');
            expect(report.findings[0].severity).toBe('error');
            expect(report.findings[0].category).toBe('security');
        });
    });

    // ============================================================
    // LLM Review - Failure and Fail-Closed cases
    // ============================================================

    describe('fail-closed behavior', () => {
        it('fails when no API key is provided and fallback is disabled', async () => {
            // Ensure no API keys in env
            const oldZai = process.env.ZAI_API_KEY;
            const oldZhipu = process.env.ZHIPU_API_KEY;
            delete process.env.ZAI_API_KEY;
            delete process.env.ZHIPU_API_KEY;

            try {
                const report = await strategy.performReview(createContext('some code'));
                expect(report.verdict).toBe('changes_requested');
                expect(report.findings[0].category).toBe('infrastructure');
                expect(report.findings[0].message).toContain('API key not configured');
            } finally {
                process.env.ZAI_API_KEY = oldZai;
                process.env.ZHIPU_API_KEY = oldZhipu;
            }
        });

        it('fails when API returns error and fallback is disabled', async () => {
            process.env.ZAI_API_KEY = 'test-key';
            mockFetchError(500);

            const report = await strategy.performReview(createContext('some code'));
            expect(report.verdict).toBe('changes_requested');
            expect(report.findings[0].message).toContain('Review API error: 500');

            delete process.env.ZAI_API_KEY;
        });

        it('fails when response JSON is invalid', async () => {
            process.env.ZAI_API_KEY = 'test-key';
            global.fetch = async () => ({
                ok: true,
                json: async () => ({
                    choices: [{ message: { content: 'not a json' } }]
                }),
            } as any);

            const report = await strategy.performReview(createContext('some code'));
            expect(report.verdict).toBe('changes_requested');
            expect(report.findings[0].category).toBe('parsing');

            delete process.env.ZAI_API_KEY;
        });

        it('fails when response format is invalid (missing fields)', async () => {
            process.env.ZAI_API_KEY = 'test-key';
            mockFetchSuccess({
                verdict: 'approved'
                // summary and findings missing
            });

            const report = await strategy.performReview(createContext('some code'));
            expect(report.verdict).toBe('changes_requested');
            expect(report.findings[0].category).toBe('validation');

            delete process.env.ZAI_API_KEY;
        });
    });

    // ============================================================
    // Security and Sanitization
    // ============================================================

    describe('sanitization', () => {
        it('sanitizes triple backticks to prevent prompt injection', async () => {
            process.env.ZAI_API_KEY = 'test-key';
            let capturedPrompt = '';
            global.fetch = async (url, options: any) => {
                capturedPrompt = JSON.parse(options.body).messages[1].content;
                return {
                    ok: true,
                    json: async () => ({
                        choices: [{ message: { content: JSON.stringify({ verdict: 'approved', summary: 'ok', findings: [] }) } }]
                    }),
                } as any;
            };

            await strategy.performReview(createContext('Code with ``` injection'));

            expect(capturedPrompt).not.toContain('``` injection');
            expect(capturedPrompt).toContain('\u0060\u200B\u0060\u200B\u0060 injection');

            delete process.env.ZAI_API_KEY;
        });
    });

    // ============================================================
    // Severity Configuration
    // ============================================================

    describe('severity configuration', () => {
        it('fails on warnings when configured', async () => {
            const strictStrategy = createMultiModelReviewStrategy({
                minSeverityToFail: 'warning',
                allowHeuristicFallback: true,
            });

            const result = await strictStrategy.validate(createContext(`
                const data = response as any;
            `));

            expect(result.isValid).toBe(false);
        });
    });

    // ============================================================
    // Factory
    // ============================================================

    describe('factory', () => {
        it('creates with defaults', () => {
            const s = createMultiModelReviewStrategy();
            expect(s.name).toBe('MultiModelReview');
        });

        it('creates with custom config', () => {
            const s = createMultiModelReviewStrategy({
                reviewModel: 'claude-3-sonnet',
                timeoutMs: 30_000,
            });
            expect(s.name).toBe('MultiModelReview');
        });
    });
});
