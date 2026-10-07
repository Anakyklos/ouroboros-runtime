#!/usr/bin/env bun
/**
 * 🐍 Ouroboros Health Check
 *
 * Verifies all dependencies and configurations are ready.
 * Exit code 0 = ready, 1 = problems found
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadEnv } from '../cli/src/utils/env-loader.js';
import { getOuroborosConfig } from '../cli/src/utils/ouroboros.js';

export interface CheckResult {
    name: string;
    status: 'ok' | 'warn' | 'error';
    message: string;
}

function check(
    name: string,
    condition: boolean,
    okMsg: string,
    missingMsg: string,
    required = true,
): CheckResult {
    const result: CheckResult = {
        name,
        status: condition ? 'ok' : required ? 'error' : 'warn',
        message: condition ? okMsg : missingMsg,
    };
    return result;
}

/**
 * Build health results from observed prerequisites. Provider and legacy tooling
 * are informational; only the runtime needed to launch the daemon/admin CLI is
 * required for this health check.
 */
export function buildHealthResults(input: {
    envFile: boolean;
    groqApiKey: boolean;
    googleApiKey: boolean;
    workspace: string;
    workspaceReady: boolean;
    python: string;
    pythonVenv: boolean;
    geminiCli: boolean;
    bunRuntime: boolean;
}): CheckResult[] {
    return [
        check('.env file', input.envFile, 'Found .env file', 'Optional: .env file is not configured', false),
        check('GROQ_API_KEY', input.groqApiKey, 'GROQ_API_KEY is set', 'Optional: GROQ_API_KEY is not set', false),
        check('GOOGLE_API_KEY', input.googleApiKey, 'GOOGLE_API_KEY is set', 'Optional: GOOGLE_API_KEY is not set', false),
        check(
            'Ouroboros workspace',
            input.workspaceReady,
            `Workspace ready at ${input.workspace}`,
            'Optional legacy workspace is missing; it is not required by the daemon/admin CLI',
            false,
        ),
        check(
            'Python venv',
            input.pythonVenv,
            `Python found at ${input.python}`,
            'Optional legacy Python venv is missing; it is not required by the daemon/admin CLI',
            false,
        ),
        check(
            'Gemini CLI',
            input.geminiCli,
            'Gemini CLI is available',
            'Optional provider tooling: Gemini CLI is not installed',
            false,
        ),
        check('Bun runtime', input.bunRuntime, 'Bun is available', 'Bun not found'),
    ];
}

function report(results: CheckResult[]): void {
    console.log('\n📊 Results:\n');

    const hasErrors = results.some((result) => result.status === 'error');
    for (const r of results) {
        const icon = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌';
        console.log(`${icon} ${r.name}: ${r.message}`);
    }

    console.log('\n' + '='.repeat(50));

    if (hasErrors) {
        console.log('❌ Required runtime checks failed. Please fix the issues above.');
        process.exit(1);
    }

    console.log('✅ Required runtime checks passed. Optional tooling may be unavailable.');
    process.exit(0);
}

async function checkCommand(command: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawn(command, args, { shell: true, timeout: 5000 });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}

async function main() {
    console.log('🐍 Ouroboros Health Check\n');
    console.log('='.repeat(50));

    loadEnv();
    const config = getOuroborosConfig();
    const [geminiCli, bunRuntime] = await Promise.all([
        checkCommand('gemini', ['--version']),
        checkCommand('bun', ['--version']),
    ]);

    report(buildHealthResults({
        envFile: existsSync('.env'),
        groqApiKey: !!process.env.GROQ_API_KEY,
        googleApiKey: !!process.env.GOOGLE_API_KEY,
        workspace: config.workspace,
        workspaceReady: config.isReady,
        python: config.python,
        pythonVenv: existsSync(config.python),
        geminiCli,
        bunRuntime,
    }));
}

if (import.meta.main) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
