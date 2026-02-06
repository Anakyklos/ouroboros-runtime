/**
 * 🧪 Session Orchestration Integration Test
 * 
 * Testa integração entre Daemon, SessionManager e Orchestrator.
 * Usage: bun run cli/src/daemon/test-session-orchestration.ts
 */

import { DaemonServer } from './server.js';
import { SqliteAdapter } from '../adapters/sqlite.adapter.js';
import { globalEventBus } from './event-bus.js';
import { Orchestrator } from '../orchestration/Orchestrator.js';
import { TaskStatus } from '../orchestration/types.js';
import { mkdir, rm } from 'fs/promises';
import { dirname } from 'path';

// --- MOCK ORCHESTRATOR ---
// Monkey patch loopUntilSuccess to simulate execution without calling LLM
const originalLoop = Orchestrator.prototype.loopUntilSuccess;
let taskExecuted = false;

Orchestrator.prototype.loopUntilSuccess = async function (task) {
    console.log(`\n🤖 [MOCK] Orchestrator executing task: ${task.id}`);
    console.log(`   Instruction: ${task.instruction}`);

    // Simulate thinking time
    await new Promise(resolve => setTimeout(resolve, 500));

    taskExecuted = true;

    return {
        status: TaskStatus.SUCCESS,
        output: 'Simulated task output',
        retryCount: 0,
        persona: task.persona,
        durationMs: 500,
        contextHistory: []
    };
};

// --- TEST SETUP ---
const DB_PATH = '.ouroboros/test-daemon.db';
const PORT = 7778; // Different port to avoid conflict
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function rpc(method: string, params: Record<string, unknown> = {}) {
    const response = await fetch(`${BASE_URL}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method,
            params,
        }),
    });
    return response.json();
}

async function main() {
    console.log('🧪 Starting Integration Test: Session Orchestration');

    // 1. Initialize
    await mkdir(dirname(DB_PATH), { recursive: true });

    const storage = new SqliteAdapter(DB_PATH);
    await storage.initialize();

    // Pass fake API key to satisfy initialization requirement
    const server = new DaemonServer(storage, {
        port: PORT,
        apiKey: "test-api-key"
    });

    try {
        await server.start();
        console.log('✅ Daemon started');

        // 2. Create Session
        console.log('\nCreating session...');
        const createRes: any = await rpc('session.create', { context: 'Integration Test' });
        const sessionId = createRes.result.sessionId;

        if (!sessionId) throw new Error('Failed to create session');
        console.log(`✅ Session created: ${sessionId}`);

        // 3. Send Input (Triggers Orchestrator)
        console.log('\nSending input (should trigger Orchestrator)...');
        taskExecuted = false;

        const inputRes: any = await rpc('agent.input', {
            sessionId,
            prompt: 'Calculate 2 + 2'
        });

        console.log(`✅ Input sent. Task ID: ${inputRes.result.taskId}`);

        // 4. Verify Execution
        console.log('Waiting for execution...');
        // Wait enough time for the mock to run
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (taskExecuted) {
            console.log('✅ Task execution verified (Mock called)');
        } else {
            throw new Error('❌ Task was NOT executed');
        }

        // Verify session logs updated
        const sessionRes: any = await rpc('session.get', { id: sessionId });
        const session = sessionRes.result.session;
        console.log(`✅ Session status: ${session.status}`);

        // 5. Interrupt Session
        console.log('\nInterrupting session...');
        await rpc('agent.interrupt', { sessionId });
        console.log('✅ Interrupt signal sent');

        const pausedSession: any = await rpc('session.get', { id: sessionId });
        console.log(`✅ Session status after interrupt: ${pausedSession.result.session.status}`);

        // 6. Resume Session
        console.log('\nResuming session...');
        await rpc('agent.resume', { sessionId });
        console.log('✅ Resume signal sent');

        const resumedSession: any = await rpc('session.get', { id: sessionId });
        console.log(`✅ Session status after resume: ${resumedSession.result.session.status}`);

    } catch (err) {
        console.error('\n❌ TEST FAILED:', err);
        process.exit(1);
    } finally {
        // 7. Shutdown
        console.log('\nShutting down...');
        await server.stop();
        await storage.close();

        // Cleanup DB
        await rm(DB_PATH, { force: true });

        console.log('✅ Test complete');
    }
}

main();