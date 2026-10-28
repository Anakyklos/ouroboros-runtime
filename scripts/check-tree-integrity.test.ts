import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    compareTreeSnapshots,
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
