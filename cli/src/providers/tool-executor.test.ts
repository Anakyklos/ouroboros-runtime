
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolExecutor } from "./tool-executor";

describe("ToolExecutor.handleListDirectory", () => {
    const testDir = path.join(process.cwd(), "test_list_dir");

    beforeAll(() => {
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
        if (fs.existsSync(path.join(testDir, "subdir1"))) {
             fs.rmSync(path.join(testDir, "subdir1"), { recursive: true, force: true });
        }
        if (fs.existsSync(path.join(testDir, "subdir2"))) {
             fs.rmSync(path.join(testDir, "subdir2"), { recursive: true, force: true });
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
        const result = await (executor as any).handleListDirectory({ path: "test_list_dir", recursive: false });

        expect(result.success).toBe(true);
        const entries = result.output.split("\n");
        expect(entries).toContain("file1.txt");
        expect(entries).toContain("subdir1/");
        expect(entries).toContain("subdir2/");
        expect(entries).not.toContain("subdir1/file2.txt");
    });

    test("should list directory recursively", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleListDirectory({ path: "test_list_dir", recursive: true });

        expect(result.success).toBe(true);
        const entries = result.output.split("\n");
        expect(entries).toContain("file1.txt");
        expect(entries).toContain("subdir1/");
        expect(entries).toContain("subdir2/");
        expect(entries).toContain("subdir1/file2.txt");
    });

    test("should return error if directory does not exist", async () => {
        const executor = new ToolExecutor({ workingDirectory: process.cwd() });
        const result = await (executor as any).handleListDirectory({ path: "non_existent_dir", recursive: false });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Directory not found");
    });
});
