import { afterEach, describe, expect, it } from 'bun:test';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHeadlessDaemon, type HeadlessDaemonDependencies } from './main.js';
import type { ConnectorDispatchSeam } from '../capabilities/dispatch-seam.js';
import { SqliteMissionStore } from '../mission/sqlite-mission-store.js';
import { MissionEngine } from '../mission/mission-engine.js';
import { MissionScheduler } from '../mission/mission-scheduler.js';
import { PlanPolicyValidator } from '../mission/policy.js';
import { FakeCapabilityResolver, FakeClock, FakeIdGenerator, FakeVerificationAuthority, makeDefaultCapabilityCatalog } from '../mission/testing.js';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { EffectClass, ReconciliationSupport, type CapabilityDescriptor } from '../capabilities/contracts.js';
import { defineCapabilityDescriptor } from '../capabilities/fixtures.js';
import { CapabilityResultStatus, CONNECTOR_CONTRACT_VERSION_1, type CapabilityConnector } from '../capabilities/connector.js';
import { ConnectorDispatchSeam } from '../capabilities/dispatch-seam.js';
import { MissionSchedulerDriver } from './mission-scheduler-driver.js';
import type { MissionSchedulerDriverTimer } from './mission-scheduler-driver.js';

const MISSION_ID = 'resident-scheduler-mission-1';
const CAPABILITY_ID = 'lifeos.query';
const SECOND_CAPABILITY_ID = 'runstead.code-review';
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

async function seedMixedAvailabilityMission(dataDir: string): Promise<void> {
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
            requestId: 'resident-scheduler-mixed-request',
            source: 'cli',
            originalIntent: 'Read LifeOS status and review the corresponding change',
            constraints: [],
            acceptanceCriteria: ['status read', 'change reviewed'],
        },
        allowedCapabilityScope: {
            capabilityIds: [CAPABILITY_ID, SECOND_CAPABILITY_ID],
            allowedEffectClasses: [EffectClass.READ, EffectClass.EXECUTION],
            allowedRefPrefixes: ['refs/lifeos/', 'refs/runstead/'],
        },
    });
    const proposal = await engine.proposePlan(mission.missionId, {
        planId: 'resident-scheduler-mixed-plan',
        missionId: mission.missionId,
        plannerNote: 'independent authorized steps for scheduler recovery',
        steps: [
            {
                stepId: 'step-a-lifeos',
                desiredOutcome: 'Read the current LifeOS status',
                dependencyIds: [],
                capabilityRequirement: CAPABILITY_ID,
                inputRefs: ['refs/lifeos/status'],
                expectedAcceptance: ['status read'],
                effectClass: EffectClass.READ,
            },
            {
                stepId: 'step-b-review',
                desiredOutcome: 'Review the corresponding change',
                dependencyIds: [],
                capabilityRequirement: SECOND_CAPABILITY_ID,
                inputRefs: ['refs/runstead/pr/120'],
                expectedAcceptance: ['change reviewed'],
                effectClass: EffectClass.EXECUTION,
            },
        ],
    });
    if (!proposal.ok) throw new Error('Mixed-availability daemon fixture plan was rejected');
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

function makeSecondDescriptor() {
    return defineCapabilityDescriptor({
        capabilityId: SECOND_CAPABILITY_ID,
        moduleOwner: 'runstead',
        purpose: 'Review a Runstead change in an isolated scheduler test',
        effectClass: EffectClass.EXECUTION,
        allowedInputRefPrefixes: ['refs/runstead/'],
        ownsStorage: false,
        requiresOwnerVerification: true,
        reconciliationSupport: ReconciliationSupport.NONE,
    });
}

function makeConnector(
    descriptor: ReturnType<typeof makeDescriptor>,
    invoke: CapabilityConnector['invoke'],
): CapabilityConnector {
    return makeConnectorFor(CAPABILITY_ID, descriptor, invoke);
}

function makeConnectorFor(
    capabilityId: string,
    descriptor: CapabilityDescriptor,
    invoke: CapabilityConnector['invoke'],
): CapabilityConnector {
    return {
        connectorContractVersion: CONNECTOR_CONTRACT_VERSION_1,
        capabilityId,
        describe: () => descriptor,
        invoke,
    };
}

async function startDaemon(
    dataDir: string,
    port: number,
    configure: NonNullable<HeadlessDaemonDependencies['configureCapabilitiesForTests']> = () => {},
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

    it('recovers a registry-absent Mission into a durable capability wait and resumes only after registration on restart', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'ouroboros-scheduler-registry-empty-'));
        directories.push(dataDir);
        await seedMission(dataDir);
        const port = await unusedPort();
        const stopWithoutRegistry = await startDaemon(dataDir, port);
        stopDaemons.push(stopWithoutRegistry);
        const waiting = await waitFor(
            () => readDurableState(dataDir),
            (item) => item.missionState === 'waiting_for_capability' || item.missionState === 'blocked',
        );
        expect(waiting.missionState).toBe('waiting_for_capability');
        expect(waiting.invocationStatus).toBeUndefined();
        await stopWithoutRegistry();

        let externalInvokeCount = 0;
        const descriptor = makeDescriptor(ReconciliationSupport.NONE);
        const connector = makeConnector(descriptor, async (request) => {
            externalInvokeCount++;
            return {
                status: CapabilityResultStatus.COMPLETED,
                requestId: request.requestId,
                summary: 'Registered owner completed the read',
                evidence: [],
            };
        });
        const stopAfterRegistration = await startDaemon(dataDir, port, (registry, seam) => {
            registry.register(descriptor);
            seam.registerConnector(CAPABILITY_ID, connector);
        });
        stopDaemons.push(stopAfterRegistration);
        const resumed = await waitFor(() => readDurableState(dataDir), (item) => item.invocationStatus === 'completed');
        expect(resumed.invocationStatus).toBe('completed');
        expect(externalInvokeCount).toBe(1);
        await stopAfterRegistration();
    });

    it('does not wake itself while a registered capability has no connector', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'ouroboros-scheduler-no-connector-'));
        directories.push(dataDir);
        await seedMission(dataDir);
        const store = new SqliteMissionStore(join(dataDir, 'missions.db'));
        await store.initialize();
        const resolver = new FakeCapabilityResolver();
        resolver.registerMany(makeDefaultCapabilityCatalog());
        const clock = new FakeClock(DATA_TIME);
        const engine = new MissionEngine({
            store,
            policy: new PlanPolicyValidator(resolver),
            clock,
            ids: new FakeIdGenerator('driver-loop'),
            interpreter: (intent) => intent.originalIntent,
            verificationAuthority: new FakeVerificationAuthority(),
        });
        const registry = new CapabilityRegistry();
        registry.register(makeDescriptor(ReconciliationSupport.NONE));
        const scheduler = new MissionScheduler({
            engine,
            store,
            seam: new ConnectorDispatchSeam(engine, registry, clock),
            clock,
        });
        const timer = new CountingFakeTimer();
        let passes = 0;
        let mutations = 0;
        let stateChanges = 0;
        const unsubscribe = store.onMutation?.((mutation) => {
            mutations++;
            if (mutation.entity === 'mission' && mutation.kind === 'state_changed') stateChanges++;
        });
        const driver = new MissionSchedulerDriver({
            scheduler: { runOnce: async () => { passes++; return scheduler.runOnce(); } },
            store,
            timer,
        });

        const started = driver.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await driver.stop();
        await started;
        const passesAtStop = passes;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const mission = await store.getMission(MISSION_ID);
        const invocations = await store.listInvocations(MISSION_ID);

        expect(mission?.state).toBe('waiting_for_capability');
        expect(passesAtStop).toBeLessThanOrEqual(2);
        expect(passes).toBe(passesAtStop);
        expect(stateChanges).toBeLessThanOrEqual(1);
        expect(mutations).toBeLessThanOrEqual(2);
        expect(timer.pendingTimers).toBe(0);
        expect(invocations).toHaveLength(0);
        unsubscribe?.();
        await store.close();
    });

    it('dispatches an available independent step once and stays idle while an earlier capability is absent', async () => {
        for (const unavailableMode of ['unregistered', 'connector_missing'] as const) {
            const dataDir = await mkdtemp(join(tmpdir(), `ouroboros-scheduler-mixed-${unavailableMode}-`));
            directories.push(dataDir);
            await seedMixedAvailabilityMission(dataDir);

            const firstStore = new SqliteMissionStore(join(dataDir, 'missions.db'));
            await firstStore.initialize();
            const firstClock = new FakeClock(DATA_TIME);
            const firstResolver = new FakeCapabilityResolver();
            firstResolver.registerMany(makeDefaultCapabilityCatalog());
            const firstEngine = new MissionEngine({
                store: firstStore,
                policy: new PlanPolicyValidator(firstResolver),
                clock: firstClock,
                ids: new FakeIdGenerator(`mixed-${unavailableMode}`),
                interpreter: (intent) => intent.originalIntent,
                verificationAuthority: new FakeVerificationAuthority(),
            });
            const firstRegistry = new CapabilityRegistry();
            const firstSeam = new ConnectorDispatchSeam(firstEngine, firstRegistry, firstClock);
            const firstBDescriptor = makeSecondDescriptor();
            firstRegistry.register(firstBDescriptor);
            let bInvokes = 0;
            firstSeam.registerConnector(SECOND_CAPABILITY_ID, makeConnectorFor(
                SECOND_CAPABILITY_ID,
                firstBDescriptor,
                async (request) => {
                    bInvokes++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: 'Independent review completed',
                        evidence: [],
                        ownerVerification: { owner: 'runstead', verified: true, reason: 'reviewed' },
                    };
                },
            ));
            if (unavailableMode === 'connector_missing') {
                firstRegistry.register(makeDescriptor(ReconciliationSupport.NONE));
            }
            const firstScheduler = new MissionScheduler({
                engine: firstEngine,
                store: firstStore,
                seam: firstSeam,
                clock: firstClock,
            });
            const firstTimer = new CountingFakeTimer();
            let firstPasses = 0;
            let firstMutations = 0;
            let firstStateChanges = 0;
            const unsubscribe = firstStore.onMutation?.((mutation) => {
                firstMutations++;
                if (mutation.entity === 'mission' && mutation.kind === 'state_changed') firstStateChanges++;
            });
            let firstDriver!: MissionSchedulerDriver;
            firstDriver = new MissionSchedulerDriver({
                scheduler: { runOnce: async () => {
                    firstPasses++;
                    if (firstPasses >= 8) void firstDriver.stop();
                    return firstScheduler.runOnce();
                } },
                store: firstStore,
                timer: firstTimer,
            });

            try {
                await firstDriver.start();
                await new Promise((resolve) => setTimeout(resolve, 25));
                const settledPasses = firstPasses;
                const settledMutations = firstMutations;
                const settledStateChanges = firstStateChanges;
                firstClock.advance(60_000);
                await new Promise((resolve) => setTimeout(resolve, 25));

                const mission = await firstStore.getMission(MISSION_ID);
                const invocations = await firstStore.listInvocations(MISSION_ID);
                const aInvocations = invocations.filter((item) => item.capabilityId === CAPABILITY_ID);
                const bInvocations = invocations.filter((item) => item.capabilityId === SECOND_CAPABILITY_ID);
                expect(firstPasses).toBe(settledPasses);
                expect(firstMutations).toBe(settledMutations);
                expect(firstStateChanges).toBe(settledStateChanges);
                expect(firstPasses).toBeLessThanOrEqual(3);
                expect(firstMutations).toBeLessThanOrEqual(10);
                expect(firstStateChanges).toBeLessThanOrEqual(2);
                expect(firstTimer.pendingTimers).toBe(0);
                expect(mission?.state).toBe('waiting_for_capability');
                expect(aInvocations).toHaveLength(0);
                expect(bInvocations).toHaveLength(1);
                expect(bInvocations[0]?.status).toBe('completed');
                expect(bInvokes).toBe(1);
            } finally {
                await firstDriver.stop();
                unsubscribe?.();
                await firstStore.close();
            }

            // A new process composition authorizes A by registering its
            // descriptor and connector. Recovery may now resume A, while B's
            // already completed effect remains protected by durable identity.
            const secondStore = new SqliteMissionStore(join(dataDir, 'missions.db'));
            await secondStore.initialize();
            const secondClock = new FakeClock(DATA_TIME);
            const secondResolver = new FakeCapabilityResolver();
            secondResolver.registerMany(makeDefaultCapabilityCatalog());
            const secondEngine = new MissionEngine({
                store: secondStore,
                policy: new PlanPolicyValidator(secondResolver),
                clock: secondClock,
                ids: new FakeIdGenerator(`mixed-resume-${unavailableMode}`),
                interpreter: (intent) => intent.originalIntent,
                verificationAuthority: new FakeVerificationAuthority(),
            });
            const secondRegistry = new CapabilityRegistry();
            const secondSeam = new ConnectorDispatchSeam(secondEngine, secondRegistry, secondClock);
            const aDescriptor = makeDescriptor(ReconciliationSupport.NONE);
            const bDescriptor = makeSecondDescriptor();
            secondRegistry.register(aDescriptor);
            secondRegistry.register(bDescriptor);
            let aInvokes = 0;
            secondSeam.registerConnector(CAPABILITY_ID, makeConnectorFor(CAPABILITY_ID, aDescriptor, async (request) => {
                aInvokes++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId: request.requestId,
                    summary: 'Previously unavailable status read completed',
                    evidence: [],
                };
            }));
            secondSeam.registerConnector(SECOND_CAPABILITY_ID, makeConnectorFor(SECOND_CAPABILITY_ID, bDescriptor, async (request) => {
                bInvokes++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId: request.requestId,
                    summary: 'Already completed review must not be repeated',
                    evidence: [],
                    ownerVerification: { owner: 'runstead', verified: true, reason: 'reviewed' },
                };
            }));
            const secondScheduler = new MissionScheduler({
                engine: secondEngine,
                store: secondStore,
                seam: secondSeam,
                clock: secondClock,
            });
            const secondDriver = new MissionSchedulerDriver({ scheduler: secondScheduler, store: secondStore });
            try {
                await secondDriver.start();
                const deadline = Date.now() + 5_000;
                let invocations = await secondStore.listInvocations(MISSION_ID);
                while (invocations.filter((item) => item.capabilityId === CAPABILITY_ID).length !== 1 && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    invocations = await secondStore.listInvocations(MISSION_ID);
                }
                expect(invocations.filter((item) => item.capabilityId === CAPABILITY_ID)).toHaveLength(1);
                expect(invocations.filter((item) => item.capabilityId === SECOND_CAPABILITY_ID)).toHaveLength(1);
                expect(aInvokes).toBe(1);
                expect(bInvokes).toBe(1);
            } finally {
                await secondDriver.stop();
                await secondStore.close();
            }
        }
    }, 15_000);
});

class CountingFakeTimer implements MissionSchedulerDriverTimer {
    private currentTime = new Date(DATA_TIME);
    private nextId = 1;
    private readonly timers = new Map<number, () => void>();

    now(): Date { return new Date(this.currentTime); }

    advance(ms: number): void {
        this.currentTime = new Date(this.currentTime.getTime() + ms);
    }

    setTimeout(callback: () => void, _delayMs: number): ReturnType<typeof setTimeout> {
        const id = this.nextId++;
        this.timers.set(id, callback);
        return id as unknown as ReturnType<typeof setTimeout>;
    }

    clearTimeout(handle: ReturnType<typeof setTimeout>): void {
        this.timers.delete(handle as unknown as number);
    }

    get pendingTimers(): number { return this.timers.size; }
}
