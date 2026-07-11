/**
 * 🔍 MultiModelReviewStrategy Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MultiModelReviewStrategy, createMultiModelReviewStrategy } from './MultiModelReviewStrategy.js';
import type { ValidationContext } from '../types.js';

describe('MultiModelReviewStrategy', () => {
    let strategy: MultiModelReviewStrategy;
    let originalFetch: typeof globalThis.fetch;

    const snapshotEnv = () => {
        return {
            ZAI_API_KEY: process.env.ZAI_API_KEY,
            ZHIPU_API_KEY: process.env.ZHIPU_API_KEY,
        };
    };

    const restoreEnv = (snapshot: Record<string, string | undefined>) => {
        for (const [key, value] of Object.entries(snapshot)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    };

    let envSnapshot: Record<string, string | undefined>;

    beforeEach(() => {
        strategy = createMultiModelReviewStrategy({
            reviewModel: 'glm-4-flash',
            minSeverityToFail: 'error',
            allowHeuristicFallback: false,
        });
        originalFetch = global.fetch;
        envSnapshot = snapshotEnv();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        restoreEnv(envSnapshot);
    });

    const createContext = (output: string): ValidationContext => ({
        workDir: '/tmp/test',
        taskId: 'test-task-1',
        output,
    });

    const mockFetchSuccess = (json: any) => {
        global.fetch = (async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: JSON.stringify(json) } }],
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
            }),
        } as any)) as typeof globalThis.fetch;
    };

    const mockFetchError = (status: number) => {
        global.fetch = (async () => ({
            ok: false,
            status,
            statusText: 'Error',
            text: async () => 'Error body',
        } as any)) as typeof globalThis.fetch;
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
            delete process.env.ZAI_API_KEY;
            delete process.env.ZHIPU_API_KEY;

            const report = await strategy.performReview(createContext('some code'));
            expect(report.verdict).toBe('changes_requested');
            expect(report.findings[0].category).toBe('infrastructure');
            expect(report.findings[0].message).toContain('API key not configured');
        });

        it('fails validation when API returns error', async () => {
            process.env.ZAI_API_KEY = 'test-key';
            mockFetchError(500);

            const result = await strategy.validate(createContext('some code'));
            expect(result.isValid).toBe(false);
            expect(result.message).toContain('Review API error: 500');
        });

        it('fails when response JSON is invalid', async () => {
            process.env.ZAI_API_KEY = 'test-key';
            // Simulate content that doesn't contain valid JSON structure
            global.fetch = (async () => ({
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [{ message: { content: 'This is not JSON at all' } }]
                }),
            } as any)) as typeof globalThis.fetch;

            const result = await strategy.validate(createContext('some code'));
            expect(result.isValid).toBe(false);
            expect(result.details?.findings[0].category).toBe('parsing');
        });

        it('fails when response format is invalid (missing fields)', async () => {
            process.env.ZAI_API_KEY = 'test-key';
            mockFetchSuccess({
                verdict: 'approved'
                // summary and findings missing
            });

            const result = await strategy.validate(createContext('some code'));
            expect(result.isValid).toBe(false);
            expect(result.details?.findings[0].category).toBe('validation');
        });

        it('handles timeout correctly', async () => {
            process.env.ZAI_API_KEY = 'test-key';
            global.fetch = (async (url: any, options: any) => {
                const signal = options?.signal;
                return new Promise((_, reject) => {
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            const err = new Error('The operation was aborted');
                            err.name = 'AbortError';
                            reject(err);
                        });
                    }
                });
            }) as any;

            const timeoutStrategy = createMultiModelReviewStrategy({
                timeoutMs: 10,
            });

            const result = await timeoutStrategy.validate(createContext('some code'));
            expect(result.isValid).toBe(false);
            expect(result.message).toContain('aborted');
        });

        it('uses default GLM model and ZAI endpoint by default', async () => {
            process.env.ZAI_API_KEY = 'test-key';
            let capturedUrl = '';
            let capturedBody: any = {};
            global.fetch = (async (url: string, options: any) => {
                capturedUrl = url;
                capturedBody = JSON.parse(options.body);
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        choices: [{ message: { content: JSON.stringify({ verdict: 'approved', summary: 'ok', findings: [] }) } }]
                    }),
                } as any;
            }) as typeof globalThis.fetch;

            await strategy.performReview(createContext('code'));

            expect(capturedUrl).toContain('api.z.ai');
            expect(capturedBody.model).toBe('glm-4-flash');
        });
    });

    // ============================================================
    // Security and Sanitization
    // ============================================================

    describe('sanitization', () => {
        it('sanitizes triple backticks to prevent prompt injection', async () => {
            process.env.ZAI_API_KEY = 'test-key';
            let capturedPrompt = '';
            global.fetch = (async (url: any, options: any) => {
                capturedPrompt = JSON.parse(options.body).messages[1].content;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        choices: [{ message: { content: JSON.stringify({ verdict: 'approved', summary: 'ok', findings: [] }) } }]
                    }),
                } as any;
            }) as typeof globalThis.fetch;

            await strategy.performReview(createContext('Code with ``` injection'));

            expect(capturedPrompt).not.toContain('``` injection');
            expect(capturedPrompt).toContain('\u0060\u200B\u0060\u200B\u0060 injection');
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
