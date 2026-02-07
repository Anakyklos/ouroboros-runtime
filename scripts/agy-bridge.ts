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

console.log(`🌉 Bridge: Executing "${command}"...`);

const proc = spawn(command.split(" "), {
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
