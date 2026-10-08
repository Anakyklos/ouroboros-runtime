import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer as createNetServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteMissionStore } from '../mission/sqlite-mission-store.js';
import { LocalControlCredentialStore } from './local-control-auth.js';
import {
    EffectClass,
    InvocationStatus,
    MissionState,
    type CapabilityInvocation,
    type Mission,
} from '../mission/contracts.js';
import { CancellationSupport, IdempotencyMode, ReconciliationSupport, RetryBackoff } from '../capabilities/contracts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAIN = join(ROOT, 'cli/src/daemon/main.ts');
const MISSION_ID = 'shutdown-e2e-mission';
const INVOCATION_ID = 'shutdown-e2e-invocation';
const NOW = '2026-10-07T12:00:00.000Z';
const authTokens = new Map<number, string>();

function mission(state: MissionState = MissionState.COMPLETED): Mission {
    return {
        missionId: MISSION_ID,
        schemaVersion: 1,
        source: 'operator',
        originalIntent: 'Verify durable state across daemon shutdown',
        sanitizedOriginalIntent: 'Verify durable state across daemon shutdown',
        originalIntentRef: 'sha256:shutdown-e2e-intent',
        interpretedObjective: 'Preserve existing durable state',
        constraints: [],
        acceptanceCriteria: ['durable state remains readable'],
        budgetPolicy: {},
        allowedCapabilityScope: {
            capabilityIds: ['owner.confirmed-effect'],
            allowedEffectClasses: [EffectClass.EXECUTION],
            allowedRefPrefixes: ['refs/test/'],
        },
        approvalRequirements: [],
        contextRefs: [],
        state,
        currentPlanRevisionId: null,
        invocationRefs: [],
        evidenceRefs: [],
        criterionVerifications: [],
        unresolvedQuestions: [],
        createdAt: NOW,
        updatedAt: NOW,
        recoveryMetadata: { recovered: false, recoveryCount: 0 },
    };
}

function invocation(): CapabilityInvocation {
    return {
        invocationId: INVOCATION_ID,
        missionId: MISSION_ID,
        stepId: 'step-confirmed',
        capabilityId: 'owner.confirmed-effect',
        planRevisionId: 'revision-confirmed',
        contractVersion: 1,
        moduleOwner: 'test-owner',
        effectClass: EffectClass.EXECUTION,
        requestId: 'request-confirmed',
        effectFingerprint: 'sha256:confirmed-effect',
        inputRefs: [],
        idempotency: { mode: IdempotencyMode.IDEMPOTENT, key: 'effect-key-confirmed' },
        retry: { maxAttempts: 1, attempt: 1, backoff: RetryBackoff.NONE, backoffMs: 0, nextEligibleAt: null },
        attempts: [{
            attempt: 1,
            correlationId: 'attempt-confirmed',
            state: 'acknowledged',
            startedAt: NOW,
            finishedAt: NOW,
        }],
        delivery: { state: 'acknowledged', acknowledgedAt: NOW, remoteOperationHandle: 'owner-op-confirmed' },
        cancellation: { support: CancellationSupport.UNSUPPORTED, requested: false, state: 'not_requested' },
        reconciliation: { support: ReconciliationSupport.NONE, state: 'not_required' },
        ownerVerificationState: 'verified',
        status: InvocationStatus.COMPLETED,
        completedAt: NOW,
        resultRefs: [],
        createdAt: NOW,
        updatedAt: NOW,
    };
}

async function unusedPort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not allocate test port');
    const { port } = address;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

function startDaemon(directory: string, port: number): ChildProcess {
    const authStore = new LocalControlCredentialStore(join(directory, '.ouroboros', 'local-control-auth.db'));
    const credential = authStore.provision('headless-e2e', ['mission.read', 'mission.control', 'daemon.admin'], Date.now() + 60 * 60_000);
    authStore.close();
    authTokens.set(port, credential.token);
    return spawn(process.execPath, [MAIN], {
        cwd: directory,
        env: {
            PATH: process.env.PATH ?? '',
            HOME: directory,
            TMPDIR: directory,
            OUROBOROS_PORT: String(port),
            OUROBOROS_ALLOWED_ORIGINS: 'http://localhost:5173',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

async function waitUntilReady(child: ChildProcess, port: number): Promise<void> {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Daemon exited before becoming ready');
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.ok) return;
        } catch {
            // Startup is asynchronous; retry only the local health observation.
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error('Daemon did not become ready before the deadline');
}

async function waitForExit(child: ChildProcess, timeoutMs = 8_000): Promise<number> {
    if (child.exitCode !== null) return child.exitCode;
    return new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Daemon did not exit before the deadline')), timeoutMs);
        child.once('exit', (code) => {
            clearTimeout(timeout);
            resolve(code ?? -1);
        });
    });
}

async function rpc(port: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${authTokens.get(port)}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-e2e`, method, params }),
    });
    return await response.json() as Record<string, unknown>;
}

async function authenticatedWebSocket(port: number, token: string): Promise<Socket> {
    const session = await fetch(`http://127.0.0.1:${port}/auth/browser-session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Origin: 'http://localhost:5173' },
    });
    if (!session.ok) throw new Error('Could not establish the browser stream session');
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
    if (!cookie) throw new Error('Browser stream session cookie was missing');
    const socket = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    const key = randomBytes(16).toString('base64');
    socket.write([
        `GET /ws HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', 'Origin: http://localhost:5173', `Cookie: ${cookie}`, '', '',
    ].join('\r\n'));
    await new Promise<void>((resolve, reject) => {
        let response = '';
        const timeout = setTimeout(() => reject(new Error('Authenticated WebSocket handshake timed out')), 3_000);
        socket.on('data', (chunk) => {
            response += chunk.toString('utf8');
            if (!response.includes('\r\n\r\n')) return;
            clearTimeout(timeout);
            if (!response.startsWith('HTTP/1.1 101 ')) reject(new Error('Authenticated WebSocket handshake was rejected'));
            else resolve();
        });
        socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });
    return socket;
}

describe('headless daemon lifecycle over real RPC and SQLite', () => {
    const children: ChildProcess[] = [];
    const directories: string[] = [];

    afterEach(async () => {
        for (const child of children.splice(0)) {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await waitForExit(child).catch(() => {});
            }
        }
        for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
    });

    it('shuts down through RPC, restarts with durable state intact, and coalesces OS signals', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'ouroboros-shutdown-e2e-'));
        directories.push(directory);
        const dbPath = join(directory, '.ouroboros', 'missions.db');
        await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(dbPath), { recursive: true }));

        const seed = new SqliteMissionStore(dbPath);
        await seed.initialize();
        await seed.createMission(mission());
        await seed.saveInvocation(invocation());
        const before = await seed.getInvocation(INVOCATION_ID);
        await seed.close();

        const port = await unusedPort();
        const first = startDaemon(directory, port);
        children.push(first);
        await waitUntilReady(first, port);
        const socket = await authenticatedWebSocket(port, authTokens.get(port)!);
        const socketClosed = new Promise<void>((resolve) => socket.once('close', resolve));
        const shutdown = await rpc(port, 'system.shutdown');
        expect(shutdown).toMatchObject({ result: { status: 'shutting_down' } });
        await socketClosed;
        expect(await waitForExit(first)).toBe(0);

        const restarted = startDaemon(directory, port);
        children.push(restarted);
        await waitUntilReady(restarted, port);
        const missionRead = await rpc(port, 'local_control.read', {
            protocolVersion: 1,
            operation: 'mission.show',
            missionId: MISSION_ID,
        });
        const invocationRead = await rpc(port, 'local_control.read', {
            protocolVersion: 1,
            operation: 'invocation.show',
            invocationId: INVOCATION_ID,
        });
        expect(missionRead).toMatchObject({ result: { ok: true, operation: 'mission.show', data: { item: { missionId: MISSION_ID, state: 'completed' } } } });
        expect(invocationRead).toMatchObject({ result: { ok: true, operation: 'invocation.show', data: { item: { invocationId: INVOCATION_ID, status: 'completed' } } } });

        restarted.kill('SIGTERM');
        restarted.kill('SIGINT');
        expect(await waitForExit(restarted)).toBe(0);

        const verify = new SqliteMissionStore(dbPath);
        await verify.initialize();
        const afterMission = await verify.getMission(MISSION_ID);
        const afterInvocation = await verify.getInvocation(INVOCATION_ID);
        await verify.close();
        expect(afterMission?.state).toBe(MissionState.COMPLETED);
        expect(afterInvocation?.status).toBe(InvocationStatus.COMPLETED);
        expect(afterInvocation?.delivery.state).toBe('acknowledged');
        expect(afterInvocation?.attempts).toEqual(before?.attempts);
    });

    it('recovers a paused non-terminal Mission across real process restarts without dispatching its confirmed invocation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'ouroboros-recovery-e2e-'));
        directories.push(directory);
        const dbPath = join(directory, '.ouroboros', 'missions.db');
        await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(dbPath), { recursive: true }));

        const seed = new SqliteMissionStore(dbPath);
        await seed.initialize();
        await seed.createMission(mission(MissionState.PAUSED));
        await seed.saveInvocation(invocation());
        await seed.close();

        const port = await unusedPort();
        const first = startDaemon(directory, port);
        children.push(first);
        await waitUntilReady(first, port);
        const firstRead = await rpc(port, 'local_control.read', {
            protocolVersion: 1,
            operation: 'mission.show',
            missionId: MISSION_ID,
        });
        expect(firstRead).toMatchObject({
            result: { ok: true, operation: 'mission.show', data: { item: { missionId: MISSION_ID, state: 'paused', recoveryCount: 1 } } },
        });
        first.kill('SIGTERM');
        expect(await waitForExit(first)).toBe(0);

        const restarted = startDaemon(directory, port);
        children.push(restarted);
        await waitUntilReady(restarted, port);
        const secondRead = await rpc(port, 'local_control.read', {
            protocolVersion: 1,
            operation: 'mission.show',
            missionId: MISSION_ID,
        });
        const invocationRead = await rpc(port, 'local_control.read', {
            protocolVersion: 1,
            operation: 'invocation.show',
            invocationId: INVOCATION_ID,
        });
        expect(secondRead).toMatchObject({
            result: { ok: true, operation: 'mission.show', data: { item: { missionId: MISSION_ID, state: 'paused', recoveryCount: 2 } } },
        });
        expect(invocationRead).toMatchObject({
            result: { ok: true, operation: 'invocation.show', data: { item: { invocationId: INVOCATION_ID, status: 'completed' } } },
        });
        restarted.kill('SIGTERM');
        expect(await waitForExit(restarted)).toBe(0);

        const verify = new SqliteMissionStore(dbPath);
        await verify.initialize();
        const afterMission = await verify.getMission(MISSION_ID);
        const afterInvocation = await verify.getInvocation(INVOCATION_ID);
        await verify.close();
        expect(afterMission?.state).toBe(MissionState.PAUSED);
        expect(afterMission?.recoveryMetadata.recoveryCount).toBe(2);
        expect(afterInvocation?.status).toBe(InvocationStatus.COMPLETED);
        expect(afterInvocation?.delivery.state).toBe('acknowledged');
    }, 15_000);
});
