/**
 * ✂️ ToolHistoryCompactor Tests
 */

import { describe, it, expect } from 'bun:test';
import { ToolHistoryCompactor, createToolHistoryCompactor } from './ToolHistoryCompactor.js';
import type { LLMMessage } from './ContextBuilder.js';

describe('ToolHistoryCompactor', () => {
    const compactor = createToolHistoryCompactor(2); // Keep last 2 rounds

    const makeToolRound = (toolName: string, args: string, result: string): LLMMessage[] => [
        {
            role: 'assistant',
            content: `Using ${toolName}`,
            tool_calls: [{
                id: `call_${toolName}`,
                type: 'function',
                function: { name: toolName, arguments: args },
            }],
        },
        {
            role: 'tool',
            content: result,
            tool_call_id: `call_${toolName}`,
        },
    ];

    describe('compact', () => {
        it('does nothing when few rounds', () => {
            const messages: LLMMessage[] = [
                { role: 'system', content: 'System prompt' },
                { role: 'user', content: 'Hello' },
                ...makeToolRound('ls', '{}', 'file1.ts\nfile2.ts'),
            ];

            const result = compactor.compact(messages);
            expect(result.compactedRounds).toBe(0);
            expect(result.messages.length).toBe(messages.length);
        });

        it('compacts old rounds while keeping recent', () => {
            const messages: LLMMessage[] = [
                { role: 'system', content: 'System prompt' },
                { role: 'user', content: 'Build feature' },
                ...makeToolRound('read_file', '{"path":"a.ts"}', 'x'.repeat(1000)),
                ...makeToolRound('grep', '{"query":"foo"}', 'y'.repeat(500)),
                ...makeToolRound('write_file', '{"path":"b.ts","content":"code"}', 'File written'),
                ...makeToolRound('test', '{}', 'All tests pass'),
            ];

            const result = compactor.compact(messages);

            expect(result.compactedRounds).toBe(2); // First 2 of 4 rounds
            expect(result.tokensSaved).toBeGreaterThan(0);
        });

        it('preserves system messages with content blocks', () => {
            const messages: LLMMessage[] = [
                {
                    role: 'system',
                    content: [
                        { type: 'text', text: 'Block 1', cache_control: { type: 'ephemeral' } },
                        { type: 'text', text: 'Block 2' },
                    ],
                },
                { role: 'user', content: 'Go' },
                ...makeToolRound('a', '{}', 'result a'),
                ...makeToolRound('b', '{}', 'result b'),
                ...makeToolRound('c', '{}', 'result c'),
            ];

            const result = compactor.compact(messages);
            // System message should be untouched
            expect(Array.isArray(result.messages[0].content)).toBe(true);
        });

        it('preserves error content in compacted results', () => {
            const messages: LLMMessage[] = [
                { role: 'user', content: 'Go' },
                ...makeToolRound('fail1', '{}', '⚠️ Error: something broke'),
                ...makeToolRound('fail2', '{}', 'Error: compilation failed with 3 errors'),
                ...makeToolRound('ok', '{}', 'Success'),
            ];

            const result = compactor.compact(messages);
            // Error content should be partially preserved
            const toolResults = result.messages.filter(m => m.role === 'tool');
            expect(toolResults[0].content).toContain('Error');
        });

        it('strips large content from write_file args', () => {
            const bigContent = 'x'.repeat(2000);
            const messages: LLMMessage[] = [
                { role: 'user', content: 'Go' },
                ...makeToolRound(
                    'write_file',
                    JSON.stringify({ path: 'big.ts', content: bigContent }),
                    'Written'
                ),
                ...makeToolRound('test1', '{}', 'pass'),
                ...makeToolRound('test2', '{}', 'pass'),
            ];

            const result = compactor.compact(messages);
            const assistantMsg = result.messages.find(
                m => m.role === 'assistant' && m.tool_calls
            );
            if (assistantMsg?.tool_calls) {
                const tc = (assistantMsg.tool_calls as any[])[0];
                const args = JSON.parse(tc.function.arguments);
                expect(args.content._truncated).toBe(true);
            }
        });
    });

    describe('factory', () => {
        it('creates with defaults', () => {
            const c = createToolHistoryCompactor();
            expect(c).toBeDefined();
        });
    });
});
