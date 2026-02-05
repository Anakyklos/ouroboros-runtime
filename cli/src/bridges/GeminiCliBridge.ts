/**
 * GeminiCliBridge - Programmatic control of Gemini CLI
 * 
 * Wraps the Gemini CLI tool for use in Ouroboros orchestration.
 * Similar to ArchitectClient but with a simplified, bridge-focused API.
 */

import { spawn, ChildProcess } from "child_process";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// Types
// ============================================================================

export type GeminiModel = "flash" | "pro";

export interface GeminiCliConfig {
    model: GeminiModel;
    timeoutSeconds: number;
    workDir: string;
    binaryPath?: string;
}

export interface GeminiCliResponse {
    success: boolean;
    content: string;
    model: GeminiModel;
    durationMs: number;
    error?: string;
}

export interface QueryOptions {
    model?: GeminiModel;
    timeoutSeconds?: number;
    cwd?: string;
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
    flash: "gemini-2.0-flash",
    pro: "gemini-2.5-pro",
};

// ============================================================================
// Bridge
// ============================================================================

export class GeminiCliBridge {
    private config: GeminiCliConfig;
    private eventBus: EventBus;
    private activeProcess: ChildProcess | null = null;

    constructor(config: Partial<GeminiCliConfig> = {}, eventBus?: EventBus) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
    }

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
            const isWindows = process.platform === "win32";
            const command = this.config.binaryPath ?? "gemini";

            return new Promise((resolve) => {
                const proc = spawn(command, ["--version"], {
                    shell: isWindows,
                    timeout: 5000,
                });

                proc.on("close", (code) => resolve(code === 0));
                proc.on("error", () => resolve(false));
            });
        } catch {
            return false;
        }
    }

    /**
     * Execute Gemini CLI with prompt
     */
    private runGemini(prompt: string, model: GeminiModel, cwd: string, timeoutSec: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const isWindows = process.platform === "win32";
            const command = this.config.binaryPath ?? "gemini";

            // Use -p for non-interactive mode, -m for model selection
            const args = ["-p", prompt, "-m", MODEL_MAP[model]];

            const proc = spawn(command, args, {
                cwd,
                shell: isWindows,
                env: { ...process.env, PAGER: "cat" },
            });

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
