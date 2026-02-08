/**
 * GeminiCliBridge - Full Parasitic Control of Gemini CLI
 * 
 * Ouroboros assumes complete control of the Gemini CLI, exposing all
 * its capabilities as native features. Like a parasite fixed to the
 * brain, controlling every function.
 */

import { spawn, ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";
import { getOuroborosEnv } from "../utils/ouroboros.js";

// ============================================================================
// Types
// ============================================================================

export type GeminiModel = "flash" | "pro" | "auto";

export interface GeminiCliConfig {
    model: GeminiModel;
    timeoutSeconds: number;
    workDir: string;
    binaryPath?: string;
    sandbox?: boolean;         // --sandbox mode
    yolo?: boolean;            // --yolo (auto-approve actions)
    checkpointDir?: string;    // --checkpoint-dir for persistence
}

export interface GeminiCliResponse {
    success: boolean;
    content: string;
    model: GeminiModel;
    durationMs: number;
    error?: string;
    warnings?: string[];
}

export interface QueryOptions {
    model?: GeminiModel;
    timeoutSeconds?: number;
    cwd?: string;
    files?: string[];          // Files to inject as context (@ notation)
}

export interface AuthStatus {
    authenticated: boolean;
    account?: string;
    error?: string;
}

export interface GeminiVersion {
    version: string;
    path: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: GeminiCliConfig = {
    model: "flash",
    timeoutSeconds: 120,
    workDir: process.cwd(),
};

const MODEL_MAP: Record<GeminiModel, string> = {
    flash: "gemini-2.5-flash",
    pro: "gemini-2.5-pro",
    auto: "auto",  // Let Gemini CLI choose optimal model
};

// File size limits for inline context injection
const MAX_INLINE_FILE_SIZE = 256 * 1024;  // 256KB per file
const MAX_INLINE_TOTAL_SIZE = 512 * 1024; // 512KB total

// ============================================================================
// Bridge
// ============================================================================

export class GeminiCliBridge {
    private config: GeminiCliConfig;
    private eventBus: EventBus;
    private activeProcess: ChildProcess | null = null;
    private cachedVersion: GeminiVersion | null = null;

    constructor(config: Partial<GeminiCliConfig> = {}, eventBus?: EventBus) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
    }

    // ========================================================================
    // Core Query Methods
    // ========================================================================

    /**
     * Send a prompt to Gemini CLI
     */
    async query(prompt: string, options: QueryOptions = {}): Promise<GeminiCliResponse> {
        const startTime = Date.now();
        const model = options.model ?? this.config.model;
        const timeout = options.timeoutSeconds ?? this.config.timeoutSeconds;
        const cwd = options.cwd ?? this.config.workDir;

        this.log("info", `Querying Gemini CLI (model: ${model}, timeout: ${timeout}s)`);

        try {
            const content = await this.runGemini(prompt, model, cwd, timeout);
            return {
                success: true,
                content,
                model,
                durationMs: Date.now() - startTime,
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log("error", `Gemini CLI query failed: ${errorMsg}`);
            return {
                success: false,
                content: "",
                model,
                durationMs: Date.now() - startTime,
                error: errorMsg,
            };
        }
    }

    /**
     * Query with file context - injects files inline or via @ notation
     */
    async queryWithFiles(
        prompt: string,
        files: string[],
        options: QueryOptions = {}
    ): Promise<GeminiCliResponse> {
        const startTime = Date.now();
        const model = options.model ?? this.config.model;
        const timeout = options.timeoutSeconds ?? this.config.timeoutSeconds;
        const cwd = options.cwd ?? this.config.workDir;
        const warnings: string[] = [];

        this.log("info", `Querying Gemini with ${files.length} file(s)`);

        try {
            // Build the context payload
            const { payload, fileWarnings } = await this.buildFilePayload(files, cwd);
            warnings.push(...fileWarnings);

            // Combine file context with prompt
            const fullPrompt = payload ? `${payload}\n\n${prompt}` : prompt;

            const content = await this.runGemini(fullPrompt, model, cwd, timeout);
            return {
                success: true,
                content,
                model,
                durationMs: Date.now() - startTime,
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log("error", `Gemini CLI query with files failed: ${errorMsg}`);
            return {
                success: false,
                content: "",
                model,
                durationMs: Date.now() - startTime,
                error: errorMsg,
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        }
    }

    /**
     * Query using @ notation (let Gemini CLI resolve files)
     * More efficient for large files as Gemini CLI handles them directly
     */
    async queryWithAtCommand(
        prompt: string,
        paths: string[],
        options: QueryOptions = {}
    ): Promise<GeminiCliResponse> {
        const startTime = Date.now();
        const model = options.model ?? this.config.model;
        const timeout = options.timeoutSeconds ?? this.config.timeoutSeconds;
        const cwd = options.cwd ?? this.config.workDir;
        const warnings: string[] = [];

        this.log("info", `Querying Gemini with @ notation (${paths.length} path(s))`);

        // Build @ notation prompt
        const atLines = paths.map(p => {
            const relPath = path.isAbsolute(p) ? path.relative(cwd, p) : p;
            return `@${relPath}`;
        });

        const fullPrompt = `${atLines.join("\n")}\n\n${prompt}`;

        try {
            const content = await this.runGemini(fullPrompt, model, cwd, timeout);
            return {
                success: true,
                content,
                model,
                durationMs: Date.now() - startTime,
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                content: "",
                model,
                durationMs: Date.now() - startTime,
                error: errorMsg,
            };
        }
    }

    // ========================================================================
    // Configuration & Status Methods
    // ========================================================================

    /**
     * Change the default model
     */
    setModel(model: GeminiModel): void {
        this.config.model = model;
        this.log("info", `Default model set to: ${MODEL_MAP[model]}`);
    }

    /**
     * Get current configuration
     */
    getConfig(): Readonly<GeminiCliConfig> {
        return { ...this.config };
    }

    /**
     * Stop any running process
     */
    stop(): void {
        if (this.activeProcess) {
            this.activeProcess.kill("SIGTERM");
            this.activeProcess = null;
        }
    }

    /**
     * Check if Gemini CLI is available
     */
    async isAvailable(): Promise<boolean> {
        try {
            const version = await this.getVersion();
            return version !== null;
        } catch {
            return false;
        }
    }

    /**
     * Get Gemini CLI version
     */
    async getVersion(): Promise<GeminiVersion | null> {
        if (this.cachedVersion) return this.cachedVersion;

        try {
            const isWindows = process.platform === "win32";
            const command = this.config.binaryPath ?? "gemini";

            return new Promise((resolve) => {
                const proc = spawn(command, ["--version"], {
                    shell: isWindows,
                    timeout: 5000,
                });

                let output = "";
                proc.stdout?.on("data", (data) => {
                    output += data.toString();
                });

                proc.on("close", (code) => {
                    if (code === 0) {
                        this.cachedVersion = {
                            version: output.trim(),
                            path: command,
                        };
                        resolve(this.cachedVersion);
                    } else {
                        resolve(null);
                    }
                });

                proc.on("error", () => resolve(null));
            });
        } catch {
            return null;
        }
    }

    /**
     * Check authentication status
     */
    async getAuthStatus(): Promise<AuthStatus> {
        try {
            const isWindows = process.platform === "win32";
            const command = this.config.binaryPath ?? "gemini";

            return new Promise((resolve) => {
                const proc = spawn(command, ["auth", "status"], {
                    shell: isWindows,
                    timeout: 10000,
                });

                let stdout = "";
                let stderr = "";

                proc.stdout?.on("data", (data) => {
                    stdout += data.toString();
                });

                proc.stderr?.on("data", (data) => {
                    stderr += data.toString();
                });

                proc.on("close", (code) => {
                    if (code === 0) {
                        // Parse account from output if possible
                        const accountMatch = stdout.match(/account:\s*(.+)/i);
                        resolve({
                            authenticated: true,
                            account: accountMatch?.[1]?.trim(),
                        });
                    } else {
                        resolve({
                            authenticated: false,
                            error: stderr.trim() || "Not authenticated",
                        });
                    }
                });

                proc.on("error", (err) => {
                    resolve({
                        authenticated: false,
                        error: err.message,
                    });
                });
            });
        } catch (error) {
            return {
                authenticated: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    // ========================================================================
    // Private Helpers
    // ========================================================================

    /**
     * Build file payload for inline context injection
     */
    private async buildFilePayload(
        files: string[],
        cwd: string
    ): Promise<{ payload: string; fileWarnings: string[] }> {
        const blocks: string[] = [];
        const warnings: string[] = [];
        let totalSize = 0;

        for (const file of files) {
            const absPath = path.isAbsolute(file) ? file : path.join(cwd, file);
            const displayName = path.relative(cwd, absPath);

            try {
                const stat = await fs.stat(absPath);

                if (stat.size > MAX_INLINE_FILE_SIZE) {
                    warnings.push(`Skipped ${displayName}: exceeds ${MAX_INLINE_FILE_SIZE} bytes`);
                    continue;
                }

                if (totalSize + stat.size > MAX_INLINE_TOTAL_SIZE) {
                    warnings.push(`Skipped ${displayName}: would exceed total size limit`);
                    continue;
                }

                const content = await fs.readFile(absPath, "utf-8");
                blocks.push(`=== ${displayName} ===\n${content}`);
                totalSize += stat.size;
            } catch (err) {
                warnings.push(`Error reading ${displayName}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        return {
            payload: blocks.join("\n\n"),
            fileWarnings: warnings,
        };
    }

    /**
     * Execute Gemini CLI with prompt
     */
    private runGemini(
        prompt: string,
        model: GeminiModel,
        cwd: string,
        timeoutSec: number
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const isWindows = process.platform === "win32";
            const command = this.config.binaryPath ?? "gemini";

            // Build args
            // We pass -p "" to force headless mode while reading the actual prompt from stdin
            // This avoids shell argument length limits for large contexts
            const args = ["-p", "", "-m", MODEL_MAP[model]];

            // Add optional flags
            if (this.config.sandbox) {
                args.push("--sandbox");
            }
            if (this.config.yolo) {
                args.push("--yolo");
            }
            if (this.config.checkpointDir) {
                args.push("--checkpoint-dir", this.config.checkpointDir);
            }

            const env = getOuroborosEnv();

            const proc = spawn(command, args, {
                cwd,
                shell: isWindows,
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...env, PAGER: "cat" },
            });

            // Write prompt to stdin and close it
            if (proc.stdin) {
                proc.stdin.write(prompt);
                proc.stdin.end();
            }

            this.activeProcess = proc;

            let stdout = "";
            let stderr = "";

            proc.stdout?.on("data", (data) => {
                stdout += data.toString();
            });

            proc.stderr?.on("data", (data) => {
                stderr += data.toString();
            });

            const timer = setTimeout(() => {
                proc.kill("SIGTERM");
                this.activeProcess = null;
                reject(new Error(`Timeout after ${timeoutSec}s`));
            }, timeoutSec * 1000);

            proc.on("close", (code) => {
                clearTimeout(timer);
                this.activeProcess = null;
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error(stderr || `Exit code ${code}`));
                }
            });

            proc.on("error", (err) => {
                clearTimeout(timer);
                this.activeProcess = null;
                reject(err);
            });
        });
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, message, "GeminiCliBridge");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createGeminiCliBridge(config?: Partial<GeminiCliConfig>): GeminiCliBridge {
    return new GeminiCliBridge(config);
}
