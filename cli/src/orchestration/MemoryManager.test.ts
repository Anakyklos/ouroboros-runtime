import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryManager } from "./MemoryManager";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

describe("MemoryManager", () => {
    let tempDir: string;
    let memoryManager: MemoryManager;

    beforeEach(() => {
        tempDir = path.join(tmpdir(), `memory-manager-test-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        memoryManager = new MemoryManager(tempDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should load recent context from today and yesterday", async () => {
        const today = new Date().toISOString().split("T")[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

        const memDir = path.join(tempDir, ".agent/memory");
        fs.mkdirSync(memDir, { recursive: true });

        fs.writeFileSync(path.join(memDir, `${yesterday}.md`), "Yesterday's log");
        fs.writeFileSync(path.join(memDir, `${today}.md`), "Today's log");

        const context = await memoryManager.loadRecentContext();
        expect(context).toContain(`Log ${yesterday}`);
        expect(context).toContain("Yesterday's log");
        expect(context).toContain(`Log ${today}`);
        expect(context).toContain("Today's log");
    });

    it("should return default message if no logs found", async () => {
        const context = await memoryManager.loadRecentContext();
        expect(context).toBe("No recent memory found.");
    });

    it("should generate daily summary", async () => {
        const today = new Date().toISOString().split("T")[0];
        const memDir = path.join(tempDir, ".agent/memory");
        fs.mkdirSync(memDir, { recursive: true });

        const content = `
## Task: task-1 ✅
- Status: SUCCESS
---
## Task: task-2 ❌
- Status: FAILURE
---
`;
        fs.writeFileSync(path.join(memDir, `${today}.md`), content);

        const summary = await memoryManager.generateDailySummary();
        expect(summary).toContain("**Total Tasks**: 2");
        expect(summary).toContain("**Success**: 1");
        expect(summary).toContain("**Failed/Escalated**: 1");
    });
});
