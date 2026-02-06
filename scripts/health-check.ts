#!/usr/bin/env bun
/**
 * 🐍 Ouroboros Health Check
 *
 * Verifies all dependencies and configurations are ready.
 * Exit code 0 = ready, 1 = problems found
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadEnv, isHeadlessMode } from '../cli/src/utils/env-loader.js';
import { getOuroborosConfig } from '../cli/src/utils/ouroboros.js';

interface CheckResult {
    name: string;
    status: 'ok' | 'warn' | 'error';
    message: string;
}

const results: CheckResult[] = [];

function check(name: string, condition: boolean, okMsg: string, errorMsg: string): void {
    results.push({
        name,
        status: condition ? 'ok' : 'error',
        message: condition ? okMsg : errorMsg,
    });
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

    // 1. Check .env
    loadEnv();
    check(
        '.env file',
        existsSync('.env'),
        'Found .env file',
        'Missing .env file (create from .env.example)'
    );

    // 2. Check environment variables
    check(
        'GROQ_API_KEY',
        !!process.env.GROQ_API_KEY,
        'GROQ_API_KEY is set',
        'GROQ_API_KEY is missing'
    );

    check(
        'GOOGLE_API_KEY',
        !!process.env.GOOGLE_API_KEY,
        'GOOGLE_API_KEY is set',
        'GOOGLE_API_KEY is missing'
    );

    // 3. Check Ouroboros environment
    const config = getOuroborosConfig();
    check(
        'Ouroboros workspace',
        config.isReady,
        `Workspace ready at ${config.workspace}`,
        'Workspace not found. Run: bun run setup'
    );

    check(
        'Python venv',
        existsSync(config.python),
        `Python found at ${config.python}`,
        'Python venv not found. Run: bun run setup'
    );

    // 4. Check Gemini CLI
    const geminiAvailable = await checkCommand('gemini', ['--version']);
    check(
        'Gemini CLI',
        geminiAvailable,
        'Gemini CLI is available',
        'Gemini CLI not found. Install: npm install -g @anthropic-ai/gemini-cli'
    );

    // 5. Check Bun
    const bunAvailable = await checkCommand('bun', ['--version']);
    check(
        'Bun runtime',
        bunAvailable,
        'Bun is available',
        'Bun not found'
    );

    // Print results
    console.log('\n📊 Results:\n');

    let hasErrors = false;
    for (const r of results) {
        const icon = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌';
        console.log(`${icon} ${r.name}: ${r.message}`);
        if (r.status === 'error') hasErrors = true;
    }

    console.log('\n' + '='.repeat(50));

    if (hasErrors) {
        console.log('❌ Some checks failed. Please fix the issues above.');
        process.exit(1);
    } else {
        console.log('✅ All checks passed! Ouroboros is ready.');
        process.exit(0);
    }
}

main().catch(console.error);
