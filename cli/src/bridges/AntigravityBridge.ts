/**
 * AntigravityBridge - Programmatic control of Antigravity CLI
 * 
 * Wraps the AGY CLI tool for use in Ouroboros orchestration.
 * Executes prompts and returns responses via subprocess.
 */

import { spawn, ChildProcess } from "child_process";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// Types
// ============================================================================

export interface AntigravityConfig {
    timeoutSeconds: number;
    workDir: string;
    binaryPath?: string; // Custom path to agy binary
}

export interface AntigravityResponse {
    success: boolean;
    content: string;
    durationMs: number;
    error?: string;
}

export interface ExecuteOptions {
    timeoutSeconds?: number;
    cwd?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: AntigravityConfig = {
    timeoutSeconds: 300, // 5 minutes for complex tasks
    workDir: process.cwd(),
};

// ============================================================================
// Bridge
// ============================================================================

export class AntigravityBridge {
    private config: AntigravityConfig;
    private eventBus: EventBus;
    private activeProcess: ChildProcess | null = null;

    constructor(config: Partial<AntigravityConfig> = {}, eventBus?: EventBus) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
    }

    /**
     * Execute a prompt via Antigravity CLI
     */
    async execute(prompt: string, options: ExecuteOptions = {}): Promise<AntigravityResponse> {
        const startTime = Date.now();
        const timeout = options.timeoutSeconds ?? this.config.timeoutSeconds;
        const cwd = options.cwd ?? this.config.workDir;

        this.log("info", `Executing prompt via Antigravity (timeout: ${timeout}s)`);

        try {
            const content = await this.runAgy(prompt, cwd, timeout);
            return {
                success: true,
                content,
                durationMs: Date.now() - startTime,
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log("error", `Antigravity execution failed: ${errorMsg}`);
            return {
                success: false,
                content: "",
                durationMs: Date.now() - startTime,
                error: errorMsg,
            };
        }
    }

    /**
     * Execute a task (higher-level wrapper)
     */
    async task(instruction: string, context?: string): Promise<AntigravityResponse> {
        let fullPrompt = instruction;
        if (context) {
            fullPrompt = `Context:\n${context}\n\nTask:\n${instruction}`;
        }
        return this.execute(fullPrompt);
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
     * Check if AGY is available
     */
    async isAvailable(): Promise<boolean> {
        try {
            const isWindows = process.platform === "win32";
            const command = this.config.binaryPath ?? "agy";

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
     * Execute AGY CLI with prompt
     */
    private runAgy(prompt: string, cwd: string, timeoutSec: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const isWindows = process.platform === "win32";
            // On Windows, use shell:true to resolve .cmd/.bat wrappers properly
            const command = this.config.binaryPath ?? "agy";

            // AGY uses positional argument for prompt, not --prompt flag
            const args = [prompt];

            const proc = spawn(command, args, {
                cwd,
                shell: isWindows, // Enable shell on Windows to resolve PATH correctly
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
        this.eventBus.log(level, message, "AntigravityBridge");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createAntigravityBridge(config?: Partial<AntigravityConfig>): AntigravityBridge {
    return new AntigravityBridge(config);
}
