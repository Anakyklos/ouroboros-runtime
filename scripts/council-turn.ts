#!/usr/bin/env bun
/**
 * 🔄 Council Turn Setter
 * 
 * CLI helper to set the current turn in COUNCIL_SIGNAL.json
 * 
 * Usage: 
 *   bun run council:turn amphisbaena "Code review do Workflow Engine"
 *   bun run council:turn wyvern
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SIGNAL_FILE = path.join(PROJECT_ROOT, 'COUNCIL_SIGNAL.json');

const AGENTS = ['wyvern', 'amphisbaena', 'leviathan', 'basilisk'];

const AGENT_EMOJIS: Record<string, string> = {
    wyvern: '🦅',
    amphisbaena: '🐍🐍',
    leviathan: '🌊',
    basilisk: '🐉',
};

interface CouncilSignal {
    mission?: string;
    turn: string;
    previousTurn?: string;
    status?: string;
    message?: string;
    autoInvoke?: boolean;
    last_update?: string;
    context?: Record<string, unknown>;
}

function readSignal(): CouncilSignal {
    if (!existsSync(SIGNAL_FILE)) {
        return { turn: '', status: 'idle' };
    }
    return JSON.parse(readFileSync(SIGNAL_FILE, 'utf-8'));
}

async function setTurn(agent: string, message: string): Promise<void> {
    const signal = readSignal();

    const newSignal: CouncilSignal = {
        ...signal,
        previousTurn: signal.turn,
        turn: agent,
        message,
        last_update: new Date().toISOString(),
        autoInvoke: true,
    };

    writeFileSync(SIGNAL_FILE, JSON.stringify(newSignal, null, 2));

    const emoji = AGENT_EMOJIS[agent] || '🤖';
    console.log(`\n✅ Turno passado para ${emoji} ${agent.toUpperCase()}`);
    console.log(`   Mensagem: ${message}`);
    console.log(`   Arquivo: ${SIGNAL_FILE}`);

    // Send notification
    try {
        await execAsync(`notify-send "${emoji} Council Handoff" "Turno de ${agent}: ${message}" -i dialog-information`);
    } catch {
        // Ignore notification errors
    }
}

function showUsage(): void {
    console.log(`
🔄 Council Turn Setter

Usage:
  bun run council:turn <agent> [message]

Agents:
  wyvern      🦅 Claude (IDE)
  amphisbaena 🐍🐍 Gemini (CLI)
  leviathan   🌊 GLM (OpenCode)
  basilisk    🐉 Jules

Examples:
  bun run council:turn amphisbaena "Code review do Workflow Engine"
  bun run council:turn wyvern "Implementar testes"
  bun run council:turn leviathan
`);
}

// Main
const [agent, ...messageParts] = process.argv.slice(2);

if (!agent || !AGENTS.includes(agent)) {
    if (agent && !AGENTS.includes(agent)) {
        console.error(`❌ Agente desconhecido: ${agent}`);
    }
    showUsage();
    process.exit(1);
}

const message = messageParts.join(' ') || 'Sua vez no Council!';
setTurn(agent, message);
