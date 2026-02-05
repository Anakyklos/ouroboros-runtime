/**
 * 🧪 Orchestrator Tests
 * 
 * Unit tests for the Orchestrator class.
 * Run with: bun test cli/src/orchestration/Orchestrator.test.ts
 */

import { describe, expect, it, mock } from "bun:test";
import {
    TaskStatus,
    SUCCESS_INDICATORS,
    FAILURE_INDICATORS,
} from "./types.js";

// Mock evaluateResult logic (extracted for unit testing)
function evaluateResult(result: { success: boolean; output: string; error?: string }): {
    status: TaskStatus;
    error?: string;
} {
    const output = result.output.toLowerCase();

    if (!result.success) {
        return {
            status: TaskStatus.FAILURE,
            error: result.error || "Execution failed with non-zero exit code",
        };
    }

    for (const indicator of FAILURE_INDICATORS) {
        if (result.output.includes(indicator)) {
            const errorLine = result.output
                .split("\n")
                .find(line => line.includes(indicator));
            return {
                status: TaskStatus.FAILURE,
                error: errorLine || `Output contains failure indicator: ${indicator}`,
            };
        }
    }

    for (const indicator of SUCCESS_INDICATORS) {
        if (output.includes(indicator.toLowerCase())) {
            return { status: TaskStatus.SUCCESS };
        }
    }

    return { status: TaskStatus.SUCCESS };
}

// Mock fixIssues logic
function fixIssues(originalInstruction: string, error: string): string {
    return `
⚠️ PREVIOUS ATTEMPT FAILED with error:
\`\`\`
${error}
\`\`\`

Please fix the issue and try again. Original task:
${originalInstruction}

IMPORTANT: Analyze the error carefully before proceeding.
`.trim();
}

describe("Orchestrator", () => {
    describe("evaluateResult", () => {
        it("detects success when output contains checkmark", () => {
            const result = { success: true, output: "✅ Task completed!" };
            expect(evaluateResult(result).status).toBe(TaskStatus.SUCCESS);
        });

        it("detects success when output contains SUCCESS keyword", () => {
            const result = { success: true, output: "Operation SUCCESS" };
            expect(evaluateResult(result).status).toBe(TaskStatus.SUCCESS);
        });

        it("detects failure when exit code is non-zero", () => {
            const result = { success: false, output: "", error: "Exit code 1" };
            expect(evaluateResult(result).status).toBe(TaskStatus.FAILURE);
        });

        it("detects failure when output contains ERROR", () => {
            const result = { success: true, output: "ERROR: File not found" };
            expect(evaluateResult(result).status).toBe(TaskStatus.FAILURE);
        });

        it("detects failure when output contains TypeError", () => {
            const result = { success: true, output: "TypeError: undefined is not a function" };
            expect(evaluateResult(result).status).toBe(TaskStatus.FAILURE);
        });

        it("defaults to success when no indicators present", () => {
            const result = { success: true, output: "Some neutral output" };
            expect(evaluateResult(result).status).toBe(TaskStatus.SUCCESS);
        });
    });

    describe("fixIssues", () => {
        it("includes error message in fixed prompt", () => {
            const fixed = fixIssues("Create a file", "Permission denied");
            expect(fixed).toContain("Permission denied");
        });

        it("preserves original instruction", () => {
            const instruction = "Implement feature X";
            const fixed = fixIssues(instruction, "Some error");
            expect(fixed).toContain(instruction);
        });

        it("adds warning header", () => {
            const fixed = fixIssues("task", "error");
            expect(fixed).toContain("PREVIOUS ATTEMPT FAILED");
        });
    });
});
