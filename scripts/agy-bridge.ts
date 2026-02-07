#!/usr/bin/env bun
/**
 * 🌉 Antigravity Bridge
 * 
 * A lightweight execution wrapper to allow Conductor (Gemini CLI)
 * to execute commands within the Ouroboros environment.
 * 
 * Usage:
 *   bun run scripts/agy-bridge.ts "<command>"
 * 
 * Example:
 *   bun run scripts/agy-bridge.ts "bun test cli/src/tui"
 */

import { spawn } from "bun";

const command = process.argv[2];

if (!command) {
    console.error("❌ Error: No command provided.");
    console.error("Usage: bun run scripts/agy-bridge.ts "<command>"");
    process.exit(1);
}

// Robust argument parser that respects quotes
function parseCommand(cmd: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < cmd.length; i++) {
        const char = cmd[i];

        if (inQuote) {
            if (char === quoteChar) {
                inQuote = false;
            } else {
                current += char;
            }
        } else {
            if (char === '"' || char === "'") {
                inQuote = true;
                quoteChar = char;
            } else if (char === ' ') {
                if (current.length > 0) {
                    args.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }
    }
    if (current.length > 0) {
        args.push(current);
    }
    return args;
}

console.log(`🌉 Bridge: Executing "${command}"...`);

const args = parseCommand(command);
const proc = spawn(args, {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" }, // Preserve colors
});

const exitCode = await proc.exited;

if (exitCode !== 0) {
    console.error(`❌ Bridge: Command failed with exit code ${exitCode}`);
    process.exit(exitCode);
}

console.log(`✅ Bridge: Command completed successfully.`);
process.exit(0);
