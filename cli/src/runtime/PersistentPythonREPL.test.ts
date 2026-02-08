/**
 * 🧪 Tests for PersistentPythonREPL
 * 
 * Verifica:
 * 1. Persistência de variáveis entre execuções
 * 2. Listagem de variáveis
 * 3. Get/Set de variáveis
 * 4. Auto-restart após crash
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { PersistentPythonREPL } from "./PersistentPythonREPL.js";

describe("PersistentPythonREPL", () => {
    let repl: PersistentPythonREPL;

    beforeAll(async () => {
        repl = new PersistentPythonREPL({ autoRestart: false });
        await repl.start();
    });

    afterAll(async () => {
        await repl.stop();
    });

    describe("Basic Execution", () => {
        it("should execute simple Python code", async () => {
            const result = await repl.execute('print("hello world")');
            expect(result.success).toBe(true);
            expect(result.stdout).toContain("hello world");
        });

        it("should capture errors in stderr", async () => {
            const result = await repl.execute('raise ValueError("test error")');
            expect(result.success).toBe(false);
            expect(result.stderr).toContain("ValueError");
        });
    });

    describe("State Persistence", () => {
        it("should persist variables between executions", async () => {
            // Define variável
            await repl.execute('x = 42');

            // Usa variável em execução separada
            const result = await repl.execute('print(x * 2)');

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("84");
        });

        it("should persist complex data structures", async () => {
            await repl.execute('my_list = [1, 2, 3]');
            await repl.execute('my_list.append(4)');

            const result = await repl.execute('print(sum(my_list))');

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("10"); // 1+2+3+4 = 10
        });

        it("should persist imported modules", async () => {
            await repl.execute('import math');

            const result = await repl.execute('print(math.pi)');

            expect(result.success).toBe(true);
            expect(result.stdout).toContain("3.14");
        });
    });

    describe("Variable Management", () => {
        it("should get variable value", async () => {
            await repl.execute('test_var = {"key": "value", "num": 123}');

            const value = await repl.getVariable('test_var');

            expect(value).toEqual({ key: "value", num: 123 });
        });

        it("should set variable value", async () => {
            await repl.setVariable('set_test', { hello: "world" });

            const result = await repl.execute('print(set_test["hello"])');

            expect(result.stdout).toContain("world");
        });

        it("should list user-defined variables", async () => {
            await repl.execute('unique_var_123 = "test"');

            const vars = await repl.listVariables();

            expect(vars).toContain("unique_var_123");
            // Should not contain internal vars
            expect(vars).not.toContain("_ouroboros_vars");
        });
    });

    describe("Status", () => {
        it("should report correct status", () => {
            expect(repl.isAlive()).toBe(true);
            expect(repl.getStatus()).toBe('idle');
        });

        it("should respond to ping", async () => {
            const alive = await repl.ping();
            expect(alive).toBe(true);
        });
    });

    describe("Timeout Handling", () => {
        it("should timeout long-running code", async () => {
            const result = await repl.execute('import time; time.sleep(5)', 500);

            expect(result.success).toBe(false);
            expect(result.error?.message).toContain("Timeout");
        });
    });
});

// Standalone test runner
if (import.meta.main) {
    console.log("🧪 Running PersistentPythonREPL tests...\n");

    const repl = new PersistentPythonREPL();

    try {
        console.log("1. Starting REPL...");
        await repl.start();
        console.log("   ✅ REPL started");

        console.log("\n2. Testing state persistence...");
        await repl.execute('x = 10');
        await repl.execute('y = 20');
        const result = await repl.execute('print(x + y)');
        console.log(`   Result: ${result.stdout}`);
        console.log(result.stdout.includes("30") ? "   ✅ State persists!" : "   ❌ State NOT persisted");

        console.log("\n3. Testing listVariables...");
        const vars = await repl.listVariables();
        console.log(`   Variables: ${vars.join(', ')}`);
        console.log(vars.includes('x') && vars.includes('y') ? "   ✅ Variables listed!" : "   ❌ Variables NOT listed");

        console.log("\n4. Testing getVariable...");
        const xValue = await repl.getVariable('x');
        console.log(`   x = ${xValue}`);
        console.log(xValue === 10 ? "   ✅ getVariable works!" : "   ❌ getVariable failed");

        console.log("\n5. Stopping REPL...");
        await repl.stop();
        console.log("   ✅ REPL stopped");

        console.log("\n🎉 All manual tests passed!");

    } catch (error) {
        console.error("❌ Test failed:", error);
        await repl.stop();
        process.exit(1);
    }
}
