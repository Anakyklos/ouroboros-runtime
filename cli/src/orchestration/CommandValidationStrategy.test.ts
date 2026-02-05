/**
 * 🧪 Command Validation Strategy Tests
 */

import { describe, test, expect } from "bun:test";
import {
    CommandValidationStrategy,
    createTestValidationStrategy,
    createCustomValidationStrategy,
} from "./strategies/CommandValidationStrategy";
import type { ValidationContext } from "./types";

describe("CommandValidationStrategy", () => {
    const createContext = (overrides?: Partial<ValidationContext>): ValidationContext => ({
        workDir: process.cwd(),
        taskId: "test-task-1",
        output: "test output",
        ...overrides,
    });

    describe("validate", () => {
        test("should return isValid=true for successful command (exit 0)", async () => {
            const strategy = new CommandValidationStrategy("echo hello", 5000);
            const result = await strategy.validate(createContext());

            expect(result.isValid).toBe(true);
            expect(result.exitCode).toBe(0);
            expect(result.message).toContain("hello");
        });

        test("should return isValid=false for failing command (exit != 0)", async () => {
            // Comando que falha em qualquer OS
            const strategy = new CommandValidationStrategy("exit 1", 5000);
            const result = await strategy.validate(createContext());

            expect(result.isValid).toBe(false);
            expect(result.exitCode).toBe(1);
        });

        test("should handle timeout gracefully", async () => {
            // Comando que demora mais que o timeout
            const strategy = new CommandValidationStrategy(
                process.platform === "win32" ? "ping -n 10 127.0.0.1" : "sleep 10",
                500 // Timeout curto
            );
            const result = await strategy.validate(createContext());

            expect(result.isValid).toBe(false);
            // Timeout pode ter exit codes diferentes dependendo do OS
        });

        test("should respect workDir", async () => {
            const strategy = new CommandValidationStrategy(
                process.platform === "win32" ? "cd" : "pwd",
                5000
            );
            const result = await strategy.validate(createContext({ workDir: process.cwd() }));

            expect(result.isValid).toBe(true);
            expect(result.details?.workDir).toBe(process.cwd());
        });

        test("should sanitize secrets in output", async () => {
            // Simula output com um token GitHub
            const strategy = new CommandValidationStrategy(
                `echo "token: ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII"`,
                5000
            );
            const result = await strategy.validate(createContext());

            expect(result.isValid).toBe(true);
            // O token deve estar mascarado
            expect(result.message).toContain("[REDACTED]");
            expect(result.message).not.toContain("ghp_");
        });
    });

    describe("name property", () => {
        test("should include command in name", () => {
            const strategy = new CommandValidationStrategy("bun test");
            expect(strategy.name).toBe("CommandValidation(bun test)");
        });
    });

    describe("factories", () => {
        test("createTestValidationStrategy should return strategy with bun test", () => {
            const strategy = createTestValidationStrategy();
            expect(strategy.name).toContain("bun test");
        });

        test("createCustomValidationStrategy should accept custom command", () => {
            const strategy = createCustomValidationStrategy("npm run build", 60000);
            expect(strategy.name).toContain("npm run build");
        });
    });
});
