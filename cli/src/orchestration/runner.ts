#!/usr/bin/env bun
/**
 * 🤖 Ouroboros Runner
 * 
 * Ponto de entrada para delegar tarefas aos subagentes Z.AI.
 * O Antigravity (eu) só deve intervir quando o status for NEEDS_HUMAN.
 * 
 * Uso:
 *   bun run cli/src/orchestration/runner.ts "Implementar feature X"
 *   bun run cli/src/orchestration/runner.ts --file task.md
 *   bun run cli/src/orchestration/runner.ts --wave tasks.json
 */

import * as fs from "node:fs";
import {
    Orchestrator,
    createTask,
    PersonaType,
    TaskStatus,
    createTestValidationStrategy,
} from "./index.js";
import { WaveExecutor } from "./WaveExecutor.js";
import type { WaveTask } from "./wave-types.js";

// Cores para output
const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
    magenta: "\x1b[35m",
};

function log(emoji: string, message: string, color = colors.reset) {
    console.log(`${color}${emoji} ${message}${colors.reset}`);
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log(`
${colors.bright}🐍 Ouroboros Runner${colors.reset}

Delega tarefas para subagentes Z.AI. Você (humano) só intervém no final.

${colors.cyan}Uso:${colors.reset}
  bun run runner.ts "Criar função de validação de email"
  bun run runner.ts --persona REVIEWER "Code review do arquivo X"
  bun run runner.ts --validate "Implementar testes para módulo Y"
  bun run runner.ts --wave tasks.json

${colors.yellow}Opções:${colors.reset}
  --persona <DEVELOPER|REVIEWER|TESTER>  Persona inicial (default: DEVELOPER)
  --validate                              Usa ValidationStrategy (bun test)
  --workdir <path>                        Diretório de trabalho
  --wave <file.json>                      Executa tasks em paralelo (Wave Coding)

${colors.magenta}Escalation Chain:${colors.reset}
  DEVELOPER → REVIEWER → ARCHITECT → NEEDS_HUMAN (você)
`);
        process.exit(0);
    }

    // Parse args
    let instruction = "";
    let persona: PersonaType = PersonaType.DEVELOPER;
    let useValidation = false;
    let workDir = process.cwd();
    let waveFile: string | null = null;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--persona" && args[i + 1]) {
            persona = args[++i] as PersonaType;
        } else if (arg === "--validate") {
            useValidation = true;
        } else if (arg === "--workdir" && args[i + 1]) {
            workDir = args[++i];
        } else if (arg === "--wave" && args[i + 1]) {
            waveFile = args[++i];
        } else if (!arg.startsWith("--")) {
            instruction = arg;
        }
    }

    // Criar orchestrator
    const orchestrator = new Orchestrator({
        maxRetries: 3,
        verbose: true,
        requireApproval: false, // TODO: Integrar HumanLayer
        skipPhaseValidation: true, // Modo simples para testes
    });

    // 🌊 Wave Mode - execução paralela
    if (waveFile) {
        if (!fs.existsSync(waveFile)) {
            log("❌", `Arquivo não encontrado: ${waveFile}`, colors.red);
            process.exit(1);
        }

        log("🌊", `Wave Coding Mode`, colors.bright);
        log("📄", `Arquivo: ${waveFile}`, colors.cyan);

        const tasks: WaveTask[] = JSON.parse(fs.readFileSync(waveFile, "utf-8"));
        log("📝", `Tasks: ${tasks.length}`, colors.yellow);
        console.log("\n" + "=".repeat(60) + "\n");

        const executor = new WaveExecutor(orchestrator, { verbose: true });
        const startTime = Date.now();
        const result = await executor.execute(tasks);
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        console.log("\n" + "=".repeat(60) + "\n");
        log("🌊", `Wave Execution Complete em ${duration}s`, colors.bright);
        log("✅", `Success: ${result.successfulTasks.length}`, colors.green);
        log("❌", `Failed: ${result.failedTasks.length}`, colors.red);
        log("⏭️", `Skipped: ${result.skippedTasks.length}`, colors.yellow);

        return result;
    }

    // Modo single task requer instrução
    if (!instruction) {
        log("❌", "Nenhuma instrução fornecida", colors.red);
        process.exit(1);
    }

    log("🐍", `Ouroboros Runner iniciado`, colors.bright);
    log("📝", `Instrução: "${instruction}"`, colors.cyan);
    log("🎭", `Persona inicial: ${persona}`, colors.yellow);
    log("📂", `WorkDir: ${workDir}`, colors.reset);

    // Criar task
    const task = createTask(instruction, persona);

    // Adicionar validation se solicitado
    if (useValidation) {
        log("🔬", "ValidationStrategy: bun test", colors.magenta);
        task.validationStrategy = createTestValidationStrategy();
    }
    task.workDir = workDir;

    // Executar!
    log("🚀", "Delegando para subagentes...", colors.green);
    console.log("\n" + "=".repeat(60) + "\n");

    const startTime = Date.now();
    const result = await orchestrator.loopUntilSuccess(task);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log("\n" + "=".repeat(60) + "\n");

    // Resultado
    switch (result.status) {
        case TaskStatus.SUCCESS:
            log("✅", `SUCESSO em ${duration}s (${result.retryCount} tentativas)`, colors.green);
            console.log("\nOutput:");
            console.log(result.output.slice(0, 500) + (result.output.length > 500 ? "..." : ""));
            break;

        case TaskStatus.NEEDS_HUMAN:
            log("🆘", `PRECISA DE INTERVENÇÃO HUMANA`, colors.red);
            log("💡", `Erro: ${result.error}`, colors.yellow);
            log("📊", `Tentativas: ${result.retryCount}`, colors.reset);
            console.log("\n🧠 Contexto das tentativas:");
            result.contextHistory.slice(-3).forEach((entry, i) => {
                console.log(`  ${i + 1}. ${entry.error || "OK"}`);
            });
            console.log("\n👆 Antigravity deve intervir agora!");
            break;

        case TaskStatus.FAILURE:
            log("❌", `FALHA após ${result.retryCount} tentativas`, colors.red);
            log("💡", `Último erro: ${result.error}`, colors.yellow);
            break;
    }

    return result;
}

main().catch(console.error);
