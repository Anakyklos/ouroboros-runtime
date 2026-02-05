/**
 * 🧠 Z.AI Provider
 *
 * Provider that integrates with the isolated Ouroboros environment.
 * Uses the opencode CLI from .ouroboros/npm as the execution bridge.
 * 
 * 🛡️ Anti-Vibe Protocol integrated - use ANTI_VIBE_PHASE env var to control mode.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
    getOuroborosConfig,
    getOuroborosEnv,
    getOuroborosOpenCodePath,
    type OuroborosConfig,
} from "../utils/ouroboros.js";
import {
    WorkflowPhase,
    getPhase,
    buildAntiVibePrompt,
    getAntiVibeConfig,
} from "../utils/anti-vibe.js";

export interface ZAIProviderOptions {
    model?: string;
    verbose?: boolean;
}

export interface ExecutionResult {
    success: boolean;
    output: string;
    error?: string;
}

/**
 * Z.AI Provider - Bridges TypeScript to the isolated Ouroboros environment.
 */
export class ZAIProvider {
    private config: OuroborosConfig;
    private openCodePath: string;
    private env: NodeJS.ProcessEnv;
    private model: string;
    private verbose: boolean;

    constructor(options: ZAIProviderOptions = {}) {
        // 1. Validate Infrastructure
        this.config = getOuroborosConfig();
        if (!this.config.isReady) {
            throw new Error(
                "⛔ FATAL: Ambiente Ouroboros não detectado.\n" +
                "   Run: bun run setup_ouroboros.ts"
            );
        }

        // 2. Configure execution environment
        this.openCodePath = getOuroborosOpenCodePath();
        this.env = getOuroborosEnv();
        this.model = options.model || "glm-4.7";
        this.verbose = options.verbose || false;

        if (this.verbose) {
            console.log(`🚀 Z.AI inicializado no ambiente isolado: ${this.config.root}`);
            console.log(`   Model: ${this.model}`);
            console.log(`   OpenCode: ${this.openCodePath}`);
        }
    }

    /**
     * Execute a prompt through the opencode CLI.
     */
    async execute(prompt: string): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            const args = [
                "--model", this.model,
                "--prompt", prompt,
            ];

            if (this.verbose) {
                console.log(`\n📝 Executing prompt: "${prompt.substring(0, 50)}..."`);
            }

            const proc = spawn(this.openCodePath, args, {
                env: this.env,
                cwd: this.config.root, // Agent works within .ouroboros
                shell: true,
            });

            let output = "";
            let error = "";

            proc.stdout.on("data", (data) => {
                output += data.toString();
                if (this.verbose) {
                    process.stdout.write(data);
                }
            });

            proc.stderr.on("data", (data) => {
                error += data.toString();
                if (this.verbose) {
                    process.stderr.write(data);
                }
            });

            proc.on("close", (code) => {
                resolve({
                    success: code === 0,
                    output: output.trim(),
                    error: error.trim() || undefined,
                });
            });

            proc.on("error", (err) => {
                resolve({
                    success: false,
                    output: "",
                    error: err.message,
                });
            });
        });
    }

    /**
     * Execute with streaming output.
     */
    executeStreaming(
        prompt: string,
        onData: (chunk: string) => void
    ): ChildProcess {
        const args = [
            "--model", this.model,
            "--prompt", prompt,
        ];

        const proc = spawn(this.openCodePath, args, {
            env: this.env,
            cwd: this.config.root,
            shell: true,
        });

        proc.stdout.on("data", (data) => {
            onData(data.toString());
        });

        proc.stderr.on("data", (data) => {
            onData(`[stderr] ${data.toString()}`);
        });

        return proc;
    }

    /**
     * Execute a Python script in the isolated environment.
     */
    async executePython(script: string, args: string[] = []): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            const proc = spawn(this.config.python, [script, ...args], {
                env: this.env,
                cwd: this.config.workspace,
                shell: true,
            });

            let output = "";
            let error = "";

            proc.stdout.on("data", (data) => {
                output += data.toString();
                if (this.verbose) {
                    process.stdout.write(data);
                }
            });

            proc.stderr.on("data", (data) => {
                error += data.toString();
                if (this.verbose) {
                    process.stderr.write(data);
                }
            });

            proc.on("close", (code) => {
                resolve({
                    success: code === 0,
                    output: output.trim(),
                    error: error.trim() || undefined,
                });
            });

            proc.on("error", (err) => {
                resolve({
                    success: false,
                    output: "",
                    error: err.message,
                });
            });
        });
    }

    /**
     * Execute inline Python code.
     */
    async executePythonCode(code: string): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            const proc = spawn(this.config.python, ["-c", code], {
                env: this.env,
                cwd: this.config.workspace,
                shell: true,
            });

            let output = "";
            let error = "";

            proc.stdout.on("data", (data) => {
                output += data.toString();
            });

            proc.stderr.on("data", (data) => {
                error += data.toString();
            });

            proc.on("close", (code) => {
                resolve({
                    success: code === 0,
                    output: output.trim(),
                    error: error.trim() || undefined,
                });
            });

            proc.on("error", (err) => {
                resolve({
                    success: false,
                    output: "",
                    error: err.message,
                });
            });
        });
    }

    /**
     * Get the current configuration.
     */
    getConfig(): OuroborosConfig {
        return this.config;
    }
}

/**
 * Factory function for creating a Z.AI provider.
 */
export function createZAIProvider(options?: ZAIProviderOptions): ZAIProvider {
    return new ZAIProvider(options);
}
