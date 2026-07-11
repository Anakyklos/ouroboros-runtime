#!/usr/bin/env bun
/**
 * Mandatory unit-test gate for repository baseline (issue #35).
 *
 * - Runs only files that are currently required to pass.
 * - Prints quarantined suites so they remain visible and are never counted as green.
 * - Does not use broad silence filters; quarantine is an explicit allow/deny list.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");

interface QuarantineEntry {
    path: string;
    classification: string;
    reason: string;
    reactivate_when: string;
}

interface QuarantineManifest {
    issue: number;
    files: QuarantineEntry[];
}

function walkTestFiles(dir: string, acc: string[] = []): string[] {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return acc;
    }
    for (const name of entries) {
        if (name === "node_modules" || name === "dist" || name === ".git") continue;
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

const manifest = JSON.parse(
    readFileSync(join(ROOT, "scripts/quarantine-manifest.json"), "utf-8")
) as QuarantineManifest;

const quarantinedPaths = new Set(manifest.files.map((f) => f.path));

const allTests = walkTestFiles(ROOT).sort();
const mandatory = allTests.filter((p) => !quarantinedPaths.has(p));
const unknownQuarantine = manifest.files.filter((f) => !allTests.includes(f.path));

console.log("══════════════════════════════════════════════════════════════");
console.log(" Ouroboros mandatory tests (baseline #35)");
console.log("══════════════════════════════════════════════════════════════");
console.log(` Discovered test files: ${allTests.length}`);
console.log(` Mandatory (will run):  ${mandatory.length}`);
console.log(` Quarantined (skipped): ${manifest.files.length}`);
console.log("");
console.log("── Quarantined (NOT executed, NOT counted as pass) ──────────");
for (const q of manifest.files) {
    console.log(` • ${q.path}`);
    console.log(`     class: ${q.classification}`);
    console.log(`     why:   ${q.reason}`);
    console.log(`     re-enable when: ${q.reactivate_when}`);
}
if (unknownQuarantine.length > 0) {
    console.log("");
    console.log("⚠ Quarantine entries with missing files:");
    for (const q of unknownQuarantine) {
        console.log(` • ${q.path}`);
    }
}
console.log("");
console.log("── Running mandatory suite (file-by-file for isolation) ─────");

let failedFiles = 0;
let totalPassHint = 0;

for (const file of mandatory) {
    const result = spawnSync("bun", ["test", "--timeout", "30000", file], {
        cwd: ROOT,
        encoding: "utf-8",
        env: { ...process.env, FORCE_COLOR: "0" },
    });

    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    process.stdout.write(out);

    if (result.status !== 0) {
        failedFiles += 1;
        console.error(`\n✖ Mandatory file failed: ${file} (exit ${result.status})\n`);
    } else {
        const m = out.match(/(\d+)\s+pass/);
        if (m) totalPassHint += Number(m[1]);
    }
}

console.log("");
console.log("══════════════════════════════════════════════════════════════");
console.log(` Mandatory files run: ${mandatory.length}`);
console.log(` Failed mandatory files: ${failedFiles}`);
console.log(` Quarantined files: ${manifest.files.length} (see scripts/quarantine-manifest.json)`);
console.log("══════════════════════════════════════════════════════════════");

if (failedFiles > 0) {
    process.exit(1);
}

console.log("✓ All mandatory unit tests passed.");
process.exit(0);
