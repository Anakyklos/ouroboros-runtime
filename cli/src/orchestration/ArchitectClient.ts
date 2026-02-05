/**
 * 🏛️ ArchitectClient
 * 
 * Native integration with Gemini Architect for design review and spec approval.
 * Part of the Ouroboros orchestration system - not an external dependency.
 * 
 * Uses Gemini CLI directly via subprocess (no MCP layer needed).
 */

import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

/** Models available via Gemini CLI */
export type GeminiModel = "flash" | "pro";

/** Configuration for ArchitectClient */
export interface ArchitectConfig {
    /** Default model to use */
    model: GeminiModel;
    /** Default timeout in seconds */
    timeoutSeconds: number;
    /** Working directory for queries */
    workDir: string;
    /** Max file size to inline (bytes) */
    maxInlineFileSize: number;
}

/** Response from Architect consultation */
export interface ArchitectResponse {
    success: boolean;
    content: string;
    model: GeminiModel;
    durationMs: number;
    error?: string;
}

/** Query options */
export interface ConsultOptions {
    model?: GeminiModel;
    timeoutSeconds?: number;
    files?: string[];
}

const DEFAULT_CONFIG: ArchitectConfig = {
    model: "flash",
    timeoutSeconds: 120,
    workDir: process.cwd(),
    maxInlineFileSize: 256 * 1024, // 256KB
};

/**
 * ArchitectClient - Consults Gemini for design decisions.
 */
export class ArchitectClient {
    private config: ArchitectConfig;
    private eventBus: EventBus;

    constructor(config: Partial<ArchitectConfig> = {}, eventBus?: EventBus) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
    }

    /**
     * Consult the Architect with a query.
     * Main entry point for design review.
     */
    async consult(query: string, options: ConsultOptions = {}): Promise<ArchitectResponse> {
        const model = options.model ?? this.config.model;
        const timeout = options.timeoutSeconds ?? this.config.timeoutSeconds;
        const startTime = Date.now();

        this.log("info", `🏛️ Consulting Architect (${model})...`);

        try {
            // Build the full prompt with any file contents
            let fullQuery = query;
            if (options.files && options.files.length > 0) {
                const fileContents = await this.loadFiles(options.files);
                fullQuery = `${query}\n\n---\n\n## Attached Files\n\n${fileContents}`;
            }

            // Execute Gemini CLI
            const content = await this.executeGemini(fullQuery, model, timeout);

            const response: ArchitectResponse = {
                success: true,
                content,
                model,
                durationMs: Date.now() - startTime,
            };

            this.log("info", `✅ Architect responded (${response.durationMs}ms)`);
            return response;

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log("error", `❌ Architect error: ${errorMsg}`);

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
     * Request spec approval from Architect.
     * Returns structured approval/rejection.
     */
    async approveSpec(specPath: string): Promise<{
        approved: boolean;
        feedback: string;
        suggestions?: string[];
    }> {
        const response = await this.consult(
            `Review this implementation spec. Reply with:
1. APPROVED or NEEDS_CHANGES
2. Your feedback
3. Any suggestions (if NEEDS_CHANGES)

Be concise and specific.`,
            {
                files: [specPath],
                model: "pro",
                timeoutSeconds: 180,
            }
        );

        if (!response.success) {
            return {
                approved: false,
                feedback: `Error consulting Architect: ${response.error}`,
            };
        }

        // Parse response for approval
        const content = response.content.toUpperCase();
        const approved = content.includes("APPROVED") && !content.includes("NEEDS_CHANGES");

        return {
            approved,
            feedback: response.content,
            suggestions: approved ? undefined : this.extractSuggestions(response.content),
        };
    }

    /**
     * Quick design question.
     */
    async askDesign(question: string): Promise<string> {
        const response = await this.consult(question, { model: "flash" });
        return response.success ? response.content : `Error: ${response.error}`;
    }

    // --- PRIVATE METHODS ---

    /**
     * Execute Gemini CLI with query.
     */
    private executeGemini(query: string, model: GeminiModel, timeoutSec: number): Promise<string> {
        return new Promise((resolve, reject) => {
            // Use --prompt for non-interactive mode
            const args = ["--prompt", query];
            if (model === "pro") {
                args.push("--model", "gemini-2.5-pro");
            }

            const isWindows = process.platform === "win32";
            // On Windows, pip installs .exe wrappers. Unix uses script files.
            // We use shell: false to prevent argument splitting issues.
            const command = isWindows ? "gemini.cmd" : "gemini";

            const proc = spawn(command, args, {
                cwd: this.config.workDir,
                shell: false,
                env: { ...process.env, PAGER: undefined }, // Let CLI handle paging or lack thereof
            });

            let stdout = "";
            let stderr = "";

            proc.stdout?.on("data", (data) => {
                stdout += data.toString();
            });

            proc.stderr?.on("data", (data) => {
                stderr += data.toString();
            });

            // Timeout handler
            const timer = setTimeout(() => {
                proc.kill("SIGTERM");
                reject(new Error(`Timeout after ${timeoutSec}s`));
            }, timeoutSec * 1000);

            proc.on("close", (code) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error(stderr || `Exit code ${code}`));
                }
            });

            proc.on("error", (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    /**
     * Load file contents for inline inclusion.
     */
    private async loadFiles(files: string[]): Promise<string> {
        const contents: string[] = [];

        for (const file of files) {
            const fullPath = path.isAbsolute(file)
                ? file
                : path.join(this.config.workDir, file);

            if (!fs.existsSync(fullPath)) {
                contents.push(`### ${file}\n\`\`\`\n[File not found]\n\`\`\``);
                continue;
            }

            const stat = fs.statSync(fullPath);
            if (stat.size > this.config.maxInlineFileSize) {
                contents.push(`### ${file}\n\`\`\`\n[File too large: ${stat.size} bytes]\n\`\`\``);
                continue;
            }

            const content = fs.readFileSync(fullPath, "utf-8");
            const ext = path.extname(file).slice(1) || "text";
            contents.push(`### ${file}\n\`\`\`${ext}\n${content}\n\`\`\``);
        }

        return contents.join("\n\n");
    }

    /**
     * Extract suggestions from feedback.
     */
    private extractSuggestions(feedback: string): string[] {
        const lines = feedback.split("\n");
        const suggestions: string[] = [];

        for (const line of lines) {
            // Look for numbered or bulleted suggestions
            const match = line.match(/^[\d\-\*]\s*[\.\)]\s*(.+)/);
            if (match) {
                suggestions.push(match[1].trim());
            }
        }

        return suggestions.length > 0 ? suggestions : [feedback];
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, message, "ArchitectClient");
    }
}

/**
 * Factory function.
 */
export function createArchitect(config?: Partial<ArchitectConfig>): ArchitectClient {
    return new ArchitectClient(config);
}

/**
 * Singleton for quick access.
 */
let defaultArchitect: ArchitectClient | null = null;

export function getArchitect(): ArchitectClient {
    if (!defaultArchitect) {
        defaultArchitect = createArchitect();
    }
    return defaultArchitect;
}
