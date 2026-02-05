#!/usr/bin/env npx tsx
/**
 * ♾️ Ouroboros Main Loop
 * 
 * Interactive CLI to interact with the fully integrated GatewayOrchestrator.
 * Uses Inquirer for menus, Boxen/Chalk for UI, and Figlet/Gradient for aesthetics.
 */

import { createGatewayOrchestrator } from "../orchestration/GatewayOrchestrator.js";
import { globalEventBus } from "./event-bus.js";
import { PersonaType } from "../orchestration/types.js";
import { runBootWizard, type BootConfig } from "../boot/BootWizard.js";
import { createConcierge, type ConciergeClient } from "../concierge/ConciergeClient.js";
import inquirer from "inquirer";
import chalk from "chalk";
import boxen from "boxen";
import figlet from "figlet";
import gradient from "gradient-string";
import ora from "ora";

// Will be initialized after boot wizard
let go: ReturnType<typeof createGatewayOrchestrator>;
let bootConfig: BootConfig;
let concierge: ConciergeClient;

// Default config (will be reused after boot wizard)
const defaultConfig = {
    gateway: { verbose: true },
    orchestrator: { maxRetries: 3, verbose: true },
    architect: { model: "pro" as const },
    wave: { maxConcurrent: 3 },
    memory: { embeddingModel: "gemini" as const }
};

const sessionId = "cli-session-1";

// --- UI Helpers ---

const showLogo = () => {
    console.clear();
    const text = figlet.textSync('OUROBOROS', {
        font: 'ANSI Shadow',
        horizontalLayout: 'default',
        verticalLayout: 'default'
    });

    // Snake-like gradient: Green to Cyan/Blue
    const logoGradient = gradient('green', 'cyan', 'blue')(text);

    console.log(boxen(logoGradient, {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'cyan',
        title: '🐍 Autonomous Development System',
        titleAlignment: 'center'
    }));
};

const showHeader = () => {
    console.clear();
    console.log(chalk.gray(`Session: ${sessionId} | Status: `) + chalk.green("Online 🟢"));
    console.log(chalk.gray("─".repeat(50)));
};

// --- Command Handlers ---

async function handleAsk() {
    const { userInput } = await inquirer.prompt([{
        type: 'input',
        name: 'userInput',
        message: chalk.green('💬 What would you like to do?'),
        validate: input => input.length > 0 ? true : 'Please enter something.'
    }]);

    const spinner = ora('Understanding your intent...').start();
    const result = await concierge.classify(userInput);

    if (result.intent === 'unknown' || result.confidence < 0.5) {
        spinner.warn(`Could not classify (confidence: ${(result.confidence * 100).toFixed(0)}%). Showing menu.`);
        return; // Will fall through to main menu
    }

    spinner.succeed(`Intent: ${result.intent} (${(result.confidence * 100).toFixed(0)}%)`);

    // Route to appropriate handler with extracted query
    switch (result.intent) {
        case 'consult':
            await handleConsultDirect(result.extractedQuery);
            break;
        case 'task':
            await handleTaskDirect(result.extractedQuery);
            break;
        case 'wave':
            await handleWaveDirect(result.extractedQuery);
            break;
        case 'memory':
            await handleMemoryDirect(result.extractedQuery);
            break;
    }
}

async function handleConsult() {
    const { query } = await inquirer.prompt([{
        type: 'input',
        name: 'query',
        message: chalk.cyan('What would you like to consult the Architect about?'),
        validate: input => input.length > 0 ? true : 'Please enter a query.'
    }]);
    await handleConsultDirect(query);
}

async function handleConsultDirect(query: string) {
    const spinner = ora('Architect is thinking...').start();
    try {
        const response = await go.consultArchitect(query);
        spinner.succeed('Architect responded');

        console.log(boxen(response, {
            title: '🏛️ Architect Response',
            borderColor: 'magenta',
            padding: 1,
            margin: 1,
            borderStyle: 'double'
        }));
    } catch (e: unknown) {
        spinner.fail('Consultation failed');
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
    }
}

async function handleTask() {
    const { desc } = await inquirer.prompt([{
        type: 'input',
        name: 'desc',
        message: chalk.yellow('Describe the task to dispatch:'),
        validate: input => input.length > 0 ? true : 'Task description required.'
    }]);
    await handleTaskDirect(desc);
}

async function handleTaskDirect(desc: string) {
    const spinner = ora('Dispatching task to Gemini...').start();
    try {
        // Check if Gemini CLI is available
        const availability = await go.checkBridgeAvailability();

        if (!availability.gemini) {
            spinner.fail('Gemini CLI not found in PATH');
            console.log(chalk.yellow('Please install Gemini CLI first: pip install gemini-cli'));
            return;
        }

        const result = await go.delegateToGemini(desc, 'flash');
        spinner.succeed('Task execution completed');

        if (result.success) {
            console.log(boxen(result.content, {
                title: '💎 Gemini Response',
                borderColor: 'green',
                padding: 1,
                margin: 1
            }));
        } else {
            console.log(boxen(chalk.red(result.error || 'Unknown error'), {
                title: '❌ Task Failed',
                borderColor: 'red',
                padding: 1,
            }));
        }
    } catch (e: unknown) {
        spinner.fail('Task execution failed');
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
    }
}

async function handleMemory() {
    const { query } = await inquirer.prompt([{
        type: 'input',
        name: 'query',
        message: chalk.blue('Search query for memory:'),
        validate: input => input.length > 0 ? true : 'Query required.'
    }]);
    await handleMemoryDirect(query);
}

async function handleMemoryDirect(query: string) {
    const spinner = ora('Searching memory...').start();
    try {
        const memory = await go.getMemory().search(query);
        spinner.succeed('Memory search complete');

        console.log(boxen(JSON.stringify(memory, null, 2), {
            title: '🧠 Memory Context',
            borderColor: 'blue',
            padding: 1
        }));
    } catch (e: unknown) {
        spinner.fail('Memory search failed');
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
    }
}

async function handleWave() {
    const { desc } = await inquirer.prompt([{
        type: 'input',
        name: 'desc',
        message: chalk.magenta('Describe the objective for the Wave (Parallel execution):'),
        validate: input => input.length > 0 ? true : 'Objective required.'
    }]);
    await handleWaveDirect(desc);
}

async function handleWaveDirect(desc: string) {
    console.log(chalk.gray("\nℹ️ Note: This will trigger the WaveExecutor simulation.\n"));

    const spinner = ora('Initializing Wave...').start();
    spinner.info('Wave functionality linked to Task Execution for now.');

    try {
        const result = await go.executeTask(sessionId, {
            id: `wave-${Date.now()}`,
            persona: PersonaType.ARCHITECT,
            instruction: `[WAVE_MODE] ${desc}`
        });
        spinner.succeed('Wave execution finished');
        console.log(boxen(JSON.stringify(result, null, 2), {
            title: '🌊 Wave Result',
            borderColor: 'magenta',
            padding: 1
        }));
    } catch (e: unknown) {
        spinner.fail('Wave failed');
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
    }
}

// --- Main Loop ---

async function mainLoop() {
    while (true) {
        const { action } = await inquirer.prompt([{
            type: 'list',
            name: 'action',
            message: 'Select an action:',
            choices: [
                { name: '💬 Ask Ouroboros (Natural Language)', value: 'ask' },
                new inquirer.Separator(),
                { name: '🏛️  Consult Architect', value: 'consult' },
                { name: '🚀 Dispatch Task', value: 'task' },
                { name: '🌊 Execute Wave', value: 'wave' },
                { name: '🧠 Search Memory', value: 'memory' },
                new inquirer.Separator(),
                { name: '🚪 Exit', value: 'exit' }
            ]
        }]);

        if (action === 'exit') {
            const confirm = await inquirer.prompt([{
                type: 'confirm',
                name: 'sure',
                message: 'Are you sure you want to exit?',
                default: true
            }]);
            if (confirm.sure) {
                console.log(chalk.green('Goodbye! 🐍'));
                process.exit(0);
            }
        } else {
            console.log(chalk.gray('─'.repeat(50)));
            switch (action) {
                case 'ask': await handleAsk(); break;
                case 'consult': await handleConsult(); break;
                case 'task': await handleTask(); break;
                case 'wave': await handleWave(); break;
                case 'memory': await handleMemory(); break;
            }
            // Wait for user before clearing screen for next menu loop
            await inquirer.prompt([{ type: 'input', name: 'pause', message: 'Press Enter to continue...' }]);
            showHeader();
        }
    }
}

async function main() {
    // Setup cleanup
    process.on('SIGINT', () => {
        console.log(chalk.yellow('\n\nGracefully shutting down...'));
        if (go) go.stop();
        process.exit(0);
    });

    // 1. Run Boot Wizard (first-run or validate existing config)
    try {
        bootConfig = await runBootWizard();
    } catch (e) {
        console.error(chalk.red('Boot wizard failed:'), e);
        process.exit(1);
    }

    // 2. Initialize Concierge with Groq API key
    concierge = createConcierge(bootConfig.groqApiKey);

    // 3. Initialize GatewayOrchestrator with config
    go = createGatewayOrchestrator(defaultConfig);

    // 4. Initialize system
    const spinner = ora('Initializing Ouroboros System...').start();
    try {
        const apiKey = bootConfig.groqApiKey || process.env.DWAVE_API_KEY || "mock-key";
        go.initialize(apiKey);
        go.start();
        spinner.succeed('System Initialized');
    } catch (e) {
        spinner.fail('Initialization Failed');
        console.error(e);
        process.exit(1);
    }

    // Silence global event bus logs to stdout to prevent UI messing
    // In a real app we might redirect these to a file or a debug panel
    globalEventBus.on("log", (payload) => {
        // Only log errors or critical info if absolutely needed, or purely to file
        if (payload.level === 'error') {
            // We can print, but it might mess up inquirer
        }
    });

    // Start UI
    showLogo();
    await mainLoop();
}

main().catch(console.error);
