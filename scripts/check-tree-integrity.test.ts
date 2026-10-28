import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    compareTreeSnapshots,
    hashPath,
    readSnapshot,
    snapshotTree,
    writeSnapshot,
    TreeIntegrityError,
} from "./check-tree-integrity.js";

const SCRIPT = join(import.meta.dir, "check-tree-integrity.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function git(cwd: string, args: string[]): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (result.error || result.status !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr ?? result.status}`
        );
    }
    return result.stdout ?? "";
}

function createRepo(): string {
    const dir = makeTempDir("ouroboros-tree-integrity-repo-");
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "tree-integrity@example.test"]);
    git(dir, ["config", "user.name", "Tree Integrity Test"]);
    writeFileSync(join(dir, "tracked.txt"), "one\n");
    git(dir, ["add", "tracked.txt"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
    return dir;
}

function commitFile(dir: string, name: string, content: string): void {
    writeFileSync(join(dir, name), content);
    git(dir, ["add", "--", name]);
    git(dir, ["commit", "-q", "-m", `add ${name}`]);
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
});

describe("check-tree-integrity", () => {
    it("passes when the tree is unchanged", () => {
        const dir = createRepo();
        const before = snapshotTree(dir);
        expect(compareTreeSnapshots(before, snapshotTree(dir))).toEqual([]);
    });

    it("fails when a tracked file is modified", () => {
        const dir = createRepo();
        const before = snapshotTree(dir);
        writeFileSync(join(dir, "tracked.txt"), "two\n");

        const errors = compareTreeSnapshots(before, snapshotTree(dir));
        expect(errors.join("\n")).toContain("tracked.txt");
        expect(errors.length).toBeGreaterThan(0);
    });

    it("fails when a new non-ignored file appears", () => {
        const dir = createRepo();
        const before = snapshotTree(dir);
        writeFileSync(join(dir, "artifact.txt"), "unexpected\n");

        const errors = compareTreeSnapshots(before, snapshotTree(dir));
        expect(errors.join("\n")).toContain("unexpected ?? entry appeared during baseline: artifact.txt");
    });

    it("detects a modified tracked file named __proto__", () => {
        const dir = createRepo();
        commitFile(dir, "__proto__", "one\n");

        const before = snapshotTree(dir);
        writeFileSync(join(dir, "__proto__"), "two\n");
        const after = snapshotTree(dir);

        expect(Object.keys(after.entries)).toContain("__proto__");
        expect(Object.prototype.hasOwnProperty.call(after.entries, "__proto__")).toBe(true);

        const errors = compareTreeSnapshots(before, after);
        expect(errors.join("\n")).toContain("__proto__");
        expect(errors.length).toBeGreaterThan(0);
    });

    it("detects an untracked file named __proto__", () => {
        const dir = createRepo();
        const before = snapshotTree(dir);

        writeFileSync(join(dir, "__proto__"), "unexpected\n");
        const after = snapshotTree(dir);
        expect(Object.keys(after.entries)).toContain("__proto__");

        const errors = compareTreeSnapshots(before, after);
        expect(errors.join("\n")).toContain(
            "unexpected ?? entry appeared during baseline: __proto__"
        );
    });

    it("preserves __proto__ through snapshot JSON serialization", () => {
        const dir = createRepo();
        writeFileSync(join(dir, "__proto__"), "unexpected\n");
        const snapshotFile = join(makeTempDir("ouroboros-tree-integrity-snapshot-"), "tree.json");

        writeSnapshot(snapshotFile, snapshotTree(dir));
        const loaded = readSnapshot(snapshotFile);

        expect(Object.keys(loaded.entries)).toContain("__proto__");
        expect(Object.prototype.hasOwnProperty.call(loaded.entries, "__proto__")).toBe(true);
        expect(loaded.entries["__proto__"].status).toBe("??");
    });

    it("detects a modified tracked __proto__ through the real snapshot -> JSON -> verify flow", () => {
        const dir = createRepo();
        commitFile(dir, "__proto__", "one\n");
        const snapshotFile = join(makeTempDir("ouroboros-tree-integrity-snapshot-"), "tree.json");

        const snapshotResult = spawnSync(
            "bun",
            ["run", SCRIPT, "snapshot", "--root", dir, "--file", snapshotFile],
            { encoding: "utf-8" }
        );
        expect(snapshotResult.status).toBe(0);

        writeFileSync(join(dir, "__proto__"), "two\n");
        const verifyResult = spawnSync("bun", ["run", SCRIPT, "verify", "--file", snapshotFile], {
            encoding: "utf-8",
        });

        expect(verifyResult.status).not.toBe(0);
        expect(verifyResult.stderr).toContain("__proto__");
    });

    it("detects an untracked __proto__ through the real snapshot -> JSON -> verify flow", () => {
        const dir = createRepo();
        const snapshotFile = join(makeTempDir("ouroboros-tree-integrity-snapshot-"), "tree.json");

        const snapshotResult = spawnSync(
            "bun",
            ["run", SCRIPT, "snapshot", "--root", dir, "--file", snapshotFile],
            { encoding: "utf-8" }
        );
        expect(snapshotResult.status).toBe(0);

        writeFileSync(join(dir, "__proto__"), "unexpected\n");
        const verifyResult = spawnSync("bun", ["run", SCRIPT, "verify", "--file", snapshotFile], {
            encoding: "utf-8",
        });

        expect(verifyResult.status).not.toBe(0);
        expect(verifyResult.stderr).toContain("__proto__");
    });

    it("preserves other Git-valid special names", () => {
        const dir = createRepo();
        const names = ["constructor", "toString", "hasOwnProperty"];
        for (const name of names) {
            commitFile(dir, name, "one\n");
        }

        const before = snapshotTree(dir);
        for (const name of names) {
            writeFileSync(join(dir, name), "two\n");
        }
        const after = snapshotTree(dir);

        for (const name of names) {
            expect(Object.prototype.hasOwnProperty.call(after.entries, name)).toBe(true);
        }

        const errors = compareTreeSnapshots(before, after);
        for (const name of names) {
            expect(errors.join("\n")).toContain(name);
        }
    });

    it("fails when a child build/test process produces an artifact", () => {
        const dir = createRepo();
        const artifact = join(dir, "generated-by-child.txt");
        const before = snapshotTree(dir);

        const result = spawnSync("bun", ["-e", `await Bun.write(${JSON.stringify(artifact)}, "artifact")`], {
            cwd: dir,
            encoding: "utf-8",
        });
        expect(result.status).toBe(0);

        const errors = compareTreeSnapshots(before, snapshotTree(dir));
        expect(errors.join("\n")).toContain("generated-by-child.txt");
    });

    it("ignores gitignored build outputs", () => {
        const dir = createRepo();
        writeFileSync(join(dir, ".gitignore"), "dist/\n");
        git(dir, ["add", ".gitignore"]);
        git(dir, ["commit", "-q", "-m", "ignore dist"]);

        const before = snapshotTree(dir);
        mkdirSync(join(dir, "dist"));
        writeFileSync(join(dir, "dist", "bundle.js"), "generated\n");

        expect(compareTreeSnapshots(before, snapshotTree(dir))).toEqual([]);
    });

    it("allows preexisting dirty content but detects changes to it", () => {
        const dir = createRepo();
        writeFileSync(join(dir, "tracked.txt"), "developer edit\n");

        const before = snapshotTree(dir);
        expect(compareTreeSnapshots(before, snapshotTree(dir))).toEqual([]);

        writeFileSync(join(dir, "tracked.txt"), "baseline edit\n");
        const errors = compareTreeSnapshots(before, snapshotTree(dir));
        expect(errors.join("\n")).toContain(
            "content changed during baseline for preexisting entry: tracked.txt"
        );
    });

    it("allows preexisting untracked content but detects changes to it", () => {
        const dir = createRepo();
        const notes = join(dir, "notes.txt");
        writeFileSync(notes, "developer notes\n");

        const before = snapshotTree(dir);
        expect(compareTreeSnapshots(before, snapshotTree(dir))).toEqual([]);

        writeFileSync(notes, "baseline appended\n");
        const errors = compareTreeSnapshots(before, snapshotTree(dir));
        expect(errors.join("\n")).toContain(
            "content changed during baseline for preexisting entry: notes.txt"
        );
    });

    it("fails when a preexisting change disappears", () => {
        const dir = createRepo();
        writeFileSync(join(dir, "tracked.txt"), "developer edit\n");

        const before = snapshotTree(dir);
        git(dir, ["checkout", "--", "tracked.txt"]);

        const errors = compareTreeSnapshots(before, snapshotTree(dir));
        expect(errors.join("\n")).toContain("preexisting entry disappeared during baseline: tracked.txt");
    });

    it("streams SHA-256 with the same digest for small and larger-than-buffer files", () => {
        const dir = makeTempDir("ouroboros-tree-integrity-hash-");
        const smallContent = Buffer.from("small file\n");
        const largeContent = Buffer.alloc(256 * 1024 + 123);
        for (let i = 0; i < largeContent.length; i++) {
            largeContent[i] = i % 251;
        }

        const smallPath = join(dir, "small.bin");
        const largePath = join(dir, "large.bin");
        writeFileSync(smallPath, smallContent);
        writeFileSync(largePath, largeContent);

        const expectedSmall = createHash("sha256").update(smallContent).digest("hex");
        const expectedLarge = createHash("sha256").update(largeContent).digest("hex");

        expect(hashPath(smallPath)).toBe(expectedSmall);
        expect(hashPath(largePath)).toBe(expectedLarge);
        expect(hashPath(largePath)).not.toBe(expectedSmall);
    });

    it("returns null for a missing path and preserves symlink semantics", () => {
        const dir = makeTempDir("ouroboros-tree-integrity-hash-");
        const target = join(dir, "target.txt");
        const link = join(dir, "link.txt");
        writeFileSync(target, "target\n");
        symlinkSync("target.txt", link);

        expect(hashPath(join(dir, "missing.txt"))).toBeNull();
        expect(hashPath(link)).toBe("symlink:target.txt");
    });

    it("fails closed for a non-file path instead of hashing silently", () => {
        const dir = makeTempDir("ouroboros-tree-integrity-hash-");
        expect(() => hashPath(dir)).toThrow(TreeIntegrityError);
    });

    it("allows a repository with no commits (legitimately unborn HEAD)", () => {
        const dir = makeTempDir("ouroboros-tree-integrity-empty-repo-");
        git(dir, ["init", "-q"]);

        const snapshot = snapshotTree(dir);
        expect(snapshot.head).toBeNull();
        expect(compareTreeSnapshots(snapshot, snapshotTree(dir))).toEqual([]);
    });

    it("fails closed when HEAD cannot be resolved in a repository with commits", () => {
        const dir = createRepo();
        writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/does-not-exist\n");

        expect(() => snapshotTree(dir)).toThrow(TreeIntegrityError);
    });

    it("fails closed through the CLI when HEAD cannot be resolved", () => {
        const dir = createRepo();
        writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/does-not-exist\n");
        const snapshotFile = join(makeTempDir("ouroboros-tree-integrity-snapshot-"), "tree.json");

        const result = spawnSync(
            "bun",
            ["run", SCRIPT, "snapshot", "--root", dir, "--file", snapshotFile],
            { encoding: "utf-8" }
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("rev-parse");
    });

    it("fails closed when git cannot inspect the tree", () => {
        const dir = makeTempDir("ouroboros-tree-integrity-not-a-repo-");
        const snapshotFile = join(makeTempDir("ouroboros-tree-integrity-snapshot-"), "tree.json");

        const result = spawnSync(
            "bun",
            ["run", SCRIPT, "snapshot", "--root", dir, "--file", snapshotFile],
            { encoding: "utf-8" }
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("git status");
    });

    it("fails closed when git inspection fails during verify", () => {
        const dir = createRepo();
        const snapshotFile = join(makeTempDir("ouroboros-tree-integrity-snapshot-"), "tree.json");
        writeSnapshot(snapshotFile, snapshotTree(dir));

        rmSync(join(dir, ".git"), { recursive: true, force: true });

        const result = spawnSync("bun", ["run", SCRIPT, "verify", "--file", snapshotFile], {
            encoding: "utf-8",
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("git status");
    });

    it("throws TreeIntegrityError instead of treating a failed inspection as clean", () => {
        const dir = makeTempDir("ouroboros-tree-integrity-not-a-repo-");
        expect(() => snapshotTree(dir)).toThrow(TreeIntegrityError);
    });
});
