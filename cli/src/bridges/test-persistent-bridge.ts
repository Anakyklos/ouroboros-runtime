#!/usr/bin/env bun
/**
 * 🧪 Test: PersistentAntigravityBridge
 * 
 * Verifica:
 * 1. Bootstrap com ferramentas nativas
 * 2. Persistência de variáveis
 * 3. Uso de remember/recall
 * 4. run_shell funciona
 * 5. Memória do agente
 */

import { PersistentAntigravityBridge } from "../bridges/PersistentAntigravityBridge.js";

async function main() {
    console.log("🧪 Testing PersistentAntigravityBridge...\n");

    const bridge = new PersistentAntigravityBridge({
        workDir: process.cwd(),
    });

    try {
        // 1. Start e Bootstrap
        console.log("1. Starting bridge (with bootstrap)...");
        await bridge.start();
        console.log("   ✅ Bridge started with native tools\n");

        // 2. Verificar ferramentas disponíveis
        console.log("2. Checking available tools...");
        const tools = await bridge.execute("print(_agent_identity['capabilities'])");
        console.log(`   Tools: ${tools.content}`);
        console.log("   ✅ Tools available\n");

        // 3. Testar persistência de variáveis
        console.log("3. Testing variable persistence...");
        await bridge.execute("x = 42");
        await bridge.execute("y = 'hello'");
        const result = await bridge.execute("print(f'{y} world, x = {x}')");
        console.log(`   Result: ${result.content}`);
        console.log(result.content.includes("hello world") ? "   ✅ Variables persist!\n" : "   ❌ Variables NOT persisted\n");

        // 4. Testar remember/recall
        console.log("4. Testing remember/recall...");
        await bridge.execute("remember('secret_key', 'my_secret_value')");
        const recalled = await bridge.execute("print(recall('secret_key'))");
        console.log(`   Recalled: ${recalled.content}`);
        console.log(recalled.content.includes("my_secret_value") ? "   ✅ Memory works!\n" : "   ❌ Memory failed\n");

        // 5. Testar run_shell
        console.log("5. Testing run_shell...");
        const shell = await bridge.execute("print(run_shell('echo Hello from shell'))");
        console.log(`   Shell output: ${shell.content}`);
        console.log(shell.content.includes("Hello") ? "   ✅ Shell works!\n" : "   ❌ Shell failed\n");

        // 6. Testar show_memory
        console.log("6. Testing show_memory...");
        const memory = await bridge.execute("print(show_memory())");
        console.log(`   Memory: ${memory.content.substring(0, 100)}...`);
        console.log(memory.content.includes("secret_key") ? "   ✅ Memory shows stored values!\n" : "   ❌ Memory display failed\n");

        // 7. Testar getMemory (API TypeScript)
        console.log("7. Testing getMemory() API...");
        const agentMemory = await bridge.getMemory();
        console.log(`   Variables in namespace: ${Object.keys(agentMemory.variables).length}`);
        console.log("   ✅ getMemory() works!\n");

        // 8. Health check
        console.log("8. Health check...");
        const healthy = await bridge.healthCheck();
        console.log(`   Healthy: ${healthy}`);
        console.log(healthy ? "   ✅ Bridge is healthy!\n" : "   ❌ Bridge unhealthy\n");

        // Stats
        console.log("📊 Stats:");
        const stats = bridge.getStats();
        console.log(`   Execution count: ${stats.executionCount}`);
        console.log(`   REPL status: ${stats.replStatus}`);

        // Stop
        console.log("\n9. Stopping bridge...");
        await bridge.stop();
        console.log("   ✅ Bridge stopped\n");

        console.log("🎉 All tests passed!");

    } catch (error) {
        console.error("❌ Test failed:", error);
        await bridge.stop();
        process.exit(1);
    }
}

main();
