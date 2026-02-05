/**
 * 🧪 Test Bridge Script
 * 
 * Validates that the TypeScript code can successfully spawn:
 * 1. Python from the isolated venv
 * 2. OpenCode CLI from the isolated npm installation
 */

import { spawn } from "child_process";
import { getOuroborosConfig, getOuroborosEnv } from "../cli/src/utils/ouroboros";

const SEPARATOR = "═".repeat(60);

async function runCommand(
    name: string,
    command: string,
    args: string[],
    env?: NodeJS.ProcessEnv
): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
        console.log(`\n🔧 Testing: ${name}`);
        console.log(`   Command: ${command} ${args.join(" ")}`);

        const proc = spawn(command, args, {
            env: env || process.env,
            shell: true,
        });

        let output = "";

        proc.stdout.on("data", (data) => {
            output += data.toString();
        });

        proc.stderr.on("data", (data) => {
            output += data.toString();
        });

        proc.on("close", (code) => {
            const success = code === 0;
            console.log(`   Status: ${success ? "✅ PASS" : "❌ FAIL"}`);
            if (output.trim()) {
                console.log(`   Output: ${output.trim().split("\n")[0]}`);
            }
            resolve({ success, output });
        });

        proc.on("error", (err) => {
            console.log(`   Status: ❌ ERROR - ${err.message}`);
            resolve({ success: false, output: err.message });
        });
    });
}

async function main() {
    console.log(SEPARATOR);
    console.log("🐍 OUROBOROS BRIDGE TEST");
    console.log(SEPARATOR);

    // Get config
    const config = getOuroborosConfig();
    const env = getOuroborosEnv();

    console.log("\n📋 Configuration:");
    console.log(`   Root:      ${config.root}`);
    console.log(`   Python:    ${config.python}`);
    console.log(`   OpenCode:  ${config.openCode}`);
    console.log(`   Workspace: ${config.workspace}`);
    console.log(`   Ready:     ${config.isReady ? "✅ Yes" : "❌ No"}`);

    const results: boolean[] = [];

    // Test 1: Python version
    const pythonTest = await runCommand(
        "Python (venv)",
        config.python,
        ["--version"],
        env
    );
    results.push(pythonTest.success);

    // Test 2: Check pandas is installed
    const pandasTest = await runCommand(
        "Python Packages (pandas)",
        config.python,
        ["-c", '"import pandas; print(f\'pandas {pandas.__version__}\')"'],
        env
    );
    results.push(pandasTest.success);

    // Test 3: OpenCode version
    const openCodeTest = await runCommand(
        "OpenCode CLI",
        config.openCode,
        ["--version"],
        env
    );
    results.push(openCodeTest.success);

    // Summary
    console.log(`\n${SEPARATOR}`);
    const passed = results.filter(Boolean).length;
    const total = results.length;
    const allPassed = passed === total;

    console.log(`\n📊 RESULTS: ${passed}/${total} tests passed`);
    console.log(allPassed
        ? "🎉 All bridge tests PASSED! TypeScript can spawn isolated processes."
        : "⚠️  Some tests failed. Check the configuration."
    );
    console.log(SEPARATOR);

    process.exit(allPassed ? 0 : 1);
}

main();
