/**
 * Gemini Commands - Ouroboros Parasitic Interface
 * 
 * Exposes all Gemini CLI capabilities as native Ouroboros commands.
 * The parasite controls the host through these command handlers.
 */

import { GeminiCliBridge, type GeminiModel, type GeminiCliResponse } from "../bridges/GeminiCliBridge.js";

// ============================================================================
// Types
// ============================================================================

export interface GeminiCommandResult {
    success: boolean;
    output: string;
    model?: GeminiModel;
    durationMs?: number;
}

export interface GeminiCommandContext {
    bridge: GeminiCliBridge;
    workDir: string;
}

// ============================================================================
// Command Handlers
// ============================================================================

/**
 * Parse a Gemini command string
 * 
 * Formats:
 * - /gemini <prompt>           -> query with default model
 * - /gemini:pro <prompt>       -> query with pro model
 * - /gemini:flash <prompt>     -> query with flash model
 * - /gemini:files <prompt>     -> detect @file references in prompt
 * - /gemini:status             -> show auth and version status
 */
export function parseGeminiCommand(input: string): {
    subcommand: string;
    model?: GeminiModel;
    prompt?: string;
    files?: string[];
} {
    // Remove /gemini prefix
    const withoutPrefix = input.replace(/^\/gemini/i, "").trim();

    // Check for subcommand (e.g., :pro, :status, :files)
    const colonMatch = withoutPrefix.match(/^:(\w+)\s*/);

    if (!colonMatch) {
        // Plain /gemini <prompt>
        return {
            subcommand: "query",
            prompt: withoutPrefix,
        };
    }

    const subcommand = colonMatch[1].toLowerCase();
    const rest = withoutPrefix.slice(colonMatch[0].length);

    switch (subcommand) {
        case "pro":
            return { subcommand: "query", model: "pro", prompt: rest };
        case "flash":
            return { subcommand: "query", model: "flash", prompt: rest };
        case "auto":
            return { subcommand: "query", model: "auto", prompt: rest };
        case "status":
            return { subcommand: "status" };
        case "version":
            return { subcommand: "version" };
        case "files":
        case "f":
            // Extract @file references from prompt
            const files = extractFileReferences(rest);
            const cleanPrompt = rest.replace(/@\S+/g, "").trim();
            return { subcommand: "files", files, prompt: cleanPrompt };
        default:
            // Unknown subcommand, treat as prompt
            return { subcommand: "query", prompt: withoutPrefix };
    }
}

/**
 * Extract @file references from a prompt
 */
function extractFileReferences(input: string): string[] {
    const matches = input.match(/@(\S+)/g) || [];
    return matches.map(m => m.slice(1)); // Remove @ prefix
}

/**
 * Handle /gemini command
 */
export async function handleGeminiCommand(
    input: string,
    ctx: GeminiCommandContext
): Promise<GeminiCommandResult> {
    const parsed = parseGeminiCommand(input);

    switch (parsed.subcommand) {
        case "query":
            return handleQuery(parsed.prompt || "", parsed.model, ctx);
        case "files":
            return handleQueryWithFiles(parsed.prompt || "", parsed.files || [], ctx);
        case "status":
            return handleStatus(ctx);
        case "version":
            return handleVersion(ctx);
        default:
            return {
                success: false,
                output: `Unknown subcommand: ${parsed.subcommand}`,
            };
    }
}

/**
 * Handle basic query
 */
async function handleQuery(
    prompt: string,
    model: GeminiModel | undefined,
    ctx: GeminiCommandContext
): Promise<GeminiCommandResult> {
    if (!prompt) {
        return {
            success: false,
            output: "Usage: /gemini <prompt> or /gemini:pro <prompt>",
        };
    }

    const result = await ctx.bridge.query(prompt, {
        model,
        cwd: ctx.workDir,
    });

    return formatResponse(result);
}

/**
 * Handle query with file context
 */
async function handleQueryWithFiles(
    prompt: string,
    files: string[],
    ctx: GeminiCommandContext
): Promise<GeminiCommandResult> {
    if (files.length === 0) {
        return {
            success: false,
            output: "Usage: /gemini:files @file1 @file2 <prompt>",
        };
    }

    if (!prompt) {
        return {
            success: false,
            output: "Please provide a prompt after the file references",
        };
    }

    // Use @ notation for efficiency (let Gemini CLI handle files)
    const result = await ctx.bridge.queryWithAtCommand(prompt, files, {
        cwd: ctx.workDir,
    });

    return formatResponse(result);
}

/**
 * Handle status command
 */
async function handleStatus(ctx: GeminiCommandContext): Promise<GeminiCommandResult> {
    const [version, auth] = await Promise.all([
        ctx.bridge.getVersion(),
        ctx.bridge.getAuthStatus(),
    ]);

    const lines: string[] = [
        "🔮 **Gemini CLI Status**",
        "",
    ];

    if (version) {
        lines.push(`📦 Version: ${version.version}`);
        lines.push(`📍 Path: ${version.path}`);
    } else {
        lines.push("❌ Gemini CLI not found");
    }

    lines.push("");

    if (auth.authenticated) {
        lines.push(`✅ Authenticated${auth.account ? ` as ${auth.account}` : ""}`);
    } else {
        lines.push(`❌ Not authenticated: ${auth.error || "Unknown reason"}`);
        lines.push("   Run: gemini auth login");
    }

    lines.push("");

    const config = ctx.bridge.getConfig();
    lines.push("⚙️ **Configuration**");
    lines.push(`   Model: ${config.model}`);
    lines.push(`   Timeout: ${config.timeoutSeconds}s`);
    lines.push(`   Sandbox: ${config.sandbox ? "enabled" : "disabled"}`);
    lines.push(`   YOLO: ${config.yolo ? "enabled" : "disabled"}`);

    return {
        success: true,
        output: lines.join("\n"),
    };
}

/**
 * Handle version command
 */
async function handleVersion(ctx: GeminiCommandContext): Promise<GeminiCommandResult> {
    const version = await ctx.bridge.getVersion();

    if (version) {
        return {
            success: true,
            output: `Gemini CLI: ${version.version}`,
        };
    } else {
        return {
            success: false,
            output: "Gemini CLI not found. Install with: npm install -g @google/gemini-cli",
        };
    }
}

/**
 * Format a GeminiCliResponse into a command result
 */
function formatResponse(response: GeminiCliResponse): GeminiCommandResult {
    if (response.success) {
        let output = response.content;

        // Add warnings if present
        if (response.warnings && response.warnings.length > 0) {
            const warningBlock = response.warnings
                .map(w => `⚠️ ${w}`)
                .join("\n");
            output = `${warningBlock}\n\n${output}`;
        }

        return {
            success: true,
            output,
            model: response.model,
            durationMs: response.durationMs,
        };
    } else {
        return {
            success: false,
            output: `Error: ${response.error || "Unknown error"}`,
            model: response.model,
            durationMs: response.durationMs,
        };
    }
}

// ============================================================================
// Help Text
// ============================================================================

export function getGeminiHelpText(): string {
    return `
🔮 **Gemini Commands** (Parasitic Interface)

/gemini <prompt>           Query with default model (flash)
/gemini:pro <prompt>       Query using Gemini Pro
/gemini:flash <prompt>     Query using Gemini Flash
/gemini:auto <prompt>      Let Gemini choose optimal model
/gemini:files @f1 @f2 ...  Query with file context
/gemini:status             Show auth and version status
/gemini:version            Show Gemini CLI version

**Examples:**
  /gemini What is the capital of France?
  /gemini:pro Analyze this complex algorithm
  /gemini:files @src/main.ts Explain this code
`.trim();
}
