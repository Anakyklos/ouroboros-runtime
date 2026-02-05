#!/usr/bin/env node
/**
 * 🐍 Ouroboros Daemon Entry Point
 * 
 * Inicia o daemon server e configura logging.
 * Usage: bun run cli/src/daemon/main.ts
 */

import { DaemonServer, globalEventBus } from './index.js';
import { SqliteAdapter } from '../adapters/sqlite.adapter.js';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

const DB_PATH = '.ouroboros/daemon.db';
const PORT = Number(process.env.OUROBOROS_PORT) || 7777;

async function main() {
    // Setup console logging from EventBus
    globalEventBus.on('log', (event) => {
        const prefix = `[${event.source ?? 'Ouroboros'}]`;
        switch (event.level) {
            case 'debug':
                console.debug(prefix, event.message);
                break;
            case 'info':
                console.log(prefix, event.message);
                break;
            case 'warn':
                console.warn(prefix, event.message);
                break;
            case 'error':
                console.error(prefix, event.message);
                break;
        }
    });

    globalEventBus.on('daemon', (event) => {
        if (event.type === 'ready') {
            console.log(`\n🐍 Ouroboros Daemon ready on http://127.0.0.1:${event.port}`);
            console.log('   Press Ctrl+C to stop\n');
        }
    });

    // Ensure database directory exists
    await mkdir(dirname(DB_PATH), { recursive: true });

    // Initialize storage
    const storage = new SqliteAdapter(DB_PATH);
    await storage.initialize();

    // Create and start server
    const server = new DaemonServer(storage, { port: PORT });

    // Handle graceful shutdown
    const shutdown = async () => {
        console.log('\n🛑 Shutting down...');
        await server.stop();
        await storage.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Start!
    await server.start();
}

main().catch((err) => {
    console.error('❌ Failed to start daemon:', err);
    process.exit(1);
});
