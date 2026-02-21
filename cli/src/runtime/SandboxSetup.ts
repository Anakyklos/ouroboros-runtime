/**
 * SandboxSetup - Deterministic sandbox environment setup
 *
 * This helper creates and validates the .ouroboros directory structure
 * and Python virtual environment for isolated code execution.
 * It does NOT use AI - all logic is deterministic code.
 */

import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs/promises';
import { execSync } from 'child_process';
import { OuroborosEnvironment } from './OuroborosEnvironment.js';

// ============================================================================
// Types
// ============================================================================

export interface SandboxSetupConfig {
    projectRoot?: string;
    pythonVersion?: string;
    skipVenvCreation?: boolean;
}

export interface SandboxSetupResult {
    success: boolean;
    environment: OuroborosEnvironment;
    venvCreated: boolean;
    venvPath: string;
    playgroundPath: string;
    pythonExecutable: string;
    error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PYTHON_VERSION = '3.10';
const REQUIRED_VENV_DIRS = [
    'Lib',
    'Scripts',
    'Include'
];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Checks if Python is available in the system
 */
function checkPythonAvailable(): boolean {
    try {
        execSync('python3 --version', { stdio: 'ignore' });
        return true;
    } catch {
        try {
            execSync('python --version', { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * Gets the Python executable command
 */
function getPythonCommand(): string {
    try {
        execSync('python3 --version', { stdio: 'ignore' });
        return 'python3';
    } catch {
        return 'python';
    }
}

/**
 * Gets Python version
 */
function getPythonVersion(): string | null {
    try {
        const pythonCmd = getPythonCommand();
        const output = execSync(`${pythonCmd} --version`, { encoding: 'utf-8' });
        const match = output.match(/Python (\d+\.\d+\.\d+)/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/**
 * Validates if a directory exists and is a valid venv
 */
async function validateVenvDirectory(venvPath: string): Promise<boolean> {
    try {
        // Check if venv directory exists
        await fs.access(venvPath);

        // Check for key venv components
        const scriptsDir = process.platform === 'win32' ? 'Scripts' : 'bin';
        const pythonPath = `${venvPath}/${scriptsDir}/${process.platform === 'win32' ? 'python.exe' : 'python'}`;

        await fs.access(pythonPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Creates a Python virtual environment
 */
async function createVirtualEnvironment(
    venvPath: string,
    pythonCmd: string
): Promise<{ success: boolean; error?: string }> {
    const spinner = ora('Creating Python virtual environment...').start();

    try {
        // Create venv using python -m venv
        execSync(
            `${pythonCmd} -m venv "${venvPath}"`,
            {
                stdio: 'pipe',
                encoding: 'utf-8'
            }
        );

        spinner.succeed('Virtual environment created');
        return { success: true };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        spinner.fail(`Failed to create virtual environment: ${errorMsg}`);
        return { success: false, error: errorMsg };
    }
}

/**
 * Upgrades pip in the newly created venv
 */
async function upgradePip(pythonExecutable: string): Promise<void> {
    const spinner = ora('Upgrading pip...').start();

    try {
        execSync(
            `"${pythonExecutable}" -m pip install --upgrade pip`,
            {
                stdio: 'pipe',
                encoding: 'utf-8'
            }
        );
        spinner.succeed('pip upgraded successfully');
    } catch (error) {
        spinner.warn('Failed to upgrade pip (continuing anyway)');
    }
}

/**
 * Creates a README in the .ouroboros directory
 */
async function createReadme(ouroborosDir: string): Promise<void> {
    const readmePath = `${ouroborosDir}/README.md`;
    const content = `# 🐍 Ouroboros Sandbox Environment

This directory contains the isolated Python sandbox for Ouroboros.

## Structure

- \`venv/\` - Python virtual environment
- \`playground/\` - Safe area for code execution
- \`README.md\` - This file

## Security

The sandbox is designed to isolate agent-generated code from your system.
All code execution happens within the virtual environment and playground directory.

## DO NOT

- Do not manually modify the venv
- Do not store sensitive data in the playground
- Do not execute untrusted code outside this environment

---

Generated by Ouroboros Runtime
`;

    try {
        await fs.writeFile(readmePath, content, 'utf-8');
    } catch (error) {
        // Non-critical, ignore if fails
    }
}

// ============================================================================
// Main Setup Functions
// ============================================================================

/**
 * Sets up the complete .ouroboros sandbox environment
 */
export async function setupSandbox(
    config: SandboxSetupConfig = {}
): Promise<SandboxSetupResult> {
    const result: SandboxSetupResult = {
        success: false,
        environment: new OuroborosEnvironment(config),
        venvCreated: false,
        venvPath: '',
        playgroundPath: '',
        pythonExecutable: ''
    };

    // Get paths from environment
    const environment = result.environment;
    await environment.initialize();
    const paths = environment.paths;

    result.venvPath = paths.venvDir;
    result.playgroundPath = paths.playgroundDir;
    result.pythonExecutable = paths.pythonExecutable;

    console.log('\n');
    console.log(chalk.cyan('🐍 Setting up Ouroboros Sandbox Environment'));
    console.log('\n');

    // Step 1: Check Python availability
    const pythonSpinner = ora('Checking Python installation...').start();
    const pythonAvailable = checkPythonAvailable();

    if (!pythonAvailable) {
        pythonSpinner.fail('Python not found');
        result.error = 'Python is not installed or not in PATH';
        return result;
    }

    const pythonVersion = getPythonVersion();
    pythonSpinner.succeed(`Python ${pythonVersion || 'unknown'} found`);

    // Step 2: Check if venv already exists
    const venvCheckSpinner = ora('Checking for existing virtual environment...').start();
    const venvExists = await validateVenvDirectory(paths.venvDir);

    if (venvExists) {
        venvCheckSpinner.info('Virtual environment already exists');
        result.venvCreated = false;
        result.success = true;

        // Create README if it doesn't exist
        await createReadme(paths.ouroborosDir);

        console.log(chalk.green('\n✅ Sandbox environment ready'));
        return result;
    }

    venvCheckSpinner.info('Creating new virtual environment');

    // Step 3: Create virtual environment
    if (config.skipVenvCreation) {
        const skipSpinner = ora('Skipping venv creation...').start();
        skipSpinner.warn('Virtual environment not created (skipped)');
        result.error = 'Venv creation skipped but venv does not exist';
        return result;
    }

    const pythonCmd = getPythonCommand();
    const venvResult = await createVirtualEnvironment(paths.venvDir, pythonCmd);

    if (!venvResult.success) {
        result.error = venvResult.error;
        return result;
    }

    result.venvCreated = true;

    // Step 4: Upgrade pip
    await upgradePip(paths.pythonExecutable);

    // Step 5: Create README
    await createReadme(paths.ouroborosDir);

    // Step 6: Validate setup
    const validateSpinner = ora('Validating sandbox setup...').start();
    const isValid = await environment.validate();

    if (!isValid) {
        validateSpinner.fail('Sandbox validation failed');
        result.error = 'Sandbox setup validation failed';
        return result;
    }

    validateSpinner.succeed('Sandbox environment validated');
    result.success = true;

    console.log(chalk.green('\n✅ Sandbox environment setup complete!'));
    console.log(chalk.gray(`   Venv: ${paths.venvDir}`));
    console.log(chalk.gray(`   Playground: ${paths.playgroundDir}`));
    console.log('\n');

    return result;
}

/**
 * Validates an existing sandbox environment
 */
export async function validateSandbox(
    projectRoot?: string
): Promise<{ valid: boolean; environment: OuroborosEnvironment; error?: string }> {
    const environment = new OuroborosEnvironment({ projectRoot });
    const paths = environment.paths;

    try {
        // Check if .ouroboros directory exists
        await fs.access(paths.ouroborosDir);

        // Check if venv exists
        const venvValid = await validateVenvDirectory(paths.venvDir);
        if (!venvValid) {
            return {
                valid: false,
                environment,
                error: 'Virtual environment is missing or invalid'
            };
        }

        // Check if playground exists
        await fs.access(paths.playgroundDir);

        return { valid: true, environment };
    } catch (error) {
        return {
            valid: false,
            environment,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Cleans up the sandbox environment (use with caution!)
 */
export async function cleanupSandbox(
    projectRoot?: string
): Promise<{ success: boolean; error?: string }> {
    const spinner = ora('Cleaning up sandbox environment...').start();
    const environment = new OuroborosEnvironment({ projectRoot });
    const paths = environment.paths;

    try {
        await fs.rm(paths.ouroborosDir, { recursive: true, force: true });
        spinner.succeed('Sandbox environment cleaned up');
        return { success: true };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        spinner.fail(`Failed to cleanup: ${errorMsg}`);
        return { success: false, error: errorMsg };
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createSandboxSetup() {
    return {
        setup: setupSandbox,
        validate: validateSandbox,
        cleanup: cleanupSandbox,
        checkPythonAvailable,
        getPythonVersion
    };
}
