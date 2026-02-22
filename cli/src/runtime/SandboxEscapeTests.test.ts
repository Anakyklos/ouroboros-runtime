/**
 * 🧪 Tests for Known Sandbox Escape Vectors
 *
 * Verifica:
 * 1. Dangerous module imports (os, sys, subprocess, shutil)
 * 2. Dynamic code execution (exec, eval, compile, __import__)
 * 3. File operations with path traversal (../, ..\, /etc/, ~)
 * 4. Object introspection escapes (__class__, __bases__, __subclasses__)
 * 5. Reflection functions (getattr, setattr)
 * 6. All patterns from ESCAPE_PATTERNS in SandboxRunner
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SandboxRunner } from "./SandboxRunner.js";

describe("SandboxEscapeTests - Known Escape Vectors", () => {
    let sandbox: SandboxRunner;

    beforeAll(async () => {
        sandbox = new SandboxRunner({ autoRestart: false });
        await sandbox.start();
    }, 30000);

    afterAll(async () => {
        await sandbox.stop();
    }, 15000);

    // ========================================================================
    // Dangerous Module Imports
    // ========================================================================

    describe("Module Import Escapes", () => {
        it("should block import os", async () => {
            const result = await sandbox.execute("import os");

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block import os with semicolon", async () => {
            const result = await sandbox.execute("import os;");

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block import os with comma", async () => {
            const result = await sandbox.execute("import os, sys");

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block import sys", async () => {
            const result = await sandbox.execute("import sys");

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block import subprocess", async () => {
            const result = await sandbox.execute("import subprocess");

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block import shutil", async () => {
            const result = await sandbox.execute("import shutil");

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block from os import path", async () => {
            const result = await sandbox.execute("from os import path");

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    // ========================================================================
    // Dynamic Code Execution
    // ========================================================================

    describe("Dynamic Execution Escapes", () => {
        it("should block __import__ function", async () => {
            const result = await sandbox.execute('__import__("os")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block exec function", async () => {
            const result = await sandbox.execute('exec("print(1)")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block eval function", async () => {
            const result = await sandbox.execute('eval("1+1")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block compile function", async () => {
            const result = await sandbox.execute('compile("print(1)", "<string>", "exec")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    // ========================================================================
    // File Operation Escapes
    // ========================================================================

    describe("File Operation Escapes", () => {
        it("should block open with single quote", async () => {
            const result = await sandbox.execute('open("/etc/passwd")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block open with double quote", async () => {
            const result = await sandbox.execute("open('/etc/passwd')");

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block open with spaces", async () => {
            const result = await sandbox.execute('open ( "/etc/passwd" )');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    // ========================================================================
    // Path Traversal Escapes
    // ========================================================================

    describe("Path Traversal Escapes", () => {
        it("should block ../ traversal", async () => {
            const result = await sandbox.execute('open("../../../escape.txt")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block ..\\ Windows traversal", async () => {
            const result = await sandbox.execute('open("..\\\\escape.txt")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block /etc/ system path", async () => {
            const result = await sandbox.execute('open("/etc/passwd")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block C:\\ Windows path", async () => {
            const result = await sandbox.execute('open("C:\\\\Windows\\\\System32\\\\config")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block ~/ home directory", async () => {
            const result = await sandbox.execute('open("~/.ssh/id_rsa")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    // ========================================================================
    // Object Introspection Escapes
    // ========================================================================

    describe("Object Introspection Escapes", () => {
        it("should block __class__ attribute", async () => {
            const result = await sandbox.execute('(1).__class__');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block __class__ manipulation", async () => {
            const result = await sandbox.execute('(1).__class__.__bases__');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block __bases__ access", async () => {
            const result = await sandbox.execute('().__class__.__bases__[0]');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block __subclasses__ escape", async () => {
            const result = await sandbox.execute('().__class__.__bases__[0].__subclasses__()');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    // ========================================================================
    // Reflection Function Escapes
    // ========================================================================

    describe("Reflection Function Escapes", () => {
        it("should block getattr", async () => {
            const result = await sandbox.execute('getattr(str, "__name__")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block setattr", async () => {
            const result = await sandbox.execute('setattr(object, "__test__", 1)');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    // ========================================================================
    // Combined/Obfuscated Escapes
    // ========================================================================

    describe("Combined Escape Attempts", () => {
        it("should block multiple escape patterns together", async () => {
            const result = await sandbox.execute(`
import os
open("/etc/passwd")
`);

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block escape with comments", async () => {
            const result = await sandbox.execute(`
# comment to hide intent
import os  # another comment
`);

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block escape with newlines", async () => {
            const result = await sandbox.execute(`
import
os
`);

            // This should still be blocked by the import os pattern
            expect(result.success).toBe(false);
        }, 10000);
    });

    // ========================================================================
    // Security Violation Tracking
    // ========================================================================

    describe("Security Violation Tracking", () => {
        it("should record escape attempt violations", async () => {
            sandbox.clearSecurityViolations();

            await sandbox.execute("import os");
            await sandbox.execute("import sys");
            await sandbox.execute('open("/etc/passwd")');

            const violations = sandbox.getSecurityViolations();

            expect(violations.length).toBeGreaterThanOrEqual(3);
            expect(violations[0].type).toBe("escape_attempt");
            expect(violations[0].detectedAt).toBeInstanceOf(Date);
        }, 15000);

        it("should include code snippet in violation", async () => {
            sandbox.clearSecurityViolations();

            const code = 'import os';
            await sandbox.execute(code);

            const violations = sandbox.getSecurityViolations();

            expect(violations.length).toBeGreaterThan(0);
            expect(violations[0].code).toBe(code);
        }, 10000);

        it("should clear violations on request", async () => {
            await sandbox.execute("import os");

            expect(sandbox.getSecurityViolations().length).toBeGreaterThan(0);

            sandbox.clearSecurityViolations();

            expect(sandbox.getSecurityViolations().length).toBe(0);
        }, 10000);
    });

    // ========================================================================
    // Safe Operations Should Still Work
    // ========================================================================

    describe("Safe Operations Allowed", () => {
        it("should allow basic arithmetic", async () => {
            const result = await sandbox.execute("print(2 + 2)");

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("4");
        }, 10000);

        it("should allow list operations", async () => {
            const result = await sandbox.execute(`
my_list = [1, 2, 3]
print(sum(my_list))
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("6");
        }, 10000);

        it("should allow dict operations", async () => {
            const result = await sandbox.execute(`
my_dict = {"a": 1, "b": 2}
print(len(my_dict))
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("2");
        }, 10000);

        it("should allow string operations", async () => {
            const result = await sandbox.execute(`
text = "hello world"
print(text.upper())
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("HELLO WORLD");
        }, 10000);

        it("should allow math module", async () => {
            const result = await sandbox.execute(`
import math
print(math.pi)
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("3.14");
        }, 10000);
    });
});

// ============================================================================
// Standalone Test Runner
// ============================================================================

if (import.meta.main) {
    console.log("🧪 Running Sandbox Escape Tests...\n");

    const testSandbox = new SandboxRunner({ autoRestart: false });

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
            console.log("1. Starting sandbox...");
            await testSandbox.start();
            console.log("   ✅ Sandbox started\n");

            console.log("2. Testing module import blocks...");
            await runTest("Block import os", async () => {
                const result = await testSandbox.execute("import os");
                if (result.success) throw new Error("import os was not blocked");
            });
            await runTest("Block import sys", async () => {
                const result = await testSandbox.execute("import sys");
                if (result.success) throw new Error("import sys was not blocked");
            });
            await runTest("Block import subprocess", async () => {
                const result = await testSandbox.execute("import subprocess");
                if (result.success) throw new Error("import subprocess was not blocked");
            });
            await runTest("Block import shutil", async () => {
                const result = await testSandbox.execute("import shutil");
                if (result.success) throw new Error("import shutil was not blocked");
            });

            console.log("\n3. Testing dynamic execution blocks...");
            await runTest("Block __import__", async () => {
                const result = await testSandbox.execute('__import__("os")');
                if (result.success) throw new Error("__import__ was not blocked");
            });
            await runTest("Block exec", async () => {
                const result = await testSandbox.execute('exec("print(1)")');
                if (result.success) throw new Error("exec was not blocked");
            });
            await runTest("Block eval", async () => {
                const result = await testSandbox.execute('eval("1+1")');
                if (result.success) throw new Error("eval was not blocked");
            });
            await runTest("Block compile", async () => {
                const result = await testSandbox.execute('compile("print(1)", "<string>", "exec")');
                if (result.success) throw new Error("compile was not blocked");
            });

            console.log("\n4. Testing path traversal blocks...");
            await runTest("Block ../ traversal", async () => {
                const result = await testSandbox.execute('open("../escape.txt")');
                if (result.success) throw new Error("../ traversal was not blocked");
            });
            await runTest("Block ..\\ traversal", async () => {
                const result = await testSandbox.execute('open("..\\\\escape.txt")');
                if (result.success) throw new Error("..\\ traversal was not blocked");
            });
            await runTest("Block /etc/ access", async () => {
                const result = await testSandbox.execute('open("/etc/passwd")');
                if (result.success) throw new Error("/etc/ access was not blocked");
            });
            await runTest("Block C:\\ access", async () => {
                const result = await testSandbox.execute('open("C:\\\\Windows\\\\System32")');
                if (result.success) throw new Error("C:\\ access was not blocked");
            });
            await runTest("Block ~/ access", async () => {
                const result = await testSandbox.execute('open("~/.bashrc")');
                if (result.success) throw new Error("~/ access was not blocked");
            });

            console.log("\n5. Testing object introspection blocks...");
            await runTest("Block __class__", async () => {
                const result = await testSandbox.execute('(1).__class__');
                if (result.success) throw new Error("__class__ was not blocked");
            });
            await runTest("Block __bases__", async () => {
                const result = await testSandbox.execute('(1).__class__.__bases__');
                if (result.success) throw new Error("__bases__ was not blocked");
            });
            await runTest("Block __subclasses__", async () => {
                const result = await testSandbox.execute('().__class__.__bases__[0].__subclasses__()');
                if (result.success) throw new Error("__subclasses__ was not blocked");
            });

            console.log("\n6. Testing reflection function blocks...");
            await runTest("Block getattr", async () => {
                const result = await testSandbox.execute('getattr(str, "__name__")');
                if (result.success) throw new Error("getattr was not blocked");
            });
            await runTest("Block setattr", async () => {
                const result = await testSandbox.execute('setattr(object, "__test__", 1)');
                if (result.success) throw new Error("setattr was not blocked");
            });

            console.log("\n7. Testing safe operations...");
            await runTest("Allow arithmetic", async () => {
                const result = await testSandbox.execute("print(2 + 2)");
                if (!result.success || !result.stdout.includes("4")) {
                    throw new Error("Arithmetic operations failed");
                }
            });
            await runTest("Allow lists", async () => {
                const result = await testSandbox.execute("print(sum([1, 2, 3]))");
                if (!result.success || !result.stdout.includes("6")) {
                    throw new Error("List operations failed");
                }
            });
            await runTest("Allow math module", async () => {
                const result = await testSandbox.execute("import math; print(math.pi)");
                if (!result.success || !result.stdout.includes("3.14")) {
                    throw new Error("Math module failed");
                }
            });

            console.log("\n8. Testing security violation tracking...");
            await runTest("Track violations", async () => {
                testSandbox.clearSecurityViolations();
                await testSandbox.execute("import os");
                const violations = testSandbox.getSecurityViolations();
                if (violations.length === 0) {
                    throw new Error("Violations not tracked");
                }
            });

            console.log("\n9. Stopping sandbox...");
            await testSandbox.stop();
            console.log("   ✅ Sandbox stopped\n");

            console.log("📊 Test Results:");
            console.log(`   Passed: ${passedTests}`);
            console.log(`   Failed: ${failedTests}`);
            console.log(`   Total:  ${passedTests + failedTests}`);

            if (failedTests === 0) {
                console.log("\n🎉 All escape tests passed!");
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
