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

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolExecutorConfig {
    workingDirectory: string;
    verbose?: boolean;
    /** Max output size per tool call (default: 50KB) */
    maxOutputSize?: number;
    /** Command timeout in ms (default: 30s) */
    commandTimeout?: number;
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
                    path: {
                        type: 'string',
                        description: 'Absolute or relative path to the file',
                    },
                    start_line: {
                        type: 'number',
                        description: 'Optional start line (1-indexed)',
                    },
                    end_line: {
                        type: 'number',
                        description: 'Optional end line (1-indexed, inclusive)',
                    },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write content to a file. Creates the file if it does not exist. Creates parent directories if needed.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute or relative path to the file',
                    },
                    content: {
                        type: 'string',
                        description: 'Content to write to the file',
                    },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Execute a shell command. Returns stdout and stderr.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The command to execute',
                    },
                    cwd: {
                        type: 'string',
                        description: 'Optional working directory for the command',
                    },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List files and directories in a path. Returns file names with type indicators.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the directory',
                    },
                    recursive: {
                        type: 'boolean',
                        description: 'Whether to list recursively (default: false)',
                    },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'grep_search',
            description: 'Search for a pattern in files. Returns matching lines with file paths and line numbers.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description: 'The search pattern (supports regex)',
                    },
                    path: {
                        type: 'string',
                        description: 'Path to search in (file or directory)',
                    },
                    include: {
                        type: 'string',
                        description: 'Optional glob pattern to filter files (e.g., "*.ts")',
                    },
                },
                required: ['pattern', 'path'],
            },
        },
    },
];

// ============================================================
// ToolExecutor
// ============================================================

export class ToolExecutor {
    private handlers: Map<string, ToolHandler> = new Map();
    private config: Required<ToolExecutorConfig>;
    private eventBus: EventBus;

    constructor(config: ToolExecutorConfig, eventBus?: EventBus) {
        this.config = {
            workingDirectory: config.workingDirectory,
            verbose: config.verbose ?? false,
            maxOutputSize: config.maxOutputSize ?? 50 * 1024, // 50KB
            commandTimeout: config.commandTimeout ?? 30_000, // 30s
        };
        this.eventBus = eventBus ?? globalEventBus;

        // Register built-in handlers
        this.registerHandler('read_file', this.handleReadFile.bind(this));
        this.registerHandler('write_file', this.handleWriteFile.bind(this));
        this.registerHandler('run_command', this.handleRunCommand.bind(this));
        this.registerHandler('list_directory', this.handleListDirectory.bind(this));
        this.registerHandler('grep_search', this.handleGrepSearch.bind(this));

        this.log('info', `Initialized with working directory: ${this.config.workingDirectory}`);
    }

    /**
     * Get tool definitions for Z.AI function calling
     */
    getToolDefinitions(): ToolDefinition[] {
        return TOOL_DEFINITIONS;
    }

    /**
     * Register a custom tool handler
     */
    registerHandler(name: string, handler: ToolHandler): void {
        this.handlers.set(name, handler);
    }

    /**
     * Execute a tool call from Z.AI response
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
            if (result.output.length > this.config.maxOutputSize) {
                result.output = result.output.slice(0, this.config.maxOutputSize) +
                    `\n\n[Output truncated at ${this.config.maxOutputSize} bytes]`;
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

        if (!fs.existsSync(filePath)) {
            return { success: false, output: '', error: `File not found: ${filePath}` };
        }

        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            return { success: false, output: '', error: `Path is a directory: ${filePath}` };
        }

        let content = fs.readFileSync(filePath, 'utf-8');

        // Handle line range
        if (startLine !== undefined || endLine !== undefined) {
            const lines = content.split('\n');
            const start = (startLine ?? 1) - 1;
            const end = endLine ?? lines.length;
            content = lines.slice(start, end).join('\n');
        }

        this.log('debug', `Read ${content.length} chars from ${filePath}`);
        return { success: true, output: content };
    }

    private async handleWriteFile(args: Record<string, unknown>): Promise<ToolResult> {
        const filePath = this.resolvePath(args.path as string);
        const content = args.content as string;

        // Create parent directories
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, content, 'utf-8');

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
                    error: `Command timed out after ${this.config.commandTimeout}ms`,
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

        if (!fs.existsSync(dirPath)) {
            return { success: false, output: '', error: `Directory not found: ${dirPath}` };
        }

        const entries: string[] = [];

        const list = (dir: string, prefix = '') => {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const indicator = item.isDirectory() ? '/' : '';
                entries.push(`${prefix}${item.name}${indicator}`);

                if (recursive && item.isDirectory()) {
                    list(path.join(dir, item.name), `${prefix}${item.name}/`);
                }
            }
        };

        list(dirPath);

        return { success: true, output: entries.join('\n') };
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
