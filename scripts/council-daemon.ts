#!/usr/bin/env bun
/**
 * 🐍 Ouroboros Auto-Invoke Daemon
 * 
 * Monitors COUNCIL_SIGNAL.json and automatically invokes agents when their turn comes.
 * 
 * Usage:
 *   bun run council:daemon
 */

import { watchFile, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SIGNAL_FILE = path.join(PROJECT_ROOT, 'COUNCIL_SIGNAL.json');
const CHAT_FILE = path.join(PROJECT_ROOT, 'AI_COUNCIL_CHAT.md');

interface CouncilSignal {
    mission?: string;
    turn: string;
    previousTurn?: string;
    status?: string;
    message?: string;
    autoInvoke?: boolean;
    last_update?: string;
}

const AGENT_EMOJIS: Record<string, string> = {
    wyvern: '🦅',
    amphisbaena: '🐍🐍',
    leviathan: '🌊',
    basilisk: '🐉',
};

let lastProcessedTurn = '';
let isProcessing = false;

function log(msg: string): void {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${msg}`);
}

function readSignal(): CouncilSignal | null {
    if (!existsSync(SIGNAL_FILE)) return null;
    try {
        return JSON.parse(readFileSync(SIGNAL_FILE, 'utf-8'));
    } catch {
        return null;
    }
}

/**
 * Build the prompt for the agent based on their role
 */
function buildPrompt(signal: CouncilSignal): string {
    const agentRole = signal.turn;
    const emoji = AGENT_EMOJIS[agentRole] || '🤖';

    return `${emoji} Você é ${agentRole.toUpperCase()} do AI Council Ouroboros.

LEIA o arquivo AI_COUNCIL_CHAT.md para entender o contexto.
SUA TASK: ${signal.message || 'Continuar o trabalho anterior'}

QUANDO TERMINAR, você DEVE:
1. Documentar seu trabalho no AI_COUNCIL_CHAT.md
2. Passar o turno usando: cd ouroboros-runtime && bun run council:turn <próximo_agente> "mensagem"

Execute a task agora.`;
}

/**
 * Invoke Amphisbaena (Gemini) via gemini CLI
 */
async function invokeAmphisbaena(prompt: string): Promise<void> {
    log('🐍🐍 Invocando Amphisbaena (Gemini)...');

    try {
        // Use gemini CLI with the prompt
        const proc = spawn('gemini', [prompt], {
            cwd: PROJECT_ROOT,
            stdio: 'inherit',
            shell: true,
        });

        proc.on('close', (code) => {
            log(`🐍🐍 Gemini terminou com código ${code}`);
            isProcessing = false;
        });

        proc.on('error', (err) => {
            log(`❌ Erro ao invocar Gemini: ${err.message}`);
            isProcessing = false;
        });
    } catch (error) {
        log(`❌ Falha ao invocar Amphisbaena: ${error}`);
        isProcessing = false;
    }
}

/**
 * Invoke Wyvern (Claude AG) via OpenCode
 */
async function invokeWyvern(prompt: string): Promise<void> {
    log('🦅 Invocando Wyvern (Claude AG)...');

    try {
        const { stdout, stderr } = await execAsync(
            `opencode run "${prompt.replace(/"/g, '\\"')}" --model=google/antigravity-claude-sonnet-4-5-thinking --variant=max`,
            { cwd: PROJECT_ROOT, timeout: 300000 }
        );

        log(`🦅 Wyvern respondeu`);
        console.log(stdout);

        // Append response to chat
        appendFileSync(CHAT_FILE, `\n\n## [WYVERN @ ${new Date().toLocaleTimeString().substring(0, 5)}] 🦅\n\n${stdout}\n`);

    } catch (error) {
        log(`❌ Falha ao invocar Wyvern: ${error}`);
    }

    isProcessing = false;
}

/**
 * Invoke Leviathan (GLM) via OpenCode
 */
async function invokeLeviathan(prompt: string): Promise<void> {
    log('🌊 Invocando Leviathan (GLM)...');

    try {
        // OpenCode with GLM model (if configured)
        const proc = spawn('opencode', [prompt], {
            cwd: PROJECT_ROOT,
            stdio: 'inherit',
        });

        proc.on('close', () => {
            log('🌊 Leviathan terminou');
            isProcessing = false;
        });

    } catch (error) {
        log(`❌ Falha ao invocar Leviathan: ${error}`);
        isProcessing = false;
    }
}

/**
 * Process turn change
 */
async function processSignal(): Promise<void> {
    if (isProcessing) {
        log('⏳ Ainda processando...');
        return;
    }

    const signal = readSignal();
    if (!signal) return;

    // Check if turn changed and autoInvoke is enabled
    const turnKey = `${signal.turn}:${signal.last_update}`;
    if (turnKey === lastProcessedTurn) return;

    if (!signal.autoInvoke) {
        log('⏸️ autoInvoke desabilitado, esperando...');
        return;
    }

    lastProcessedTurn = turnKey;
    isProcessing = true;

    const emoji = AGENT_EMOJIS[signal.turn] || '🤖';
    log(`🔄 Turno mudou para ${emoji} ${signal.turn.toUpperCase()}`);
    log(`   Task: ${signal.message}`);

    const prompt = buildPrompt(signal);

    // Invoke the appropriate agent
    switch (signal.turn) {
        case 'amphisbaena':
            await invokeAmphisbaena(prompt);
            break;
        case 'wyvern':
            await invokeWyvern(prompt);
            break;
        case 'leviathan':
            await invokeLeviathan(prompt);
            break;
        default:
            log(`❓ Agente desconhecido: ${signal.turn}`);
            isProcessing = false;
    }
}

// Main
console.log('\n╔════════════════════════════════════════════════════════╗');
console.log('║        🐍 OUROBOROS AUTO-INVOKE DAEMON 🐍               ║');
console.log('╠════════════════════════════════════════════════════════╣');
console.log('║ Monitoring: COUNCIL_SIGNAL.json                        ║');
console.log('║ Agents invoke AUTOMATICALLY on turn change             ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

log('👀 Iniciando monitoramento...');

// Initial check
processSignal();

// Watch for changes
if (existsSync(SIGNAL_FILE)) {
    watchFile(SIGNAL_FILE, { interval: 2000 }, processSignal);
}

// Fallback polling
setInterval(processSignal, 3000);
