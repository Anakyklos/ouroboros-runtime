/**
 * 🧪 End-to-End Sandbox Verification Tests
 *
 * Verifica a segurança e isolamento do sandbox em cenários completos:
 * 1. Criação de ambiente .ouroboros isolado
 * 2. Execução de código Python no sandbox
 * 3. Verificação de impossibilidade de escape do diretório .ouroboros
 * 4. Verificação de imposição de limites de recursos
 * 5. Verificação de timeout para loops infinitos
 * 6. Verificação de limpeza após execução
 *
 * @module runtime/SandboxE2E
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SandboxRunner } from "./SandboxRunner.js";
import { OuroborosEnvironment } from "./OuroborosEnvironment.js";
import { rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

describe("SandboxE2E - End-to-End Verification", () => {
    let environment: OuroborosEnvironment;
    let sandbox: SandboxRunner;
    const testProjectRoot = join(process.cwd(), "cli", "src", "runtime", "temp_e2e_test");

    // ========================================================================
    // Setup & Teardown
    // ========================================================================

    beforeAll(async () => {
        // Create isolated test environment
        environment = new OuroborosEnvironment({ projectRoot: testProjectRoot });
        await environment.initialize();

        sandbox = new SandboxRunner({
            environment,
            autoRestart: false,
            limits: {
                maxMemoryMb: 256,
                maxCpuTimeSeconds: 10,
                timeoutMs: 5000,
                maxFileSizeMb: 50,
                maxProcesses: 1,
            },
        });
        await sandbox.start();
    }, 30000);

    afterAll(async () => {
        await sandbox.stop();

        // Cleanup test environment
        if (existsSync(testProjectRoot)) {
            try {
                rmSync(testProjectRoot, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors in tests
            }
        }
    }, 15000);

    // ========================================================================
    // 1. Environment Isolation
    // ========================================================================

    describe("1. Environment Isolation", () => {
        it("should create isolated .ouroboros directory", () => {
            const { ouroborosDir } = environment.paths;

            expect(existsSync(ouroborosDir)).toBe(true);
        });

        it("should create playground directory within .ouroboros", () => {
            const { playgroundDir } = environment.paths;

            expect(existsSync(playgroundDir)).toBe(true);
            expect(playgroundDir).toContain(".ouroboros");
        });

        it("should keep playground inside .ouroboros boundaries", () => {
            const { playgroundDir, ouroborosDir } = environment.paths;

            expect(playgroundDir.startsWith(ouroborosDir)).toBe(true);
        });

        it("should detect paths inside playground correctly", () => {
            const testFile = join(environment.playgroundPath, "test.txt");

            expect(environment.isPathInPlayground(testFile)).toBe(true);
        });

        it("should reject paths outside playground", () => {
            const systemFile = "/etc/passwd";

            expect(environment.isPathInPlayground(systemFile)).toBe(false);
        });

        it("should detect paths inside .ouroboros", () => {
            const venvPath = environment.venvPath;

            expect(environment.isPathInOuroboros(venvPath)).toBe(true);
        });
    });

    // ========================================================================
    // 2. Basic Code Execution
    // ========================================================================

    describe("2. Basic Code Execution", () => {
        it("should execute Python code successfully", async () => {
            const result = await sandbox.execute('print("Hello from sandbox!")');

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("Hello from sandbox!");
        });

        it("should support mathematical operations", async () => {
            const result = await sandbox.execute(`
result = 2 ** 10
print(f"2^10 = {result}")
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("1024");
        });

        it("should support multi-line functions", async () => {
            const result = await sandbox.execute(`
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)

print(fibonacci(10))
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("55");
        });

        it("should handle errors gracefully", async () => {
            const result = await sandbox.execute(`
raise ValueError("Intentional test error")
`);

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("ValueError");
            expect(result.stderr).toContain("Intentional test error");
        });
    });

    // ========================================================================
    // 3. Directory Escape Prevention
    // ========================================================================

    describe("3. Directory Escape Prevention", () => {
        it("should block reading files outside playground", async () => {
            // Try to read a file using open()
            const result = await sandbox.execute('open("/etc/passwd").read()');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        });

        it("should block path traversal with ../", async () => {
            const result = await sandbox.execute('open("../../../etc/passwd").read()');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        });

        it("should block Windows path traversal", async () => {
            const result = await sandbox.execute('open("..\\\\..\\\\test.txt").read()');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        });

        it("should block system directory access", async () => {
            const result = await sandbox.execute('open("/etc/hosts").read()');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        });

        it("should validate file paths before execution", async () => {
            const isValid = await sandbox.validatePath("safe_file.py");

            expect(isValid).toHaveProperty("valid");
            expect(typeof isValid.valid).toBe("boolean");
        });

        it("should reject absolute paths outside sandbox", async () => {
            const result = await sandbox.validatePath("/etc/passwd");

            expect(result.valid).toBe(false);
            expect(result.error).toContain("not allowed");
        });

        it("should allow files within playground", async () => {
            // Create a test file in playground
            const testFile = join(environment.playgroundPath, "allowed_test.py");
            writeFileSync(testFile, 'print("Allowed file")');

            const result = await sandbox.validatePath(testFile);

            expect(result.valid).toBe(true);

            // Cleanup
            rmSync(testFile);
        });
    });

    // ========================================================================
    // 4. Resource Limits Enforcement
    // ========================================================================

    describe("4. Resource Limits Enforcement", () => {
        it("should enforce memory limits", async () => {
            // Try to allocate a large list (should hit memory limit)
            const result = await sandbox.execute(`
# Try to create a huge list that would exceed 256MB
huge_list = [i for i in range(100000000)]
print(len(huge_list))
`, 10000);

            // Should either fail due to memory limit or timeout
            expect(result.success).toBe(false);
        });

        it("should enforce CPU time limits", async () => {
            // CPU-intensive operation
            const result = await sandbox.execute(`
# Heavy computation that should exceed CPU time
count = 0
for i in range(100000000):
    count += i
print(count)
`, 8000);

            expect(result.success).toBe(false);
        });

        it("should track resource usage", async () => {
            // Run some light code
            await sandbox.execute(`
x = sum(range(1000))
print(x)
`);

            const usage = await sandbox.getResourceUsage();

            // Resource usage should be available if psutil is installed
            if (usage !== null) {
                expect(typeof usage).toBe("object");
                expect(usage).toHaveProperty("memoryMb");
                expect(usage).toHaveProperty("cpuTimeMs");
            }
        });

        it("should report execution duration", async () => {
            const result = await sandbox.execute(`
import time
time.sleep(0.1)
print("Slept")
`);

            expect(result.durationMs).toBeGreaterThanOrEqual(100);
            expect(result.durationMs).toBeLessThan(5000);
        });
    });

    // ========================================================================
    // 5. Timeout Enforcement
    // ========================================================================

    describe("5. Timeout Enforcement", () => {
        it("should timeout on infinite loop", async () => {
            const result = await sandbox.execute(`
while True:
    pass
`, 1000);

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("timeout");
            expect(result.error?.message).toContain("Timeout");
        });

        it("should timeout on long sleep", async () => {
            const result = await sandbox.execute(`
import time
time.sleep(100)
print("Should not reach here")
`, 500);

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("timeout");
        });

        it("should timeout on recursive infinite loop", async () => {
            const result = await sandbox.execute(`
def recurse():
    recurse()
recurse()
`, 1000);

            expect(result.success).toBe(false);
        });

        it("should complete fast code within timeout", async () => {
            const result = await sandbox.execute(`
for i in range(100):
    print(i)
`, 5000);

            expect(result.success).toBe(true);
        });
    });

    // ========================================================================
    // 6. Variable Persistence & Cleanup
    // ========================================================================

    describe("6. Variable Persistence & Cleanup", () => {
        it("should persist variables between executions", async () => {
            // Set a variable
            await sandbox.execute('_ouroboros_sandbox_vars["test"] = 42');

            // Retrieve it in another execution
            const result = await sandbox.execute('print(_ouroboros_sandbox_vars["test"])');

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("42");
        });

        it("should get variable using helper method", async () => {
            await sandbox.setVariable("my_var", { key: "value", num: 123 });

            const value = await sandbox.getVariable("my_var");

            expect(value).toEqual({ key: "value", num: 123 });
        });

        it("should list all variables", async () => {
            await sandbox.setVariable("var1", "test1");
            await sandbox.setVariable("var2", "test2");

            const vars = await sandbox.listVariables();

            expect(vars).toContain("var1");
            expect(vars).toContain("var2");
        });

        it("should clear all variables", async () => {
            await sandbox.setVariable("to_clear", "data");
            expect((await sandbox.listVariables()).length).toBeGreaterThan(0);

            await sandbox.clearVariables();

            expect((await sandbox.listVariables()).length).toBe(0);
        });

        it("should cleanup after execution", async () => {
            // Run code that creates local variables
            await sandbox.execute(`
local_var = "should not persist"
x = 100
y = 200
`);

            // Only sandbox vars should persist, not locals
            const vars = await sandbox.listVariables();

            // Local variables should not be in the sandbox vars
            expect(vars).not.toContain("local_var");
            expect(vars).not.toContain("x");
            expect(vars).not.toContain("y");
        });
    });

    // ========================================================================
    // 7. Security Violation Tracking
    // ========================================================================

    describe("7. Security Violation Tracking", () => {
        it("should record escape attempts", async () => {
            sandbox.clearSecurityViolations();

            await sandbox.execute("import os");

            const violations = sandbox.getSecurityViolations();

            expect(violations.length).toBeGreaterThan(0);
            expect(violations[0].type).toBe("escape_attempt");
        });

        it("should include violation metadata", async () => {
            sandbox.clearSecurityViolations();

            const code = "import sys";
            await sandbox.execute(code);

            const violations = sandbox.getSecurityViolations();

            expect(violations[0].detectedAt).toBeInstanceOf(Date);
            expect(violations[0].code).toBe(code);
            expect(violations[0].message).toContain("escape pattern");
        });

        it("should clear violations on request", async () => {
            await sandbox.execute("import subprocess");

            expect(sandbox.getSecurityViolations().length).toBeGreaterThan(0);

            sandbox.clearSecurityViolations();

            expect(sandbox.getSecurityViolations().length).toBe(0);
        });
    });

    // ========================================================================
    // 8. Safe Operations
    // ========================================================================

    describe("8. Safe Operations", () => {
        it("should allow safe imports", async () => {
            const result = await sandbox.execute(`
import math
import json
import random
print(f"Pi = {math.pi}")
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("3.14");
        });

        it("should allow data structures", async () => {
            const result = await sandbox.execute(`
my_list = [1, 2, 3, 4, 5]
my_dict = {"a": 1, "b": 2}
my_set = {1, 2, 3}
print(len(my_list), len(my_dict), len(my_set))
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("5 2 3");
        });

        it("should allow list comprehensions", async () => {
            const result = await sandbox.execute(`
squares = [x**2 for x in range(10)]
print(sum(squares))
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("285");
        });

        it("should allow lambda functions", async () => {
            const result = await sandbox.execute(`
add = lambda x, y: x + y
print(add(5, 3))
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("8");
        });

        it("should allow class definitions", async () => {
            const result = await sandbox.execute(`
class Calculator:
    def add(self, a, b):
        return a + b

calc = Calculator()
print(calc.add(10, 20))
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("30");
        });
    });

    // ========================================================================
    // 9. Lifecycle Management
    // ========================================================================

    describe("9. Lifecycle Management", () => {
        it("should restart sandbox correctly", async () => {
            // Set a variable before restart
            await sandbox.setVariable("before_restart", "data");

            await sandbox.restart();

            // After restart, sandbox should be alive
            expect(sandbox.isAlive()).toBe(true);
            expect(sandbox.getStatus()).toBe("idle");

            // But variables should be cleared
            const vars = await sandbox.listVariables();
            expect(vars).not.toContain("before_restart");
        });

        it("should report correct status", () => {
            expect(sandbox.isAlive()).toBe(true);
            expect(sandbox.getStatus()).toBe("idle");
        });

        it("should handle rapid sequential executions", async () => {
            const results = await Promise.all([
                sandbox.execute('print("exec1")'),
                sandbox.execute('print("exec2")'),
                sandbox.execute('print("exec3")'),
            ]);

            expect(results.every(r => r.success)).toBe(true);
        });
    });

    // ========================================================================
    // 10. Edge Cases
    // ========================================================================

    describe("10. Edge Cases", () => {
        it("should handle empty code", async () => {
            const result = await sandbox.execute("");

            expect(result).toBeDefined();
        });

        it("should handle whitespace-only code", async () => {
            const result = await sandbox.execute("   \n  \n  ");

            expect(result).toBeDefined();
        });

        it("should handle unicode characters", async () => {
            const result = await sandbox.execute(`
emoji = "🐍 Hello 🌍"
print(emoji)
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("🐍");
        });

        it("should handle very long code", async () => {
            const longCode = `
# Generate a long list
result = []
for i in range(1000):
    result.append(i * 2)
print(sum(result))
`;

            const result = await sandbox.execute(longCode);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("999000"); // sum of 0, 2, 4, ..., 1998
        });
    });
});

// ============================================================================
// Standalone Test Runner
// ============================================================================

if (import.meta.main) {
    console.log("🧪 Running End-to-End Sandbox Verification Tests...\n");

    const testEnv = new OuroborosEnvironment({
        projectRoot: join(process.cwd(), "cli", "src", "runtime", "temp_e2e_manual")
    });
    const testSandbox = new SandboxRunner({
        environment: testEnv,
        autoRestart: false,
        limits: {
            maxMemoryMb: 256,
            maxCpuTimeSeconds: 10,
            timeoutMs: 5000,
            maxFileSizeMb: 50,
            maxProcesses: 1,
        },
    });

    let passedTests = 0;
    let failedTests = 0;

    const runTest = async (
        testName: string,
        testFn: () => Promise<void>
    ): Promise<void> => {
        try {
            await testFn();
            console.log(`   ✅ ${testName}`);
            passedTests++;
        } catch (error) {
            console.log(`   ❌ ${testName}`);
            console.log(`      Error: ${(error as Error).message}`);
            failedTests++;
        }
    };

    (async () => {
        try {
            console.log("📋 Test Suite: End-to-End Sandbox Verification\n");

            console.log("1️️⃣  Environment Isolation Tests");
            console.log("─────────────────────────────────");
            await testEnv.initialize();
            await runTest("Create .ouroboros directory", async () => {
                const { ouroborosDir } = testEnv.paths;
                if (!existsSync(ouroborosDir)) {
                    throw new Error(".ouroboros directory not created");
                }
            });
            await runTest("Playground inside .ouroboros", async () => {
                const { playgroundDir, ouroborosDir } = testEnv.paths;
                if (!playgroundDir.startsWith(ouroborosDir)) {
                    throw new Error("Playground not inside .ouroboros");
                }
            });

            console.log("\n2️️⃣  Starting Sandbox");
            console.log("─────────────────────────────────");
            await testSandbox.start();
            console.log("   ✅ Sandbox started");

            console.log("\n3️️⃣  Basic Execution Tests");
            console.log("─────────────────────────────────");
            await runTest("Execute Python code", async () => {
                const result = await testSandbox.execute('print("Hello")');
                if (!result.success || !result.stdout.includes("Hello")) {
                    throw new Error("Basic execution failed");
                }
            });
            await runTest("Mathematical operations", async () => {
                const result = await testSandbox.execute("print(2**10)");
                if (!result.success || !result.stdout.includes("1024")) {
                    throw new Error("Math operations failed");
                }
            });

            console.log("\n4️️⃣  Directory Escape Prevention Tests");
            console.log("─────────────────────────────────");
            await runTest("Block /etc/passwd access", async () => {
                const result = await testSandbox.execute('open("/etc/passwd").read()');
                if (result.success) {
                    throw new Error("System file access not blocked");
                }
            });
            await runTest("Block ../ traversal", async () => {
                const result = await testSandbox.execute('open("../../../etc/passwd").read()');
                if (result.success) {
                    throw new Error("Path traversal not blocked");
                }
            });

            console.log("\n5️️⃣  Timeout Enforcement Tests");
            console.log("─────────────────────────────────");
            await runTest("Timeout infinite loop", async () => {
                const result = await testSandbox.execute("while True: pass", 1000);
                if (result.success || !result.stderr.includes("timeout")) {
                    throw new Error("Infinite loop not timed out");
                }
            });
            await runTest("Timeout long sleep", async () => {
                const result = await testSandbox.execute('import time; time.sleep(100)', 500);
                if (result.success || !result.stderr.includes("timeout")) {
                    throw new Error("Long sleep not timed out");
                }
            });

            console.log("\n6️️⃣  Variable Persistence Tests");
            console.log("─────────────────────────────────");
            await runTest("Persist variables", async () => {
                await testSandbox.setVariable("test", 42);
                const value = await testSandbox.getVariable("test");
                if (value !== 42) {
                    throw new Error("Variable not persisted");
                }
            });
            await runTest("List variables", async () => {
                await testSandbox.setVariable("var1", "value1");
                const vars = await testSandbox.listVariables();
                if (!vars.includes("var1")) {
                    throw new Error("Variables not listed correctly");
                }
            });

            console.log("\n7️️⃣  Security Violation Tests");
            console.log("─────────────────────────────────");
            await runTest("Track escape attempts", async () => {
                testSandbox.clearSecurityViolations();
                await testSandbox.execute("import os");
                const violations = testSandbox.getSecurityViolations();
                if (violations.length === 0) {
                    throw new Error("Violations not tracked");
                }
            });

            console.log("\n8️️⃣  Safe Operations Tests");
            console.log("─────────────────────────────────");
            await runTest("Allow safe imports", async () => {
                const result = await testSandbox.execute("import math; print(math.pi)");
                if (!result.success || !result.stdout.includes("3.14")) {
                    throw new Error("Safe imports not working");
                }
            });
            await runTest("Allow data structures", async () => {
                const result = await testSandbox.execute("print(sum([1,2,3]))");
                if (!result.success || !result.stdout.includes("6")) {
                    throw new Error("Data structures not working");
                }
            });

            console.log("\n9️️⃣  Lifecycle Tests");
            console.log("─────────────────────────────────");
            await runTest("Restart sandbox", async () => {
                await testSandbox.restart();
                if (!testSandbox.isAlive()) {
                    throw new Error("Sandbox not alive after restart");
                }
            });

            console.log("\n🔟 Stopping Sandbox");
            console.log("─────────────────────────────────");
            await testSandbox.stop();
            console.log("   ✅ Sandbox stopped");

            // Cleanup
            const { rmSync } = await import("fs");
            const { existsSync } = await import("fs");
            const testPath = join(process.cwd(), "cli", "src", "runtime", "temp_e2e_manual");
            if (existsSync(testPath)) {
                try {
                    rmSync(testPath, { recursive: true, force: true });
                } catch {
                    // Ignore
                }
            }

            console.log("\n📊 Test Results:");
            console.log("─────────────────────────────────");
            console.log(`   ✅ Passed: ${passedTests}`);
            console.log(`   ❌ Failed: ${failedTests}`);
            console.log(`   📦 Total:  ${passedTests + failedTests}`);

            if (failedTests === 0) {
                console.log("\n🎉 All end-to-end tests passed! Sandbox is secure.");
                process.exit(0);
            } else {
                console.log(`\n⚠️  ${failedTests} test(s) failed`);
                process.exit(1);
            }

        } catch (error) {
            console.error("\n❌ Fatal error during tests:");
            console.error(error);
            await testSandbox.stop();
            process.exit(1);
        }
    })();
}
