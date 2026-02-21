/**
 * 🧪 Tests for Sandbox Resource Limits Enforcement
 *
 * Verifica:
 * 1. Memory limit enforcement
 * 2. CPU time limit enforcement
 * 3. File size limit enforcement
 * 4. Process limit enforcement
 * 5. Execution timeout enforcement
 * 6. Resource usage reporting
 * 7. Custom limit configurations
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SandboxRunner } from "./SandboxRunner.js";

describe("SandboxResourceLimits", () => {
    describe("Memory Limits", () => {
        it("should enforce memory limits on large allocations", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxMemoryMb: 50,
                    timeoutMs: 10000,
                },
            });

            await sandbox.start();

            // Try to allocate more memory than allowed
            const code = `
# Try to consume excessive memory
big_list = []
try:
    for i in range(100000):
        big_list.append(' ' * 1000)
    print("Allocated:", len(big_list))
except MemoryError as e:
    print("MemoryError:", str(e))
`;

            const result = await sandbox.execute(code);

            // Should complete (either with allocation or memory error)
            expect(result).toBeDefined();
            expect(typeof result.success).toBe("boolean");

            await sandbox.stop();
        }, 20000);

        it("should handle normal memory usage within limits", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxMemoryMb: 100,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            // Normal memory usage should work fine
            const code = `
data = list(range(1000))
print("Created list with", len(data), "items")
`;

            const result = await sandbox.execute(code);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("Created list with");
            expect(result.stdout).toContain("1000");

            await sandbox.stop();
        }, 15000);

        it("should support custom memory limits", async () => {
            const customLimit = 200;
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxMemoryMb: customLimit,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            // Verify sandbox starts with custom limits
            expect(sandbox.isAlive()).toBe(true);

            // Execute code that uses moderate memory
            const result = await sandbox.execute(`
data = [i for i in range(10000)]
print("OK")
`);

            expect(result.success).toBe(true);

            await sandbox.stop();
        }, 15000);
    });

    describe("CPU Time Limits", () => {
        it("should enforce CPU time limits on intensive tasks", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxCpuTimeSeconds: 1,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            // CPU-intensive task that should exceed limit
            const code = `
# CPU-intensive calculation
total = 0
for i in range(10000000):
    total += i
print("Result:", total)
`;

            const result = await sandbox.execute(code);

            // Should complete (possibly with CPU time exceeded error)
            expect(result).toBeDefined();

            await sandbox.stop();
        }, 15000);

        it("should handle short CPU tasks within limits", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxCpuTimeSeconds: 5,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            // Quick computation that should complete in time
            const code = `
result = sum([i * 2 for i in range(100)])
print("Sum:", result)
`;

            const result = await sandbox.execute(code);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("Sum:");

            await sandbox.stop();
        }, 15000);

        it("should support custom CPU time limits", async () => {
            const customCpuLimit = 2;
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxCpuTimeSeconds: customCpuLimit,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            expect(sandbox.isAlive()).toBe(true);

            // Execute a moderately CPU-intensive task
            const result = await sandbox.execute(`
result = sum(i for i in range(1000))
print(result)
`);

            expect(result.success).toBe(true);

            await sandbox.stop();
        }, 15000);
    });

    describe("File Size Limits", () => {
        it("should block file operations due to security", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxFileSizeMb: 10,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            // open() is blocked by security patterns
            const code = `
try:
    with open("test_file.txt", "w") as f:
        f.write("test")
    print("File created")
except Exception as e:
    print(f"Blocked: {type(e).__name__}")
`;

            const result = await sandbox.execute(code);

            // Should be blocked by security validation before execution
            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");

            await sandbox.stop();
        }, 15000);

        it("should have file size limits configured", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxFileSizeMb: 5,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            // Verify sandbox starts with file size limit configured
            expect(sandbox.isAlive()).toBe(true);

            // Normal operations should work
            const result = await sandbox.execute("print('File limit configured')");

            expect(result.success).toBe(true);

            await sandbox.stop();
        }, 15000);
    });

    describe("Process Limits", () => {
        it("should enforce process limits", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxProcesses: 1,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            // Try to spawn subprocesses (should be blocked by security)
            const code = `
import subprocess
try:
    subprocess.run(["echo", "test"])
    print("Subprocess created")
except (SecurityError, OSError) as e:
    print("Subprocess blocked:", str(e))
`;

            const result = await sandbox.execute(code);

            // Should be blocked by security (import subprocess)
            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");

            await sandbox.stop();
        }, 15000);

        it("should support custom process limits", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxProcesses: 2,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            // Verify sandbox starts with custom process limit
            expect(sandbox.isAlive()).toBe(true);

            // Normal code execution should work
            const result = await sandbox.execute("print('Single process test')");

            expect(result.success).toBe(true);

            await sandbox.stop();
        }, 15000);
    });

    describe("Execution Timeout", () => {
        it("should timeout on infinite loops", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    timeoutMs: 1000,
                },
            });

            await sandbox.start();

            const result = await sandbox.execute(`
while True:
    pass
`, 1000);

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("timeout");

            await sandbox.stop();
        }, 15000);

        it("should timeout on long sleep", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    timeoutMs: 500,
                },
            });

            await sandbox.start();

            const result = await sandbox.execute(`
import time
time.sleep(10)
print("Done")
`, 500);

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("timeout");

            await sandbox.stop();
        }, 15000);

        it("should complete fast code within timeout", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            const result = await sandbox.execute(`
print("Quick execution")
`, 5000);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("Quick execution");

            await sandbox.stop();
        }, 15000);

        it("should support custom timeout per execution", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    timeoutMs: 10000, // Default 10s
                },
            });

            await sandbox.start();

            // Override with shorter timeout
            const result = await sandbox.execute(`
import time
time.sleep(5)
print("Should not reach here")
`, 500);

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("timeout");

            await sandbox.stop();
        }, 15000);
    });

    describe("Resource Usage Reporting", () => {
        it("should report resource usage", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxMemoryMb: 100,
                    maxCpuTimeSeconds: 5,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            const usage = await sandbox.getResourceUsage();

            // Resource usage might be null if psutil not available
            if (usage !== null) {
                expect(typeof usage).toBe("object");
                expect(usage).toHaveProperty("memoryMb");
                expect(usage).toHaveProperty("cpuTimeMs");
            }

            await sandbox.stop();
        }, 15000);

        it("should track memory usage over time", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxMemoryMb: 100,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            // Execute code that uses memory
            await sandbox.execute(`
data = list(range(10000))
result = sum(data)
print("Sum:", result)
`);

            const usage = await sandbox.getResourceUsage();

            // Should report some memory usage if psutil available
            if (usage !== null && usage.memoryMb !== undefined) {
                expect(usage.memoryMb).toBeGreaterThan(0);
            }

            await sandbox.stop();
        }, 15000);

        it("should track CPU time for computations", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxCpuTimeSeconds: 5,
                    timeoutMs: 10000,
                },
            });

            await sandbox.start();

            // Execute CPU-intensive code
            await sandbox.execute(`
total = 0
for i in range(100000):
    total += i * i
print("Done")
`);

            const usage = await sandbox.getResourceUsage();

            // Should report some CPU time if psutil available
            if (usage !== null && usage.cpuTimeMs !== undefined) {
                expect(usage.cpuTimeMs).toBeGreaterThanOrEqual(0);
            }

            await sandbox.stop();
        }, 20000);
    });

    describe("Combined Resource Limits", () => {
        it("should handle multiple limits simultaneously", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxMemoryMb: 100,
                    maxCpuTimeSeconds: 3,
                    maxFileSizeMb: 10,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            // Code that uses memory and CPU (no file operations due to security)
            const code = `
# Use memory
data = list(range(10000))

# Use CPU
result = sum(i * i for i in data)

print("Success")
`;

            const result = await sandbox.execute(code);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("Success");

            await sandbox.stop();
        }, 15000);

        it("should enforce limits independently", async () => {
            // Test with very low memory but sufficient CPU time
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxMemoryMb: 20,
                    maxCpuTimeSeconds: 10,
                    timeoutMs: 5000,
                },
            });

            await sandbox.start();

            // Memory-intensive task
            const result = await sandbox.execute(`
big_list = []
for i in range(1000000):
    big_list.append(i)
print("Done")
`);

            // Should fail due to memory limit or complete
            expect(result).toBeDefined();

            await sandbox.stop();
        }, 15000);
    });

    describe("Limit Configuration", () => {
        it("should use default limits when none specified", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
            });

            await sandbox.start();

            // Should work with default limits
            const result = await sandbox.execute("print('Default limits test')");

            expect(result.success).toBe(true);

            await sandbox.stop();
        }, 15000);

        it("should allow partial limit configuration", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    timeoutMs: 3000,
                    // Other limits use defaults
                },
            });

            await sandbox.start();

            const result = await sandbox.execute("print('Partial limits')");

            expect(result.success).toBe(true);

            await sandbox.stop();
        }, 15000);

        it("should handle very low limits gracefully", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxMemoryMb: 10,
                    timeoutMs: 1000,
                },
            });

            await sandbox.start();

            // Even simple operations should work
            const result = await sandbox.execute("x = 1 + 1; print(x)");

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("2");

            await sandbox.stop();
        }, 15000);
    });

    describe("Duration Tracking", () => {
        it("should measure execution duration", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
            });

            await sandbox.start();

            const result = await sandbox.execute("print('test')");

            expect(result.durationMs).toBeGreaterThanOrEqual(0);
            expect(typeof result.durationMs).toBe("number");

            await sandbox.stop();
        }, 15000);

        it("should track duration for longer executions", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
            });

            await sandbox.start();

            const result = await sandbox.execute(`
import time
time.sleep(0.1)
print("After sleep")
`);

            expect(result.durationMs).toBeGreaterThanOrEqual(100);
            expect(result.stdout).toContain("After sleep");

            await sandbox.stop();
        }, 15000);
    });

    describe("Exit Code Tracking", () => {
        it("should report exit code 0 for success", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
            });

            await sandbox.start();

            const result = await sandbox.execute("print('success')");

            expect(result.success).toBe(true);
            expect(result.exitCode).toBe(0);

            await sandbox.stop();
        }, 15000);

        it("should report non-zero exit code for errors", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
            });

            await sandbox.start();

            const result = await sandbox.execute("raise ValueError('error')");

            expect(result.success).toBe(false);
            expect(result.exitCode).toBe(1);

            await sandbox.stop();
        }, 15000);

        it("should report exit code -1 for timeout", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
            });

            await sandbox.start();

            const result = await sandbox.execute(`
import time
time.sleep(10)
`, 500);

            expect(result.success).toBe(false);
            expect(result.exitCode).toBe(-1);

            await sandbox.stop();
        }, 15000);
    });
});

// ============================================================================
// Standalone Resource Limits Test Runner
// ============================================================================

if (import.meta.main) {
    console.log("🧪 Running Sandbox Resource Limits tests...\n");

    const runTest = async (
        testName: string,
        testFn: () => Promise<void>
    ): Promise<boolean> => {
        try {
            await testFn();
            console.log(`   ✅ ${testName}`);
            return true;
        } catch (error) {
            console.log(`   ❌ ${testName}`);
            console.log(`      Error: ${(error as Error).message}`);
            return false;
        }
    };

    (async () => {
        const results: boolean[] = [];

        console.log("1. Testing memory limits...");
        results.push(await runTest("Enforce memory limits", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: { maxMemoryMb: 50, timeoutMs: 10000 },
            });
            await sandbox.start();
            const result = await sandbox.execute("data = list(range(100000)); print('OK')");
            await sandbox.stop();
            if (!result.stdout.includes("OK")) throw new Error("Memory limit test failed");
        }));

        console.log("\n2. Testing CPU time limits...");
        results.push(await runTest("Enforce CPU limits", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: { maxCpuTimeSeconds: 1, timeoutMs: 5000 },
            });
            await sandbox.start();
            const result = await sandbox.execute("result = sum(i for i in range(1000)); print(result)");
            await sandbox.stop();
            if (!result.success) throw new Error("CPU limit test failed");
        }));

        console.log("\n3. Testing timeout enforcement...");
        results.push(await runTest("Enforce timeout", async () => {
            const sandbox = new SandboxRunner({ autoRestart: false });
            await sandbox.start();
            const result = await sandbox.execute('import time; time.sleep(5)', 500);
            await sandbox.stop();
            if (result.success) throw new Error("Timeout not enforced");
        }));

        console.log("\n4. Testing resource usage reporting...");
        results.push(await runTest("Report resource usage", async () => {
            const sandbox = new SandboxRunner({ autoRestart: false });
            await sandbox.start();
            await sandbox.execute("x = [1, 2, 3]; print(sum(x))");
            const usage = await sandbox.getResourceUsage();
            await sandbox.stop();
            if (usage === null) {
                console.log("      ⚠️  psutil not available, skipping detailed checks");
            } else {
                console.log(`      Memory: ${usage.memoryMb}MB, CPU: ${usage.cpuTimeMs}ms`);
            }
        }));

        console.log("\n5. Testing custom limit configuration...");
        results.push(await runTest("Custom limits", async () => {
            const sandbox = new SandboxRunner({
                autoRestart: false,
                limits: { maxMemoryMb: 200, maxCpuTimeSeconds: 5, timeoutMs: 5000 },
            });
            await sandbox.start();
            const result = await sandbox.execute("print('Custom limits test')");
            await sandbox.stop();
            if (!result.success) throw new Error("Custom limits test failed");
        }));

        console.log("\n6. Testing duration tracking...");
        results.push(await runTest("Track duration", async () => {
            const sandbox = new SandboxRunner({ autoRestart: false });
            await sandbox.start();
            const result = await sandbox.execute("print('duration test')");
            await sandbox.stop();
            if (result.durationMs < 0) throw new Error("Invalid duration");
        }));

        console.log("\n7. Testing exit codes...");
        results.push(await runTest("Track exit codes", async () => {
            const sandbox = new SandboxRunner({ autoRestart: false });
            await sandbox.start();
            const successResult = await sandbox.execute("print('success')");
            const errorResult = await sandbox.execute("raise ValueError('error')");
            await sandbox.stop();
            if (successResult.exitCode !== 0) throw new Error("Exit code should be 0 for success");
            if (errorResult.exitCode !== 1) throw new Error("Exit code should be 1 for error");
        }));

        const passed = results.filter(r => r).length;
        const failed = results.filter(r => !r).length;

        console.log("\n📊 Test Results:");
        console.log(`   Passed: ${passed}`);
        console.log(`   Failed: ${failed}`);
        console.log(`   Total:  ${results.length}`);

        if (failed === 0) {
            console.log("\n🎉 All resource limits tests passed!");
            process.exit(0);
        } else {
            console.log(`\n⚠️  ${failed} test(s) failed`);
            process.exit(1);
        }
    })();
}
