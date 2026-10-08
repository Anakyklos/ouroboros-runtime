import { afterEach, describe, expect, it } from 'bun:test';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHeadlessDaemon, type HeadlessDaemonDependencies } from './main.js';
import type { ConnectorDispatchSeam } from '../capabilities/dispatch-seam.js';
import { SqliteMissionStore } from '../mission/sqlite-mission-store.js';
import { MissionEngine } from '../mission/mission-engine.js';
import { PlanPolicyValidator } from '../mission/policy.js';
import { FakeCapabilityResolver, FakeClock, FakeIdGenerator, FakeVerificationAuthority, makeDefaultCapabilityCatalog } from '../mission/testing.js';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { EffectClass, ReconciliationSupport } from '../capabilities/contracts.js';
import { defineCapabilityDescriptor } from '../capabilities/fixtures.js';
import { CapabilityResultStatus, CONNECTOR_CONTRACT_VERSION_1, type CapabilityConnector } from '../capabilities/connector.js';

const MISSION_ID = 'resident-scheduler-mission-1';
const CAPABILITY_ID = 'lifeos.query';
const DATA_TIME = '2026-10-08T10:00:00.000Z';

async function unusedPort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not allocate daemon test port');
    const port = address.port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

async function waitFor<T>(read: () => Promise<T>, isReady: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5_000;
    let current = await read();
    while (!isReady(current) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        current = await read();
    }
    if (!isReady(current)) throw new Error(`Daemon durable state did not reach the expected value: ${JSON.stringify(current)}`);
    return current;
}

async function seedMission(dataDir: string): Promise<void> {
    const store = new SqliteMissionStore(join(dataDir, 'missions.db'));
    await store.initialize();
    const resolver = new FakeCapabilityResolver();
    resolver.registerMany(makeDefaultCapabilityCatalog());
    const engine = new MissionEngine({
        store,
        policy: new PlanPolicyValidator(resolver),
        clock: new FakeClock(DATA_TIME),
        ids: new FakeIdGenerator('resident-scheduler-mission'),
        interpreter: (intent) => intent.originalIntent,
        verificationAuthority: new FakeVerificationAuthority(),
    });
    const mission = await engine.createMission({
        intent: {
            requestId: 'resident-scheduler-request',
            source: 'cli',
            originalIntent: 'Read the current LifeOS status',
            constraints: [],
            acceptanceCriteria: ['status read'],
        },
        allowedCapabilityScope: {
            capabilityIds: [CAPABILITY_ID],
            allowedEffectClasses: [EffectClass.READ],
            allowedRefPrefixes: ['refs/lifeos/'],
        },
    });
    const proposal = await engine.proposePlan(mission.missionId, {
        planId: 'resident-scheduler-plan',
        missionId: mission.missionId,
        plannerNote: 'deterministic daemon fixture',
        steps: [{
            stepId: 'read-status',
            desiredOutcome: 'Read the current LifeOS status',
            dependencyIds: [],
            capabilityRequirement: CAPABILITY_ID,
            inputRefs: ['refs/lifeos/status'],
            expectedAcceptance: ['status read'],
            effectClass: EffectClass.READ,
        }],
    });
    if (!proposal.ok) throw new Error('Daemon E2E fixture plan was rejected');
    await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);
    await store.close();
}

function makeDescriptor(reconciliationSupport: ReconciliationSupport) {
    return defineCapabilityDescriptor({
        capabilityId: CAPABILITY_ID,
        moduleOwner: 'lifeos',
        purpose: 'Read LifeOS status in an isolated scheduler test',
        effectClass: EffectClass.READ,
        allowedInputRefPrefixes: ['refs/lifeos/'],
        ownsStorage: true,
        reconciliationSupport,
    });
}

function makeConnector(
    descriptor: ReturnType<typeof makeDescriptor>,
    invoke: CapabilityConnector['invoke'],
): CapabilityConnector {
    return {
        connectorContractVersion: CONNECTOR_CONTRACT_VERSION_1,
        capabilityId: CAPABILITY_ID,
        describe: () => descriptor,
        invoke,
    };
}

async function startDaemon(
    dataDir: string,
    port: number,
    configure: NonNullable<HeadlessDaemonDependencies['configureCapabilitiesForTests']>,
) {
    const stop = await startHeadlessDaemon({
        dataDir,
        port,
        forceTerminate: () => {},
        setExitCode: () => {},
        configureCapabilitiesForTests: configure,
    });
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.ok).toBe(true);
    return stop;
}

async function readDurableState(dataDir: string): Promise<Record<string, unknown>> {
    const store = new SqliteMissionStore(join(dataDir, 'missions.db'));
    await store.initialize();
    const mission = await store.getMission(MISSION_ID);
    const invocation = (await store.listInvocations(MISSION_ID))[0];
    await store.close();
    return {
        missionState: mission?.state,
        recoveryCount: mission?.recoveryMetadata.recoveryCount,
        invocationStatus: invocation?.status,
        deliveryState: invocation?.delivery.state,
    };
}

async function requestRpcShutdown(port: number): Promise<Record<string, unknown>> {
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'pending-scheduler-shutdown', method: 'system.shutdown' }),
    });
    return await response.json() as Record<string, unknown>;
}

describe('resident Mission scheduler daemon composition', () => {
    const directories: string[] = [];
    const stopDaemons: Array<() => Promise<void>> = [];

    afterEach(async () => {
        for (const stop of stopDaemons.splice(0)) await stop().catch(() => {});
        for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
    });

    it('dispatches an authorized typed connector once and preserves the confirmed effect across daemon restart', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'ouroboros-scheduler-confirmed-'));
        directories.push(dataDir);
        await seedMission(dataDir);
        const port = await unusedPort();
        let externalInvokeCount = 0;
        const descriptor = makeDescriptor(ReconciliationSupport.NONE);
        const connector = makeConnector(descriptor, async (request) => {
            externalInvokeCount++;
            return {
                status: CapabilityResultStatus.COMPLETED,
                requestId: request.requestId,
                summary: 'Fixture owner completed the read',
                evidence: [],
            };
        });
        const configure = (registry: CapabilityRegistry, seam: ConnectorDispatchSeam) => {
            registry.register(descriptor);
            seam.registerConnector(CAPABILITY_ID, connector);
        };

        const stopFirst = await startDaemon(dataDir, port, configure);
        stopDaemons.push(stopFirst);
        const completed = await waitFor(() => readDurableState(dataDir), (item) => item.invocationStatus === 'completed');
        expect(completed.invocationStatus).toBe('completed');
        expect(externalInvokeCount).toBe(1);
        await stopFirst();

        const reopened = new SqliteMissionStore(join(dataDir, 'missions.db'));
        await reopened.initialize();
        const durable = await reopened.getMission(MISSION_ID);
        const invocation = durable?.invocationRefs[0];
        expect(durable?.state).toBe('executing');
        expect(invocation?.status).toBe('completed');
        await reopened.close();

        const stopSecond = await startDaemon(dataDir, port, configure);
        stopDaemons.push(stopSecond);
        expect((await waitFor(() => readDurableState(dataDir), (item) => item.invocationStatus === 'completed')).invocationStatus).toBe('completed');
        expect(externalInvokeCount).toBe(1);
        await stopSecond();
    }, 15_000);

    it('does not blindly resubmit an invocation after a possible handoff and restart', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'ouroboros-scheduler-uncertain-'));
        directories.push(dataDir);
        await seedMission(dataDir);
        const port = await unusedPort();
        let externalInvokeCount = 0;
        const descriptor = makeDescriptor(ReconciliationSupport.NONE);
        const connector = makeConnector(descriptor, async () => {
            externalInvokeCount++;
            throw new Error('simulated disconnect after possible submission');
        });
        const configure = (registry: CapabilityRegistry, seam: ConnectorDispatchSeam) => {
            registry.register(descriptor);
            seam.registerConnector(CAPABILITY_ID, connector);
        };

        const stopFirst = await startDaemon(dataDir, port, configure);
        stopDaemons.push(stopFirst);
        const blockedAfterRestart = await waitFor(() => readDurableState(dataDir), (item) => item.missionState === 'blocked');
        expect(blockedAfterRestart.invocationStatus).toBe('blocked');
        expect(externalInvokeCount).toBe(1);
        await stopFirst();

        const stopSecond = await startDaemon(dataDir, port, configure);
        stopDaemons.push(stopSecond);
        const blocked = await waitFor(() => readDurableState(dataDir), (item) => item.missionState === 'blocked');
        expect(blocked.invocationStatus).toBe('blocked');
        expect(externalInvokeCount).toBe(1);
        await stopSecond();

        const reopened = new SqliteMissionStore(join(dataDir, 'missions.db'));
        await reopened.initialize();
        const invocations = await reopened.listInvocations(MISSION_ID);
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.delivery.state).toBe('uncertain');
        expect(invocations[0]?.status).toBe('blocked');
        await reopened.close();
    }, 15_000);

    it('starts the daemon listener while the initial connector invocation is still pending', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'ouroboros-scheduler-pending-'));
        directories.push(dataDir);
        await seedMission(dataDir);
        const port = await unusedPort();
        let externalInvokeCount = 0;
        let releaseInvocation!: () => void;
        const descriptor = makeDescriptor(ReconciliationSupport.NONE);
        const connector = makeConnector(descriptor, async (request) => {
            externalInvokeCount++;
            await new Promise<void>((resolve) => { releaseInvocation = resolve; });
            return {
                status: CapabilityResultStatus.COMPLETED,
                requestId: request.requestId,
                summary: 'Fixture owner completed the pending read',
                evidence: [],
            };
        });
        const configure = (registry: CapabilityRegistry, seam: ConnectorDispatchSeam) => {
            registry.register(descriptor);
            seam.registerConnector(CAPABILITY_ID, connector);
        };

        const startedAt = Date.now();
        const stop = await startDaemon(dataDir, port, configure);
        stopDaemons.push(stop);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        await waitFor(() => readDurableState(dataDir), (item) => item.deliveryState === 'submitted');
        expect(externalInvokeCount).toBe(1);

        expect(await requestRpcShutdown(port)).toMatchObject({ result: { status: 'shutting_down' } });

        releaseInvocation();
        await waitFor(() => readDurableState(dataDir), (item) => item.invocationStatus === 'completed');
        await stop();
    }, 15_000);
});
