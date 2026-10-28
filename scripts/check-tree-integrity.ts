#!/usr/bin/env bun
/**
 * Working-tree integrity gate (issue #153).
 *
 * The baseline must not mutate the checkout as a side effect of compiling or
 * running tests. This script snapshots the non-ignored working tree (tracked
 * changes + untracked files) before the gate and verifies it afterwards.
 *
 * It deliberately distinguishes preexisting developer changes from changes
 * produced during the run:
 * - a path that was already dirty is allowed to stay dirty with identical content;
 * - any content/status change on such a path fails the gate;
 * - any new non-ignored path fails the gate.
 *
 * Ignored build outputs (node_modules, dist, *.tsbuildinfo, ...) are not part
 * of the snapshot by design.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    closeSync,
    lstatSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readlinkSync,
    readSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(join(import.meta.dir, ".."));

/** Fixed buffer for streaming file hashes; memory use does not scale with file size. */
const HASH_BUFFER_SIZE = 64 * 1024;

/** Baseline steps run by `run` mode; each must stay in the mandatory gate. */
const BASELINE_STEPS = ["check:install", "check:runtime", "check:web", "check:tests"] as const;

export interface TreeEntry {
    status: string;
    hash: string | null;
}

export interface TreeSnapshot {
    root: string;
    head: string | null;
    entries: Record<string, TreeEntry>;
}

export class TreeIntegrityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TreeIntegrityError";
    }
}

function runGitResult(root: string, args: string[]) {
    const result = spawnSync("git", args, {
        cwd: root,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
    });

    if (result.error) {
        throw new TreeIntegrityError(
            `git ${args.join(" ")} failed to run: ${result.error.message}`
        );
    }
    if (result.signal) {
        throw new TreeIntegrityError(`git ${args.join(" ")} terminated by signal ${result.signal}`);
    }

    return result;
}

function runGit(root: string, args: string[]): string {
    const result = runGitResult(root, args);
    if (result.status !== 0) {
        const stderr = (result.stderr ?? "").trim();
        throw new TreeIntegrityError(
            `git ${args.join(" ")} failed with exit ${result.status}${stderr ? `: ${stderr}` : ""}`
        );
    }

    return result.stdout ?? "";
}

function readHead(root: string): string | null {
    const result = runGitResult(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);

    if (result.status === 0) {
        const head = (result.stdout ?? "").trim();
        if (head.length === 0) {
            throw new TreeIntegrityError("git rev-parse returned an empty HEAD");
        }
        return head;
    }

    if (result.status !== 1) {
        const stderr = (result.stderr ?? "").trim();
        throw new TreeIntegrityError(
            `git rev-parse HEAD failed with exit ${result.status}${stderr ? `: ${stderr}` : ""}`
        );
    }

    // Exit 1 with --quiet may be a legitimately unborn HEAD. Confirm that the
    // repository has no commits at all; otherwise an unresolvable HEAD is an
    // inspection failure and must not be recorded as a valid snapshot.
    const commits = runGitResult(root, ["rev-list", "--all", "--max-count=1"]);
    if (commits.status !== 0) {
        const stderr = (commits.stderr ?? "").trim();
        throw new TreeIntegrityError(
            `git rev-list failed with exit ${commits.status}${stderr ? `: ${stderr}` : ""}`
        );
    }
    if ((commits.stdout ?? "").trim().length > 0) {
        throw new TreeIntegrityError(
            "git rev-parse HEAD failed although the repository has commits"
        );
    }

    return null;
}

/**
 * Hash a path with SHA-256 using a fixed-size buffer.
 * Symlinks are represented by their target string; regular files are streamed
 * so auxiliary memory does not grow with file size. Missing files return null.
 */
export function hashPath(absolutePath: string): string | null {
    try {
        const stat = lstatSync(absolutePath);
        if (stat.isSymbolicLink()) {
            return `symlink:${readlinkSync(absolutePath)}`;
        }
        if (!stat.isFile()) {
            throw new TreeIntegrityError(`cannot hash non-file path: ${absolutePath}`);
        }

        let fd: number;
        try {
            fd = openSync(absolutePath, "r");
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw e;
        }

        const hash = createHash("sha256");
        const buffer = Buffer.alloc(HASH_BUFFER_SIZE);
        try {
            while (true) {
                const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
                if (bytesRead === 0) break;
                hash.update(buffer.subarray(0, bytesRead));
            }
        } finally {
            closeSync(fd);
        }

        return hash.digest("hex");
    } catch (e) {
        if (e instanceof TreeIntegrityError) throw e;
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null;
        const message = e instanceof Error ? e.message : String(e);
        throw new TreeIntegrityError(`cannot hash ${absolutePath}: ${message}`);
    }
}

/**
 * Snapshot the non-ignored working tree for `root`.
 * Throws `TreeIntegrityError` when git cannot inspect the repository.
 */
export function snapshotTree(root: string): TreeSnapshot {
    const resolvedRoot = resolve(root);

    // Run status first: it fails closed when `root` is not a git repository.
    const raw = runGit(resolvedRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
    ]);

    // Null prototype keeps Git-valid names such as `__proto__` as own entries.
    const entries: Record<string, TreeEntry> = Object.create(null);
    for (const record of raw.split("\0")) {
        if (record.length === 0) continue;
        if (record.length < 4) {
            throw new TreeIntegrityError(`unexpected git status record: ${JSON.stringify(record)}`);
        }
        const status = record.slice(0, 2);
        const relativePath = record.slice(3);
        entries[relativePath] = {
            status,
            hash: hashPath(join(resolvedRoot, relativePath)),
        };
    }

    return {
        root: resolvedRoot,
        head: readHead(resolvedRoot),
        entries,
    };
}

/** Persist a snapshot as JSON. */
export function writeSnapshot(file: string, snapshot: TreeSnapshot): void {
    writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
}

/** Read and validate a snapshot written by `writeSnapshot`. */
export function readSnapshot(file: string): TreeSnapshot {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new TreeIntegrityError(`cannot read snapshot ${file}: ${message}`);
    }

    if (!parsed || typeof parsed !== "object") {
        throw new TreeIntegrityError(`invalid snapshot file: ${file}`);
    }

    const candidate = parsed as Partial<TreeSnapshot>;
    const root = candidate.root;
    const head = candidate.head;
    const rawEntries = candidate.entries;
    if (
        typeof root !== "string" ||
        !("head" in candidate) ||
        !(head === null || typeof head === "string") ||
        !rawEntries ||
        typeof rawEntries !== "object" ||
        Array.isArray(rawEntries)
    ) {
        throw new TreeIntegrityError(`invalid snapshot file: ${file}`);
    }

    // JSON.parse creates own properties for `__proto__`; copy them into a
    // null-prototype map so later lookups cannot fall through to Object.prototype.
    const entries: Record<string, TreeEntry> = Object.create(null);
    for (const [path, rawEntry] of Object.entries(rawEntries)) {
        if (!rawEntry || typeof rawEntry !== "object") {
            throw new TreeIntegrityError(`invalid snapshot entry for ${JSON.stringify(path)}: ${file}`);
        }
        const entry = rawEntry as Partial<TreeEntry>;
        if (typeof entry.status !== "string" || !("hash" in entry)) {
            throw new TreeIntegrityError(`invalid snapshot entry for ${JSON.stringify(path)}: ${file}`);
        }
        if (entry.hash !== null && typeof entry.hash !== "string") {
            throw new TreeIntegrityError(`invalid snapshot entry for ${JSON.stringify(path)}: ${file}`);
        }
        entries[path] = { status: entry.status, hash: entry.hash };
    }

    return {
        root,
        head,
        entries,
    };
}

/**
 * Compare two snapshots and return human-readable integrity errors.
 * An empty array means the run did not change the working tree.
 */
export function compareTreeSnapshots(before: TreeSnapshot, after: TreeSnapshot): string[] {
    const errors: string[] = [];

    if (before.root !== after.root) {
        errors.push(`repository root changed: ${before.root} -> ${after.root}`);
    }
    if (before.head !== after.head) {
        errors.push(`HEAD changed during baseline: ${before.head ?? "(none)"} -> ${after.head ?? "(none)"}`);
    }

    const beforePaths = new Set(Object.keys(before.entries));
    const afterPaths = new Set(Object.keys(after.entries));

    for (const path of afterPaths) {
        if (!beforePaths.has(path)) {
            const entry = after.entries[path];
            errors.push(`unexpected ${entry.status} entry appeared during baseline: ${path}`);
        }
    }

    for (const path of beforePaths) {
        if (!afterPaths.has(path)) {
            errors.push(`preexisting entry disappeared during baseline: ${path}`);
            continue;
        }

        const beforeEntry = before.entries[path];
        const afterEntry = after.entries[path];

        if (beforeEntry.status !== afterEntry.status) {
            errors.push(
                `status changed during baseline for ${path}: "${beforeEntry.status}" -> "${afterEntry.status}"`
            );
        }
        if (beforeEntry.hash !== afterEntry.hash) {
            errors.push(`content changed during baseline for preexisting entry: ${path}`);
        }
    }

    return errors.sort();
}

/** Verify the current tree against a snapshot file; returns errors (empty = clean). */
export function verifySnapshotFile(file: string): string[] {
    const before = readSnapshot(file);
    const after = snapshotTree(before.root);
    return compareTreeSnapshots(before, after);
}

function parseOption(argv: string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (!value) throw new TreeIntegrityError(`${name} requires a value`);
    return value;
}

function printErrors(errors: string[]): void {
    console.error("✖ Working tree changed during the baseline:");
    for (const error of errors) {
        console.error(`  - ${error}`);
    }
}

function runBaseline(): number {
    const tempDir = mkdtempSync(join(tmpdir(), "ouroboros-check-"));
    const snapshotFile = join(tempDir, "tree.json");

    try {
        writeSnapshot(snapshotFile, snapshotTree(ROOT));

        for (const step of BASELINE_STEPS) {
            console.log(`\n$ bun run ${step}`);
            const result = spawnSync("bun", ["run", step], {
                cwd: ROOT,
                stdio: "inherit",
                env: process.env,
            });

            if (result.error) {
                console.error(`✖ Failed to spawn bun run ${step}: ${result.error.message}`);
                return 1;
            }
            if (result.signal) {
                console.error(`✖ bun run ${step} terminated by signal ${result.signal}`);
                return 1;
            }
            if (result.status !== 0) {
                console.error(`✖ bun run ${step} failed (exit ${result.status ?? "null"})`);
                return result.status ?? 1;
            }
        }

        const errors = verifySnapshotFile(snapshotFile);
        if (errors.length > 0) {
            printErrors(errors);
            return 1;
        }

        console.log("\n✓ Baseline left the working tree unchanged.");
        return 0;
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function main(argv: string[]): number {
    const command = argv[0];

    if (command === "run") {
        return runBaseline();
    }

    if (command === "snapshot") {
        const file = parseOption(argv, "--file");
        if (!file) throw new TreeIntegrityError("snapshot requires --file <path>");
        const root = parseOption(argv, "--root") ?? ROOT;
        writeSnapshot(file, snapshotTree(root));
        console.log(`✓ Tree snapshot written to ${file}`);
        return 0;
    }

    if (command === "verify") {
        const file = parseOption(argv, "--file");
        if (!file) throw new TreeIntegrityError("verify requires --file <path>");
        const errors = verifySnapshotFile(file);
        if (errors.length > 0) {
            printErrors(errors);
            return 1;
        }
        console.log("✓ Working tree matches the baseline snapshot.");
        return 0;
    }

    console.error("Usage: bun run scripts/check-tree-integrity.ts <snapshot|verify|run> [--file <path>] [--root <path>]");
    return 1;
}

if (import.meta.main) {
    try {
        process.exitCode = main(Bun.argv.slice(2));
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`✖ ${message}`);
        process.exitCode = 1;
    }
}
