/**
 * 🔄 Anti-Vibe Workflow Integration Tests
 *
 * End-to-end tests for the complete Anti-Vibe Protocol workflow:
 * spec → code → validate → approve → promote
 *
 * Tests the full integration between:
 * - Spec generation and validation
 * - Code creation in playground
 * - Quality gate validation (test, type-check, lint)
 * - Human approval workflow
 * - Code promotion from playground to src
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { PromotionManager } from "./PromotionManager.js";
import { ApprovalManager } from "./ApprovalManager.js";
import { SpecValidator } from "./validators/SpecValidator.js";
import { TestCoverageValidator } from "./validators/TestCoverageValidator.js";
import { ValidationReporter } from "./ValidationReporter.js";
import { generateSpecTemplate, ensureSpecFile } from "../utils/spec-generator.js";
import type { ValidationContext, ValidationResult, ValidationStrategy } from "./types.js";
import type { PromotionConfig } from "./promotion-types.js";
import type { ApprovalConfig } from "./approval-types.js";

// --- MOCK VALIDATION STRATEGY ---

/**
 * Mock validation strategy that simulates command execution without actually running commands.
 * This allows testing the workflow without external dependencies.
 */
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
        // Simulate execution time
        await new Promise(resolve => setTimeout(resolve, this.executionTimeMs));

        if (this.shouldPass) {
            return {
                isValid: true,
                exitCode: 0,
                message: `${this.name} passed successfully`,
                details: {
                    workDir: context.workDir,
                    durationMs: this.executionTimeMs,
                    mockOutput: "Simulated successful execution",
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
                    mockOutput: "Simulated failure",
                },
            };
        }
    }
}

// --- TEST HELPERS ---

interface AntiVibeTestSetup {
    tempDir: string;
    playgroundDir: string;
    srcDir: string;
    specDir: string;
    promotionManager: PromotionManager;
    approvalManager: ApprovalManager;
    specValidator: SpecValidator;
    testCoverageValidator: TestCoverageValidator;
    reporter: ValidationReporter;
    cleanup: () => void;
}

/**
 * Sets up a complete Anti-Vibe workflow test environment.
 */
function setupAntiVibeTest(): AntiVibeTestSetup {
    const tempDir = path.join(tmpdir(), `anti-vibe-test-${Date.now()}`);
    const playgroundDir = path.join(tempDir, "playground");
    const srcDir = path.join(tempDir, "src");
    const specDir = path.join(tempDir, ".auto-claude", "specs", "test-feature");

    // Create directories
    fs.mkdirSync(playgroundDir, { recursive: true });
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(specDir, { recursive: true });

    // Mock approval callback that auto-approves for testing
    const mockApprovalCallback = async () => true;

    // Create managers with test configuration
    const promotionConfig: Partial<PromotionConfig> = {
        projectRoot: tempDir,
        sourceDir: "playground",
        targetDir: "src",
        requireApproval: true,
        requiredGates: ["TEST", "TYPE_CHECK", "LINT"] as any,
        verbose: false,
    };

    const approvalConfig: Partial<ApprovalConfig> = {
        projectRoot: tempDir,
        approvalTimeoutMs: 60000,
        maxPendingRequests: 100,
        verbose: false,
    };

    const promotionManager = new PromotionManager(
        promotionConfig,
        undefined,
        mockApprovalCallback
    );
    const approvalManager = new ApprovalManager(approvalConfig);

    // Create validators
    const specValidator = new SpecValidator({
        specPath: path.join(".auto-claude", "specs", "test-feature", "spec.md"),
        requireApproval: true,
    });

    const testCoverageValidator = new TestCoverageValidator({
        requireTestsForNewCode: true,
        checkCoverageThresholds: false, // Disable coverage checks for unit tests
    });

    const reporter = new ValidationReporter(false);

    return {
        tempDir,
        playgroundDir,
        srcDir,
        specDir,
        promotionManager,
        approvalManager,
        specValidator,
        testCoverageValidator,
        reporter,
        cleanup: () => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        },
    };
}

// --- TEST SUITES ---

describe("Anti-Vibe Workflow Integration", () => {
    describe("Phase 1: Spec Generation", () => {
        let setup: AntiVibeTestSetup;

        beforeEach(() => {
            setup = setupAntiVibeTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should generate a complete spec template with all required sections", () => {
            const specContent = generateSpecTemplate({
                taskDescription: "Test feature implementation",
                filesToCreate: ["src/test.ts"],
                patternFiles: ["src/pattern.ts"],
                verificationCommand: "bun test",
                author: "Test Architect",
            });

            // Check for required sections
            expect(specContent).toContain("## 🎯 Objetivo");
            expect(specContent).toContain("## 💡 Contexto e Justificativa");
            expect(specContent).toContain("## 🚀 Plano de Implementação");
            expect(specContent).toContain("## ✅ Critérios de Aceitação / Verificação");

            // Check for task-specific content
            expect(specContent).toContain("Test feature implementation");
            expect(specContent).toContain("src/test.ts");
            expect(specContent).toContain("src/pattern.ts");
            expect(specContent).toContain("bun test");
        });

        it("should create spec file in context directory", async () => {
            await ensureSpecFile(setup.specDir);

            const specPath = path.join(setup.specDir, "spec.md");
            expect(fs.existsSync(specPath)).toBe(true);

            const content = fs.readFileSync(specPath, "utf-8");
            expect(content).toContain("## 🎯 Objetivo");
        });

        it("should validate spec with all required sections", async () => {
            // Create a valid spec file
            const specPath = path.join(setup.specDir, "spec.md");
            const validSpec = `## 🎯 Objetivo
Test objective

## 💡 Contexto e Justificativa
Test context

## 🚀 Plano de Implementação
Test implementation plan

## ✅ Critérios de Aceitação / Verificação
✅ Approved
`;

            fs.writeFileSync(specPath, validSpec, "utf-8");

            const context: ValidationContext = {
                workDir: setup.tempDir,
                taskId: "test-task",
                output: "",
            };

            const result = await setup.specValidator.validate(context);

            expect(result.isValid).toBe(true);
            expect(result.message).toContain("passed");
            expect(result.details?.spec).toBeDefined();
        });

        it("should reject spec missing required sections", async () => {
            // Create an invalid spec file (missing sections)
            const specPath = path.join(setup.specDir, "spec.md");
            const invalidSpec = `## 🎯 Objetivo
Test objective

## 💡 Contexto e Justificativa
Test context
`;

            fs.writeFileSync(specPath, invalidSpec, "utf-8");

            const context: ValidationContext = {
                workDir: setup.tempDir,
                taskId: "test-task",
                output: "",
            };

            const result = await setup.specValidator.validate(context);

            expect(result.isValid).toBe(false);
            expect(result.message).toContain("failed");
            const specDetails = result.details?.spec as any;
            expect(specDetails?.missingSections).toBeDefined();
        });
    });

    describe("Phase 2: Code Creation in Playground", () => {
        let setup: AntiVibeTestSetup;

        beforeEach(() => {
            setup = setupAntiVibeTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should create code file in playground directory", () => {
            const testFile = path.join(setup.playgroundDir, "utils", "test-utils.ts");
            const testCode = `export function testHelper(): string {
    return "test";
}`;

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, testCode, "utf-8");

            expect(fs.existsSync(testFile)).toBe(true);
            const content = fs.readFileSync(testFile, "utf-8");
            expect(content).toContain("testHelper");
        });

        it("should create corresponding test file", () => {
            const sourceFile = path.join(setup.playgroundDir, "utils", "test-utils.ts");
            const testFile = path.join(setup.playgroundDir, "utils", "test-utils.test.ts");

            // Create source file
            const sourceCode = `export function testHelper(): string {
    return "test";
}`;
            fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
            fs.writeFileSync(sourceFile, sourceCode, "utf-8");

            // Create test file
            const testCode = `import { test, expect } from "bun:test";
import { testHelper } from "./test-utils";

test("testHelper returns 'test'", () => {
    expect(testHelper()).toBe("test");
});`;
            fs.writeFileSync(testFile, testCode, "utf-8");

            expect(fs.existsSync(testFile)).toBe(true);
            const content = fs.readFileSync(testFile, "utf-8");
            expect(content).toContain("testHelper");
        });

        it("should validate test coverage for new code", async () => {
            // Create source file with test
            const sourceFile = path.join(setup.playgroundDir, "utils", "helper.ts");
            const testFile = path.join(setup.playgroundDir, "utils", "helper.test.ts");

            fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
            fs.writeFileSync(sourceFile, "export function helper() {}", "utf-8");
            fs.writeFileSync(testFile, "import { test } from 'bun:test';", "utf-8");

            const context: ValidationContext = {
                workDir: setup.tempDir,
                taskId: "test-task",
                output: "",
            };

            const result = await setup.testCoverageValidator.validate(context);

            expect(result.isValid).toBe(true);
            expect(result.details?.coverage).toBeDefined();
        });
    });

    describe("Phase 3: Quality Gate Validation", () => {
        let setup: AntiVibeTestSetup;

        beforeEach(() => {
            setup = setupAntiVibeTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should run all quality gates successfully", async () => {
            // Create a candidate file
            const sourcePath = "utils/test-utils.ts";
            const testFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, "export function test() {}", "utf-8");

            // Register candidate
            await setup.promotionManager.registerCandidate(sourcePath, sourcePath, "test-task");

            // Set mock validation strategies that pass
            setup.promotionManager.setValidationStrategy(
                "TEST" as any,
                new MockValidationStrategy("TEST", true, 50)
            );
            setup.promotionManager.setValidationStrategy(
                "TYPE_CHECK" as any,
                new MockValidationStrategy("TYPE_CHECK", true, 50)
            );
            setup.promotionManager.setValidationStrategy(
                "LINT" as any,
                new MockValidationStrategy("LINT", true, 50)
            );

            // Run validations
            const validations = await setup.promotionManager.validateCandidate(sourcePath);

            expect(validations).toHaveLength(3);
            expect(validations.every(v => v.result.isValid)).toBe(true);

            // Check candidate status
            const state = setup.promotionManager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe("AWAITING_APPROVAL");
        });

        it("should fail quality gates when validation fails", async () => {
            const sourcePath = "utils/failing-test.ts";
            const testFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, "export function failingTest() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath, "test-task");

            // Set mock strategy that fails
            setup.promotionManager.setValidationStrategy(
                "TEST" as any,
                new MockValidationStrategy("TEST", false, 50)
            );

            const validations = await setup.promotionManager.validateCandidate(sourcePath);

            expect(validations).toHaveLength(1);
            expect(validations[0].result.isValid).toBe(false);

            const state = setup.promotionManager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe("REJECTED");
            expect(candidate?.rejectionReason).toContain("TEST");
        });
    });

    describe("Phase 4: Human Approval", () => {
        let setup: AntiVibeTestSetup;

        beforeEach(() => {
            setup = setupAntiVibeTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should request and grant approval for promotion", async () => {
            const sourcePath = "utils/approved-test.ts";
            const testFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(testFile), { recursive: true });
            fs.writeFileSync(testFile, "export function approvedTest() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath, "test-task");

            // Set mock validators that pass
            setup.promotionManager.setValidationStrategy(
                "TEST" as any,
                new MockValidationStrategy("TEST", true, 10)
            );
            setup.promotionManager.setValidationStrategy(
                "TYPE_CHECK" as any,
                new MockValidationStrategy("TYPE_CHECK", true, 10)
            );

            // Run validations
            await setup.promotionManager.validateCandidate(sourcePath);

            // Request approval
            const approved = await setup.promotionManager.requestApproval(sourcePath);

            expect(approved).toBe(true);

            const state = setup.promotionManager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe("APPROVED");
        });

        it("should create approval request with correct metadata", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/test.ts",
                "src/utils/test.ts",
                "test-task",
                "NORMAL" as any,
                ["TEST passed", "TYPE_CHECK passed"]
            );

            expect(request.id).toBeDefined();
            expect(request.sourcePath).toBe("utils/test.ts");
            expect(request.targetPath).toBe("src/utils/test.ts");
            expect(request.taskId).toBe("test-task");
            expect(request.status).toBe("PENDING");
            expect(request.validationResults).toEqual(["TEST passed", "TYPE_CHECK passed"]);

            const retrieved = setup.approvalManager.getRequest(request.id);
            expect(retrieved).toEqual(request);
        });

        it("should approve request and update status", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/test.ts",
                "src/utils/test.ts",
                "test-task"
            );

            const result = await setup.approvalManager.approveRequest(
                request.id,
                "test-user",
                "Looks good!"
            );

            expect(result.success).toBe(true);

            const updated = setup.approvalManager.getRequest(request.id);
            expect(updated?.status).toBe("APPROVED");
            expect(updated?.reviewedBy).toBe("test-user");
            expect(updated?.reviewerComments).toBe("Looks good!");
        });

        it("should reject request with reason", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/test.ts",
                "src/utils/test.ts",
                "test-task"
            );

            const result = await setup.approvalManager.rejectRequest(
                request.id,
                "test-user",
                "Not ready yet",
                "Needs more tests"
            );

            expect(result.success).toBe(true);

            const updated = setup.approvalManager.getRequest(request.id);
            expect(updated?.status).toBe("REJECTED");
            expect(updated?.rejectionReason).toBe("Not ready yet");
            expect(updated?.reviewerComments).toBe("Needs more tests");
        });
    });

    describe("Phase 5: Code Promotion", () => {
        let setup: AntiVibeTestSetup;

        beforeEach(() => {
            setup = setupAntiVibeTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should promote approved file from playground to src", async () => {
            const sourcePath = "utils/final-test.ts";
            const playgroundFile = path.join(setup.playgroundDir, sourcePath);
            const srcFile = path.join(setup.srcDir, sourcePath);

            const code = "export function finalTest() { return 'promoted'; }";

            fs.mkdirSync(path.dirname(playgroundFile), { recursive: true });
            fs.writeFileSync(playgroundFile, code, "utf-8");

            // Register and approve
            await setup.promotionManager.registerCandidate(sourcePath, sourcePath, "test-task");

            // Set passing validators
            setup.promotionManager.setValidationStrategy(
                "TEST" as any,
                new MockValidationStrategy("TEST", true, 10)
            );
            setup.promotionManager.setValidationStrategy(
                "TYPE_CHECK" as any,
                new MockValidationStrategy("TYPE_CHECK", true, 10)
            );

            await setup.promotionManager.validateCandidate(sourcePath);
            await setup.promotionManager.requestApproval(sourcePath);

            // Promote
            const result = await setup.promotionManager.promote(sourcePath);

            expect(result.success).toBe(true);
            expect(fs.existsSync(srcFile)).toBe(true);

            const promotedContent = fs.readFileSync(srcFile, "utf-8");
            expect(promotedContent).toBe(code);

            const state = setup.promotionManager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe("PROMOTED");
        });

        it("should not promote unapproved file", async () => {
            const sourcePath = "utils/unapproved.ts";
            const playgroundFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(playgroundFile), { recursive: true });
            fs.writeFileSync(playgroundFile, "export function unapproved() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath, "test-task");

            const result = await setup.promotionManager.promote(sourcePath);

            expect(result.success).toBe(false);
            expect(result.error).toContain("not approved");
        });

        it("should execute batch promotions for all approved files", async () => {
            const files = [
                "utils/file1.ts",
                "utils/file2.ts",
                "utils/file3.ts",
            ];

            // Create and approve all files
            for (const sourcePath of files) {
                const playgroundFile = path.join(setup.playgroundDir, sourcePath);

                fs.mkdirSync(path.dirname(playgroundFile), { recursive: true });
                fs.writeFileSync(playgroundFile, `export function ${path.basename(sourcePath, '.ts')}() {}`, "utf-8");

                await setup.promotionManager.registerCandidate(sourcePath, sourcePath, "batch-task");

                setup.promotionManager.setValidationStrategy(
                    "TEST" as any,
                    new MockValidationStrategy("TEST", true, 5)
                );
                setup.promotionManager.setValidationStrategy(
                    "TYPE_CHECK" as any,
                    new MockValidationStrategy("TYPE_CHECK", true, 5)
                );

                await setup.promotionManager.validateCandidate(sourcePath);
                await setup.promotionManager.requestApproval(sourcePath);
            }

            // Execute batch promotions
            const batchResult = await setup.promotionManager.executePromotions();

            expect(batchResult.success).toBe(3);
            expect(batchResult.failed).toBe(0);

            // Verify all files were promoted
            for (const sourcePath of files) {
                const srcFile = path.join(setup.srcDir, sourcePath);
                expect(fs.existsSync(srcFile)).toBe(true);
            }
        });
    });

    describe("End-to-End: Complete Workflow", () => {
        let setup: AntiVibeTestSetup;

        beforeEach(() => {
            setup = setupAntiVibeTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should execute complete anti-vibe workflow from spec to promotion", async () => {
            // Phase 1: Spec Generation
            const specPath = path.join(setup.specDir, "spec.md");
            const specContent = generateSpecTemplate({
                taskDescription: "Complete workflow test",
                filesToCreate: ["src/complete-test.ts"],
                verificationCommand: "bun test",
            });

            fs.writeFileSync(specPath, specContent, "utf-8");

            // Validate spec
            const specContext: ValidationContext = {
                workDir: setup.tempDir,
                taskId: "e2e-task",
                output: "",
            };

            const specResult = await setup.specValidator.validate(specContext);
            expect(specResult.isValid).toBe(true);

            // Phase 2: Code Creation in Playground
            const sourcePath = "complete-test.ts";
            const playgroundFile = path.join(setup.playgroundDir, sourcePath);
            const testFile = path.join(setup.playgroundDir, `${sourcePath}.test`);

            const code = `export function completeWorkflow(): string {
    return "workflow-complete";
}`;

            fs.writeFileSync(playgroundFile, code, "utf-8");
            fs.writeFileSync(testFile, `import { test, expect } from "bun:test";
test("complete workflow", () => {
    expect(completeWorkflow()).toBe("workflow-complete");
});`, "utf-8");

            // Phase 3: Quality Gate Validation
            await setup.promotionManager.registerCandidate(sourcePath, `src/${sourcePath}`, "e2e-task");

            setup.promotionManager.setValidationStrategy(
                "TEST" as any,
                new MockValidationStrategy("TEST", true, 20)
            );
            setup.promotionManager.setValidationStrategy(
                "TYPE_CHECK" as any,
                new MockValidationStrategy("TYPE_CHECK", true, 20)
            );
            setup.promotionManager.setValidationStrategy(
                "LINT" as any,
                new MockValidationStrategy("LINT", true, 20)
            );

            const validations = await setup.promotionManager.validateCandidate(sourcePath);
            expect(validations.every(v => v.result.isValid)).toBe(true);

            // Phase 4: Human Approval
            const approved = await setup.promotionManager.requestApproval(sourcePath);
            expect(approved).toBe(true);

            // Create approval request for tracking
            const approvalRequest = await setup.approvalManager.createRequest(
                sourcePath,
                `src/${sourcePath}`,
                "e2e-task",
                "NORMAL" as any,
                validations.map(v => `${v.type} passed`)
            );

            const approvalResult = await setup.approvalManager.approveRequest(
                approvalRequest.id,
                "e2e-tester",
                "Approved in E2E test"
            );
            expect(approvalResult.success).toBe(true);

            // Phase 5: Code Promotion
            const promotionResult = await setup.promotionManager.promote(sourcePath);
            expect(promotionResult.success).toBe(true);

            // Verify final state
            const srcFile = path.join(setup.srcDir, sourcePath);
            expect(fs.existsSync(srcFile)).toBe(true);

            const promotedContent = fs.readFileSync(srcFile, "utf-8");
            expect(promotedContent).toBe(code);

            // Verify promotion state
            const promoState = setup.promotionManager.getState();
            const candidate = promoState.candidates.find(c => c.sourcePath === sourcePath);
            expect(candidate?.status).toBe("PROMOTED");

            // Verify approval state
            const approvalState = setup.approvalManager.getState();
            const approvedRequest = approvalState.approved.find(r => r.id === approvalRequest.id);
            expect(approvedRequest).toBeDefined();
        });

        it("should handle workflow failure at validation stage", async () => {
            const sourcePath = "failing-test.ts";
            const playgroundFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(playgroundFile), { recursive: true });
            fs.writeFileSync(playgroundFile, "export function failing() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath, "fail-task");

            // Set failing validator
            setup.promotionManager.setValidationStrategy(
                "TEST" as any,
                new MockValidationStrategy("TEST", false, 20)
            );

            const validations = await setup.promotionManager.validateCandidate(sourcePath);

            expect(validations[0].result.isValid).toBe(false);

            const state = setup.promotionManager.getState();
            const candidate = state.candidates.find(c => c.sourcePath === sourcePath);

            expect(candidate?.status).toBe("REJECTED");
            expect(candidate?.rejectionReason).toContain("TEST");
        });

        it("should generate validation report for workflow", async () => {
            const sourcePath = "report-test.ts";
            const playgroundFile = path.join(setup.playgroundDir, sourcePath);

            fs.mkdirSync(path.dirname(playgroundFile), { recursive: true });
            fs.writeFileSync(playgroundFile, "export function reportTest() {}", "utf-8");

            await setup.promotionManager.registerCandidate(sourcePath, sourcePath, "report-task");

            setup.promotionManager.setValidationStrategy(
                "TEST" as any,
                new MockValidationStrategy("TEST", true, 10)
            );

            const validations = await setup.promotionManager.validateCandidate(sourcePath);

            // Generate markdown report
            const markdown = setup.reporter.toPromotionMarkdown(validations, sourcePath);

            expect(markdown).toContain("Promotion Validation");
            expect(markdown).toContain(sourcePath);
            expect(markdown).toContain("TEST");
            expect(markdown).toContain("PASSED");
        });
    });
});
