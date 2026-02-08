#!/usr/bin/env bun
/**
 * 🐍 Ouroboros CLI Monitor
 * 
 * Real-time monitoring of the AI Council activity
 * 
 * Usage:
 *   bun run ouroboros        - Show current status
 *   bun run ouroboros watch  - Watch mode (updates every 2s)
 */

import { readFileSync, existsSync, watchFile } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SIGNAL_FILE = path.join(PROJECT_ROOT, 'COUNCIL_SIGNAL.json');
const CHAT_FILE = path.join(PROJECT_ROOT, 'AI_COUNCIL_CHAT.md');

const AGENT_EMOJIS: Record<string, string> = {
    wyvern: '🦅',
    amphisbaena: '🐍🐍',
    leviathan: '🌊',
    basilisk: '🐉',
};

const AGENT_NAMES: Record<string, string> = {
    wyvern: 'Wyvern (Claude AG)',
    amphisbaena: 'Amphisbaena (Gemini)',
    leviathan: 'Leviathan (GLM)',
    basilisk: 'Basilisk (Jules)',
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

/**
 * Clear terminal
 */
function clearScreen(): void {
    process.stdout.write('\x1b[2J\x1b[H');
}

/**
 * Read council signal
 */
function readSignal(): CouncilSignal | null {
    if (!existsSync(SIGNAL_FILE)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(SIGNAL_FILE, 'utf-8'));
    } catch {
        return null;
    }
}

/**
 * Check if watcher is running
 */
async function isWatcherRunning(): Promise<boolean> {
    try {
        const { stdout } = await execAsync('ps aux | grep "council-handoff" | grep -v grep');
        return stdout.trim().length > 0;
    } catch {
        return false;
    }
}

/**
 * Get last Council messages
 */
function getLastMessages(count: number = 3): string[] {
    if (!existsSync(CHAT_FILE)) {
        return ['No chat history'];
    }

    const content = readFileSync(CHAT_FILE, 'utf-8');
    const lines = content.split('\n');
    const messages: string[] = [];

    // Find messages with pattern ## [AGENT @ TIME]
    for (let i = lines.length - 1; i >= 0 && messages.length < count; i--) {
        const line = lines[i];
        if (line.match(/^##\s+\[(\w+)\s+@\s+([\d:]+)\]/i)) {
            messages.unshift(line.replace(/^##\s+/, ''));
        }
    }

    return messages.length > 0 ? messages : ['No recent messages'];
}

/**
 * Format uptime
 */
function formatUptime(lastUpdate?: string): string {
    if (!lastUpdate) return 'Unknown';

    const now = new Date();
    const then = new Date(lastUpdate);
    const diff = now.getTime() - then.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s ago`;
    return `${seconds}s ago`;
}

/**
 * Display status
 */
async function displayStatus(): Promise<void> {
    const signal = readSignal();
    const watcherRunning = await isWatcherRunning();
    const lastMessages = getLastMessages(3);

    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║           🐍 OUROBOROS COUNCIL MONITOR 🐍             ║');
    console.log('╚═══════════════════════════════════════════════════════╝\n');

    // System Status
    console.log('📊 SYSTEM STATUS');
    console.log('─'.repeat(55));
    console.log(`Watcher:     ${watcherRunning ? '🟢 RUNNING' : '🔴 STOPPED'}`);
    console.log(`Signal File: ${signal ? '✅ OK' : '❌ NOT FOUND'}`);
    console.log(`Last Update: ${formatUptime(signal?.last_update)}`);
    console.log();

    if (!signal) {
        console.log('❌ No council signal found. Initialize with:');
        console.log('   bun run council:turn <agent> "message"');
        return;
    }

    // Current Turn
    console.log('🎯 CURRENT TURN');
    console.log('─'.repeat(55));
    const emoji = AGENT_EMOJIS[signal.turn] || '🤖';
    const name = AGENT_NAMES[signal.turn] || signal.turn;
    console.log(`Agent:   ${emoji} ${name}`);
    console.log(`Task:    ${signal.message || 'No message'}`);
    console.log(`Status:  ${signal.status || 'unknown'}`);
    if (signal.previousTurn && signal.previousTurn !== signal.turn) {
        const prevEmoji = AGENT_EMOJIS[signal.previousTurn] || '🤖';
        console.log(`From:    ${prevEmoji} ${signal.previousTurn}`);
    }
    console.log();

    // Mission Info
    if (signal.mission) {
        console.log('🎯 MISSION');
        console.log('─'.repeat(55));
        console.log(`ID: ${signal.mission}`);
        console.log();
    }

    // Recent Activity
    console.log('💬 RECENT ACTIVITY');
    console.log('─'.repeat(55));
    lastMessages.forEach((msg, i) => {
        console.log(`${i + 1}. ${msg}`);
    });
    console.log();

    // Quick Commands
    console.log('⚡ QUICK COMMANDS');
    console.log('─'.repeat(55));
    console.log('bun run council:turn <agent> "msg"  - Pass turn');
    console.log('bun run council:watch               - Start watcher');
    console.log('tail -f AI_COUNCIL_CHAT.md          - Follow chat');
    console.log();
}

/**
 * Watch mode
 */
async function watchMode(): Promise<void> {
    console.log('👀 Watch mode enabled (Ctrl+C to exit)\n');

    let lastSignal: string | null = null;

    const update = async () => {
        const currentSignal = readSignal();
        const signalStr = JSON.stringify(currentSignal);

        if (signalStr !== lastSignal) {
            clearScreen();
            await displayStatus();
            lastSignal = signalStr;
        }
    };

    // Initial display
    await update();

    // Watch file changes
    if (existsSync(SIGNAL_FILE)) {
        watchFile(SIGNAL_FILE, { interval: 2000 }, update);
    }

    // Fallback: poll every 2 seconds
    setInterval(update, 2000);
}

// Main
const mode = process.argv[2];

if (mode === 'watch' || mode === 'w') {
    watchMode();
} else if (mode === 'help' || mode === '--help' || mode === '-h') {
    console.log(`
🐍 Ouroboros CLI Monitor

Usage:
  bun run ouroboros        Show current status
  bun run ouroboros watch  Watch mode (auto-refresh)
  bun run ouroboros help   Show this help

Examples:
  bun run ouroboros
  bun run ouroboros w
`);
} else {
    displayStatus();
}
