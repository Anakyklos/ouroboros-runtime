/**
 * ♾️ Ouroboros Main Loop
 * 
 * Interactive REPL to interact with the fully integrated GatewayOrchestrator.
 * Supports:
 * - Direct Architect consultation
 * - Wave Execution
 * - Session Management
 */

import { createGatewayOrchestrator } from "../orchestration/GatewayOrchestrator.js";
import * as readline from "readline";
import { globalEventBus } from "./event-bus.js";
import { PersonaType } from "../orchestration/types.js";

// Initialize system
const go = createGatewayOrchestrator({
    gateway: { verbose: true },
    orchestrator: { maxRetries: 3, verbose: true },
    architect: { model: "pro" }, // Use Pro for best reasoning
    wave: { maxConcurrent: 3 },
    memory: { embeddingModel: "gemini" }
});

// Setup REPL
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "🐍 Ouroboros> "
});

// Event logging
globalEventBus.on("log", (payload) => {
    // Overwrite current line to show log, then restore prompt
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    const icon = payload.level === "error" ? "❌" : payload.level === "warn" ? "⚠️" : "ℹ️";
    console.log(`${icon} [${payload.source || "System"}] ${payload.message}`);
    rl.prompt(true);
});

async function main() {
    console.clear();
    console.log(`
╔════════════════════════════════════════╗
║         🐍 Ouroboros v0.1.0            ║
║    Autonomous Development System       ║
╚════════════════════════════════════════╝
    `);

    // Retrieve API Key (mock for now or env)
    const apiKey = process.env.DWAVE_API_KEY || "mock-key";

    console.log("Initializing GatewayOrchestrator...");
    go.initialize(apiKey);
    go.start();

    console.log("\nCommands:");
    console.log("  /consult <query>   - Ask Architect (Design Review)");
    console.log("  /task <desc>       - Run single orchestrator task");
    console.log("  /wave <desc>       - Run parallel wave tasks (simulated)");
    console.log("  /memory <query>    - Search memory");
    console.log("  /exit              - Shutdown\n");

    const sessionId = "cli-session-1";
    console.log(`Active Session: ${sessionId}\n`);

    rl.prompt();

    rl.on("line", async (line) => {
        const input = line.trim();

        if (!input) {
            rl.prompt();
            return;
        }

        if (input.toLowerCase() === "/exit") {
            console.log("Shutting down...");
            go.stop();
            process.exit(0);
        }

        if (input.startsWith("/consult ")) {
            const query = input.slice(9);
            console.log("⏳ Consultando Architect...");
            try {
                const response = await go.consultArchitect(query);
                console.log("\n🏛️ Architect Response:\n");
                console.log(response);
            } catch (e) {
                console.error("Error:", e);
            }
        }
        else if (input.startsWith("/memory ")) {
            const query = input.slice(8);
            console.log("🧠 Searching Memory...");
            try {
                const memory = await go.getMemory().search(query);
                console.log(JSON.stringify(memory, null, 2));
            } catch (e) {
                console.error("Error:", e);
            }
        }
        else if (input.startsWith("/task ")) {
            const desc = input.slice(6);
            console.log("🚀 Dispatching Task...");
            try {
                // Mock task dispatch
                const result = await go.executeTask(sessionId, {
                    id: `task-${Date.now()}`,
                    persona: PersonaType.DEVELOPER,
                    instruction: desc
                });
                console.log("Result:", result.status);
            } catch (e) {
                console.error("Error:", e);
            }
        }
        else {
            console.log("Unknown command through REPL (Try /consult, /task, /memory)");
        }

        console.log(""); // newline
        rl.prompt();
    });
}

main().catch(console.error);
