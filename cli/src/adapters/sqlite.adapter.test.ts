import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from './sqlite.adapter.js';

function readForeignKeysFromAdapterConnection(adapter: SqliteAdapter): number | undefined {
    const internal = adapter as unknown as {
        db: { query(sql: string): { get(): unknown } } | null;
    };
    const row = internal.db?.query('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
    return row?.foreign_keys;
}

async function expectForeignKeyViolation(operation: Promise<unknown>): Promise<void> {
    await expect(operation).rejects.toThrow(/FOREIGN KEY constraint failed/i);
}

async function expectOrphanChildrenRejected(adapter: SqliteAdapter): Promise<void> {
    const missingSessionId = 'missing-session';
    await expectForeignKeyViolation(adapter.saveWave({
        sessionId: missingSessionId,
        waveNumber: 1,
        status: 'pending',
        taskCount: 0,
        completedCount: 0,
        taskData: [],
    }));
    await expectForeignKeyViolation(adapter.createCheckpoint(missingSessionId, { checkpoint: true }));
    await expectForeignKeyViolation(adapter.saveMemory({
        sessionId: missingSessionId,
        type: 'fact',
        content: 'orphan memory',
    }));
    await expectForeignKeyViolation(adapter.appendLog({
        sessionId: missingSessionId,
        type: 'input',
        content: 'orphan log',
    }));
}

test('SqliteAdapter enforces session foreign keys, cascades children, and keeps enforcement after reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ouroboros-sqlite-foreign-keys-'));
    const databasePath = join(directory, 'runtime.sqlite');
    let adapter: SqliteAdapter | null = null;

    try {
        adapter = new SqliteAdapter(databasePath);
        await adapter.initialize();

        // Read the pragma on the exact connection owned by the production adapter.
        expect(readForeignKeysFromAdapterConnection(adapter)).toBe(1);
        await expectOrphanChildrenRejected(adapter);

        const session = await adapter.createSession({
            status: 'active',
            contextSnapshot: 'integration fixture',
            metadata: { source: 'sqlite-foreign-key-test' },
        });
        await adapter.createSession({
            status: 'paused',
            contextSnapshot: 'second fixture',
            metadata: { source: 'sqlite-foreign-key-test' },
        });
        expect(await adapter.listSessions({ limit: 1 })).toHaveLength(1);
        expect(await adapter.listSessions({ status: 'active', limit: 1 })).toHaveLength(1);
        await adapter.saveWave({
            sessionId: session.id,
            waveNumber: 1,
            status: 'pending',
            taskCount: 1,
            completedCount: 0,
            taskData: [{ id: 'task-1', title: 'fixture', phase: 'test', progress: 0 }],
        });
        await adapter.createCheckpoint(session.id, { checkpoint: 1 });
        await adapter.saveMemory({ sessionId: session.id, type: 'fact', content: 'fixture memory' });
        await adapter.appendLog({ sessionId: session.id, type: 'input', content: 'fixture log' });

        expect(await adapter.listWaves(session.id)).toHaveLength(1);
        expect(await adapter.listCheckpoints(session.id)).toHaveLength(1);
        expect(await adapter.listMemory(session.id)).toHaveLength(1);
        expect(await adapter.getLogs(session.id)).toHaveLength(1);

        await adapter.close();
        adapter = new SqliteAdapter(databasePath);
        await adapter.initialize();

        expect(readForeignKeysFromAdapterConnection(adapter)).toBe(1);
        expect(await adapter.getSession(session.id)).not.toBeNull();
        expect(await adapter.listWaves(session.id)).toHaveLength(1);
        expect(await adapter.listCheckpoints(session.id)).toHaveLength(1);
        expect(await adapter.listMemory(session.id)).toHaveLength(1);
        expect(await adapter.getLogs(session.id)).toHaveLength(1);

        await expectOrphanChildrenRejected(adapter);
        await adapter.deleteSession(session.id);

        expect(await adapter.getSession(session.id)).toBeNull();
        expect(await adapter.listWaves(session.id)).toHaveLength(0);
        expect(await adapter.listCheckpoints(session.id)).toHaveLength(0);
        expect(await adapter.listMemory(session.id)).toHaveLength(0);
        expect(await adapter.getLogs(session.id)).toHaveLength(0);
    } finally {
        await adapter?.close();
        await rm(directory, { recursive: true, force: true });
    }
});
