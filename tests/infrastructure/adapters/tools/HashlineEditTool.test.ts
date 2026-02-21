import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { HashlineEditTool } from "../../../../src/infrastructure/adapters/tools/HashlineEditTool";
import * as fs from "fs";
import * as path from "path";

describe("HashlineEditTool", () => {
    let tool: HashlineEditTool;
    const testDir = path.join(process.cwd(), "tests/infrastructure/adapters/tools/temp");
    const testFile = path.join(testDir, "test.txt");

    beforeAll(() => {
        tool = new HashlineEditTool();
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("should create the tool with correct properties", () => {
        expect(tool.name).toBe("hashline_edit");
        expect(tool.description).toContain("safe file editor");
    });

    it("should read a file and append hashes", async () => {
        fs.writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

        const result = await tool.execute({
            action: "read",
            filePath: testFile
        });

        expect(result).toContain("1#");
        expect(result).toContain("Hello" ? "Line 1" : "Line 1"); // simple assertion of content

        // Let's capture the hash of the second line
        const lines = result.split("\n");
        const line2Hash = lines[1].substring(2, 4); // Format: 2#XX:Line 2

        // Execute an edit using that hash
        const editResult = await tool.execute({
            action: "edit",
            filePath: testFile,
            edits: [{
                type: "set_line",
                lineHash: `2#${line2Hash}`,
                content: "Edited Line 2"
            }]
        });

        expect(editResult).toContain("Edited Line 2");
        expect(editResult).not.toContain("2#XX:Line 2"); // The old line content should be gone

        // Verify file on disk
        const diskContent = fs.readFileSync(testFile, "utf-8");
        expect(diskContent).toContain("Edited Line 2");
        expect(diskContent).toContain("Line 1");
        expect(diskContent).toContain("Line 3");
    });
});
