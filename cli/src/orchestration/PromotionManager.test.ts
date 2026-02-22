/**
 * 📤 PromotionManager Unit Tests
 *
 * Tests for the playground → src promotion workflow with quality gates.
 * Uses MockValidationStrategy for isolated testing.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { PromotionManager } from "./PromotionManager.js";
import { PromotionStatus, QualityGateType } from "./promotion-types.js";
import type { ValidationStrategy, ValidationContext, ValidationResult } from "./types.js";
import type { PromotionConfig } from "./promotion-types.js";

// --- MOCK VALIDATION STRATEGY ---

class MockValidationStrategy implements ValidationStrategy {
    readonly name: string;
    private shouldPass: boolean;
    private executionTimeMs: number;

    constructor(name: string, shouldPass: boolean, executionTimeMs = 100) {
        this.name = name;
        this.shouldPass = shouldPass;
        this.executionTimeMs = executionTimeMs;
    }

    async validate(context: ValidationContext): Promise<ValidationResult> {
        await new Promise(resolve => setTimeout(resolve, this.executionTimeMs));

        if (this.shouldPass) {
            return {
                isValid: true,
                exitCode: 0,
                message: `${this.name} passed successfully`,
                details: {
                    workDir: context.workDir,
                    durationMs: this.executionTimeMs,
                },
            };
        } else {
            return {
                isValid: false,
                exitCode: 1,
                message: `${this.name} failed`,
                details: {
                    workDir: context.workDir,
                    durationMs: this.executionTimeMs,
                },
            };
        }
    }
}

// --- TEST SETUP ---

interface TestSetup {
    tempDir: string;
    playgroundDir: string;
    srcDir: string;
    promotionManager: PromotionManager;
    cleanup: () => void;
}

function setupTest(): TestSetup {
    const tempDir = path.join(tmpdir(), `promotion-test-${Date.now()}`);
    const playgroundDir = path.join(tempDir, "playground");
    const srcDir = path.join(tempDir, "src");

    fs.mkdirSync(playgroundDir, { recursive: true });
    fs.mkdirSync(srcDir, { recursive: true });

    const config: Partial<PromotionConfig> = {
        projectRoot: tempDir,
        sourceDir: "playground",
        targetDir: "src",
        requireApproval: false, // Auto-approve for testing
        requiredGates: [QualityGateType.TEST, QualityGateType.TYPE_CHECK],
        verbose: false,
    };

    const promotionManager = new PromotionManager(config);

    return {
        tempDir,
        playgroundDir,
        srcDir,
        promotionManager,
        cleanup: () => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        },
    };
}

// --- TEST SUITES ---

describe("PromotionManager", () => {
    describe("Candidate Registration", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should register a candidate for promotion", async () => {
            const candidate = await setup.promotionManager.registerCandidate(
                "utils/test.ts",
                "src/utils/test.ts",
                "test-task"
            );

            expect(candidate.sourcePath).toBe("utils/test.ts");
            expect(candidate.targetPath).toBe("src/utils/test.ts");
            expect(candidate.taskId).toBe("test-task");
            expect(candidate.status).toBe(PromotionStatus.PENDING);
            expect(candidate.createdAt).toBeDefined();
            expect(candidate.updatedAt).toBeDefined();
        });

        it("should persist candidate state to disk", async () => {
            await setup.promotionManager.registerCandidate(
                "utils/persist.ts",
                "src/utils/persist.ts"
            );

            const state = setup.promotionManager.getState();
            expect(state.candidates).toHaveLength(1);
            expect(state.candidates[0].sourcePath).toBe("utils/persist.ts");
        });

        it("should load existing state from disk", async () => {
            await setup.promotionManager.registerCandidate(
                "utils/existing.ts",
                "src/utils/existing.ts"
            );

            // Create new manager instance - should load existing state
            const newManager = new PromotionManager({
                projectRoot: setup.tempDir,
                sourceDir: "playground",
                targetDir: "src",
                verbose: false,
            });

            const state = newManager.getState();
            expect(state.candidates).toHaveLength(1);
            expect(state.candidates[0].sourcePath).toBe("utils/existing.ts");
        });
    });

    describe("Quality Gate Execution", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should run all quality gates successfully", async () => {
            const sourcePath = "utils/success.ts";
            const testFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, "export function test() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath, "test-task");

            // Set passing validators
            setup.promotionManager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", true, 50)
            );
            setup.promotionManager.setValidationStrategy(
                QualityGateType.TYPE_CHECK,
                new MockValidationStrategy("TYPE_CHECK", true, 50)
            );

            const validations = await setup.promotionManager.validateCandidate(sourcePath);

            expect(validations).toHaveLength(2);
            expect(validations.every(v => v.result.isValid)).toBe(true);

            const state = setup.promotionManager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe(PromotionStatus.AWAITING_APPROVAL);
        });

        it("should fail when quality gate validation fails", async () => {
            const sourcePath = "utils/failing.ts";
            const testFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, "export function failing() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath, "test-task");

            // Set failing validator
            setup.promotionManager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", false, 50)
            );

            const validations = await setup.promotionManager.validateCandidate(sourcePath);

            expect(validations).toHaveLength(1);
            expect(validations[0].result.isValid).toBe(false);

            const state = setup.promotionManager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe(PromotionStatus.REJECTED);
            expect(candidate?.rejectionReason).toContain("TEST");
        });

        it("should stop at first failed quality gate", async () => {
            const sourcePath = "utils/stop.ts";
            const testFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, "export function stop() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath, "test-task");

            // First gate passes, second fails
            setup.promotionManager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", true, 10)
            );
            setup.promotionManager.setValidationStrategy(
                QualityGateType.TYPE_CHECK,
                new MockValidationStrategy("TYPE_CHECK", false, 10)
            );

            const validations = await setup.promotionManager.validateCandidate(sourcePath);

            // Should stop after TYPE_CHECK fails (not run any more gates)
            expect(validations).toHaveLength(2);
            expect(validations[0].result.isValid).toBe(true);
            expect(validations[1].result.isValid).toBe(false);
        });

        it("should throw error when candidate not found", async () => {
            await expect(
                setup.promotionManager.validateCandidate("nonexistent.ts")
            ).toThrow("Candidate not found: nonexistent.ts");
        });
    });

    describe("Approval Workflow", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should auto-approve when requireApproval is false", async () => {
            const sourcePath = "utils/auto-approve.ts";
            const testFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, "export function autoApprove() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

            setup.promotionManager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", true, 10)
            );

            await setup.promotionManager.validateCandidate(sourcePath);

            const approved = await setup.promotionManager.requestApproval(sourcePath);

            expect(approved).toBe(true);

            const state = setup.promotionManager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe(PromotionStatus.APPROVED);
        });

        it("should use approval callback when configured", async () => {
            // Create manager with approval required
            const config: Partial<PromotionConfig> = {
                projectRoot: setup.tempDir,
                sourceDir: "playground",
                targetDir: "src",
                requireApproval: true,
                requiredGates: [QualityGateType.TEST],
                verbose: false,
            };

            const approvalCallback = async () => true; // Always approve
            const manager = new PromotionManager(config, undefined, approvalCallback);

            const sourcePath = "utils/callback.ts";
            const testFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, "export function callback() {}", "utf-8");

            await manager.registerCandidate(sourcePath, sourcePath);

            manager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", true, 10)
            );

            await manager.validateCandidate(sourcePath);

            const approved = await manager.requestApproval(sourcePath);

            expect(approved).toBe(true);

            const state = manager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe(PromotionStatus.APPROVED);
        });

        it("should reject when approval callback returns false", async () => {
            const config: Partial<PromotionConfig> = {
                projectRoot: setup.tempDir,
                sourceDir: "playground",
                targetDir: "src",
                requireApproval: true,
                requiredGates: [QualityGateType.TEST],
                verbose: false,
            };

            const approvalCallback = async () => false; // Always reject
            const manager = new PromotionManager(config, undefined, approvalCallback);

            const sourcePath = "utils/reject.ts";
            const testFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, "export function reject() {}", "utf-8");

            await manager.registerCandidate(sourcePath, sourcePath);

            manager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", true, 10)
            );

            await manager.validateCandidate(sourcePath);

            const approved = await manager.requestApproval(sourcePath);

            expect(approved).toBe(false);

            const state = manager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe(PromotionStatus.REJECTED);
            expect(candidate?.rejectionReason).toBe("Rejected by human approval");
        });

        it("should throw error when approval required but no callback configured", async () => {
            const config: Partial<PromotionConfig> = {
                projectRoot: setup.tempDir,
                sourceDir: "playground",
                targetDir: "src",
                requireApproval: true,
                requiredGates: [QualityGateType.TEST],
                verbose: false,
            };

            const manager = new PromotionManager(config); // No callback

            const sourcePath = "utils/no-callback.ts";
            const testFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, "export function noCallback() {}", "utf-8");

            await manager.registerCandidate(sourcePath, sourcePath);

            manager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", true, 10)
            );

            await manager.validateCandidate(sourcePath);

            await expect(
                manager.requestApproval(sourcePath)
            ).toThrow("Approval required but no callback configured");
        });

        it("should throw error when candidate not in AWAITING_APPROVAL status", async () => {
            const sourcePath = "utils/wrong-status.ts";

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

            await expect(
                setup.promotionManager.requestApproval(sourcePath)
            ).toThrow("is not awaiting approval");
        });
    });

    describe("Code Promotion", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should promote approved file from playground to src", async () => {
            const sourcePath = "utils/promote.ts";
            const playgroundFile = path.join(setup.playgroundDir, sourcePath);
            const srcFile = path.join(setup.srcDir, sourcePath);

            const code = "export function promoted() { return 'success'; }";

            fs.mkdirSync(path.dirname(playgroundFile), { recursive: true });
            fs.writeFileSync(playgroundFile, code, "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

            setup.promotionManager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", true, 10)
            );

            await setup.promotionManager.validateCandidate(sourcePath);
            await setup.promotionManager.requestApproval(sourcePath);

            const result = await setup.promotionManager.promote(sourcePath);

            expect(result.success).toBe(true);
            expect(fs.existsSync(srcFile)).toBe(true);

            const promotedContent = fs.readFileSync(srcFile, "utf-8");
            expect(promotedContent).toBe(code);

            const state = setup.promotionManager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe(PromotionStatus.PROMOTED);
        });

        it("should not promote unapproved file", async () => {
            const sourcePath = "utils/unapproved.ts";
            const playgroundFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(playgroundFile), { recursive: true });
            fs.writeFileSync(playgroundFile, "export function unapproved() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

            const result = await setup.promotionManager.promote(sourcePath);

            expect(result.success).toBe(false);
            expect(result.error).toContain("not approved");
        });

        it("should create target directory if not exists", async () => {
            const sourcePath = "deep/nested/path/file.ts";
            const playgroundFile = path.join(setup.playgroundDir, sourcePath);
            const srcFile = path.join(setup.srcDir, sourcePath);

            fs.mkdirSync(path.dirname(playgroundFile), { recursive: true });
            fs.writeFileSync(playgroundFile, "export function nested() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

            setup.promotionManager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", true, 10)
            );

            await setup.promotionManager.validateCandidate(sourcePath);
            await setup.promotionManager.requestApproval(sourcePath);

            const result = await setup.promotionManager.promote(sourcePath);

            expect(result.success).toBe(true);
            expect(fs.existsSync(srcFile)).toBe(true);
        });

        it("should return error for non-existent candidate", async () => {
            const result = await setup.promotionManager.promote("nonexistent.ts");

            expect(result.success).toBe(false);
            expect(result.error).toContain("Candidate not found");
        });
    });

    describe("Batch Promotions", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should execute batch promotions for all approved files", async () => {
            const files = [
                "utils/file1.ts",
                "utils/file2.ts",
                "utils/file3.ts",
            ];

            for (const sourcePath of files) {
                const playgroundFile = path.join(setup.playgroundDir, sourcePath);

                fs.mkdirSync(path.dirname(playgroundFile), { recursive: true });
                fs.writeFileSync(playgroundFile, `export function ${path.basename(sourcePath, '.ts')}() {}`, "utf-8");

                await setup.promotionManager.registerCandidate(sourcePath, sourcePath, "batch-task");

                setup.promotionManager.setValidationStrategy(
                    QualityGateType.TEST,
                    new MockValidationStrategy("TEST", true, 5)
                );

                await setup.promotionManager.validateCandidate(sourcePath);
                await setup.promotionManager.requestApproval(sourcePath);
            }

            const batchResult = await setup.promotionManager.executePromotions();

            expect(batchResult.success).toBe(3);
            expect(batchResult.failed).toBe(0);

            for (const sourcePath of files) {
                const srcFile = path.join(setup.srcDir, sourcePath);
                expect(fs.existsSync(srcFile)).toBe(true);
            }
        });

        it("should handle partial failures in batch promotions", async () => {
            // Create 2 files where one will fail
            const files = [
                { path: "utils/success.ts", shouldFail: false },
                { path: "utils/fail.ts", shouldFail: true },
            ];

            for (const { path: sourcePath } of files) {
                const playgroundFile = path.join(setup.playgroundDir, sourcePath);

                fs.mkdirSync(path.dirname(playgroundFile), { recursive: true });
                fs.writeFileSync(playgroundFile, "export function test() {}", "utf-8");

                await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

                setup.promotionManager.setValidationStrategy(
                    QualityGateType.TEST,
                    new MockValidationStrategy("TEST", true, 5)
                );

                await setup.promotionManager.validateCandidate(sourcePath);
                await setup.promotionManager.requestApproval(sourcePath);
            }

            // Manually mark one as FAILED to simulate failure
            const state = setup.promotionManager.getState();
            const failCandidate = state.candidates.find(c => c.sourcePath === "utils/fail.ts");
            if (failCandidate) {
                failCandidate.status = PromotionStatus.FAILED;
            }

            const batchResult = await setup.promotionManager.executePromotions();

            expect(batchResult.success).toBe(1);
            expect(batchResult.failed).toBe(1);
        });
    });

    describe("Rollback", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should rollback promoted file", async () => {
            const sourcePath = "utils/rollback.ts";
            const playgroundFile = path.join(setup.playgroundDir, sourcePath);
            const srcFile = path.join(setup.srcDir, sourcePath);

            const code = "export function rollback() {}";

            fs.mkdirSync(path.dirname(playgroundFile), { recursive: true });
            fs.writeFileSync(playgroundFile, code, "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

            setup.promotionManager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", true, 10)
            );

            await setup.promotionManager.validateCandidate(sourcePath);
            await setup.promotionManager.requestApproval(sourcePath);
            await setup.promotionManager.promote(sourcePath);

            // Verify file is promoted
            expect(fs.existsSync(srcFile)).toBe(true);

            // Rollback
            const rollbackResult = await setup.promotionManager.rollbackPromotion(sourcePath);

            expect(rollbackResult.success).toBe(true);

            // File should be back in playground
            expect(fs.existsSync(playgroundFile)).toBe(true);
            // File should be removed from src
            expect(fs.existsSync(srcFile)).toBe(false);

            const state = setup.promotionManager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe(PromotionStatus.APPROVED);
        });

        it("should fail to rollback non-promoted file", async () => {
            const sourcePath = "utils/not-promoted.ts";

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

            const result = await setup.promotionManager.rollbackPromotion(sourcePath);

            expect(result.success).toBe(false);
            expect(result.error).toContain("not promoted");
        });
    });

    describe("State Persistence", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should save and load state correctly", async () => {
            await setup.promotionManager.registerCandidate(
                "utils/persist1.ts",
                "src/utils/persist1.ts",
                "task-1"
            );
            await setup.promotionManager.registerCandidate(
                "utils/persist2.ts",
                "src/utils/persist2.ts",
                "task-2"
            );

            const state1 = setup.promotionManager.getState();
            expect(state1.candidates).toHaveLength(2);

            // Create new manager - should load state
            const newManager = new PromotionManager({
                projectRoot: setup.tempDir,
                sourceDir: "playground",
                targetDir: "src",
                verbose: false,
            });

            const state2 = newManager.getState();
            expect(state2.candidates).toHaveLength(2);
            expect(state2.candidates[0].sourcePath).toBe("utils/persist1.ts");
            expect(state2.candidates[1].sourcePath).toBe("utils/persist2.ts");
        });

        it("should persist status changes", async () => {
            const sourcePath = "utils/status.ts";
            const testFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, "export function status() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

            setup.promotionManager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", true, 10)
            );

            await setup.promotionManager.validateCandidate(sourcePath);

            // Create new manager
            const newManager = new PromotionManager({
                projectRoot: setup.tempDir,
                sourceDir: "playground",
                targetDir: "src",
                verbose: false,
            });

            const state = newManager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe(PromotionStatus.AWAITING_APPROVAL);
        });
    });

    describe("Error Handling", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should handle promotion when source file doesn't exist", async () => {
            const sourcePath = "utils/missing.ts";

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

            setup.promotionManager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", true, 10)
            );

            await setup.promotionManager.validateCandidate(sourcePath);
            await setup.promotionManager.requestApproval(sourcePath);

            const result = await setup.promotionManager.promote(sourcePath);

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });

        it("should handle invalid state file gracefully", () => {
            const statePath = path.join(setup.tempDir, ".agent", "promotion", "promotion-state.json");
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, "invalid json content", "utf-8");

            const manager = new PromotionManager({
                projectRoot: setup.tempDir,
                sourceDir: "playground",
                targetDir: "src",
                verbose: false,
            });

            const state = manager.getState();
            expect(state.candidates).toHaveLength(0); // Should start with empty state
        });
    });

    describe("Cleanup", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should remove candidate from state", async () => {
            const sourcePath = "utils/remove.ts";

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

            let state = setup.promotionManager.getState();
            expect(state.candidates).toHaveLength(1);

            const removed = setup.promotionManager.removeCandidate(sourcePath);

            expect(removed).toBe(true);

            state = setup.promotionManager.getState();
            expect(state.candidates).toHaveLength(0);
        });

        it("should return false when removing non-existent candidate", () => {
            const removed = setup.promotionManager.removeCandidate("nonexistent.ts");

            expect(removed).toBe(false);
        });

        it("should cleanup promoted files from playground", async () => {
            const sourcePath = "utils/cleanup.ts";
            const playgroundFile = path.join(setup.playgroundDir, sourcePath);
            const srcFile = path.join(setup.srcDir, sourcePath);

            fs.mkdirSync(path.dirname(playgroundFile), { recursive: true });
            fs.writeFileSync(playgroundFile, "export function cleanup() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

            setup.promotionManager.setValidationStrategy(
                QualityGateType.TEST,
                new MockValidationStrategy("TEST", true, 10)
            );

            await setup.promotionManager.validateCandidate(sourcePath);
            await setup.promotionManager.requestApproval(sourcePath);
            await setup.promotionManager.promote(sourcePath);

            expect(fs.existsSync(playgroundFile)).toBe(true);

            const cleaned = setup.promotionManager.cleanupPromotedFiles(sourcePath);

            expect(cleaned).toBe(1);
            expect(fs.existsSync(playgroundFile)).toBe(false);
            expect(fs.existsSync(srcFile)).toBe(true); // src file should still exist
        });
    });

    describe("Custom Validation Strategies", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should allow setting custom validation strategy", async () => {
            const customStrategy = new MockValidationStrategy("CUSTOM", true, 50);

            setup.promotionManager.setValidationStrategy(
                QualityGateType.TEST,
                customStrategy
            );

            const sourcePath = "utils/custom.ts";
            const testFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, "export function custom() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath);

            const validations = await setup.promotionManager.validateCandidate(sourcePath);

            expect(validations).toHaveLength(1);
            expect(validations[0].result.isValid).toBe(true);
        });
    });
});
