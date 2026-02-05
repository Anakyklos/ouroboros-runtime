/**
 * 🐍 Ouroboros Path Utilities
 * 
 * Provides cross-platform path resolution for the isolated Python environment.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const OUROBOROS_ROOT = ".ouroboros";
const VENV_DIR = "venv";
const WORKSPACE_DIR = "workspace";
const LOGS_DIR = "logs";

/**
 * Returns the absolute path to the Ouroboros root directory.
 */
export function getOuroborosRoot(projectRoot?: string): string {
    const root = projectRoot ?? process.cwd();
    return resolve(root, OUROBOROS_ROOT);
}

/**
 * Returns the absolute path to the Python executable inside the Ouroboros venv.
 * Detects OS automatically.
 */
export function getPythonPath(projectRoot?: string): string {
    const ouroborosRoot = getOuroborosRoot(projectRoot);
    const isWindows = process.platform === "win32";

    const pythonPath = isWindows
        ? join(ouroborosRoot, VENV_DIR, "Scripts", "python.exe")
        : join(ouroborosRoot, VENV_DIR, "bin", "python");

    return pythonPath;
}

/**
 * Returns the absolute path to the pip executable inside the Ouroboros venv.
 */
export function getPipPath(projectRoot?: string): string {
    const ouroborosRoot = getOuroborosRoot(projectRoot);
    const isWindows = process.platform === "win32";

    const pipPath = isWindows
        ? join(ouroborosRoot, VENV_DIR, "Scripts", "pip.exe")
        : join(ouroborosRoot, VENV_DIR, "bin", "pip");

    return pipPath;
}

/**
 * Returns the absolute path to the workspace directory (agent scratchpad).
 */
export function getWorkspacePath(projectRoot?: string): string {
    return join(getOuroborosRoot(projectRoot), WORKSPACE_DIR);
}

/**
 * Returns the absolute path to the logs directory.
 */
export function getLogsPath(projectRoot?: string): string {
    return join(getOuroborosRoot(projectRoot), LOGS_DIR);
}

/**
 * Checks if the Ouroboros environment is properly set up.
 */
export function isOuroborosReady(projectRoot?: string): boolean {
    const pythonPath = getPythonPath(projectRoot);
    const workspacePath = getWorkspacePath(projectRoot);

    return existsSync(pythonPath) && existsSync(workspacePath);
}

/**
 * Configuration object for Ouroboros environment.
 */
export interface OuroborosConfig {
    root: string;
    python: string;
    pip: string;
    workspace: string;
    logs: string;
    isReady: boolean;
}

/**
 * Returns the VALIDATED absolute path to the Python executable.
 * THROWS an error if the environment is not set up.
 * 
 * This is the main function providers should use to get the Python path.
 */
export function getOuroborosPythonPath(projectRoot?: string): string {
    const pythonPath = getPythonPath(projectRoot);

    if (!existsSync(pythonPath)) {
        throw new Error(
            `🐍 Ouroboros environment not found!\n` +
            `   Expected Python at: ${pythonPath}\n` +
            `   Run: bun run setup_ouroboros.ts`
        );
    }

    return pythonPath;
}

/**
 * Returns the VALIDATED absolute path to the pip executable.
 * THROWS an error if the environment is not set up.
 */
export function getOuroborosPipPath(projectRoot?: string): string {
    const pipPath = getPipPath(projectRoot);

    if (!existsSync(pipPath)) {
        throw new Error(
            `🐍 Ouroboros environment not found!\n` +
            `   Expected pip at: ${pipPath}\n` +
            `   Run: bun run setup_ouroboros.ts`
        );
    }

    return pipPath;
}

/**
 * Returns the absolute path to the opencode CLI executable.
 * NOTE: opencode is a Go binary installed via npm, NOT a Python package.
 */
export function getOpenCodePath(projectRoot?: string): string {
    const ouroborosRoot = getOuroborosRoot(projectRoot);
    const isWindows = process.platform === "win32";

    const openCodePath = isWindows
        ? join(ouroborosRoot, "npm", "node_modules", ".bin", "opencode.cmd")
        : join(ouroborosRoot, "npm", "node_modules", ".bin", "opencode");

    return openCodePath;
}

/**
 * Returns the VALIDATED absolute path to the opencode CLI executable.
 * THROWS an error if not found.
 */
export function getOuroborosOpenCodePath(projectRoot?: string): string {
    const openCodePath = getOpenCodePath(projectRoot);

    if (!existsSync(openCodePath)) {
        throw new Error(
            `🐍 Ouroboros opencode CLI not found!\n` +
            `   Expected at: ${openCodePath}\n` +
            `   Run: npm install opencode-ai --prefix .ouroboros/npm`
        );
    }

    return openCodePath;
}

/**
 * Returns environment variables for isolated Ouroboros execution.
 * Injects venv paths so spawned processes use the isolated Python.
 */
export function getOuroborosEnv(projectRoot?: string): NodeJS.ProcessEnv {
    const ouroborosRoot = getOuroborosRoot(projectRoot);
    const pythonBinDir = process.platform === "win32"
        ? join(ouroborosRoot, VENV_DIR, "Scripts")
        : join(ouroborosRoot, VENV_DIR, "bin");

    const delimiter = process.platform === "win32" ? ";" : ":";

    return {
        ...process.env,
        PATH: `${pythonBinDir}${delimiter}${process.env.PATH}`,
        VIRTUAL_ENV: join(ouroborosRoot, VENV_DIR),
    };
}

/**
 * Extended configuration including opencode CLI.
 */
export interface OuroborosConfig {
    root: string;
    python: string;
    pip: string;
    openCode: string;
    workspace: string;
    logs: string;
    isReady: boolean;
}

/**
 * Checks if the full Ouroboros environment is ready (including opencode).
 */
export function isFullOuroborosReady(projectRoot?: string): boolean {
    const pythonPath = getPythonPath(projectRoot);
    const openCodePath = getOpenCodePath(projectRoot);
    const workspacePath = getWorkspacePath(projectRoot);

    return existsSync(pythonPath) && existsSync(openCodePath) && existsSync(workspacePath);
}

/**
 * Returns full Ouroboros configuration.
 */
export function getOuroborosConfig(projectRoot?: string): OuroborosConfig {
    return {
        root: getOuroborosRoot(projectRoot),
        python: getPythonPath(projectRoot),
        pip: getPipPath(projectRoot),
        openCode: getOpenCodePath(projectRoot),
        workspace: getWorkspacePath(projectRoot),
        logs: getLogsPath(projectRoot),
        isReady: isFullOuroborosReady(projectRoot),
    };
}
