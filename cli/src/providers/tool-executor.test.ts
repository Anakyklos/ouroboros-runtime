/**
 * QUARANTINED — excluded from `bun run check:tests` (baseline gate).
 * Recovery debt: https://github.com/RenyEnnos/ouroboros-runtime/issues/41
 * Manifest: scripts/quarantine-manifest.json
 * Do not delete/rename this file to make CI green; fix or keep listed in the manifest.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolExecutor } from "./tool-executor";

describe("ToolExecutor.handleListDirectory (Optimized)", () => {
    const testDir = path.join(process.cwd(), "test_list_dir_v2");

    beforeAll(() => {
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
        fs.mkdirSync(path.join(testDir, "subdir1"), { recursive: true });
        fs.mkdirSync(path.join(testDir, "subdir2"), { recursive: true });
        fs.writeFileSync(path.join(testDir, "file1.txt"), "content1");
        fs.writeFileSync(path.join(testDir, "subdir1", "file2.txt"), "content2");
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    test("should list directory non-recursively", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleListDirectory({ path: "test_list_dir_v2", recursive: false });

        expect(result.success).toBe(true);
        const entries = result.output.split("\n").sort();
        expect(entries).toContain("file1.txt");
        expect(entries).toContain("subdir1/");
        expect(entries).toContain("subdir2/");
    });

    test("should list directory recursively", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleListDirectory({ path: "test_list_dir_v2", recursive: true });

        expect(result.success).toBe(true);
        const entries = result.output.split("\n").sort();
        expect(entries).toContain("file1.txt");
        expect(entries).toContain("subdir1/");
        expect(entries).toContain("subdir2/");
        expect(entries).toContain("subdir1/file2.txt");
    });

    test("should return error if directory does not exist", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleListDirectory({ path: "non_existent_dir_123", recursive: false });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Error listing directory");
    });

    test("should handle inaccessible subdirectories gracefully", async () => {
        const restrictedDir = path.join(testDir, "restricted");
        if (!fs.existsSync(restrictedDir)) {
            fs.mkdirSync(restrictedDir, { recursive: true, mode: 0o000 });
        }

        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleListDirectory({ path: "test_list_dir_v2", recursive: true });

        expect(result.success).toBe(true);
        const entries = result.output.split("\n").sort();
        expect(entries).toContain("restricted/");
        // Cleanup restricted dir for afterAll
        fs.chmodSync(restrictedDir, 0o755);
    });
});

describe("ToolExecutor.handleReadFile", () => {
    const testDir = path.join(process.cwd(), "test_read_file");
    const testFile = path.join(testDir, "test.txt");
    const multiLineFile = path.join(testDir, "multiline.txt");

    beforeAll(() => {
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
        fs.writeFileSync(testFile, "Hello, world!");
        fs.writeFileSync(multiLineFile, "Line 1\nLine 2\nLine 3\nLine 4\nLine 5");
describe("ToolExecutor.handleGrepSearch", () => {
    const testDir = path.join(process.cwd(), "test_grep_dir");

    beforeAll(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
        fs.mkdirSync(testDir, { recursive: true });
        fs.mkdirSync(path.join(testDir, "subdir1"), { recursive: true });

        fs.writeFileSync(path.join(testDir, "file1.txt"), "This is a test file with pattern.");
        fs.writeFileSync(path.join(testDir, "file2.js"), "This is a js file with pattern.");
        fs.writeFileSync(path.join(testDir, "subdir1", "file3.txt"), "Nested file with pattern inside.");
        fs.writeFileSync(path.join(testDir, "subdir1", "file4.txt"), "No match here.");
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    test("should read file successfully", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleReadFile({ path: path.relative(process.cwd(), testFile) });

        expect(result.success).toBe(true);
        expect(result.output).toBe("Hello, world!");
    });

    test("should read file with line range (start_line)", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleReadFile({
            path: path.relative(process.cwd(), multiLineFile),
            start_line: 2
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe("Line 2\nLine 3\nLine 4\nLine 5");
    });

    test("should read file with line range (end_line)", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleReadFile({
            path: path.relative(process.cwd(), multiLineFile),
            end_line: 3
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe("Line 1\nLine 2\nLine 3");
    });

    test("should read file with specific range", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleReadFile({
            path: path.relative(process.cwd(), multiLineFile),
            start_line: 2,
            end_line: 4
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe("Line 2\nLine 3\nLine 4");
    });

    test("should return error if file does not exist", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleReadFile({ path: "non_existent_file.txt" });

        expect(result.success).toBe(false);
        expect(result.error).toContain("File not found");
    });

    test("should return error if path is a directory", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleReadFile({ path: path.relative(process.cwd(), testDir) });

        expect(result.success).toBe(false);
        // Expect failure, specific error message depends on implementation details
        expect(result.success).toBe(false);
    test("should find pattern in files recursively", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleGrepSearch({
            path: "test_grep_dir",
            pattern: "pattern"
        });

        expect(result.success).toBe(true);
        const output = result.output;
        expect(output).toContain("file1.txt");
        expect(output).toContain("file2.js");
        expect(output).toContain("subdir1/file3.txt");
        expect(output).not.toContain("file4.txt");
    });

    test("should filter by include glob", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleGrepSearch({
            path: "test_grep_dir",
            pattern: "pattern",
            include: "*.txt"
        });

        expect(result.success).toBe(true);
        const output = result.output;
        expect(output).toContain("file1.txt");
        expect(output).not.toContain("file2.js"); // JS file should be excluded
        expect(output).toContain("subdir1/file3.txt");
    });

    test("should handle non-existent path gracefully", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleGrepSearch({
            path: "non_existent_grep_path",
            pattern: "pattern"
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Path not found");
    });

    test("should search specific file if path is a file", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleGrepSearch({
            path: "test_grep_dir/file1.txt",
            pattern: "pattern"
        });

        expect(result.success).toBe(true);
        expect(result.output).toContain("file1.txt");
        expect(result.output).not.toContain("file2.js");
    });
});
