#!/usr/bin/env bun
/**
 * Verify frozen-lockfile installs for root and web without mutating the tree.
 * Exits non-zero if install fails or if tracked files would change.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function run(cmd: string, args: string[], cwd: string): number {
    console.log(`$ ${cmd} ${args.join(" ")}  (cwd=${cwd === ROOT ? "." : "web"})`);
    const result = spawnSync(cmd, args, {
        cwd,
        encoding: "utf-8",
        stdio: "inherit",
    });
    if (result.error) {
        console.error(`✖ Failed to spawn ${cmd}: ${result.error.message}`);
        return 1;
    }
    if (result.signal) {
        console.error(`✖ ${cmd} terminated by signal ${result.signal}`);
        return 1;
    }
    return result.status ?? 1;
}

/**
 * Run `git status --porcelain` and fail hard if git is missing, not a repo,
 * or the command returns non-zero. Never silently treat failure as "clean".
 */
function gitStatusPorcelain(): string {
    const result = spawnSync("git", ["status", "--porcelain"], {
        cwd: ROOT,
        encoding: "utf-8",
    });

    if (result.error) {
        console.error("✖ git status failed: git is not installed or not in PATH.");
        console.error(`  ${result.error.message}`);
        process.exit(1);
    }

    if (result.status !== 0) {
        const stderr = (result.stderr ?? "").trim();
        console.error(`✖ git status failed with exit code ${result.status}`);
        if (stderr) console.error(stderr);
        if (result.signal) console.error(`  signal: ${result.signal}`);
        console.error("  Ensure this is a git repository and git works from the project root.");
        process.exit(1);
    }

    return (result.stdout ?? "").trim();
}

const before = gitStatusPorcelain();

const rootCode = run("bun", ["install", "--frozen-lockfile"], ROOT);
if (rootCode !== 0) {
    console.error("✖ Root bun install --frozen-lockfile failed");
    process.exit(rootCode);
}

const webCode = run("bun", ["install", "--frozen-lockfile"], join(ROOT, "web"));
if (webCode !== 0) {
    console.error("✖ web/ bun install --frozen-lockfile failed");
    process.exit(webCode);
}

const after = gitStatusPorcelain();
if (after !== before) {
    console.error("✖ Install mutated the working tree (lockfile or tracked files changed).");
    console.error("Before:\n" + (before || "(clean)"));
    console.error("After:\n" + (after || "(clean)"));
    console.error("Commit lockfile updates before relying on frozen installs.");
    process.exit(1);
}

console.log("✓ Frozen installs OK (root + web); working tree unchanged by install.");
process.exit(0);
