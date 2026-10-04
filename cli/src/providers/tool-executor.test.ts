/**
 * ToolExecutor contract tests — fail-close of model-controlled effects (#85).
 *
 * Covers the final contract:
 * - effectful model tool calls (run_command/write_file) are never offered
 *   to the model and never execute: no host process, no file write;
 * - a synthetic provider response containing effectful tool calls, processed
 *   through AgentLoop (the daemon.delegate(glm) and wave-parser shape),
 *   produces no host effect — the central negative gate;
 * - unknown and forbidden tools fail closed;
 * - surviving read-only tools are deterministically confined to the
 *   authorized workspace (external absolute path, ../ traversal, symlink
 *   escape);
 * - refusal diagnostics do not echo model-supplied arguments.
 *
 * Deterministic: temp workspaces under os.tmpdir() and a synthetic provider
 * with a dummy key. No network, no real API key, no secrets.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentLoop } from './agent-loop';
import {
    DirectZAIProvider,
    type ChatResponse,
    type Message,
    type ToolCall,
    type ToolDefinition,
} from './direct-zai';
import { createToolExecutor, ToolExecutor } from './tool-executor';

let callCounter = 0;

function toolCall(
    name: string,
    args: Record<string, unknown>,
    id = `call-${++callCounter}`
): ToolCall {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/**
 * Provider stub that replays scripted responses instead of hitting the
 * network. Records every chat invocation so tests can assert what was
 * fed back to the model.
 */
class SyntheticResponseProvider extends DirectZAIProvider {
    public readonly chats: Message[][] = [];
    private readonly script: ChatResponse[];
    private step = 0;

    constructor(script: ChatResponse[]) {
        super({ apiKey: 'dummy-key-not-used-no-network' });
        this.script = script;
    }

    override async chat(
        messages: Message[],
        _tools?: ToolDefinition[],
        _options?: { temperature?: number; max_tokens?: number; signal?: AbortSignal }
    ): Promise<ChatResponse> {
        this.chats.push([...messages]);
        const response = this.script[Math.min(this.step, this.script.length - 1)];
        this.step += 1;
        return response;
    }
}

function toolCallsResponse(calls: ToolCall[], id: string): ChatResponse {
    return {
        id,
        choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: { role: 'assistant', tool_calls: calls },
        }],
    };
}

function stopResponse(content: string, id: string): ChatResponse {
    return {
        id,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    };
}

describe('ToolExecutor fail-close (issue #85)', () => {
    let workspace: string;
    let executor: ToolExecutor;

    beforeAll(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-tool-executor-'));
        fs.writeFileSync(path.join(workspace, 'existing.txt'), 'original');
        executor = createToolExecutor({ workingDirectory: workspace });
    });

    afterAll(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    test('model is never offered effectful tools', () => {
        const names = executor.getToolDefinitions().map(d => d.function.name);
        expect(names).toContain('read_file');
        expect(names).toContain('list_directory');
        expect(names).toContain('grep_search');
        expect(names).not.toContain('write_file');
        expect(names).not.toContain('run_command');
    });

    test('effectful run_command tool call does not execute a host process', async () => {
        const marker = path.join(workspace, 'shell-marker.txt');
        const result = await executor.execute(
            toolCall('run_command', { command: `touch ${marker}` })
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('disabled');
        expect(fs.existsSync(marker)).toBe(false);
    });

    test('effectful write_file tool call does not create or modify files', async () => {
        const target = path.join(workspace, 'injected.txt');
        const created = await executor.execute(
            toolCall('write_file', { path: target, content: 'injected' })
        );
        expect(created.success).toBe(false);
        expect(fs.existsSync(target)).toBe(false);

        const overwritten = await executor.execute(
            toolCall('write_file', { path: path.join(workspace, 'existing.txt'), content: 'tampered' })
        );
        expect(overwritten.success).toBe(false);
        expect(fs.readFileSync(path.join(workspace, 'existing.txt'), 'utf-8')).toBe('original');
    });

    test('synthetic provider response with effectful tool calls produces no host effect (AgentLoop negative gate)', async () => {
        const loopMarker = path.join(workspace, 'loop-marker.txt');
        const loopInjected = path.join(workspace, 'loop-injected.txt');
        const provider = new SyntheticResponseProvider([
            toolCallsResponse([
                toolCall('run_command', { command: `touch ${loopMarker}` }, 'call-run'),
                toolCall('write_file', { path: loopInjected, content: 'injected' }, 'call-write'),
            ], 'resp-1'),
            stopResponse('done', 'resp-2'),
        ]);

        const agent = new AgentLoop(provider, createToolExecutor({ workingDirectory: workspace }), {
            maxIterations: 5,
        });
        const result = await agent.run('synthesize an effectful response');

        // Loop completed; the effectful calls were processed but refused.
        expect(result.success).toBe(true);
        expect(result.toolCallsCount).toBe(2);
        expect(fs.existsSync(loopMarker)).toBe(false);
        expect(fs.existsSync(loopInjected)).toBe(false);

        // Fail closed is explicit, not silent: refusals are fed back to the model.
        const followUp = provider.chats[1] ?? [];
        const toolMessages = followUp.filter(m => m.role === 'tool');
        expect(toolMessages.length).toBe(2);
        for (const message of toolMessages) {
            expect(message.content).toContain('disabled');
        }
    });

    test('wave parser shape: parser-built executor cannot possess shell or write effects', async () => {
        // parseWaveTasks (rpc-gateway) builds its parser via createAgent, which
        // always constructs the executor through createToolExecutor.
        const parserExecutor = createToolExecutor({ workingDirectory: workspace });
        const names = parserExecutor.getToolDefinitions().map(d => d.function.name);
        expect(names).not.toContain('run_command');
        expect(names).not.toContain('write_file');

        // A parser-style synthetic response that asks for effects stays effect-free.
        const parserMarker = path.join(workspace, 'parser-marker.txt');
        const provider = new SyntheticResponseProvider([
            toolCallsResponse([
                toolCall('run_command', { command: `touch ${parserMarker}` }, 'call-parser'),
            ], 'resp-1'),
            stopResponse('[]', 'resp-2'),
        ]);
        const agent = new AgentLoop(provider, parserExecutor, { maxIterations: 3 });
        const result = await agent.run('WAVE: parse this prompt into tasks');

        expect(result.success).toBe(true);
        expect(fs.existsSync(parserMarker)).toBe(false);
    });

    test('unknown and forbidden tools fail closed', async () => {
        const unknown = await executor.execute(
            toolCall('delete_everything', { path: workspace })
        );
        expect(unknown.success).toBe(false);
        expect(unknown.error).toContain('Unknown tool');

        const forbidden = await executor.execute(
            toolCall('write_file', { path: path.join(workspace, 'x.txt'), content: 'x' })
        );
        expect(forbidden.success).toBe(false);
        expect(forbidden.error).toContain('disabled');
    });

    test('refusal diagnostics do not echo model-supplied arguments', async () => {
        const fakeSecret = 'fake-secret-token-85';
        const refused = await executor.execute(
            toolCall('run_command', { command: `echo ${fakeSecret}` })
        );
        expect(refused.success).toBe(false);
        expect(refused.error).not.toContain(fakeSecret);
        expect(refused.error).not.toContain('echo');

        const badArgs = await executor.execute({
            id: 'call-bad',
            type: 'function',
            function: { name: 'read_file', arguments: '{not-valid-json' },
        });
        expect(badArgs.success).toBe(false);
        expect(badArgs.error).not.toContain('not-valid-json');
    });
});

describe('ToolExecutor read-only workspace confinement (issue #85)', () => {
    let workspace: string;
    let outsideDir: string;
    let outsideFile: string;
    let executor: ToolExecutor;

    beforeAll(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-confine-'));
        outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-confine-outside-'));
        outsideFile = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(outsideFile, 'outside-content');
        fs.writeFileSync(path.join(workspace, 'inside.txt'), 'inside-content');
        executor = createToolExecutor({ workingDirectory: workspace });
    });

    afterAll(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    test('reads a file inside the workspace via relative path', async () => {
        const result = await executor.execute(toolCall('read_file', { path: 'inside.txt' }));
        expect(result.success).toBe(true);
        expect(result.output).toBe('inside-content');
    });

    test('reads a file inside the workspace via absolute path', async () => {
        const result = await executor.execute(
            toolCall('read_file', { path: path.join(workspace, 'inside.txt') })
        );
        expect(result.success).toBe(true);
        expect(result.output).toBe('inside-content');
    });

    test('rejects an absolute path outside the workspace', async () => {
        const result = await executor.execute(toolCall('read_file', { path: outsideFile }));
        expect(result.success).toBe(false);
        expect(result.error).toContain('outside authorized workspace');
        expect(result.output).toBe('');
    });

    test('rejects ../ traversal that escapes the workspace', async () => {
        // workspace and outsideDir are siblings under os.tmpdir()
        const traversal = path.join('..', path.basename(outsideDir), 'secret.txt');
        const result = await executor.execute(toolCall('read_file', { path: traversal }));
        expect(result.success).toBe(false);
        expect(result.error).toContain('outside authorized workspace');
        expect(fs.existsSync(outsideFile)).toBe(true); // untouched
    });

    test('rejects a symlink whose target escapes the workspace', async () => {
        const link = path.join(workspace, 'escape-link.txt');
        fs.symlinkSync(outsideFile, link);
        try {
            const result = await executor.execute(toolCall('read_file', { path: 'escape-link.txt' }));
            expect(result.success).toBe(false);
            expect(result.error).toContain('outside authorized workspace');
        } finally {
            fs.rmSync(link, { force: true });
        }
    });

    test('rejects list_directory outside the workspace', async () => {
        const result = await executor.execute(toolCall('list_directory', { path: outsideDir }));
        expect(result.success).toBe(false);
        expect(result.error).toContain('outside authorized workspace');
    });

    test('rejects grep_search outside the workspace', async () => {
        const result = await executor.execute(
            toolCall('grep_search', { pattern: 'secret', path: outsideDir })
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('outside authorized workspace');
    });

    test('surviving read-only tools still work inside the workspace', async () => {
        const list = await executor.execute(toolCall('list_directory', { path: '.' }));
        expect(list.success).toBe(true);
        expect(list.output).toContain('inside.txt');

        const grep = await executor.execute(
            toolCall('grep_search', { pattern: 'inside-content', path: '.' })
        );
        expect(grep.success).toBe(true);
        expect(grep.output).toContain('inside.txt');
    });
});
