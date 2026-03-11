/**
 * 🔍 MultiModelReviewStrategy Tests
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { MultiModelReviewStrategy, createMultiModelReviewStrategy } from './MultiModelReviewStrategy.js';
import type { ValidationContext } from '../types.js';

describe('MultiModelReviewStrategy', () => {
    let strategy: MultiModelReviewStrategy;

    beforeEach(() => {
        strategy = createMultiModelReviewStrategy({
            reviewModel: 'gemini-2.5-flash',
            minSeverityToFail: 'error',
        });
    });

    const createContext = (output: string): ValidationContext => ({
        workDir: '/tmp/test',
        taskId: 'test-task-1',
        output,
    });

    // ============================================================
    // Basic Validation
    // ============================================================

    describe('validate', () => {
        it('approves clean code', async () => {
            const result = await strategy.validate(createContext(`
                function add(a: number, b: number): number {
                    return a + b;
                }
            `));

            expect(result.isValid).toBe(true);
            expect(result.message).toContain('no significant issues');
        });

        it('flags eval() as security error', async () => {
            const result = await strategy.validate(createContext(`
                function execute(code: string) {
                    return eval(code);
                }
            `));

            expect(result.isValid).toBe(false);
            expect(result.message).toContain('error');
            expect(result.details?.verdict).toBe('changes_requested');
        });

        it('flags hardcoded credentials', async () => {
            const result = await strategy.validate(createContext(`
                const password = "SuperSecret123!";
                const api_key = "sk-1234567890abcdef";
            `));

            expect(result.isValid).toBe(false);
        });

        it('warns about as any casts', async () => {
            const result = await strategy.validate(createContext(`
                const data = response as any;
                const value = (obj as any).foo;
            `));

            // Warning doesn't fail with minSeverityToFail='error'
            expect(result.isValid).toBe(true);
            expect(result.message).toContain('suggestion');
        });

        it('warns about TODO/FIXME markers', async () => {
            const result = await strategy.validate(createContext(`
                // TODO: implement proper validation
                function validate() {
                    // FIXME: this is wrong
                    return true;
                }
            `));

            expect(result.isValid).toBe(true); // Warnings don't fail by default
            expect(result.details?.findings).toBeDefined();
        });
    });

    // ============================================================
    // Severity Configuration
    // ============================================================

    describe('severity configuration', () => {
        it('fails on warnings when configured', async () => {
            const strictStrategy = createMultiModelReviewStrategy({
                minSeverityToFail: 'warning',
            });

            const result = await strictStrategy.validate(createContext(`
                const data = response as any;
            `));

            expect(result.isValid).toBe(false); // Warning now causes failure
        });

        it('fails on info when configured', async () => {
            const ultrastrictStrategy = createMultiModelReviewStrategy({
                minSeverityToFail: 'info',
            });

            const result = await ultrastrictStrategy.validate(createContext(`
                console.log("debugging");
            `));

            expect(result.isValid).toBe(false);
        });
    });

    // ============================================================
    // performReview
    // ============================================================

    describe('performReview', () => {
        it('returns structured report', async () => {
            const report = await strategy.performReview(createContext(`
                function safe(x: number): number {
                    return x * 2;
                }
            `));

            expect(report.verdict).toBe('approved');
            expect(report.findings).toBeInstanceOf(Array);
            expect(report.summary).toBeTruthy();
            expect(report.reviewModel).toBeTruthy();
        });

        it('returns heuristic model when no API key', async () => {
            const report = await strategy.performReview(createContext('clean code'));
            expect(report.reviewModel).toBe('heuristic');
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
                reviewModel: 'claude-sonnet-4',
                timeoutMs: 30_000,
            });
            expect(s.name).toBe('MultiModelReview');
        });
    });
});
