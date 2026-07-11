#!/usr/bin/env bun
/**
 * Mandatory unit-test gate for repository baseline (issue #35).
 *
 * - Runs only files that are currently required to pass.
 * - Prints quarantined suites so they remain visible and are never counted as green.
 * - Does not use broad silence filters; quarantine is an explicit allow/deny list.
 * - Missing/duplicate/invalid quarantine entries fail the gate (no silent disappearance).
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");

/** Per-file wall-clock timeout for the child bun test process (ms). */
const CHILD_PROCESS_TIMEOUT_MS = 120_000;

/** Directory names skipped during test discovery (venv, caches, build artifacts). */
const SKIP_DIR_NAMES = new Set([
    "node_modules",
    "dist",
    ".git",
    ".ouroboros",
    "coverage",
    ".turbo",
    ".next",
    "temp_e2e_test",
    "temp_e2e_manual",
]);

interface QuarantineEntry {
    path: string;
    classification: string;
    reason: string;
    reactivate_when: string;
    tracking_issue?: number;
}

interface QuarantineManifest {
    issue: number;
    tracking_issue?: number;
    files: QuarantineEntry[];
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function walkTestFiles(dir: string, acc: string[] = []): string[] {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return acc;
    }
    for (const name of entries) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        const full = join(dir, name);
        let st;
        try {
            st = statSync(full);
        } catch {
            continue;
        }
        if (st.isDirectory()) {
            walkTestFiles(full, acc);
        } else if (/\.test\.(ts|tsx)$/.test(name)) {
            acc.push(relative(ROOT, full).replaceAll("\\", "/"));
        }
    }
    return acc;
}

function loadAndValidateManifest(manifestPath: string): QuarantineManifest {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`✖ Failed to parse quarantine manifest: ${manifestPath}`);
        console.error(`  ${msg}`);
        process.exit(1);
    }

    if (!raw || typeof raw !== "object") {
        console.error("✖ Quarantine manifest must be a JSON object.");
        process.exit(1);
    }

    const manifest = raw as QuarantineManifest;

    if (!Array.isArray(manifest.files)) {
        console.error("✖ Quarantine manifest.files must be an array.");
        process.exit(1);
    }

    if (manifest.tracking_issue !== undefined && typeof manifest.tracking_issue !== "number") {
        console.error("✖ Quarantine manifest.tracking_issue must be a number when present.");
        process.exit(1);
    }

    const seen = new Set<string>();
    const validationErrors: string[] = [];

    for (let i = 0; i < manifest.files.length; i++) {
        const entry = manifest.files[i];
        const prefix = `files[${i}]`;

        if (!entry || typeof entry !== "object") {
            validationErrors.push(`${prefix}: entry must be an object`);
            continue;
        }

        for (const field of ["path", "classification", "reason", "reactivate_when"] as const) {
            if (!isNonEmptyString(entry[field])) {
                validationErrors.push(`${prefix}.${field}: must be a non-empty string`);
            }
        }

        if (isNonEmptyString(entry.path)) {
            if (seen.has(entry.path)) {
                validationErrors.push(`${prefix}.path: duplicate quarantine path "${entry.path}"`);
            } else {
                seen.add(entry.path);
            }
        }
    }

    if (validationErrors.length > 0) {
        console.error("✖ Quarantine manifest validation failed:");
        for (const err of validationErrors) {
            console.error(`  - ${err}`);
        }
        process.exit(1);
    }

    return manifest;
}

function describeChildFailure(result: ReturnType<typeof spawnSync>, file: string): string {
    if (result.error) {
        const err = result.error as NodeJS.ErrnoException;
        if (err.code === "ETIMEDOUT") {
            return `✖ Mandatory file timed out after ${CHILD_PROCESS_TIMEOUT_MS}ms: ${file}`;
        }
        return `✖ Mandatory file failed to spawn (${err.message}): ${file}`;
    }
    if (result.signal) {
        return `✖ Mandatory file terminated by signal ${result.signal}: ${file}`;
    }
    if (result.status === null) {
        return `✖ Mandatory file ended with no exit status (possible timeout/signal): ${file}`;
    }
    return `✖ Mandatory file failed: ${file} (exit ${result.status})`;
}

const manifestPath = join(ROOT, "scripts/quarantine-manifest.json");
const manifest = loadAndValidateManifest(manifestPath);

const trackingIssue = manifest.tracking_issue ?? 41;
const quarantinedPaths = new Set(manifest.files.map((f) => f.path));

const allTests = walkTestFiles(ROOT).sort();
const mandatory = allTests.filter((p) => !quarantinedPaths.has(p));

// Missing quarantine targets: path not on disk (renamed/deleted) — fail the gate
const missingOnDisk = manifest.files.filter((f) => !existsSync(join(ROOT, f.path)));
// Also flag quarantine paths that exist on disk but are not discovered as test files
// (should be rare; usually same as missing if pattern doesn't match)
const notDiscovered = manifest.files.filter(
    (f) => existsSync(join(ROOT, f.path)) && !allTests.includes(f.path)
);

console.log("══════════════════════════════════════════════════════════════");
console.log(" Ouroboros mandatory tests (baseline #35)");
console.log(` Quarantine debt tracking: #${trackingIssue}`);
console.log("══════════════════════════════════════════════════════════════");
console.log(` Discovered test files: ${allTests.length}`);
console.log(` Mandatory (will run):  ${mandatory.length}`);
console.log(` Quarantined (skipped): ${manifest.files.length}`);
console.log("");
console.log("── Quarantined (NOT executed, NOT counted as pass) ──────────");
for (const q of manifest.files) {
    const issue = q.tracking_issue ?? trackingIssue;
    console.log(` • ${q.path}`);
    console.log(`     class: ${q.classification}`);
    console.log(`     why:   ${q.reason}`);
    console.log(`     re-enable when: ${q.reactivate_when}`);
    console.log(`     tracking: #${issue}`);
}

if (missingOnDisk.length > 0 || notDiscovered.length > 0) {
    console.error("");
    console.error("✖ Quarantine entries must stay discoverable — silent disappearance is not allowed.");
    if (missingOnDisk.length > 0) {
        console.error("  Missing on disk (deleted or renamed):");
        for (const q of missingOnDisk) {
            console.error(`   • ${q.path}`);
        }
    }
    if (notDiscovered.length > 0) {
        console.error("  Present on disk but not discovered as *.test.ts(x):");
        for (const q of notDiscovered) {
            console.error(`   • ${q.path}`);
        }
    }
    process.exit(1);
}

console.log("");
console.log("── Manifest validated ───────────────────────────────────────");
console.log(` ✓ ${manifest.files.length} quarantine entries (unique paths, required fields)`);
console.log(` ✓ tracking_issue=#${trackingIssue}`);
console.log("");
console.log("── Running mandatory suite (file-by-file for isolation) ─────");

let failedFiles = 0;

for (const file of mandatory) {
    const result = spawnSync("bun", ["test", "--timeout", "30000", file], {
        cwd: ROOT,
        stdio: "inherit",
        timeout: CHILD_PROCESS_TIMEOUT_MS,
        env: process.env,
    });

    const failed =
        result.error != null ||
        result.signal != null ||
        result.status === null ||
        result.status !== 0;

    if (failed) {
        failedFiles += 1;
        console.error(`\n${describeChildFailure(result, file)}\n`);
    }
}

console.log("");
console.log("══════════════════════════════════════════════════════════════");
console.log(` Mandatory files run: ${mandatory.length}`);
console.log(` Failed mandatory files: ${failedFiles}`);
console.log(` Quarantined files: ${manifest.files.length} (tracking #${trackingIssue})`);
console.log("══════════════════════════════════════════════════════════════");

if (failedFiles > 0) {
    process.exit(1);
}

console.log("✓ All mandatory unit tests passed.");
process.exit(0);
