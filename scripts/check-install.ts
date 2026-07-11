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
    return result.status ?? 1;
}

function gitStatusPorcelain(): string {
    const result = spawnSync("git", ["status", "--porcelain"], {
        cwd: ROOT,
        encoding: "utf-8",
    });
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
