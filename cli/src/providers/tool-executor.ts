/**
 * 🔧 ToolExecutor
 *
 * Read-only local tools for the legacy AgentLoop.
 * Implements: read_file, list_directory, grep_search
 *
 * ⚠️ SECURITY (#85): the model may only invoke a fixed allowlist of
 * read-only tools (`read_file`, `list_directory`, `grep_search`).
 * Effectful tools (`write_file`, `run_command`), unknown names and
 * dynamically registered handlers all fail closed before dispatch —
 * no host process is spawned and no file is created or modified.
 * Effectful work belongs to deterministic policy / Capability
 * Registry / capability owners (Runstead for software work), never
 * to a raw model tool call.
 *
 * Surviving read-only tools are deterministically confined to the
 * authorized workspace: external absolute paths, `../` traversal and
 * symlinks that escape the workspace are rejected.
 *
 * ⚠️ SECURITY (#85): credential sources (`.secrets`, legacy
 * `Apikeys`, `.env` and `.env.*` variants) are denied on their
 * canonical path, so relative, absolute and symlink aliases cannot
 * read them, and recursive grep skips them during traversal.
 *
 * ⚠️ SECURITY (#85): telemetry is bounded at the source. Logs
 * and returned errors carry only tool name, success/failure,
 * character counts, result counts and fixed error categories —
 * never a model-supplied path, pattern, include or other raw
 * argument (which would reach the global EventBus under
 * verbose=true and the chat history via tool_result).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventBus, globalEventBus } from '../daemon/event-bus.js';
import type { ToolCall, ToolDefinition } from './direct-zai.js';

// ============================================================
// Types
// ============================================================

export interface ToolExecutorConfig {
    workingDirectory: string;
    maxOutputSize?: number; // chars
    verbose?: boolean;
    concurrencyLimit?: number; // Max concurrent FS operations
}

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
}

// ============================================================
// Tool Definitions (for provider function calling)
// ============================================================

const TOOL_DEFINITIONS: ToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the contents of a file within the authorized workspace. Returns the file content as text.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the file to read' },
                    start_line: { type: 'integer', description: 'Optional start line number (1-based)' },
                    end_line: { type: 'integer', description: 'Optional end line number (1-based)' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List contents of a directory within the authorized workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path' },
                    recursive: { type: 'boolean', description: 'List recursively (default: false)' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'grep_search',
            description: 'Search for a text pattern in files within the authorized workspace.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Regex pattern to search' },
                    path: { type: 'string', description: 'Directory or file to search in' },
                    include: { type: 'string', description: 'Glob pattern for file names to include (e.g. *.ts)' }
                },
                required: ['pattern', 'path']
            }
        }
    }
];

// Fixed allowlist of the read-only tools the model is authorized to
// invoke. Everything else — effectful, unknown, or dynamically
// registered under an arbitrary name — fails closed before handler
// lookup, so no registration can turn model output into new
// authority. (#85)
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
    'read_file',
    'list_directory',
    'grep_search',
]);

// Credential sources used by this runtime (rpc-gateway loadZAIKey
// reads `.secrets` and legacy `Apikeys`; dotenv loads `.env` and
// its variants). Model-controlled read-only tools must never
// return their content. (#85)
const SENSITIVE_FILE_NAMES: ReadonlySet<string> = new Set([
    '.secrets',
    'Apikeys',
    '.env',
]);

function isSensitiveFileName(basename: string): boolean {
    return SENSITIVE_FILE_NAMES.has(basename) || basename.startsWith('.env.');
}

// ============================================================
// Concurrency Limiter
// ============================================================

type Task<T = void> = () => Promise<T>;

class ConcurrencyLimiter {
    private active = 0;
    private queue: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    async run<T>(task: Task<T>): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>((resolve) => this.queue.push(resolve));
        }

        this.active++;
        try {
            return await task();
        } finally {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
        }
    }
}

// ============================================================
// ToolExecutor
// ============================================================

export class ToolExecutor {
    private config: ToolExecutorConfig;
    private eventBus: EventBus;
    private handlers: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>;
    private concurrencyLimiter: ConcurrencyLimiter;

    constructor(config: ToolExecutorConfig) {
        this.config = {
            maxOutputSize: 100000,
            verbose: false,
            ...config
        };
        this.eventBus = globalEventBus;
        this.handlers = new Map();
        this.concurrencyLimiter = new ConcurrencyLimiter(this.config.concurrencyLimit ?? 10);

        // Read-only tools only. Effectful tools are intentionally absent. (#85)
        this.registerHandler('read_file', this.handleReadFile.bind(this));
        this.registerHandler('list_directory', this.handleListDirectory.bind(this));
        this.registerHandler('grep_search', this.handleGrepSearch.bind(this));
    }

    /**
     * Registers a handler. Registration alone does NOT grant model
     * authority: `execute()` only dispatches names on the fixed
     * read-only allowlist. (#85)
     */
    registerHandler(name: string, handler: (args: Record<string, unknown>) => Promise<ToolResult>): void {
        this.handlers.set(name, handler);
    }

    /**
     * Returns tool definitions for provider function calling.
     * Read-only tools only; effectful tools are never advertised. (#85)
     */
    getToolDefinitions(): ToolDefinition[] {
        return TOOL_DEFINITIONS;
    }

    /**
     * Executes a tool call from a provider response.
     * Effectful and unknown tools fail closed before any host effect. (#85)
     */
    async execute(call: ToolCall): Promise<ToolResult> {
        const toolName = call.function.name;

        // Fail closed against the fixed allowlist: effectful, unknown
        // and dynamically registered names are all unreachable from
        // model output, regardless of what the provider response
        // claims. (#85)
        if (!READ_ONLY_TOOLS.has(toolName)) {
            this.log('warn', `Refused tool call outside read-only allowlist: ${toolName}`);
            return {
                success: false,
                output: '',
                error: `Tool '${toolName}' is not permitted in this runtime: only read-only workspace tools are authorized (#85)`,
            };
        }

        const handler = this.handlers.get(toolName);

        if (!handler) {
            return {
                success: false,
                output: '',
                error: `Tool '${toolName}' has no handler`,
            };
        }

        let args: Record<string, unknown>;
        try {
            args = JSON.parse(call.function.arguments);
        } catch {
            // Do not echo raw arguments back: they are model-supplied and
            // may contain sensitive content. (#85)
            return {
                success: false,
                output: '',
                error: 'Invalid arguments JSON',
            };
        }

        this.log('debug', `Executing tool: ${toolName}`);

        try {
            const result = await handler(args);

            // Truncate if too large
            if (result.output.length > this.config.maxOutputSize!) {
                result.output = result.output.slice(0, this.config.maxOutputSize!) +
                    `\n\n[Output truncated at ${this.config.maxOutputSize!} characters]`;
            }

            return result;
        } catch (err) {
            return {
                success: false,
                output: '',
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ============================================================
    // Tool Handlers (read-only)
    // ============================================================

    private async handleReadFile(args: Record<string, unknown>): Promise<ToolResult> {
        const inputPath = args.path as string;
        const startLine = args.start_line as number | undefined;
        const endLine = args.end_line as number | undefined;

        let filePath: string;
        try {
            filePath = await this.confinePath(inputPath);
        } catch (err) {
            return { success: false, output: '', error: err instanceof Error ? err.message : String(err) };
        }

        try {
            let content = await fs.promises.readFile(filePath, 'utf-8');

            // Handle line range
            if (startLine !== undefined || endLine !== undefined) {
                const lines = content.split('\n');
                const start = (startLine ?? 1) - 1;
                const end = endLine ?? lines.length;
                content = lines.slice(start, end).join('\n');
            }

            // Bounded telemetry: char count only, never the
            // model-supplied path. (#85)
            this.log('debug', `Read ${content.length} chars from workspace file`);
            return { success: true, output: content };
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code === 'ENOENT') {
                return { success: false, output: '', error: 'Path is not a readable file' };
            }
            if (err.code === 'EISDIR') {
                return { success: false, output: '', error: 'Path is not a readable file' };
            }
            // err.message may echo the canonical path; fixed category. (#85)
            return { success: false, output: '', error: 'Error reading file' };
        }
    }

    private async handleListDirectory(args: Record<string, unknown>): Promise<ToolResult> {
        const inputPath = args.path as string;
        const recursive = args.recursive as boolean ?? false;
        const CONCURRENCY_LIMIT = 10;

        let dirPath: string;
        try {
            dirPath = await this.confinePath(inputPath);
        } catch (err) {
            return { success: false, output: '', error: err instanceof Error ? err.message : String(err) };
        }

        const list = async (dir: string, prefix = ''): Promise<string[]> => {
            const items = await fs.promises.readdir(dir, { withFileTypes: true });
            const results: string[][] = new Array(items.length);

            // Simple worker pool for concurrency limiting
            let nextIndex = 0;
            const workers = Array.from({ length: Math.min(CONCURRENCY_LIMIT, items.length) }, async () => {
                while (nextIndex < items.length) {
                    const index = nextIndex++;
                    const item = items[index];
                    const indicator = item.isDirectory() ? '/' : '';
                    const entry = `${prefix}${item.name}${indicator}`;

                    if (recursive && item.isDirectory()) {
                        try {
                            const subEntries = await list(path.join(dir, item.name), `${prefix}${item.name}/`);
                            results[index] = [entry, ...subEntries];
                        } catch {
                            // Skip inaccessible subdirectories or files that disappeared
                            results[index] = [entry];
                        }
                    } else {
                        results[index] = [entry];
                    }
                }
            });

            await Promise.all(workers);
            return results.flat();
        };

        try {
            const entries = await list(dirPath);
            return { success: true, output: entries.join('\n') };
        } catch {
            // err.message may echo the canonical path; fixed category. (#85)
            return {
                success: false,
                output: '',
                error: 'Error listing directory'
            };
        }
    }

    private async handleGrepSearch(args: Record<string, unknown>): Promise<ToolResult> {
        const pattern = args.pattern as string;
        const inputPath = args.path as string;
        const include = args.include as string | undefined;

        let searchPath: string;
        try {
            searchPath = await this.confinePath(inputPath);
        } catch (err) {
            return { success: false, output: '', error: err instanceof Error ? err.message : String(err) };
        }

        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(searchPath);
        } catch {
            // Fixed category: never echo the model-supplied path or
            // the canonical path from fs error messages. (#85)
            return { success: false, output: '', error: 'Path not found' };
        }

        const results: string[] = [];
        // Use 'i' flag only (case-insensitive) to avoid stateful regex issues with 'g'
        let regex: RegExp;
        try {
            regex = new RegExp(pattern, 'i');
        } catch {
            // SyntaxError messages echo the raw pattern; fixed category. (#85)
            return { success: false, output: '', error: 'Invalid search pattern' };
        }

        const searchFile = async (filePath: string) => {
            try {
                // Skip credential sources during recursive traversal so
                // their content never reaches grep output. (#85)
                if (isSensitiveFileName(path.basename(filePath))) {
                    return;
                }
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const lines = content.split('\n');

                // Normalize path separators to forward slashes for cross-platform consistency
                const normalizedPath = filePath.split(path.sep).join('/');

                for (let i = 0; i < lines.length; i++) {
                    if (regex.test(lines[i])) {
                        results.push(`${normalizedPath}:${i + 1}: ${lines[i].trim()}`);
                    }
                }
            } catch {
                // Skip files that can't be read
            }
        };

        const processDir = async (dir: string) => {
            // Enqueue readdir to respect global concurrency limit
            const items = await this.enqueueFsTask(() => fs.promises.readdir(dir, { withFileTypes: true }));

            await Promise.all(items.map(item => this.enqueueFsTask(async () => {
                 const fullPath = path.join(dir, item.name);

                 if (item.isDirectory()) {
                     await processDir(fullPath);
                 } else if (item.isFile()) {
                     if (!include || this.matchGlob(item.name, include)) {
                         await searchFile(fullPath);
                     }
                 }
             })));
        };

        try {
            if (stat.isFile()) {
                await searchFile(searchPath);
            } else {
                await processDir(searchPath);
            }
        } catch {
            // Fixed category: fs error messages echo canonical paths. (#85)
            return { success: false, output: '', error: 'Error searching workspace' };
        }

        // Sort results for deterministic output
        results.sort();

        return {
            success: true,
            output: results.length > 0
                ? results.join('\n')
                : 'No matches found'
        };
    }

    // ============================================================
    // Helpers
    // ============================================================

    private enqueueFsTask<T>(task: Task<T>): Promise<T> {
        return this.concurrencyLimiter.run(task);
    }

    /**
     * Resolves a model-supplied path inside the authorized workspace.
     * Rejects external absolute paths, `../` traversal that escapes the
     * workspace, and symlinks whose real target leaves the workspace. (#85)
     */
    private async confinePath(inputPath: string): Promise<string> {
        const workspace = path.resolve(this.config.workingDirectory);
        const workspaceReal = await fs.promises.realpath(workspace);

        const candidate = path.isAbsolute(inputPath)
            ? path.resolve(inputPath)
            : path.resolve(workspace, inputPath);

        let real: string;
        try {
            real = await fs.promises.realpath(candidate);
        } catch {
            // Generic: never echo model-supplied input back, it
            // may itself carry sensitive content. (#85)
            throw new Error('Path not found');
        }

        if (real !== workspaceReal && !real.startsWith(workspaceReal + path.sep)) {
            throw new Error('Path outside authorized workspace');
        }

        // Credential-source denial on the canonical path: defeats
        // relative, absolute and symlink aliases alike. The error is
        // generic — no content, no resolved path. (#85)
        if (isSensitiveFileName(path.basename(real))) {
            throw new Error('Access denied: sensitive paths are not readable by this runtime (#85)');
        }

        return real;
    }

    private matchGlob(filename: string, pattern: string): boolean {
        // Simple glob matching (*.ts, *.js, etc.)
        const regex = new RegExp(
            '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
        );
        return regex.test(filename);
    }

    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        if (this.config.verbose) {
            this.eventBus.log(level, message, 'ToolExecutor');
        }
    }
}

// ============================================================
// Factory
// ============================================================

export function createToolExecutor(config: ToolExecutorConfig): ToolExecutor {
    return new ToolExecutor(config);
}
