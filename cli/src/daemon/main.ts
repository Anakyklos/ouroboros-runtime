#!/usr/bin/env node
/**
 * Headless daemon composition root and lifecycle owner.
 * Usage: bun run cli/src/daemon/main.ts
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DaemonServer, globalEventBus } from './index.js';
import { SqliteAdapter } from '../adapters/sqlite.adapter.js';
import { SqliteMissionStore } from '../mission/sqlite-mission-store.js';
import { MissionEngine } from '../mission/mission-engine.js';
import { PlanPolicyValidator } from '../mission/policy.js';
import { CapabilityRegistry } from '../capabilities/registry.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { MissionStore } from '../mission/ports.js';
import {
    DaemonShutdownCoordinator,
    type DaemonShutdownReason,
    type ShutdownDiagnostic,
} from './shutdown-coordinator.js';

const DATA_DIR = '.ouroboros';
const PORT = Number(process.env.OUROBOROS_PORT) || 7777;

interface InitializableStorage extends StoragePort {
    initialize(): Promise<void>;
    close(): Promise<void>;
}

interface InitializableMissionStore extends MissionStore {
    initialize(): Promise<void>;
    close(): Promise<void>;
}

interface HeadlessServer {
    start(): Promise<void>;
    stop(): Promise<void>;
}

export interface HeadlessDaemonDependencies {
    dataDir?: string;
    port?: number;
    createStorage?: (path: string) => InitializableStorage;
    createMissionStore?: (path: string) => InitializableMissionStore;
    createServer?: (
        storage: StoragePort,
        missionStore: MissionStore,
        missionEngine: MissionEngine,
        requestShutdown: () => void,
    ) => HeadlessServer;
    onDiagnostic?: (diagnostic: ShutdownDiagnostic) => void;
    forceTerminate?: () => void;
    setExitCode?: (code: number) => void;
}

/** Compose and start the current headless daemon with one lifecycle owner. */
export async function startHeadlessDaemon(
    dependencies: HeadlessDaemonDependencies = {},
): Promise<() => Promise<void>> {
    const dataDir = dependencies.dataDir ?? DATA_DIR;
    const port = dependencies.port ?? PORT;
    let storage: InitializableStorage | undefined;
    let missionStore: InitializableMissionStore | undefined;
    let server: HeadlessServer | undefined;

    const lifecycle = new DaemonShutdownCoordinator({
        stopServer: async () => { await server?.stop(); },
        closeStorage: async () => { await storage?.close(); },
        closeMissionStore: async () => { await missionStore?.close(); },
        onDiagnostic: dependencies.onDiagnostic ?? ((diagnostic) => {
            const detail = `${diagnostic.stage} ${diagnostic.outcome}`;
            console.error(`Daemon shutdown: ${detail}`);
        }),
        forceTerminate: dependencies.forceTerminate ?? (() => process.exit(1)),
        setExitCode: dependencies.setExitCode ?? ((code) => { process.exitCode = code; }),
    });
    const requestShutdown = (reason: DaemonShutdownReason = 'RPC'): Promise<void> =>
        lifecycle.requestShutdown(reason);

    try {
        globalEventBus.on('log', (event) => {
            const prefix = `[${event.source ?? 'Ouroboros'}]`;
            switch (event.level) {
                case 'debug': console.debug(prefix, event.message); break;
                case 'info': console.log(prefix, event.message); break;
                case 'warn': console.warn(prefix, event.message); break;
                case 'error': console.error(prefix, event.message); break;
            }
        });
        await mkdir(dataDir, { recursive: true });
        storage = (dependencies.createStorage ?? ((path) => new SqliteAdapter(path)))(join(dataDir, 'daemon.db'));
        await storage.initialize();

        missionStore = (dependencies.createMissionStore ?? ((path) => new SqliteMissionStore(path)))
            (join(dataDir, 'missions.db'));
        await missionStore.initialize();

        const capabilityRegistry = new CapabilityRegistry();
        const missionEngine = new MissionEngine({
            store: missionStore,
            policy: new PlanPolicyValidator(capabilityRegistry),
        });

        const activeSessions = await storage.listSessions({ status: 'active' });
        if (activeSessions.length > 0) {
            console.log(`Found ${activeSessions.length} active daemon session(s).`);
        }

        server = (dependencies.createServer ?? ((sessionStorage, durableMissions, engine, onShutdown) =>
            new DaemonServer(
                sessionStorage,
                { port, host: '127.0.0.1' },
                globalEventBus,
                durableMissions,
                undefined,
                engine,
                onShutdown,
            )
        ))(storage, missionStore, missionEngine, () => { void requestShutdown('RPC'); });

        const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
            console.log(`Daemon shutdown requested by ${signal}.`);
            void requestShutdown(signal);
        };
        const onSigint = () => onSignal('SIGINT');
        const onSigterm = () => onSignal('SIGTERM');
        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);

        try {
            await server.start();
        } catch (error) {
            process.off('SIGINT', onSigint);
            process.off('SIGTERM', onSigterm);
            throw error;
        }

        console.log(`Ouroboros daemon ready on http://127.0.0.1:${port}`);
        return () => requestShutdown('RPC');
    } catch {
        console.error('Failed to start daemon; initialized resources will be closed.');
        await requestShutdown('startup_failure');
        (dependencies.setExitCode ?? ((code) => { process.exitCode = code; }))(1);
        throw new Error('Headless daemon startup failed');
    }
}

if (import.meta.main) {
    try {
        await startHeadlessDaemon();
    } catch {
        process.exitCode = 1;
    }
}
