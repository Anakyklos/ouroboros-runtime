#!/usr/bin/env bun
/**
 * 🦅 Claude AG (Antigravity) Wrapper
 * 
 * Invokes Claude via OpenCode's Antigravity OAuth plugin.
 * This allows programmatic access to the same Claude quota
 * used by Antigravity IDE.
 * 
 * Usage:
 *   bun run claude:ag "Your prompt here"
 *   bun run claude:ag --file=prompt.txt
 *   bun run claude:ag --variant=low "Quick question"
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Configuration
const DEFAULT_MODEL = 'google/antigravity-claude-sonnet-4-5-thinking';
const DEFAULT_VARIANT = 'max';

interface ClaudeAGOptions {
    prompt: string;
    model?: string;
    variant?: string;
    json?: boolean;
    context?: string;
}

/**
 * Execute Claude via OpenCode
 */
async function executeClaudeAG(options: ClaudeAGOptions): Promise<string> {
    const { prompt, model = DEFAULT_MODEL, variant = DEFAULT_VARIANT, context } = options;

    // Build the full prompt with context if provided
    let fullPrompt = prompt;
    if (context) {
        fullPrompt = `Context:\n${context}\n\nTask:\n${prompt}`;
    }

    return new Promise((resolve, reject) => {
        const args = [
            'run',
            fullPrompt,
            `--model=${model}`,
            `--variant=${variant}`,
        ];

        console.log(`🦅 Claude AG: Executing with model ${model} (variant: ${variant})`);
        console.log(`   Prompt: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`);

        const proc = spawn('opencode', args, {
            cwd: PROJECT_ROOT,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                console.log(`   ✅ Claude AG responded successfully`);
                resolve(stdout.trim());
            } else {
                console.error(`   ❌ Claude AG failed (code ${code})`);
                console.error(`   stderr: ${stderr}`);
                reject(new Error(stderr || `Process exited with code ${code}`));
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * Parse command line arguments
 */
function parseArgs(): ClaudeAGOptions {
    const args = process.argv.slice(2);
    let prompt = '';
    let model = DEFAULT_MODEL;
    let variant = DEFAULT_VARIANT;
    let context: string | undefined;

    for (const arg of args) {
        if (arg.startsWith('--model=')) {
            model = arg.replace('--model=', '');
        } else if (arg.startsWith('--variant=')) {
            variant = arg.replace('--variant=', '');
        } else if (arg.startsWith('--file=')) {
            const filePath = arg.replace('--file=', '');
            if (existsSync(filePath)) {
                prompt = readFileSync(filePath, 'utf-8');
            } else {
                console.error(`File not found: ${filePath}`);
                process.exit(1);
            }
        } else if (arg.startsWith('--context=')) {
            const contextPath = arg.replace('--context=', '');
            if (existsSync(contextPath)) {
                context = readFileSync(contextPath, 'utf-8');
            }
        } else if (!arg.startsWith('--')) {
            prompt = arg;
        }
    }

    return { prompt, model, variant, context };
}

/**
 * Show usage
 */
function showUsage(): void {
    console.log(`
🦅 Claude AG (Antigravity) Wrapper

Usage:
  bun run claude:ag "Your prompt here"
  bun run claude:ag --file=prompt.txt
  bun run claude:ag --variant=low "Quick question"
  bun run claude:ag --model=google/antigravity-claude-opus-4-5-thinking "Complex task"

Models:
  google/antigravity-claude-sonnet-4-5-thinking  (default)
  google/antigravity-claude-opus-4-5-thinking
  google/antigravity-claude-sonnet-4-5

Variants:
  max   - Maximum thinking budget (32k tokens) - default
  low   - Low thinking budget (8k tokens)

Prerequisites:
  1. Run: opencode auth login
  2. Authenticate with your Google account (same as Antigravity Pro)
`);
}

// Main
const options = parseArgs();

if (!options.prompt) {
    showUsage();
    process.exit(1);
}

executeClaudeAG(options)
    .then((response) => {
        console.log('\n--- Response ---\n');
        console.log(response);
    })
    .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
    });
