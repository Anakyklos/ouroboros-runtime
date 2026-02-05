/**
 * 🧪 Ouroboros Isolation Smoke Test
 * 
 * This script validates that:
 * 1. The ouroboros utility can find the isolated Python
 * 2. The Python executable is from .ouroboros/venv (NOT the system Python)
 * 
 * Execute with: bun run test_ouroboros.ts
 */

import { execSync } from "node:child_process";
import { getOuroborosPythonPath, getOuroborosConfig } from "./cli/src/utils/ouroboros";

console.log("\n" + "=".repeat(50));
console.log("🧪 OUROBOROS ISOLATION SMOKE TEST");
console.log("=".repeat(50) + "\n");

try {
    // Step 1: Get the config
    const config = getOuroborosConfig();
    console.log("📋 Configuration:");
    console.log(`   Root:      ${config.root}`);
    console.log(`   Python:    ${config.python}`);
    console.log(`   Pip:       ${config.pip}`);
    console.log(`   Workspace: ${config.workspace}`);
    console.log(`   Ready:     ${config.isReady ? "✅" : "❌"}`);
    console.log();

    // Step 2: Get validated Python path (should throw if not ready)
    const pythonPath = getOuroborosPythonPath();
    console.log("🔍 Validated Python path:", pythonPath);
    console.log();

    // Step 3: Execute Python and check sys.executable
    console.log("🐍 Executing Python to verify isolation...");
    const result = execSync(`"${pythonPath}" -c "import sys; print(sys.executable)"`, {
        encoding: "utf-8"
    }).trim();

    console.log("   sys.executable:", result);
    console.log();

    // Step 4: Validate the path is from .ouroboros
    const isIsolated = result.includes(".ouroboros");

    if (isIsolated) {
        console.log("=".repeat(50));
        console.log("🎉 SUCCESS! Python is running from the isolated environment!");
        console.log("=".repeat(50));
    } else {
        console.log("=".repeat(50));
        console.log("❌ FAILURE! Python is NOT running from .ouroboros!");
        console.log("   Expected path containing: .ouroboros");
        console.log("   Got:", result);
        console.log("=".repeat(50));
        process.exit(1);
    }

} catch (error) {
    console.error("❌ Test failed:", error instanceof Error ? error.message : error);
    process.exit(1);
}
