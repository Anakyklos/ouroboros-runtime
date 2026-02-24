/**
 * 🔧 ToolExecutor
 * 
 * Executa ferramentas locais para o subagente Z.AI.
 * Implementa: read_file, write_file, run_command, list_directory, grep_search
 * 
 * ⚠️ IMPORTANTE: Estas são NOSSAS tools, não as do Z.AI.
 * O function calling é ilimitado - só a execução roda aqui.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { EventBus, globalEventBus } from '../daemon/event-bus.js';
import type { ToolCall, ToolDefinition } from './direct-zai.js';

// ============================================================
// Types
// ============================================================

export interface ToolExecutorConfig {
    workingDirectory: string;
    allowedCommands?: string[]; // Allowlist for run_command
    commandTimeout?: number; // ms
    maxOutputSize?: number; // chars
    verbose?: boolean;
}

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
}
    /** Max output size per tool call (default: 50KB) */
    maxOutputSize?: number;
    /** Command timeout in ms (default: 30s) */
    commandTimeout?: number;
    /** Max concurrent FS operations (default: 20) */
    concurrencyLimit?: number;
}

// ============================================================
// Tool Definitions (for Z.AI function calling)
// ============================================================

const TOOL_DEFINITIONS: ToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the contents of a file. Returns the file content as text.',
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
            name: 'write_file',
            description: 'Write content to a file. Creates directories if they do not exist.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the file to write' },
                    content: { type: 'string', description: 'Content to write' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Run a shell command.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Command to run' },
                    cwd: { type: 'string', description: 'Optional working directory' }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List contents of a directory.',
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
            description: 'Search for a text pattern in files.',
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
            commandTimeout: 30000,
            maxOutputSize: 100000,
            verbose: false,
            ...config
        };
        this.eventBus = globalEventBus;
        this.handlers = new Map();
            workingDirectory: config.workingDirectory,
            verbose: config.verbose ?? false,
            maxOutputSize: config.maxOutputSize ?? 50 * 1024, // 50KB
            commandTimeout: config.commandTimeout ?? 30_000, // 30s
            concurrencyLimit: config.concurrencyLimit ?? 20,
        };
        this.eventBus = eventBus ?? globalEventBus;
        this.concurrencyLimiter = new ConcurrencyLimiter(this.config.concurrencyLimit!);

        // Register tools
        this.registerHandler('read_file', this.handleReadFile.bind(this));
        this.registerHandler('write_file', this.handleWriteFile.bind(this));
        this.registerHandler('run_command', this.handleRunCommand.bind(this));
        this.registerHandler('list_directory', this.handleListDirectory.bind(this));
        this.registerHandler('grep_search', this.handleGrepSearch.bind(this));
    }

    registerHandler(name: string, handler: (args: Record<string, unknown>) => Promise<ToolResult>): void {
        this.handlers.set(name, handler);
    }

    /**
     * Executes a tool call from Z.AI response
     */
    async execute(call: ToolCall): Promise<ToolResult> {
        const handler = this.handlers.get(call.function.name);

        if (!handler) {
            return {
                success: false,
                output: '',
                error: `Unknown tool: ${call.function.name}`,
            };
        }

        let args: Record<string, unknown>;
        try {
            args = JSON.parse(call.function.arguments);
        } catch {
            return {
                success: false,
                output: '',
                error: `Invalid arguments JSON: ${call.function.arguments}`,
            };
        }

        this.log('debug', `Executing tool: ${call.function.name}`);

        try {
            const result = await handler(args);

            // Truncate if too large
            if (result.output.length > this.config.maxOutputSize!) {
                result.output = result.output.slice(0, this.config.maxOutputSize!) +
                    `\n\n[Output truncated at ${this.config.maxOutputSize!} bytes]`;
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
    // Tool Handlers
    // ============================================================

    private async handleReadFile(args: Record<string, unknown>): Promise<ToolResult> {
        const filePath = this.resolvePath(args.path as string);
        const startLine = args.start_line as number | undefined;
        const endLine = args.end_line as number | undefined;

        try {
            let content = await fs.promises.readFile(filePath, 'utf-8');

            // Handle line range
            if (startLine !== undefined || endLine !== undefined) {
                const lines = content.split('\n');
                const start = (startLine ?? 1) - 1;
                const end = endLine ?? lines.length;
                content = lines.slice(start, end).join('\n');
            }

            this.log('debug', `Read ${content.length} chars from ${filePath}`);
            return { success: true, output: content };
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code === 'ENOENT') {
                return { success: false, output: '', error: `File not found: ${filePath}` };
            }
            if (err.code === 'EISDIR') {
                return { success: false, output: '', error: `Path is a directory: ${filePath}` };
            }
            return { success: false, output: '', error: `Error reading file: ${err.message}` };
        }
    }

    private async handleWriteFile(args: Record<string, unknown>): Promise<ToolResult> {
        const filePath = this.resolvePath(args.path as string);
        const content = args.content as string;

        // Create parent directories
        const dir = path.dirname(filePath);

        // Check if exists to avoid mkdir overhead if possible
        try {
            await fs.promises.access(dir);
        } catch {
            await fs.promises.mkdir(dir, { recursive: true });
        }

        await fs.promises.writeFile(filePath, content, 'utf-8');

        this.log('info', `Wrote ${content.length} chars to ${filePath}`);
        return { success: true, output: `File written: ${filePath}` };
    }

    private async handleRunCommand(args: Record<string, unknown>): Promise<ToolResult> {
        const command = args.command as string;
        const cwd = args.cwd ? this.resolvePath(args.cwd as string) : this.config.workingDirectory;

        this.log('debug', `Running: ${command}`);

        return new Promise((resolve) => {
            const proc = spawn(command, [], {
                shell: true,
                cwd,
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            const timeout = setTimeout(() => {
                proc.kill();
                resolve({
                    success: false,
                    output: stdout,
                    error: `Command timed out after ${this.config.commandTimeout!}ms`,
                });
            }, this.config.commandTimeout);

            proc.on('close', (code) => {
                clearTimeout(timeout);
                resolve({
                    success: code === 0,
                    output: stdout + (stderr ? `\n[stderr]\n${stderr}` : ''),
                    error: code !== 0 ? `Exit code: ${code}` : undefined,
                });
            });

            proc.on('error', (err) => {
                clearTimeout(timeout);
                resolve({
                    success: false,
                    output: '',
                    error: err.message,
                });
            });
        });
    }

    private async handleListDirectory(args: Record<string, unknown>): Promise<ToolResult> {
        const dirPath = this.resolvePath(args.path as string);
        const recursive = args.recursive as boolean ?? false;
        const CONCURRENCY_LIMIT = 10;

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
        } catch (err) {
            return {
                success: false,
                output: '',
                error: `Error listing directory: ${err instanceof Error ? err.message : String(err)}`
            };
        }
    }

    private async handleGrepSearch(args: Record<string, unknown>): Promise<ToolResult> {
        const pattern = args.pattern as string;
        const searchPath = this.resolvePath(args.path as string);
        const include = args.include as string | undefined;

        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(searchPath);
        } catch (error: any) {
             if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
                return { success: false, output: '', error: `Path not found: ${searchPath}` };
            }
            throw error;
        }

        const results: string[] = [];
        // Use 'i' flag only (case-insensitive) to avoid stateful regex issues with 'g'
        const regex = new RegExp(pattern, 'i');

        const searchFile = async (filePath: string) => {
            try {
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

        if (stat.isFile()) {
            await searchFile(searchPath);
        } else {
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

            await processDir(searchPath);
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

    private resolvePath(inputPath: string): string {
        if (path.isAbsolute(inputPath)) {
            return inputPath;
        }
        return path.join(this.config.workingDirectory, inputPath);
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
