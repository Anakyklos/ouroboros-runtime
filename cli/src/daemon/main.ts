#!/usr/bin/env node
/**
 * Headless daemon composition root and lifecycle owner.
 * Usage: bun run cli/src/daemon/main.ts
 */

import { join } from 'node:path';
import { DaemonServer, globalEventBus } from './index.js';
import { SqliteAdapter } from '../adapters/sqlite.adapter.js';
import { SqliteMissionStore } from '../mission/sqlite-mission-store.js';
import { MissionEngine } from '../mission/mission-engine.js';
import { PlanPolicyValidator } from '../mission/policy.js';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { ConnectorDispatchSeam } from '../capabilities/dispatch-seam.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { MissionStore } from '../mission/ports.js';
import { MissionScheduler } from '../mission/mission-scheduler.js';
import { MissionSchedulerDriver } from './mission-scheduler-driver.js';
import {
    DaemonShutdownCoordinator,
    type DaemonShutdownReason,
    type ShutdownDiagnostic,
} from './shutdown-coordinator.js';
import {
    LocalControlAuthorizer,
    LocalControlCredentialStore,
    securePrivateDirectory,
    type LocalControlAuthorizationPort,
} from './local-control-auth.js';

const DATA_DIR = process.env.OUROBOROS_DATA_DIR || '.ouroboros';
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
        authorization: LocalControlAuthorizationPort,
    ) => HeadlessServer;
    /** Test-only fixture seam; production composition leaves the registry empty. */
    configureCapabilitiesForTests?: (
        registry: CapabilityRegistry,
        seam: ConnectorDispatchSeam,
    ) => void;
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
    let localControlCredentialStore: LocalControlCredentialStore | undefined;
    let localControlAuthorization: LocalControlAuthorizer | undefined;
    let server: HeadlessServer | undefined;
    let schedulerDriver: MissionSchedulerDriver | undefined;
    let detachSignalListeners = (): void => {};
    let detachLogListener = (): void => {};

    const onDiagnostic = dependencies.onDiagnostic ?? ((diagnostic: ShutdownDiagnostic) => {
        const detail = `${diagnostic.stage} ${diagnostic.outcome}`;
        console.error(`Daemon lifecycle: ${detail}`);
    });

    const lifecycle = new DaemonShutdownCoordinator({
        stopServer: async () => {
            detachSignalListeners();
            detachLogListener();
            await server?.stop();
        },
        stopMissionScheduler: async () => { await schedulerDriver?.stop(); },
        closeStorage: async () => { await storage?.close(); },
        closeMissionStore: async () => { await missionStore?.close(); },
        closeLocalControlAuth: async () => {
            localControlAuthorization?.close();
            localControlCredentialStore?.close();
        },
        onDiagnostic,
        forceTerminate: dependencies.forceTerminate ?? (() => process.exit(1)),
        setExitCode: dependencies.setExitCode ?? ((code) => { process.exitCode = code; }),
    });
    const requestShutdown = (reason: DaemonShutdownReason = 'RPC'): Promise<void> =>
        lifecycle.requestShutdown(reason);

    try {
        detachLogListener = globalEventBus.on('log', (event) => {
            const prefix = `[${event.source ?? 'Ouroboros'}]`;
            switch (event.level) {
                case 'debug': console.debug(prefix, event.message); break;
                case 'info': console.log(prefix, event.message); break;
                case 'warn': console.warn(prefix, event.message); break;
                case 'error': console.error(prefix, event.message); break;
            }
        });
        securePrivateDirectory(dataDir);
        storage = (dependencies.createStorage ?? ((path) => new SqliteAdapter(path)))(join(dataDir, 'daemon.db'));
        await storage.initialize();

        missionStore = (dependencies.createMissionStore ?? ((path) => new SqliteMissionStore(path)))
            (join(dataDir, 'missions.db'));
        await missionStore.initialize();

        localControlCredentialStore = new LocalControlCredentialStore(join(dataDir, 'local-control-auth.db'));
        localControlAuthorization = new LocalControlAuthorizer(
            localControlCredentialStore,
            (process.env.OUROBOROS_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
        );
        if (!localControlAuthorization.hasActiveClients()) {
            throw new Error('Local-control authentication must be provisioned before daemon startup');
        }

        const capabilityRegistry = new CapabilityRegistry();
        const missionEngine = new MissionEngine({
            store: missionStore,
            policy: new PlanPolicyValidator(capabilityRegistry),
        });
        const dispatchSeam = new ConnectorDispatchSeam(missionEngine, capabilityRegistry);
        dependencies.configureCapabilitiesForTests?.(capabilityRegistry, dispatchSeam);
        const missionScheduler = new MissionScheduler({
            engine: missionEngine,
            store: missionStore,
            seam: dispatchSeam,
            // The resident driver uses only `nextWakeAt`; retaining report ID
            // histories would duplicate unbounded Mission-backlog data in RAM.
            reportIdLimit: 0,
        });
        schedulerDriver = new MissionSchedulerDriver({
            scheduler: missionScheduler,
            store: missionStore,
            onDiagnostic: (outcome) => onDiagnostic({ stage: 'mission_scheduler', outcome }),
        });

        const activeSessions = await storage.listSessions({ status: 'active' });
        if (activeSessions.length > 0) {
            console.log(`Found ${activeSessions.length} active daemon session(s).`);
        }

        server = (dependencies.createServer ?? ((sessionStorage, durableMissions, engine, onShutdown, authorization) =>
            new DaemonServer(
                sessionStorage,
                { port, host: '127.0.0.1' },
                globalEventBus,
                durableMissions,
                undefined,
                engine,
                onShutdown,
                authorization,
            )
        ))(storage, missionStore, missionEngine, () => { void requestShutdown('RPC'); }, localControlAuthorization);

        const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
            console.log(`Daemon shutdown requested by ${signal}.`);
            void requestShutdown(signal);
        };
        const onSigint = () => onSignal('SIGINT');
        const onSigterm = () => onSignal('SIGTERM');
        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);
        detachSignalListeners = () => {
            process.off('SIGINT', onSigint);
            process.off('SIGTERM', onSigterm);
            detachSignalListeners = () => {};
        };

        try {
            await server.start();
        } catch (error) {
            detachSignalListeners();
            throw error;
        }

        // A slow/hung connector must not hold daemon startup or prevent signal
        // handlers from owning shutdown while the initial pass is in flight.
        void schedulerDriver.start().catch(() => {});

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
