/**
 * 🔄 Council Auto-Handoff
 * 
 * Monitora COUNCIL_SIGNAL.json e dispara triggers quando o turno muda.
 * Objetivo: Eliminar Pedro como "carteiro" entre as IAs.
 * 
 * Usage: bun run council:watch
 */

import { watch, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);

// Paths
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SIGNAL_FILE = path.join(PROJECT_ROOT, 'COUNCIL_SIGNAL.json');
const CHAT_FILE = path.join(PROJECT_ROOT, 'AI_COUNCIL_CHAT.md');

// Agent display names
const AGENT_NAMES: Record<string, string> = {
    wyvern: '🦅 Wyvern (Claude)',
    amphisbaena: '🐍🐍 Amphisbaena (Gemini)',
    leviathan: '🌊 Leviathan (GLM)',
    basilisk: '🐉 Basilisk (Jules)',
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

let lastKnownTurn: string | null = null;

/**
 * Read current signal state
 */
function readSignal(): CouncilSignal | null {
    try {
        if (!existsSync(SIGNAL_FILE)) {
            console.log('⚠️  COUNCIL_SIGNAL.json not found');
            return null;
        }
        const content = readFileSync(SIGNAL_FILE, 'utf-8');
        return JSON.parse(content) as CouncilSignal;
    } catch (error) {
        console.error('❌ Error reading signal:', error);
        return null;
    }
}

/**
 * Send desktop notification
 */
async function notify(title: string, message: string): Promise<void> {
    try {
        await execAsync(`notify-send "${title}" "${message}" -i dialog-information -u normal`);
    } catch (error) {
        console.error('❌ notify-send failed:', error);
    }
}

/**
 * Trigger for Wyvern (Claude) - tries xdotool
 */
async function triggerWyvern(message: string): Promise<void> {
    console.log('🦅 Triggering Wyvern (Claude)...');

    // Notify first
    await notify('🦅 Wyvern', `Sua vez no Council! ${message}`);

    // Try to find Antigravity window and type
    try {
        // Search for Antigravity window
        const { stdout } = await execAsync('xdotool search --name "Antigravity" 2>/dev/null || xdotool search --name "Code" 2>/dev/null || echo ""');
        const windowId = stdout.trim().split('\n')[0];

        if (windowId) {
            console.log(`   Found window: ${windowId}`);
            // Focus and type
            await execAsync(`xdotool windowactivate ${windowId}`);
            await new Promise(r => setTimeout(r, 500));
            await execAsync(`xdotool type --delay 50 "Ler AI_COUNCIL_CHAT.md - é sua vez!"`);
            console.log('   ✅ Typed message in window');
        } else {
            console.log('   ⚠️  Antigravity window not found, notification only');
        }
    } catch (error) {
        console.log('   ⚠️  xdotool failed, notification only');
    }
}

/**
 * Trigger for Amphisbaena (Gemini) - notify + try terminal
 */
async function triggerAmphisbaena(message: string): Promise<void> {
    console.log('🐍🐍 Triggering Amphisbaena (Gemini)...');

    await notify('🐍🐍 Amphisbaena', `Sua vez no Council! ${message}`);

    // Try to find gemini terminal via tmux
    try {
        const { stdout } = await execAsync('tmux list-panes -a -F "#{pane_id}:#{pane_current_command}" 2>/dev/null || echo ""');
        if (stdout.includes('gemini')) {
            console.log('   Found gemini in tmux, sending keys...');
            // This would need the specific pane ID
        }
    } catch {
        console.log('   Usando apenas notificação');
    }
}

/**
 * Trigger for Leviathan (GLM/OpenCode)
 */
async function triggerLeviathan(message: string): Promise<void> {
    console.log('🌊 Triggering Leviathan (GLM)...');
    await notify('🌊 Leviathan', `Sua vez no Council! ${message}`);
}

/**
 * Trigger for Basilisk (Jules)
 */
async function triggerBasilisk(message: string): Promise<void> {
    console.log('🐉 Triggering Basilisk (Jules)...');
    await notify('🐉 Basilisk', `Sua vez no Council! ${message}`);
}

/**
 * Handle turn change
 */
async function handleTurnChange(signal: CouncilSignal): Promise<void> {
    const { turn, message = 'Sua vez!' } = signal;

    console.log(`\n🔄 Turn changed to: ${AGENT_NAMES[turn] || turn}`);
    console.log(`   Message: ${message}`);

    switch (turn) {
        case 'wyvern':
            await triggerWyvern(message);
            break;
        case 'amphisbaena':
            await triggerAmphisbaena(message);
            break;
        case 'leviathan':
            await triggerLeviathan(message);
            break;
        case 'basilisk':
            await triggerBasilisk(message);
            break;
        default:
            console.log(`   ⚠️  Unknown agent: ${turn}`);
            await notify('🤖 Council', `Turno de ${turn}: ${message}`);
    }
}

/**
 * Check for turn changes
 */
function checkForChanges(): void {
    const signal = readSignal();
    if (!signal) return;

    if (lastKnownTurn === null) {
        // First run, just record the state
        lastKnownTurn = signal.turn;
        console.log(`📍 Initial state: turn = ${AGENT_NAMES[signal.turn] || signal.turn}`);
        return;
    }

    if (signal.turn !== lastKnownTurn) {
        handleTurnChange(signal);
        lastKnownTurn = signal.turn;
    }
}

/**
 * Helper: Set turn (for other scripts to use)
 */
export function setTurn(agent: string, message: string = 'Sua vez!'): void {
    const signal = readSignal() || { turn: '', status: 'idle' };

    const newSignal: CouncilSignal = {
        ...signal,
        previousTurn: signal.turn,
        turn: agent,
        message,
        last_update: new Date().toISOString(),
        autoInvoke: true,
    };

    writeFileSync(SIGNAL_FILE, JSON.stringify(newSignal, null, 2));
    console.log(`✅ Turn set to ${agent}`);
}

/**
 * Main: Start watching
 */
function main(): void {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║        🐉 COUNCIL AUTO-HANDOFF WATCHER 🐉              ║');
    console.log('╠════════════════════════════════════════════════════════╣');
    console.log(`║ Monitoring: ${SIGNAL_FILE.slice(-40).padStart(42)} ║`);
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log('');

    // Initial check
    checkForChanges();

    // Watch for file changes
    watch(SIGNAL_FILE, (eventType) => {
        if (eventType === 'change') {
            checkForChanges();
        }
    });

    console.log('👀 Watching for turn changes... (Ctrl+C to stop)');
    console.log('');
}

// Run if executed directly
if (import.meta.main) {
    main();
}
