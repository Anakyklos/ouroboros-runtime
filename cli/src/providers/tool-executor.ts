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

// ============================================================
// ToolExecutor
// ============================================================

export class ToolExecutor {
    private config: ToolExecutorConfig;
    private eventBus: EventBus;
    private handlers: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>;

    constructor(config: ToolExecutorConfig) {
        this.config = {
            commandTimeout: 30000,
            maxOutputSize: 100000,
            verbose: false,
            ...config
        };
        this.eventBus = globalEventBus;
        this.handlers = new Map();

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

        if (!fs.existsSync(searchPath)) {
            return { success: false, output: '', error: `Path not found: ${searchPath}` };
        }

        const results: string[] = [];
        const regex = new RegExp(pattern, 'gi');

        const searchFile = (filePath: string) => {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n');

                for (let i = 0; i < lines.length; i++) {
                    if (regex.test(lines[i])) {
                        results.push(`${filePath}:${i + 1}: ${lines[i].trim()}`);
                    }
                }
            } catch {
                // Skip files that can't be read
            }
        };

        const searchDir = (dir: string) => {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);

                if (item.isDirectory()) {
                    searchDir(fullPath);
                } else if (item.isFile()) {
                    if (!include || this.matchGlob(item.name, include)) {
                        searchFile(fullPath);
                    }
                }
            }
        };

        const stat = fs.statSync(searchPath);
        if (stat.isFile()) {
            searchFile(searchPath);
        } else {
            searchDir(searchPath);
        }

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
