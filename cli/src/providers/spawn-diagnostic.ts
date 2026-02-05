#!/usr/bin/env bun
/**
 * 🔍 Diagnóstico do Spawn Issue
 * 
 * Testa diferentes abordagens de spawn para identificar o problema.
 */

import { spawn, exec, execSync, spawnSync } from "node:child_process";
import { getOuroborosOpenCodePath, getOuroborosEnv, getWorkspacePath } from "../utils/ouroboros.js";

const opencodePath = getOuroborosOpenCodePath();
const env = getOuroborosEnv();
const cwd = getWorkspacePath();

console.log("🔍 Diagnóstico do Spawn Issue");
console.log("==============================");
console.log(`OpenCode: ${opencodePath}`);
console.log(`CWD: ${cwd}`);
console.log("");

const prompt = "Responda apenas: DIAGNOSTICO_OK";
const escapedPrompt = prompt.replace(/"/g, '\\"');

// Teste 1: spawn com shell: true
async function testSpawnShellTrue() {
    console.log("\n📋 Teste 1: spawn com shell: true");
    console.log("----------------------------------");

    return new Promise((resolve) => {
        const start = Date.now();
        const command = `& "${opencodePath}" run --model "zai-coding-plan/glm-4.7" "${escapedPrompt}"`;

        console.log(`Comando: ${command.substring(0, 80)}...`);

        const proc = spawn(command, [], {
            env,
            cwd,
            shell: "powershell.exe",
        });

        let output = "";
        let error = "";
        let hasEvents = false;

        proc.stdout.on("data", (data) => {
            hasEvents = true;
            output += data.toString();
            console.log(`[stdout ${Date.now() - start}ms] ${data.toString().substring(0, 100)}`);
        });

        proc.stderr.on("data", (data) => {
            hasEvents = true;
            error += data.toString();
            console.log(`[stderr ${Date.now() - start}ms] ${data.toString().substring(0, 100)}`);
        });

        proc.on("close", (code) => {
            console.log(`[close] code=${code}, duration=${Date.now() - start}ms`);
            console.log(`Output length: ${output.length}, Error length: ${error.length}`);
            console.log(`Has events: ${hasEvents}`);
            resolve({ method: "spawn-shell-true", output, error, code, duration: Date.now() - start });
        });

        proc.on("error", (err) => {
            console.log(`[error] ${err.message}`);
            resolve({ method: "spawn-shell-true", output: "", error: err.message, code: -1 });
        });

        // Timeout de segurança
        setTimeout(() => {
            if (!hasEvents) {
                console.log("[TIMEOUT] Nenhum evento recebido após 60s!");
                proc.kill();
            }
        }, 60000);
    });
}

// Teste 2: exec (simula terminal)
async function testExec() {
    console.log("\n📋 Teste 2: exec (simula terminal)");
    console.log("-----------------------------------");

    return new Promise((resolve) => {
        const start = Date.now();
        const command = `& "${opencodePath}" run --model "zai-coding-plan/glm-4.7" "${escapedPrompt}"`;

        console.log(`Comando: ${command.substring(0, 80)}...`);

        exec(command, { env, cwd, shell: "powershell.exe", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            console.log(`[done] duration=${Date.now() - start}ms`);
            console.log(`stdout: ${stdout.substring(0, 200)}`);
            console.log(`stderr: ${stderr.substring(0, 200)}`);
            resolve({ method: "exec", output: stdout, error: stderr || err?.message, duration: Date.now() - start });
        });
    });
}

// Teste 3: spawn com stdio: inherit (herança de console)
async function testSpawnInherit() {
    console.log("\n📋 Teste 3: spawn com stdio: inherit");
    console.log("-------------------------------------");

    return new Promise((resolve) => {
        const start = Date.now();
        const command = `& "${opencodePath}" run --model "zai-coding-plan/glm-4.7" "${escapedPrompt}"`;

        const proc = spawn(command, [], {
            env,
            cwd,
            shell: "powershell.exe",
            stdio: "inherit", // Herda stdio do processo pai
        });

        proc.on("close", (code) => {
            console.log(`[close] code=${code}, duration=${Date.now() - start}ms`);
            resolve({ method: "spawn-inherit", code, duration: Date.now() - start });
        });

        proc.on("error", (err) => {
            console.log(`[error] ${err.message}`);
            resolve({ method: "spawn-inherit", error: err.message, code: -1 });
        });
    });
}

// Teste 4: spawn sem PowerShell (cmd.exe)
async function testSpawnCmd() {
    console.log("\n📋 Teste 4: spawn com cmd.exe");
    console.log("-----------------------------");

    return new Promise((resolve) => {
        const start = Date.now();
        // Para cmd.exe, não precisa do &
        const command = `"${opencodePath}" run --model "zai-coding-plan/glm-4.7" "${escapedPrompt}"`;

        console.log(`Comando: ${command.substring(0, 80)}...`);

        const proc = spawn(command, [], {
            env,
            cwd,
            shell: true, // Usa cmd.exe por padrão no Windows
        });

        let output = "";
        let error = "";

        proc.stdout.on("data", (data) => {
            output += data.toString();
            console.log(`[stdout ${Date.now() - start}ms] ${data.toString().substring(0, 100)}`);
        });

        proc.stderr.on("data", (data) => {
            error += data.toString();
            console.log(`[stderr ${Date.now() - start}ms] ${data.toString().substring(0, 100)}`);
        });

        proc.on("close", (code) => {
            console.log(`[close] code=${code}, duration=${Date.now() - start}ms`);
            resolve({ method: "spawn-cmd", output, error, code, duration: Date.now() - start });
        });

        proc.on("error", (err) => {
            console.log(`[error] ${err.message}`);
            resolve({ method: "spawn-cmd", error: err.message, code: -1 });
        });
    });
}

// Executar testes sequencialmente
async function runDiagnostics() {
    const results = [];

    // Escolher qual teste rodar (para não demorar muito)
    console.log("\n🚀 Escolha um teste para rodar:");
    console.log("  1 - spawn com shell: powershell.exe");
    console.log("  2 - exec (simula terminal)");
    console.log("  3 - spawn com stdio: inherit");
    console.log("  4 - spawn com cmd.exe");
    console.log("  all - Todos os testes");

    const testChoice = process.argv[2] || "1";

    if (testChoice === "1" || testChoice === "all") {
        results.push(await testSpawnShellTrue());
    }
    if (testChoice === "2" || testChoice === "all") {
        results.push(await testExec());
    }
    if (testChoice === "3" || testChoice === "all") {
        results.push(await testSpawnInherit());
    }
    if (testChoice === "4" || testChoice === "all") {
        results.push(await testSpawnCmd());
    }

    console.log("\n📊 RESUMO DOS RESULTADOS");
    console.log("========================");
    results.forEach((r) => {
        console.log(`${r.method}: ${r.code === 0 ? "✅" : "❌"} (${r.duration}ms)`);
        if (r.output) console.log(`  Output: ${r.output.substring(0, 100)}...`);
        if (r.error) console.log(`  Error: ${r.error.substring(0, 100)}`);
    });
}

runDiagnostics().catch(console.error);
