import { describe, expect, it, mock } from 'bun:test';
import { startHeadlessDaemon } from './main.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { MissionStore } from '../mission/ports.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('headless daemon startup cleanup', () => {
    it('fails closed before creating a listener when no local-control client is provisioned', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'ouroboros-no-auth-'));
        const storage = {
            initialize: mock(async () => {}), close: mock(async () => {}), listSessions: mock(async () => []),
        } as unknown as StoragePort & { initialize(): Promise<void>; close(): Promise<void> };
        const missionStore = {
            initialize: mock(async () => {}), close: mock(async () => {}),
        } as unknown as MissionStore & { initialize(): Promise<void>; close(): Promise<void> };
        try {
            await expect(startHeadlessDaemon({
                dataDir,
                port: 0,
                createStorage: () => storage,
                createMissionStore: () => missionStore,
                forceTerminate: mock(() => {}),
                setExitCode: mock(() => {}),
            })).rejects.toThrow('Headless daemon startup failed');
            expect(storage.close).toHaveBeenCalledTimes(1);
            expect(missionStore.close).toHaveBeenCalledTimes(1);
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('closes both initialized stores when composition fails before listen', async () => {
        const closeStorage = mock(async () => {});
        const closeMissionStore = mock(async () => {});
        const setExitCode = mock((_code: number) => {});
        const storage = {
            initialize: mock(async () => {}),
            close: closeStorage,
            listSessions: mock(async () => []),
        } as unknown as StoragePort & { initialize(): Promise<void>; close(): Promise<void> };
        const missionStore = {
            initialize: mock(async () => {}),
            close: closeMissionStore,
        } as unknown as MissionStore & { initialize(): Promise<void>; close(): Promise<void> };

        await expect(startHeadlessDaemon({
            dataDir: '/tmp/ouroboros-startup-failure',
            createStorage: () => storage,
            createMissionStore: () => ({
                ...missionStore,
                initialize: mock(async () => { throw new Error('PRIVATE startup detail'); }),
            }),
            forceTerminate: mock(() => {}),
            setExitCode,
            onDiagnostic: (diagnostic) => {
                expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE');
            },
        })).rejects.toThrow('Headless daemon startup failed');

        expect(closeStorage).toHaveBeenCalledTimes(1);
        expect(closeMissionStore).toHaveBeenCalledTimes(1);
        expect(setExitCode).toHaveBeenCalledWith(1);
    });
});
