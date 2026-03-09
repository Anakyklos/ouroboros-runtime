/**
 * 🧱 ContextBuilder Tests
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
    ContextBuilder,
    createContextBuilder,
    estimateTokens,
    clipText,
    type ContentBlock,
    type LLMMessage,
} from './ContextBuilder.js';

describe('ContextBuilder', () => {
    let builder: ContextBuilder;

    beforeEach(() => {
        builder = createContextBuilder({
            systemPrompt: 'You are a test assistant.',
            projectRoot: '/tmp/test',
            softCapTokens: 200_000,
        });
    });

    // ============================================================
    // build()
    // ============================================================

    describe('build', () => {
        it('builds messages with 3-block system message', () => {
            builder.setSemiStableProvider(() => '## Identity\n\nI am Ouroboros.');
            builder.setDynamicProvider(() => '## Health\n\nAll OK');

            const result = builder.build('Hello');

            expect(result.messages.length).toBe(2);
            expect(result.messages[0].role).toBe('system');
            expect(result.messages[1].role).toBe('user');
            expect(result.messages[1].content).toBe('Hello');

            // System message should have ContentBlock array
            const blocks = result.messages[0].content as ContentBlock[];
            expect(Array.isArray(blocks)).toBe(true);
            expect(blocks.length).toBe(3); // static + semi-stable + dynamic
        });

        it('static block has 1h cache control', () => {
            const result = builder.build('Hi');
            const blocks = result.messages[0].content as ContentBlock[];

            expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        });

        it('semi-stable block has ephemeral cache control', () => {
            builder.setSemiStableProvider(() => 'Identity content');
            const result = builder.build('Hi');
            const blocks = result.messages[0].content as ContentBlock[];

            const semiBlock = blocks.find(b =>
                b.cache_control && !b.cache_control.ttl && b.text.includes('Identity')
            );
            expect(semiBlock).toBeDefined();
            expect(semiBlock!.cache_control).toEqual({ type: 'ephemeral' });
        });

        it('dynamic block has no cache control', () => {
            builder.setDynamicProvider(() => 'Health check');
            const result = builder.build('Hi');
            const blocks = result.messages[0].content as ContentBlock[];

            const dynamicBlock = blocks.find(b => !b.cache_control);
            expect(dynamicBlock).toBeDefined();
        });

        it('omits empty semi-stable block', () => {
            // No semi-stable provider set
            const result = builder.build('Hi');
            const blocks = result.messages[0].content as ContentBlock[];

            // Should have static + dynamic only (2 blocks)
            expect(blocks.length).toBe(2);
        });

        it('includes additional context in dynamic block', () => {
            const result = builder.build('Hi', 'Task history data here');
            const blocks = result.messages[0].content as ContentBlock[];

            const dynamicBlock = blocks.find(b => !b.cache_control);
            expect(dynamicBlock!.text).toContain('Task history data');
        });

        it('returns token estimates', () => {
            const result = builder.build('Hello world');

            expect(result.estimatedTokens).toBeGreaterThan(0);
            expect(result.blocks.staticTokens).toBeGreaterThan(0);
        });
    });

    // ============================================================
    // buildFlat()
    // ============================================================

    describe('buildFlat', () => {
        it('returns flat system prompt string', () => {
            builder.setSemiStableProvider(() => 'Identity block');
            builder.setDynamicProvider(() => 'Dynamic block');

            const { systemPrompt, estimatedTokens } = builder.buildFlat('Hello');

            expect(typeof systemPrompt).toBe('string');
            expect(systemPrompt).toContain('test assistant');
            expect(systemPrompt).toContain('Identity block');
            expect(systemPrompt).toContain('Dynamic block');
            expect(estimatedTokens).toBeGreaterThan(0);
        });
    });

    // ============================================================
    // Soft Cap Trimming
    // ============================================================

    describe('soft cap trimming', () => {
        it('trims when exceeding soft cap', () => {
            // Create a builder with very low cap
            const tinyBuilder = createContextBuilder({
                systemPrompt: 'Short prompt',
                softCapTokens: 50,
            });

            tinyBuilder.setDynamicProvider(() => [
                '## Recent Chat\n\n' + 'x'.repeat(100),
                '## Recent Progress\n\n' + 'y'.repeat(100),
                '## Health\n\nAll OK',
            ].join('\n\n'));

            const result = tinyBuilder.build('Hi');

            // Should have trimmed some sections
            expect(result.trimmedSections.length).toBeGreaterThan(0);
        });

        it('does not trim when under soft cap', () => {
            const result = builder.build('Short message');
            expect(result.trimmedSections.length).toBe(0);
        });
    });

    // ============================================================
    // Utilities
    // ============================================================

    describe('estimateTokens', () => {
        it('estimates roughly 4 chars per token', () => {
            const tokens = estimateTokens('Hello world');
            // "Hello world" = 11 chars → ~3 tokens
            expect(tokens).toBe(3);
        });

        it('returns 0 for empty string', () => {
            expect(estimateTokens('')).toBe(0);
        });
    });

    describe('clipText', () => {
        it('returns text as-is if under limit', () => {
            expect(clipText('short', 100)).toBe('short');
        });

        it('clips text and adds truncation marker', () => {
            const long = 'a'.repeat(200);
            const clipped = clipText(long, 50);
            expect(clipped.length).toBeLessThan(200);
            expect(clipped).toContain('[... truncated]');
        });
    });

    // ============================================================
    // Factory
    // ============================================================

    describe('factory', () => {
        it('creates with defaults', () => {
            const b = createContextBuilder();
            const result = b.build('Test');
            expect(result.messages.length).toBe(2);
        });
    });
});
