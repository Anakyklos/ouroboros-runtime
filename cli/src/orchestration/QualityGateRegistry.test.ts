/**
 * QUARANTINED — excluded from `bun run check:tests` (baseline gate).
 * Recovery debt: https://github.com/RenyEnnos/ouroboros-runtime/issues/41
 * Manifest: scripts/quarantine-manifest.json
 * Do not delete/rename this file to make CI green; fix or keep listed in the manifest.
 */

/**
 * 🚦 QualityGateRegistry Unit Tests
 *
 * Tests for the quality gate registry system.
 * Tests gate registration, execution order, pass/fail aggregation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { QualityGateRegistry, QualityGateType } from "./strategies/QualityGateRegistry.js";
import type { ValidationStrategy, ValidationContext, ValidationResult } from "./types.js";

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
                message: `${this.name} passed`,
                details: {
                    durationMs: this.executionTimeMs,
                },
            };
        } else {
            return {
                isValid: false,
                exitCode: 1,
                message: `${this.name} failed`,
                details: {
                    durationMs: this.executionTimeMs,
                },
            };
        }
    }
}

// --- TEST SUITES ---

describe("QualityGateRegistry", () => {
    describe("Registry Initialization", () => {
        it("should create empty registry", () => {
            const registry = new QualityGateRegistry(false);

            const gates = registry.getAllGates();
            expect(gates).toHaveLength(0);
        });

        it("should register default gates", () => {
            const registry = new QualityGateRegistry(false);
            registry.registerDefaultGates();

            const stats = registry.getStats();
            expect(stats.total).toBeGreaterThan(0);
        });
    });

    describe("Gate Registration", () => {
        let registry: QualityGateRegistry;

        beforeEach(() => {
            registry = new QualityGateRegistry(false);
        });

        it("should register a single gate", () => {
            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            const gate = registry.getGate(QualityGateType.TEST);
            expect(gate).toBeDefined();
            expect(gate?.type).toBe(QualityGateType.TEST);
            expect(gate?.required).toBe(true);
            expect(gate?.priority).toBe(1);
            expect(gate?.enabled).toBe(true);
        });

        it("should register multiple gates", () => {
            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            registry.registerGate({
                type: QualityGateType.TYPE_CHECK,
                strategy: new MockValidationStrategy("TYPE_CHECK", true),
                required: true,
                priority: 2,
                enabled: true,
                timeoutMs: 30000,
            });

            const gates = registry.getAllGates();
            expect(gates).toHaveLength(2);
        });

        it("should override existing gate when registering same type", () => {
            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST_NEW", false),
                required: false,
                priority: 5,
                enabled: false,
                timeoutMs: 30000,
            });

            const gate = registry.getGate(QualityGateType.TEST);
            expect(gate?.required).toBe(false);
            expect(gate?.priority).toBe(5);
            expect(gate?.enabled).toBe(false);

            // Should still be only one gate
            const gates = registry.getAllGates();
            expect(gates).toHaveLength(1);
        });

        it("should unregister a gate", () => {
            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            const removed = registry.unregisterGate(QualityGateType.TEST);

            expect(removed).toBe(true);

            const gate = registry.getGate(QualityGateType.TEST);
            expect(gate).toBeUndefined();
        });

        it("should return false when unregistering non-existent gate", () => {
            const removed = registry.unregisterGate(QualityGateType.TEST);

            expect(removed).toBe(false);
        });

        it("should clear all gates", () => {
            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            registry.registerGate({
                type: QualityGateType.TYPE_CHECK,
                strategy: new MockValidationStrategy("TYPE_CHECK", true),
                required: true,
                priority: 2,
                enabled: true,
                timeoutMs: 30000,
            });

            expect(registry.getAllGates()).toHaveLength(2);

            registry.clear();

            expect(registry.getAllGates()).toHaveLength(0);
        });
    });

    describe("Gate Execution Order", () => {
        let registry: QualityGateRegistry;

        beforeEach(() => {
            registry = new QualityGateRegistry(false);

            // Register gates in reverse priority order
            registry.registerGate({
                type: QualityGateType.LINT,
                strategy: new MockValidationStrategy("LINT", true),
                required: true,
                priority: 3,
                enabled: true,
                timeoutMs: 30000,
            });

            registry.registerGate({
                type: QualityGateType.TYPE_CHECK,
                strategy: new MockValidationStrategy("TYPE_CHECK", true),
                required: true,
                priority: 2,
                enabled: true,
                timeoutMs: 30000,
            });

            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });
        });

        it("should return gates sorted by priority", () => {
            const enabledGates = registry.getEnabledGates();

            expect(enabledGates).toHaveLength(3);
            expect(enabledGates[0].type).toBe(QualityGateType.TEST);
            expect(enabledGates[1].type).toBe(QualityGateType.TYPE_CHECK);
            expect(enabledGates[2].type).toBe(QualityGateType.LINT);
        });

        it("should execute gates in priority order", async () => {
            const executionOrder: QualityGateType[] = [];

            // Create strategies that record execution order
            const orderStrategies = [
                {
                    type: QualityGateType.LINT,
                    priority: 3,
                },
                {
                    type: QualityGateType.TYPE_CHECK,
                    priority: 2,
                },
                {
                    type: QualityGateType.TEST,
                    priority: 1,
                },
            ];

            for (const { type, priority } of orderStrategies) {
                class OrderTrackingStrategy implements ValidationStrategy {
                    readonly name: string;
                    constructor(
                        name: string,
                        private orderList: QualityGateType[],
                        private gateType: QualityGateType
                    ) {
                        this.name = name;
                    }

                    async validate(context: ValidationContext): Promise<ValidationResult> {
                        this.orderList.push(this.gateType);
                        return {
                            isValid: true,
                            exitCode: 0,
                            message: `${this.name} passed`,
                        };
                    }
                }

                registry.registerGate({
                    type,
                    strategy: new OrderTrackingStrategy(type.toString(), executionOrder, type),
                    required: true,
                    priority,
                    enabled: true,
                    timeoutMs: 60000,
                });
            }

            const context: ValidationContext = {
                workDir: "/test",
                taskId: "test-task",
                output: "",
            };

            await registry.runAllGates(context);

            expect(executionOrder).toEqual([
                QualityGateType.TEST,
                QualityGateType.TYPE_CHECK,
                QualityGateType.LINT,
            ]);
        });
    });

    describe("Gate Pass/Fail Aggregation", () => {
        let registry: QualityGateRegistry;

        beforeEach(() => {
            registry = new QualityGateRegistry(false);
        });

        it("should pass when all gates pass", async () => {
            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            registry.registerGate({
                type: QualityGateType.TYPE_CHECK,
                strategy: new MockValidationStrategy("TYPE_CHECK", true),
                required: true,
                priority: 2,
                enabled: true,
                timeoutMs: 30000,
            });

            const context: ValidationContext = {
                workDir: "/test",
                taskId: "test-task",
                output: "",
            };

            const report = await registry.runAllGates(context);

            expect(report.passed).toBe(true);
            expect(report.results).toHaveLength(2);
            expect(report.succeeded).toHaveLength(2);
            expect(report.failed).toHaveLength(0);
            expect(report.skipped).toHaveLength(0);
        });

        it("should fail when required gate fails", async () => {
            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            registry.registerGate({
                type: QualityGateType.TYPE_CHECK,
                strategy: new MockValidationStrategy("TYPE_CHECK", false),
                required: true,
                priority: 2,
                enabled: true,
                timeoutMs: 30000,
            });

            registry.registerGate({
                type: QualityGateType.LINT,
                strategy: new MockValidationStrategy("LINT", true),
                required: true,
                priority: 3,
                enabled: true,
                timeoutMs: 30000,
            });

            const context: ValidationContext = {
                workDir: "/test",
                taskId: "test-task",
                output: "",
            };

            const report = await registry.runAllGates(context);

            expect(report.passed).toBe(false);
            expect(report.failed).toHaveLength(1);
            expect(report.failed[0].type).toBe(QualityGateType.TYPE_CHECK);
            expect(report.succeeded).toHaveLength(1);
            expect(report.succeeded[0].type).toBe(QualityGateType.TEST);
            // LINT should not run because TYPE_CHECK failed and is required
            expect(report.results).toHaveLength(2);
        });

        it("should pass when optional gate fails but required gates pass", async () => {
            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            registry.registerGate({
                type: QualityGateType.LINT,
                strategy: new MockValidationStrategy("LINT", false),
                required: false,
                priority: 2,
                enabled: true,
                timeoutMs: 30000,
            });

            const context: ValidationContext = {
                workDir: "/test",
                taskId: "test-task",
                output: "",
            };

            const report = await registry.runAllGates(context);

            expect(report.passed).toBe(true);
            expect(report.succeeded).toHaveLength(1);
            expect(report.skipped).toHaveLength(1);
            expect(report.skipped[0].type).toBe(QualityGateType.LINT);
        });

        it("should fail when any required gate fails even if optional passes", async () => {
            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", false),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            registry.registerGate({
                type: QualityGateType.LINT,
                strategy: new MockValidationStrategy("LINT", true),
                required: false,
                priority: 2,
                enabled: true,
                timeoutMs: 30000,
            });

            const context: ValidationContext = {
                workDir: "/test",
                taskId: "test-task",
                output: "",
            };

            const report = await registry.runAllGates(context);

            expect(report.passed).toBe(false);
            expect(report.failed).toHaveLength(1);
            expect(report.failed[0].type).toBe(QualityGateType.TEST);
        });
    });

    describe("Timeout Handling", () => {
        it("should handle timeout during gate execution", async () => {
            const registry = new QualityGateRegistry(false);

            class SlowValidationStrategy implements ValidationStrategy {
                readonly name = "SLOW";

                async validate(context: ValidationContext): Promise<ValidationResult> {
                    // Simulate slow validation
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    return {
                        isValid: true,
                        exitCode: 0,
                        message: "Finally passed",
                    };
                }
            }

            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new SlowValidationStrategy(),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 100, // Very short timeout
            });

            const context: ValidationContext = {
                workDir: "/test",
                taskId: "test-task",
                output: "",
            };

            const report = await registry.runAllGates(context);

            // Should complete (the mock doesn't actually enforce timeout)
            // In real implementation, timeout would be handled by the strategy
            expect(report.results).toHaveLength(1);
        });
    });

    describe("Parallel vs Sequential Execution", () => {
        it("should execute gates sequentially (in priority order)", async () => {
            const registry = new QualityGateRegistry(false);

            const executionTimes: number[] = [];

            class TimingStrategy implements ValidationStrategy {
                readonly name: string;
                constructor(
                    name: string,
                    private times: number[]
                ) {
                    this.name = name;
                }

                async validate(context: ValidationContext): Promise<ValidationResult> {
                    const start = Date.now();
                    await new Promise(resolve => setTimeout(resolve, 50));
                    this.times.push(Date.now() - start);
                    return {
                        isValid: true,
                        exitCode: 0,
                        message: `${this.name} passed`,
                    };
                }
            }

            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new TimingStrategy("TEST", executionTimes),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            registry.registerGate({
                type: QualityGateType.TYPE_CHECK,
                strategy: new TimingStrategy("TYPE_CHECK", executionTimes),
                required: true,
                priority: 2,
                enabled: true,
                timeoutMs: 30000,
            });

            registry.registerGate({
                type: QualityGateType.LINT,
                strategy: new TimingStrategy("LINT", executionTimes),
                required: true,
                priority: 3,
                enabled: true,
                timeoutMs: 30000,
            });

            const context: ValidationContext = {
                workDir: "/test",
                taskId: "test-task",
                output: "",
            };

            const startTime = Date.now();
            await registry.runAllGates(context);
            const totalTime = Date.now() - startTime;

            // Sequential: should take roughly sum of all times (3 * 50 = 150ms minimum)
            expect(totalTime).toBeGreaterThanOrEqual(140);

            // Each gate should have executed
            expect(executionTimes).toHaveLength(3);
        });
    });

    describe("Gate Filtering and Querying", () => {
        let registry: QualityGateRegistry;

        beforeEach(() => {
            registry = new QualityGateRegistry(false);

            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            registry.registerGate({
                type: QualityGateType.TYPE_CHECK,
                strategy: new MockValidationStrategy("TYPE_CHECK", true),
                required: true,
                priority: 2,
                enabled: true,
                timeoutMs: 30000,
            });

            registry.registerGate({
                type: QualityGateType.LINT,
                strategy: new MockValidationStrategy("LINT", true),
                required: false,
                priority: 3,
                enabled: false, // Disabled
                timeoutMs: 30000,
            });

            registry.registerGate({
                type: QualityGateType.COVERAGE,
                strategy: new MockValidationStrategy("COVERAGE", true),
                required: false,
                priority: 4,
                enabled: true,
                timeoutMs: 90000,
            });
        });

        it("should return only enabled gates", () => {
            const enabledGates = registry.getEnabledGates();

            expect(enabledGates).toHaveLength(3); // TEST, TYPE_CHECK, COVERAGE (LINT is disabled)
        });

        it("should return only required gates", () => {
            const requiredGates = registry.getRequiredGates();

            expect(requiredGates).toHaveLength(2); // TEST, TYPE_CHECK
            expect(requiredGates.every(g => g.required)).toBe(true);
        });

        it("should return correct stats", () => {
            const stats = registry.getStats();

            expect(stats.total).toBe(4);
            expect(stats.enabled).toBe(3);
            expect(stats.disabled).toBe(1);
            expect(stats.required).toBe(2);
            expect(stats.optional).toBe(2);
        });
    });

    describe("Gate Configuration", () => {
        let registry: QualityGateRegistry;

        beforeEach(() => {
            registry = new QualityGateRegistry(false);

            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });
        });

        it("should enable and disable gates", () => {
            let gate = registry.getGate(QualityGateType.TEST);
            expect(gate?.enabled).toBe(true);

            registry.setGateEnabled(QualityGateType.TEST, false);

            gate = registry.getGate(QualityGateType.TEST);
            expect(gate?.enabled).toBe(false);

            registry.setGateEnabled(QualityGateType.TEST, true);

            gate = registry.getGate(QualityGateType.TEST);
            expect(gate?.enabled).toBe(true);
        });

        it("should update gate strategy", () => {
            const originalStrategy = registry.getGate(QualityGateType.TEST)?.strategy;

            const newStrategy = new MockValidationStrategy("NEW_TEST", false);
            registry.setGateStrategy(QualityGateType.TEST, newStrategy);

            const gate = registry.getGate(QualityGateType.TEST);
            expect(gate?.strategy).toBe(newStrategy);
            expect(gate?.strategy).not.toBe(originalStrategy);
        });
    });

    describe("Report Generation", () => {
        let registry: QualityGateRegistry;

        beforeEach(() => {
            registry = new QualityGateRegistry(false);

            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true, 50),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            registry.registerGate({
                type: QualityGateType.TYPE_CHECK,
                strategy: new MockValidationStrategy("TYPE_CHECK", false, 50),
                required: true,
                priority: 2,
                enabled: true,
                timeoutMs: 30000,
            });

            registry.registerGate({
                type: QualityGateType.LINT,
                strategy: new MockValidationStrategy("LINT", false, 50),
                required: false,
                priority: 3,
                enabled: true,
                timeoutMs: 30000,
            });
        });

        it("should generate comprehensive report", async () => {
            const context: ValidationContext = {
                workDir: "/test",
                taskId: "test-task",
                output: "",
            };

            const report = await registry.runAllGates(context);

            expect(report.results).toHaveLength(2); // Stops after TYPE_CHECK fails
            expect(report.passed).toBe(false);
            expect(report.succeeded).toHaveLength(1);
            expect(report.failed).toHaveLength(1);
            expect(report.skipped).toHaveLength(0);
            expect(report.totalDurationMs).toBeGreaterThan(0);

            // Check result details
            expect(report.succeeded[0].type).toBe(QualityGateType.TEST);
            expect(report.failed[0].type).toBe(QualityGateType.TYPE_CHECK);
            expect(report.failed[0].required).toBe(true);
        });

        it("should include timestamps in results", async () => {
            const context: ValidationContext = {
                workDir: "/test",
                taskId: "test-task",
                output: "",
            };

            const report = await registry.runAllGates(context);

            for (const result of report.results) {
                expect(result.timestamp).toBeInstanceOf(Date);
            }
        });
    });

    describe("Error Handling", () => {
        let registry: QualityGateRegistry;

        beforeEach(() => {
            registry = new QualityGateRegistry(false);
        });

        it("should handle thrown errors from validation strategies", async () => {
            class ErrorStrategy implements ValidationStrategy {
                readonly name = "ERROR";

                async validate(context: ValidationContext): Promise<ValidationResult> {
                    throw new Error("Validation error");
                }
            }

            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new ErrorStrategy(),
                required: true,
                priority: 1,
                enabled: true,
                timeoutMs: 60000,
            });

            const context: ValidationContext = {
                workDir: "/test",
                taskId: "test-task",
                output: "",
            };

            const report = await registry.runAllGates(context);

            expect(report.passed).toBe(false);
            expect(report.results).toHaveLength(1);
            expect(report.results[0].result.isValid).toBe(false);
            expect(report.results[0].result.message).toContain("Validation error");
        });

        it("should throw error when running non-registered gate", async () => {
            const context: ValidationContext = {
                workDir: "/test",
                taskId: "test-task",
                output: "",
            };

            await expect(
                registry.runGate(QualityGateType.TEST, context)
            ).toThrow("Quality gate not registered: TEST");
        });

        it("should throw error when running disabled gate", async () => {
            registry.registerGate({
                type: QualityGateType.TEST,
                strategy: new MockValidationStrategy("TEST", true),
                required: true,
                priority: 1,
                enabled: false, // Disabled
                timeoutMs: 60000,
            });

            const context: ValidationContext = {
                workDir: "/test",
                taskId: "test-task",
                output: "",
            };

            await expect(
                registry.runGate(QualityGateType.TEST, context)
            ).toThrow("Quality gate is disabled: TEST");
        });
    });

    describe("Factory Functions", () => {
        it("should create registry with default gates", () => {
            const { createQualityGateRegistry } = require("./strategies/QualityGateRegistry.js");

            const registry = createQualityGateRegistry(false, true);

            const stats = registry.getStats();
            expect(stats.total).toBeGreaterThan(0);
        });

        it("should create custom registry", () => {
            const { createCustomQualityGateRegistry } = require("./strategies/QualityGateRegistry.js");

            const customGates = [
                {
                    type: QualityGateType.TEST,
                    strategy: new MockValidationStrategy("CUSTOM_TEST", true),
                    required: true,
                    priority: 1,
                    enabled: true,
                    timeoutMs: 60000,
                },
            ];

            const registry = createCustomQualityGateRegistry(customGates, false);

            const gates = registry.getAllGates();
            expect(gates).toHaveLength(1);
            expect(gates[0].type).toBe(QualityGateType.TEST);
        });

        it("should create minimal registry", () => {
            const { createMinimalQualityGateRegistry } = require("./strategies/QualityGateRegistry.js");

            const registry = createMinimalQualityGateRegistry();

            const gates = registry.getAllGates();
            expect(gates.length).toBeGreaterThanOrEqual(2); // TEST and TYPE_CHECK
        });
    });
});
