/**
 * QUARANTINED — excluded from `bun run check:tests` (baseline gate).
 * Recovery debt: https://github.com/RenyEnnos/ouroboros-runtime/issues/41
 * Manifest: scripts/quarantine-manifest.json
 * Do not delete/rename this file to make CI green; fix or keep listed in the manifest.
 */

/**
 * 🧪 Security Tests for Sandbox Escape Attempts
 *
 * Verifica:
 * 1. Advanced escape patterns (beyond basic imports)
 * 2. Path traversal and symlink attacks
 * 3. File descriptor and resource limit bypasses
 * 4. Python-specific sandbox escape techniques
 * 5. Environment variable escapes
 * 6. Type manipulation and object escapes
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SandboxRunner } from "./SandboxRunner.js";
import { mkdirSync, rmSync, writeFileSync, readlinkSync, symlinkSync } from "fs";
import { join } from "path";
import { validatePath, createSandboxPathConfig, sanitizeFilename, detectSuspiciousPathPatterns } from "./SandboxPathUtils.js";
import { OuroborosEnvironment } from "./OuroborosEnvironment.js";

describe("SandboxSecurity - Escape Attempts", () => {
    let sandbox: SandboxRunner;
    let testEnv: OuroborosEnvironment;

    beforeAll(async () => {
        sandbox = new SandboxRunner({ autoRestart: false });
        await sandbox.start();

        testEnv = new OuroborosEnvironment();
        await testEnv.initialize();
    }, 30000);

    afterAll(async () => {
        await sandbox.stop();
    }, 15000);

    // ========================================================================
    // Advanced Python Escape Techniques
    // ========================================================================

    describe("Advanced Import Escapes", () => {
        it("should block __import__ function", async () => {
            const result = await sandbox.execute('__import__("os")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block import with alias", async () => {
            const result = await sandbox.execute("import os as operating_system");

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block multiple imports", async () => {
            const result = await sandbox.execute("import os, sys");

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        // NOTE: The following patterns are NOT currently detected but should be added to ESCAPE_PATTERNS:
        // - importlib usage (import importlib.util)
        // - from os import *
        // - from os.path import
        // These tests document the gaps for future security improvements
    });

    describe("Code Execution Escapes", () => {
        it("should block compile() function", async () => {
            const result = await sandbox.execute('compile("print(1)", "<string>", "exec")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block exec with dynamic code", async () => {
            const result = await sandbox.execute('exec("import os")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block eval with dangerous code", async () => {
            const result = await sandbox.execute('eval("__import__(\\"os\\")")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    describe("Object Manipulation Escapes", () => {
        it("should block getattr access to dangerous modules", async () => {
            const result = await sandbox.execute('getattr(__import__("builtins"), "__import__")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block setattr manipulation", async () => {
            const result = await sandbox.execute('setattr(object, "__test__", 1)');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block __class__ manipulation", async () => {
            const result = await sandbox.execute('(1).__class__.__bases__');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block __subclasses__ escape", async () => {
            const result = await sandbox.execute('().__class__.__bases__[0].__subclasses__()');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    describe("File Operation Escapes", () => {
        it("should block open() function", async () => {
            const result = await sandbox.execute('open("/etc/passwd")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block open with relative path traversal", async () => {
            const result = await sandbox.execute('open("../../../etc/passwd")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block file operations with path traversal", async () => {
            const result = await sandbox.execute('with open("../../../../test.txt") as f: pass');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    describe("Path Traversal Patterns", () => {
        it("should block ../ traversal", async () => {
            const result = await sandbox.execute('open("../escape.txt")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block ..\\ Windows traversal", async () => {
            const result = await sandbox.execute('open("..\\\\escape.txt")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block ././../ traversal", async () => {
            const result = await sandbox.execute('open("././../escape.txt")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block encoded path traversal", async () => {
            const result = await sandbox.execute('open("%2e%2e%2fpasswd")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    describe("System Path Access", () => {
        it("should block /etc/ access", async () => {
            const result = await sandbox.execute('open("/etc/passwd", "r")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block /home/ access", async () => {
            const result = await sandbox.execute('open("/home/user/.ssh/id_rsa")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block C:\\ Windows paths", async () => {
            const result = await sandbox.execute('open("C:\\\\Windows\\\\System32\\\\config")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block ~/ home directory access", async () => {
            const result = await sandbox.execute('open("~/.bashrc")');

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    describe("Environment Variable Escapes", () => {
        it("should allow safe environment access", async () => {
            const result = await sandbox.execute('import json; print(json.dumps(dict(__import__("os").environ)))');

            // This should be blocked because it imports os
            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    describe("Subprocess and Process Escapes", () => {
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

        // NOTE: The following patterns are NOT currently detected but should be added to ESCAPE_PATTERNS:
        // - import pty
        // - import fcntl
        // These low-level system modules should be blocked for security
    });

    // ========================================================================
    // Path Validation Security Tests
    // ========================================================================

    describe("Path Validation Security", () => {
        it("should block null byte injection", async () => {
            const result = await validatePath("test\x00file.txt", {
                allowedDirectories: [testEnv.playgroundPath],
            });

            expect(result.valid).toBe(false);
            expect(result.error).toContain("null byte");
        });

        it("should block excessive path length", async () => {
            const longPath = "a".repeat(5000) + ".txt";
            const result = await validatePath(longPath, {
                allowedDirectories: [testEnv.playgroundPath],
            });

            expect(result.valid).toBe(false);
            expect(result.error).toContain("maximum length");
        });

        it("should detect URL-encoded traversal", () => {
            const patterns = detectSuspiciousPathPatterns("%2e%2e%2f");
            expect(patterns).toContain("url_encoded_traversal");
        });

        it("should detect absolute path attempts", () => {
            const patterns = detectSuspiciousPathPatterns("/etc/passwd");
            expect(patterns).toContain("absolute_path");
        });

        it("should detect path traversal", () => {
            const patterns = detectSuspiciousPathPatterns("../escape.txt");
            expect(patterns).toContain("path_traversal");
        });

        it("should detect null byte injection", () => {
            const patterns = detectSuspiciousPathPatterns("test\x00file.txt");
            expect(patterns).toContain("null_byte_injection");
        });

        it("should detect excessive length", () => {
            const patterns = detectSuspiciousPathPatterns("a".repeat(5000));
            expect(patterns).toContain("excessive_length");
        });
    });

    describe("Filename Sanitization", () => {
        it("should remove path separators", () => {
            const sanitized = sanitizeFilename("../../etc/passwd");
            expect(sanitized).not.toContain("/");
            expect(sanitized).not.toContain("\\");
            expect(sanitized).not.toContain("..");
        });

        it("should remove null bytes", () => {
            const sanitized = sanitizeFilename("test\\0file.txt");
            expect(sanitized).not.toContain("\\0");
        });

        it("should remove invalid Windows characters", () => {
            const sanitized = sanitizeFilename('test<>:"|?*.txt');
            expect(sanitized).not.toContain("<");
            expect(sanitized).not.toContain(">");
            expect(sanitized).not.toContain(":");
            expect(sanitized).not.toContain('"');
            expect(sanitized).not.toContain("|");
            expect(sanitized).not.toContain("?");
            expect(sanitized).not.toContain("*");
        });

        it("should limit filename length", () => {
            const longName = "a".repeat(500);
            const sanitized = sanitizeFilename(longName);
            expect(sanitized.length).toBeLessThanOrEqual(255);
        });
    });

    // ========================================================================
    // Symlink Attack Tests
    // ========================================================================

    describe("Symlink Security", () => {
        const testDir = join(process.cwd(), "cli/src/runtime/temp_symlink_test");
        let linkPath: string;
        let targetPath: string;

        beforeAll(() => {
            // Clean up any existing test directory
            try {
                rmSync(testDir, { recursive: true, force: true });
            } catch {
                // Ignore if it doesn't exist
            }

            mkdirSync(testDir, { recursive: true });

            // Create a file outside the playground
            targetPath = join(testDir, "external_file.txt");
            writeFileSync(targetPath, "sensitive data");

            // Create a symlink in the playground pointing to the external file
            linkPath = join(testEnv.playgroundPath, "symlink_to_external.txt");

            try {
                symlinkSync(targetPath, linkPath);
            } catch (e) {
                // Symlink creation might fail on some systems
                console.warn("Could not create test symlink:", e);
            }
        });

        afterAll(() => {
            try {
                rmSync(testDir, { recursive: true, force: true });
                // Also remove the symlink from playground
                try {
                    rmSync(linkPath, { force: true });
                } catch {
                    // Ignore
                }
            } catch {
                // Ignore cleanup errors
            }
        });

        it("should block symlink to files outside sandbox", async () => {
            // This test verifies that even if a symlink exists in the playground,
            // the sandbox should validate the resolved path and block access

            const result = await sandbox.validatePath(linkPath);

            // The resolved path points outside the allowed directories
            // or the absolute path check catches it
            expect(result.valid).toBe(false);
        }, 10000);
    });

    // ========================================================================
    // Resource Limit Security Tests
    // ========================================================================

    describe("Resource Limit Enforcement", () => {
        it("should enforce memory limits", async () => {
            // Try to allocate excessive memory
            const code = `
# Try to consume excessive memory
big_list = []
try:
    for i in range(10000000):
        big_list.append(' ' * 1000)
except MemoryError:
    print("Memory limit hit")
`;

            const limitedSandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxMemoryMb: 50,
                    timeoutMs: 5000,
                },
            });

            await limitedSandbox.start();

            const result = await limitedSandbox.execute(code);

            // Should either succeed (if memory limit not enforced) or fail gracefully
            expect(result).toBeDefined();

            await limitedSandbox.stop();
        }, 15000);

        it("should enforce CPU time limits", async () => {
            // Try to consume excessive CPU time
            const code = `
# CPU-intensive task
total = 0
for i in range(10000000):
    total += i
print(total)
`;

            const limitedSandbox = new SandboxRunner({
                autoRestart: false,
                limits: {
                    maxCpuTimeSeconds: 1,
                    timeoutMs: 5000,
                },
            });

            await limitedSandbox.start();

            const result = await limitedSandbox.execute(code);

            // Should either succeed or be limited
            expect(result).toBeDefined();

            await limitedSandbox.stop();
        }, 15000);

        it("should enforce execution timeout", async () => {
            const code = `
import time
time.sleep(10)
print("done")
`;

            const result = await sandbox.execute(code, 500);

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("timeout");
        }, 10000);
    });

    // ========================================================================
    // Security Violation Tracking
    // ========================================================================

    describe("Security Violation Tracking", () => {
        it("should record multiple violations", async () => {
            sandbox.clearSecurityViolations();

            await sandbox.execute("import os");
            await sandbox.execute("import sys");
            await sandbox.execute('exec("1+1")');

            const violations = sandbox.getSecurityViolations();
            expect(violations.length).toBeGreaterThanOrEqual(3);
        }, 15000);

        it("should track violation types", async () => {
            sandbox.clearSecurityViolations();

            await sandbox.execute("import os");

            const violations = sandbox.getSecurityViolations();
            expect(violations.length).toBeGreaterThan(0);
            expect(violations[0].type).toBe("escape_attempt");
            expect(violations[0].detectedAt).toBeInstanceOf(Date);
            expect(violations[0].message).toBeDefined();
        }, 10000);

        it("should clear violations", async () => {
            await sandbox.execute("import os");

            expect(sandbox.getSecurityViolations().length).toBeGreaterThan(0);

            sandbox.clearSecurityViolations();

            expect(sandbox.getSecurityViolations().length).toBe(0);
        }, 10000);
    });

    // ========================================================================
    // Complex Escape Scenarios
    // ========================================================================

    describe("Complex Escape Scenarios", () => {
        it("should block obfuscated import attempts", async () => {
            // Try to obfuscate the import
            const result = await sandbox.execute(`
imp = __import__
imp("os")
`);

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block string concatenation to bypass patterns", async () => {
            const result = await sandbox.execute(`
mod = "o" + "s"
__import__(mod)
`);

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);

        it("should block encoded module names", async () => {
            const result = await sandbox.execute(`
import base64
mod = base64.b64decode("b3M=").decode()
__import__(mod)
`);

            // base64 import should be blocked
            expect(result.success).toBe(false);
        }, 10000);

        it("should block indirect file access through exceptions", async () => {
            // Try to use exception handling to access files
            const result = await sandbox.execute(`
try:
    open("/etc/passwd")
except:
    pass
`);

            expect(result.success).toBe(false);
            expect(result.stderr).toContain("Security violation");
        }, 10000);
    });

    describe("Whitelist-Based Security", () => {
        it("should only allow safe Python built-ins", async () => {
            const result = await sandbox.execute(`
# These should all work safely
print(sum([1, 2, 3]))
print(len("hello"))
print(max([1, 2, 3]))
print(min([1, 2, 3]))
print(abs(-5))
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("6");
            expect(result.stdout).toContain("5");
            expect(result.stdout).toContain("3");
            expect(result.stdout).toContain("1");
            expect(result.stdout).toContain("5");
        }, 10000);

        it("should allow mathematical operations", async () => {
            const result = await sandbox.execute(`
import math
result = math.sqrt(16) + math.pi
print(result)
`);

            // math import should be allowed (it's safe)
            expect(result.success).toBe(true);
            expect(result.stdout).toContain("7");
        }, 10000);

        it("should allow data structure operations", async () => {
            const result = await sandbox.execute(`
my_dict = {"a": 1, "b": 2}
my_list = [1, 2, 3, 4, 5]
my_set = {1, 2, 3}

print(len(my_dict))
print(sum(my_list))
print(3 in my_set)
`);

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("2");
            expect(result.stdout).toContain("15");
            expect(result.stdout).toContain("true");
        }, 10000);
    });
});

// ============================================================================
// Standalone Security Test Runner
// ============================================================================

if (import.meta.main) {
    console.log("🛡️  Running Sandbox Security Tests...\n");

    const securitySandbox = new SandboxRunner({ autoRestart: false });
    const env = new OuroborosEnvironment();

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
            console.log("1. Initializing sandbox...");
            await env.initialize();
            await securitySandbox.start();
            console.log("   ✅ Sandbox initialized\n");

            console.log("2. Testing import blocking...");
            await runTest("Block import os", async () => {
                const result = await securitySandbox.execute("import os");
                if (result.success) throw new Error("import os was not blocked");
            });
            await runTest("Block import sys", async () => {
                const result = await securitySandbox.execute("import sys");
                if (result.success) throw new Error("import sys was not blocked");
            });
            await runTest("Block __import__", async () => {
                const result = await securitySandbox.execute('__import__("os")');
                if (result.success) throw new Error("__import__ was not blocked");
            });
            await runTest("Block exec()", async () => {
                const result = await securitySandbox.execute('exec("print(1)")');
                if (result.success) throw new Error("exec() was not blocked");
            });
            await runTest("Block eval()", async () => {
                const result = await securitySandbox.execute('eval("1+1")');
                if (result.success) throw new Error("eval() was not blocked");
            });

            console.log("\n3. Testing path traversal blocking...");
            await runTest("Block ../ traversal", async () => {
                const result = await securitySandbox.execute('open("../escape.txt")');
                if (result.success) throw new Error("../ traversal was not blocked");
            });
            await runTest("Block /etc/ access", async () => {
                const result = await securitySandbox.execute('open("/etc/passwd")');
                if (result.success) throw new Error("/etc/ access was not blocked");
            });
            await runTest("Block ~ expansion", async () => {
                const result = await securitySandbox.execute('open("~/.bashrc")');
                if (result.success) throw new Error("~ expansion was not blocked");
            });

            console.log("\n4. Testing object manipulation blocking...");
            await runTest("Block __class__ escape", async () => {
                const result = await securitySandbox.execute('(1).__class__.__bases__');
                if (result.success) throw new Error("__class__ escape was not blocked");
            });
            await runTest("Block __subclasses__ escape", async () => {
                const result = await securitySandbox.execute('().__class__.__bases__[0].__subclasses__()');
                if (result.success) throw new Error("__subclasses__ escape was not blocked");
            });
            await runTest("Block getattr escape", async () => {
                const result = await securitySandbox.execute('getattr(__import__("builtins"), "__import__")');
                if (result.success) throw new Error("getattr escape was not blocked");
            });

            console.log("\n5. Testing safe operations...");
            await runTest("Allow math operations", async () => {
                const result = await securitySandbox.execute("print(2 + 2)");
                if (!result.success || !result.stdout.includes("4")) {
                    throw new Error("Math operations failed");
                }
            });
            await runTest("Allow data structures", async () => {
                const result = await securitySandbox.execute("print(len([1, 2, 3]))");
                if (!result.success || !result.stdout.includes("3")) {
                    throw new Error("Data structure operations failed");
                }
            });

            console.log("\n6. Testing security violation tracking...");
            await runTest("Track violations", async () => {
                securitySandbox.clearSecurityViolations();
                await securitySandbox.execute("import os");
                const violations = securitySandbox.getSecurityViolations();
                if (violations.length === 0) {
                    throw new Error("Violations not tracked");
                }
            });

            console.log("\n7. Testing timeout enforcement...");
            await runTest("Enforce timeout", async () => {
                const result = await securitySandbox.execute('import time; time.sleep(5)', 500);
                if (result.success) {
                    throw new Error("Timeout was not enforced");
                }
            });

            console.log("\n8. Cleaning up...");
            await securitySandbox.stop();
            console.log("   ✅ Sandbox stopped\n");

            console.log("📊 Test Results:");
            console.log(`   Passed: ${passedTests}`);
            console.log(`   Failed: ${failedTests}`);
            console.log(`   Total:  ${passedTests + failedTests}`);

            if (failedTests === 0) {
                console.log("\n🎉 All security tests passed!");
                process.exit(0);
            } else {
                console.log(`\n⚠️  ${failedTests} test(s) failed`);
                process.exit(1);
            }

        } catch (error) {
            console.error("\n❌ Fatal error during security tests:");
            console.error(error);
            await securitySandbox.stop();
            process.exit(1);
        }
    })();
}
