#!/usr/bin/env bun
/**
 * 🐍 Ouroboros Main Entry Point
 * 
 * Unified CLI that:
 * 1. Runs BootWizard on first launch
 * 2. Initializes GatewayOrchestrator
 * 3. Renders the TUI
 * 4. Handles user input via slash commands or natural language
 */

import chalk from "chalk";
import ora from "ora";

import { runBootWizard, showWelcomeBanner, type BootConfig } from "./boot/BootWizard.js";
import { createGatewayOrchestrator } from "./orchestration/GatewayOrchestrator.js";
import { createConcierge, type ConciergeClient } from "./concierge/ConciergeClient.js";
import { globalEventBus } from "./daemon/event-bus.js";
import { renderTui } from "./tui/entry.js";
import { useTuiStore } from "./tui/store.js";

// ============================================================================
// State
// ============================================================================

let go: ReturnType<typeof createGatewayOrchestrator>;
let bootConfig: BootConfig;
let concierge: ConciergeClient;

const defaultConfig = {
    gateway: { verbose: false },
    orchestrator: { maxRetries: 3, verbose: false },
    architect: { model: "pro" as const },
    wave: { maxConcurrent: 3 },
    memory: { embeddingModel: "gemini" as const }
};

// ============================================================================
// Command Handlers
// ============================================================================

async function handleConsult(query: string): Promise<string> {
    try {
        return await go.consultArchitect(query);
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

async function handleTask(desc: string): Promise<string> {
    try {
        const availability = await go.checkBridgeAvailability();
        const lowerDesc = desc.toLowerCase();

        // Check for Antigravity delegation
        if (lowerDesc.startsWith("(agy)") || lowerDesc.startsWith("(antigravity)")) {
            if (!availability.antigravity) {
                return "❌ Antigravity CLI not found. Ensure 'agy' is installed in .ouroboros/venv";
            }
            // Strip prefix
            const cleanDesc = desc.replace(/^\((agy|antigravity)\)\s*/i, "");
            const result = await go.delegateToAntigravity(cleanDesc);
            return result.success ? result.content : `Error: ${result.error || 'Unknown'}`;
        }

        // Default to Gemini
        if (!availability.gemini) {
            return "❌ Gemini CLI not found. Run 'bun run setup' to install.";
        }

        const result = await go.delegateToGemini(desc, 'flash');
        return result.success ? result.content : `Error: ${result.error || 'Unknown'}`;
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

async function handleMemory(query: string): Promise<string> {
    try {
        const results = await go.getMemory().search(query);
        return JSON.stringify(results, null, 2);
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}

async function handleHelp(): Promise<string> {
    return `
🐍 **Ouroboros Commands**

/consult <query>  - Ask the Architect for guidance
/task <desc>      - Dispatch a task to Gemini
                    Prefix with (agy) to use Antigravity
/memory <query>   - Search memory/context
/help             - Show this help message
/exit             - Exit Ouroboros

Or just type naturally - Ouroboros will understand your intent!
`.trim();
}

// ============================================================================
// Message Router
// ============================================================================

async function handleMessage(input: string): Promise<void> {
    const store = useTuiStore.getState();
    const trimmed = input.trim();

    // Handle slash commands
    if (trimmed.startsWith('/')) {
        const [cmd, ...args] = trimmed.slice(1).split(' ');
        const argStr = args.join(' ');

        store.setStatus('executing');

        let response: string;
        switch (cmd.toLowerCase()) {
            case 'help':
                response = await handleHelp();
                break;
            case 'consult':
                response = argStr ? await handleConsult(argStr) : 'Usage: /consult <query>';
                break;
            case 'task':
                response = argStr ? await handleTask(argStr) : 'Usage: /task <description>';
                break;
            case 'memory':
                response = argStr ? await handleMemory(argStr) : 'Usage: /memory <query>';
                break;
            case 'exit':
                console.log(chalk.green('\nGoodbye! 🐍'));
                process.exit(0);
            default:
                response = `Unknown command: /${cmd}. Type /help for available commands.`;
        }

        if (!response) {
            response = "Received empty response from agent.";
        }

        store.addMessage({ role: 'agent', content: response, timestamp: new Date() });
        store.setStatus('idle');
        return;
    }

    // Natural language - use Concierge to classify
    store.setStatus('thinking');

    try {
        const result = await concierge.classify(trimmed);

        if (result.intent === 'unknown' || result.confidence < 0.5) {
            store.addMessage({
                role: 'agent',
                content: `I'm not sure what you want to do. Try:\n- "/help" for commands\n- Be more specific about your request`,
                timestamp: new Date()
            });
            store.setStatus('idle');
            return;
        }

        store.addLog({
            level: 'info',
            message: `Intent: ${result.intent} (${(result.confidence * 100).toFixed(0)}%)`,
            timestamp: new Date(),
            source: 'concierge'
        });

        store.setStatus('executing');

        let response: string;
        switch (result.intent) {
            case 'consult':
                response = await handleConsult(result.extractedQuery);
                break;
            case 'task':
                response = await handleTask(result.extractedQuery);
                break;
            case 'memory':
                response = await handleMemory(result.extractedQuery);
                break;
            default:
                response = await handleTask(result.extractedQuery); // Default to task
        }

        if (!response) {
            response = "Agent produced no output.";
        }

        store.addMessage({ role: 'agent', content: response, timestamp: new Date() });
    } catch (e) {
        store.addMessage({
            role: 'agent',
            content: `Error: ${e instanceof Error ? e.message : String(e)}`,
            timestamp: new Date()
        });
    }

    store.setStatus('idle');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    // Show big logo banner
    showWelcomeBanner();

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log(chalk.yellow('\n\nShutting down...'));
        if (go) go.stop();
        process.exit(0);
    });

    // 1. Boot Wizard
    try {
        bootConfig = await runBootWizard();
    } catch (e) {
        console.error(chalk.red('Boot failed:'), e);
        process.exit(1);
    }

    // 2. Initialize Concierge
    concierge = createConcierge(bootConfig.groqApiKey);

    // 2.5 Set Gemini API Key if available
    if (bootConfig.googleApiKey) {
        process.env.GOOGLE_API_KEY = bootConfig.googleApiKey;
    }

    // 3. Initialize GatewayOrchestrator
    go = createGatewayOrchestrator(defaultConfig);

    const spinner = ora('Initializing Ouroboros...').start();
    try {
        go.initialize(bootConfig.groqApiKey);
        go.start();
        spinner.succeed('System ready');
    } catch (e) {
        spinner.fail('Initialization failed');
        console.error(e);
        process.exit(1);
    }

    // 4. Setup store with welcome message
    const store = useTuiStore.getState();
    store.addMessage({
        role: 'system',
        content: '🐍 Welcome to Ouroboros! Type /help for commands or just ask naturally.',
        timestamp: new Date()
    });

    // 5. Wire EventBus to TUI logs
    globalEventBus.on('log', (payload) => {
        if (payload.level !== 'debug') {
            store.addLog({
                level: payload.level,
                message: payload.message,
                timestamp: new Date(),
                source: payload.source
            });
        }
    });

    // 6. Render TUI
    const { waitUntilExit } = renderTui(globalEventBus, handleMessage);
    await waitUntilExit();
}

main().catch(console.error);
