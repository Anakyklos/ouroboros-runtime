/**
 * BootWizard - Deterministic first-run setup
 * 
 * This wizard runs on first launch (or when config is missing/invalid).
 * It does NOT use AI - all logic is deterministic code.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';

// ============================================================================
// Types
// ============================================================================

export interface BootConfig {
    groqApiKey: string;
    googleApiKey?: string;
    geminiInstalled: boolean;
    configPath: string;
    createdAt: string;
}

// ============================================================================
// Constants
// ============================================================================

const CONFIG_DIR = '.ouroboros';
const CONFIG_FILE = 'config.json';

// ============================================================================
// Helpers
// ============================================================================

function getConfigPath(): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    return path.join(homeDir, CONFIG_DIR, CONFIG_FILE);
}

function getConfigDir(): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    return path.join(homeDir, CONFIG_DIR);
}

async function validateGroqKey(key: string): Promise<boolean> {
    const spinner = ora('Validating Groq API key...').start();

    try {
        const response = await fetch('https://api.groq.com/openai/v1/models', {
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            spinner.succeed('Groq API key is valid!');
            return true;
        } else {
            const errorText = await response.text();
            spinner.fail(`Invalid key: ${response.status} ${response.statusText}`);
            console.error(chalk.red(`Groq API Error: ${errorText}`));
            return false;
        }
    } catch (error) {
        spinner.fail(`Connection error: ${error instanceof Error ? error.message : 'Unknown'}`);
        return false;
    }
}

function checkGeminiCli(): boolean {
    try {
        execSync('gemini --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

async function loadConfig(): Promise<BootConfig | null> {
    try {
        const configPath = getConfigPath();
        const content = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(content) as BootConfig;

        // Validate required fields
        if (!config.groqApiKey) {
            return null;
        }

        return config;
    } catch {
        return null;
    }
}

async function saveConfig(config: BootConfig): Promise<void> {
    const configDir = getConfigDir();
    const configPath = getConfigPath();

    // Ensure directory exists
    await fs.mkdir(configDir, { recursive: true });

    // Save config
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// ============================================================================
// Main Wizard
// ============================================================================

export function showWelcomeBanner(): void {
    console.log('\n');

    // Elegant ASCII art banner with emerald gradient
    const emerald = chalk.hex('#10B981');
    const emeraldMuted = chalk.hex('#059669');
    const emeraldDark = chalk.hex('#047857');
    const silver = chalk.hex('#94A3B8');

    // Gradient effect: dark → muted → bright
    console.log(emeraldDark('   ██████╗ ██╗   ██╗██████╗  ██████╗ ██████╗  ██████╗ ██████╗  ██████╗ ███████╗'));
    console.log(emeraldDark('  ██╔═══██╗██║   ██║██╔══██╗██╔═══██╗██╔══██╗██╔═══██╗██╔══██╗██╔═══██╗██╔════╝'));
    console.log(emeraldMuted('  ██║   ██║██║   ██║██████╔╝██║   ██║██████╔╝██║   ██║██████╔╝██║   ██║███████╗'));
    console.log(emerald('  ██║   ██║██║   ██║██╔══██╗██║   ██║██╔══██╗██║   ██║██╔══██╗██║   ██║╚════██║'));
    console.log(emerald('  ╚██████╔╝╚██████╔╝██║  ██║╚██████╔╝██████╔╝╚██████╔╝██║  ██║╚██████╔╝███████║'));
    console.log(emerald.bold('   ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝'));
    console.log();
    console.log(silver('                        🐍 Autonomous Agent Runtime\n'));
}

export async function runBootWizard(): Promise<BootConfig> {
    // 1. Check for existing config
    const existingConfig = await loadConfig();

    if (existingConfig) {
        // Quick validation: can we still reach Groq?
        const spinner = ora('Validating existing configuration...').start();
        const isValid = await validateGroqKey(existingConfig.groqApiKey);

        if (isValid) {
            spinner.succeed('Configuration loaded successfully');
            return existingConfig;
        } else {
            spinner.warn('Existing configuration is invalid, starting wizard...');
        }
    }

    // 2. Interactive Setup (only if config missing or invalid)
    // Removed showWelcomeBanner() here to avoid duplication with main.ts

    // 3. Collect Groq API key
    let groqApiKey = '';
    let keyValid = false;

    while (!keyValid) {
        const { key } = await inquirer.prompt([
            {
                type: 'password',
                name: 'key',
                message: 'Enter your Groq API Key:',
                mask: '*',
                validate: (input: string) => {
                    if (!input || input.length < 10) {
                        return 'Please enter a valid API key';
                    }
                    return true;
                }
            }
        ]);

        groqApiKey = key;
        keyValid = await validateGroqKey(groqApiKey);

        if (!keyValid) {
            const { retry } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'retry',
                    message: 'Would you like to try again?',
                    default: true
                }
            ]);

            if (!retry) {
                console.log(chalk.red('\nSetup cancelled. Ouroboros requires a valid Groq API key.'));
                process.exit(1);
            }
        }
    }

    // 4. Collect Google API Key (Optional)
    console.log('\n');
    const { googleKey } = await inquirer.prompt([
        {
            type: 'password',
            name: 'googleKey',
            message: 'Enter your Google API Key (optional, for embeddings):',
            mask: '*',
        }
    ]);

    // 5. Check Gemini CLI
    console.log('\n');
    const geminiSpinner = ora('Checking for Gemini CLI...').start();
    const geminiInstalled = checkGeminiCli();

    if (geminiInstalled) {
        geminiSpinner.succeed('Gemini CLI found in PATH');
    } else {
        geminiSpinner.warn('Gemini CLI not found (optional - some features will be limited)');
    }

    // 6. Build and save config
    const config: BootConfig = {
        groqApiKey,
        googleApiKey: googleKey || undefined,
        geminiInstalled,
        configPath: getConfigPath(),
        createdAt: new Date().toISOString()
    };

    const saveSpinner = ora('Saving configuration...').start();
    await saveConfig(config);
    saveSpinner.succeed(`Configuration saved to ${getConfigPath()}`);

    // 6. Success message
    console.log('\n');
    console.log(chalk.green('✅ Setup complete! Ouroboros is ready.'));
    console.log('\n');

    return config;
}

// ============================================================================
// Factory
// ============================================================================

export function createBootWizard() {
    return {
        run: runBootWizard,
        validateGroqKey,
        checkGeminiCli,
        loadConfig,
        saveConfig
    };
}
