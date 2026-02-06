/**
 * 🐍 Ouroboros Environment Bootstrap Script
 * 
 * Execute with: bun run setup_ouroboros.ts
 * Or: npx tsx setup_ouroboros.ts
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUROBOROS_ROOT = ".ouroboros";
const VENV_DIR = join(OUROBOROS_ROOT, "venv");
const WORKSPACE_DIR = join(OUROBOROS_ROOT, "workspace");
const LOGS_DIR = join(OUROBOROS_ROOT, "logs");

function log(emoji: string, message: string): void {
    console.log(`${emoji} ${message}`);
}

function createDirectory(path: string, name: string): void {
    if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
        log("📁", `Created ${name}: ${path}`);
    } else {
        log("✓", `${name} already exists: ${path}`);
    }
}

function checkPythonVersion(): string {
    try {
        const version = execSync("python --version", { encoding: "utf-8" }).trim();
        const match = version.match(/Python (\d+)\.(\d+)/);

        if (match) {
            const major = parseInt(match[1]);
            const minor = parseInt(match[2]);

            if (major < 3 || (major === 3 && minor < 10)) {
                throw new Error(`Python 3.10+ required. Found: ${version}`);
            }
        }

        log("🐍", `Found ${version}`);
        return "python";
    } catch (error) {
        // Try python3 command
        try {
            const version = execSync("python3 --version", { encoding: "utf-8" }).trim();
            log("🐍", `Found ${version}`);
            return "python3";
        } catch {
            throw new Error("Python 3.10+ not found. Please install Python first.");
        }
    }
}

function createVirtualEnvironment(pythonCmd: string): void {
    if (existsSync(VENV_DIR)) {
        log("✓", `Virtual environment already exists: ${VENV_DIR}`);
        return;
    }

    log("⏳", "Creating virtual environment...");
    execSync(`${pythonCmd} -m venv ${VENV_DIR}`, { stdio: "inherit" });
    log("✅", `Virtual environment created: ${VENV_DIR}`);
}

function getPipPath(): string {
    const isWindows = process.platform === "win32";
    return isWindows
        ? join(VENV_DIR, "Scripts", "pip.exe")
        : join(VENV_DIR, "bin", "pip");
}

function installBaseDependencies(): void {
    const pipPath = getPipPath();

    log("📦", "Upgrading pip...");
    execSync(`"${pipPath}" install --upgrade pip`, { stdio: "inherit" });

    // Base dependencies for the agent
    const baseDeps = ["requests", "gemini-chat-cli"];

    log("📦", `Installing base dependencies: ${baseDeps.join(", ")}`);
    execSync(`"${pipPath}" install ${baseDeps.join(" ")}`, { stdio: "inherit" });
}

async function main(): Promise<void> {
    console.log("\n" + "=".repeat(50));
    console.log("🐍 OUROBOROS ENVIRONMENT BOOTSTRAP");
    console.log("=".repeat(50) + "\n");

    try {
        // Step 1: Check Python
        const pythonCmd = checkPythonVersion();

        // Step 2: Create directories
        createDirectory(OUROBOROS_ROOT, "Ouroboros root");
        createDirectory(WORKSPACE_DIR, "Workspace (agent scratchpad)");
        createDirectory(LOGS_DIR, "Logs directory");

        // Step 3: Create venv
        createVirtualEnvironment(pythonCmd);

        // Step 4: Install base dependencies
        installBaseDependencies();

        // Success!
        console.log("\n" + "=".repeat(50));
        log("🎉", "OUROBOROS ENVIRONMENT READY!");
        console.log("=".repeat(50));

        const isWindows = process.platform === "win32";
        const pythonPath = isWindows
            ? `.ouroboros\\venv\\Scripts\\python.exe`
            : `.ouroboros/venv/bin/python`;

        console.log(`\n📍 Python executable: ${pythonPath}`);
        console.log(`📁 Workspace: ${WORKSPACE_DIR}`);
        console.log(`📋 Logs: ${LOGS_DIR}\n`);

    } catch (error) {
        console.error("\n❌ Setup failed:", error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

main();
