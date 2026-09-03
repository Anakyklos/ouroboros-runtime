import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    computeEffectFingerprint,
    EffectClass,
    InvocationStatus,
    MissionState,
    type CapabilityInvocation,
    type Mission,
    type PlanCandidate,
} from "./contracts.js";
import { MissionEngine } from "./mission-engine.js";
import { MissionScheduler } from "./mission-scheduler.js";
import { PlanPolicyValidator } from "./policy.js";
import { SqliteMissionStore } from "./sqlite-mission-store.js";
import {
    FakeCapabilityResolver,
    FakeClock,
    FakeIdGenerator,
    makeDefaultCapabilityCatalog,
    FakeVerificationAuthority,
} from "./testing.js";
import { CapabilityRegistry } from "../capabilities/registry.js";
import { defineCapabilityDescriptor } from "../capabilities/fixtures.js";
import { CapabilityResultStatus } from "../capabilities/connector.js";
import { ConnectorDispatchSeam } from "../capabilities/dispatch-seam.js";
import {
    CapabilityAvailability,
    CancellationSupport,
    IdempotencyMode,
    ReconciliationSupport,
    RetryBackoff,
} from "../capabilities/contracts.js";

const BASE_TIME = "2026-09-03T18:00:00.000Z";

function tempDb(): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "mission-scheduler-"));
    return {
        path: join(dir, "missions.db"),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

function makeMission(id: string, state: MissionState = MissionState.READY): Mission {
    return {
        missionId: id,
        schemaVersion: 1,
        source: "cli",
        originalIntent: "Read the current LifeOS status",
        sanitizedOriginalIntent: "Read the current LifeOS status",
        originalIntentRef: `ref-${id}`,
        interpretedObjective: "Read the current LifeOS status",
        constraints: [],
        acceptanceCriteria: ["status read"],
        budgetPolicy: {},
        allowedCapabilityScope: {
            capabilityIds: ["lifeos.query"],
            allowedEffectClasses: [EffectClass.READ],
            allowedRefPrefixes: ["refs/lifeos/"],
        },
        approvalRequirements: [],
        contextRefs: [],
        state,
        currentPlanRevisionId: null,
        invocationRefs: [],
        evidenceRefs: [],
        criterionVerifications: [],
        unresolvedQuestions: [],
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
        recoveryMetadata: { recovered: false, recoveryCount: 0 },
    };
}

function planFor(
    mission: Mission,
    options: {
        capabilityId?: string;
        effectClass?: EffectClass;
        inputRef?: string;
    } = {},
): PlanCandidate {
    const capabilityId = options.capabilityId ?? "lifeos.query";
    const effectClass = options.effectClass ?? EffectClass.READ;
    const inputRef = options.inputRef ?? "refs/lifeos/status";
    return {
        planId: "plan-scheduler-1",
        missionId: mission.missionId,
        plannerNote: "scheduler test plan",
        steps: [{
            stepId: "read-status",
            desiredOutcome: "Read the current LifeOS status",
            dependencyIds: [],
            capabilityRequirement: capabilityId,
            inputRefs: [inputRef],
            expectedAcceptance: ["status read"],
            effectClass,
        }],
    };
}

function createEngine(store: SqliteMissionStore, ids: FakeIdGenerator): MissionEngine {
    const resolver = new FakeCapabilityResolver();
    resolver.registerMany(makeDefaultCapabilityCatalog());
    return new MissionEngine({
        store,
        policy: new PlanPolicyValidator(resolver),
        clock: new FakeClock(BASE_TIME),
        ids,
        interpreter: (intent) => intent.originalIntent,
        verificationAuthority: new FakeVerificationAuthority(),
    });
}

function createRegistry(): CapabilityRegistry {
    const registry = new CapabilityRegistry();
    registry.register(defineCapabilityDescriptor({
        capabilityId: "lifeos.query",
        moduleOwner: "lifeos",
        purpose: "Read the LifeOS status",
        effectClass: EffectClass.READ,
        allowedInputRefPrefixes: ["refs/lifeos/"],
        ownsStorage: true,
        retry: { maxAttempts: 3, backoff: RetryBackoff.FIXED },
        reconciliationSupport: "status_replay",
    }));
    registry.register(defineCapabilityDescriptor({
        capabilityId: "runstead.code-review",
        moduleOwner: "runstead",
        purpose: "Review a Runstead change",
        effectClass: EffectClass.EXECUTION,
        allowedInputRefPrefixes: ["refs/runstead/"],
        requiresOwnerVerification: true,
        ownsStorage: false,
    }));
    return registry;
}

describe("MissionScheduler", () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        for (const cleanup of cleanups.splice(0)) cleanup();
    });

    it("recovers a non-terminal mission without dispatching or changing its paused state", async () => {
        const db = tempDb();
        cleanups.push(db.cleanup);
        const firstStore = new SqliteMissionStore(db.path);
        await firstStore.initialize();
        const firstEngine = createEngine(firstStore, new FakeIdGenerator("first"));
        const created = await firstEngine.createMission({
            intent: {
                requestId: "request-1",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const proposal = await firstEngine.proposePlan(created.missionId, planFor(created));
        if (!proposal.ok) throw new Error("scheduler plan was rejected");
        await firstEngine.acceptPlan(created.missionId, proposal.revision.revisionId);
        await firstEngine.pauseMission(created.missionId, "operator hold");
        await firstStore.close();

        const secondStore = new SqliteMissionStore(db.path);
        await secondStore.initialize();
        const secondEngine = createEngine(secondStore, new FakeIdGenerator("second"));
        const registry = createRegistry();
        const seam = new ConnectorDispatchSeam(secondEngine, registry, new FakeClock(BASE_TIME));
        const scheduler = new MissionScheduler({
            engine: secondEngine,
            store: secondStore,
            seam,
            clock: new FakeClock(BASE_TIME),
        });

        const report = await scheduler.recover();
        const recovered = await secondStore.getMission(created.missionId);
        expect(report.recoveredMissionIds).toEqual([created.missionId]);
        expect(recovered?.state).toBe(MissionState.PAUSED);
        expect(recovered?.recoveryMetadata).toMatchObject({ recovered: true, recoveryCount: 1 });
        expect(recovered?.pauseMetadata).toMatchObject({ reason: "operator hold" });
        expect(report.reconciledInvocationIds).toEqual([]);
    });

    it("reconstructs a legacy effect when one accepted revision proves its identity", async () => {
        const db = tempDb();
        cleanups.push(db.cleanup);
        const legacy = new Database(db.path);
        legacy.exec(`
            CREATE TABLE missions (
                mission_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, source TEXT NOT NULL,
                sanitized_original_intent TEXT NOT NULL, original_intent_ref TEXT NOT NULL,
                interpreted_objective TEXT NOT NULL, constraints TEXT NOT NULL, acceptance_criteria TEXT NOT NULL,
                budget_policy TEXT NOT NULL, allowed_capability_scope TEXT NOT NULL, approval_requirements TEXT NOT NULL,
                context_refs TEXT NOT NULL, state TEXT NOT NULL, current_plan_revision_id TEXT,
                evidence_refs TEXT NOT NULL, criterion_verifications TEXT NOT NULL, unresolved_questions TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, recovery_metadata TEXT NOT NULL
            );
            CREATE TABLE mission_plan_revisions (
                revision_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
                plan_id TEXT NOT NULL, steps TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
                accepted_at TEXT, replaces_revision_id TEXT, rejection_reason TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE mission_invocations (
                invocation_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, step_id TEXT NOT NULL,
                capability_id TEXT NOT NULL, status TEXT NOT NULL, dispatched_at TEXT, completed_at TEXT,
                result_refs TEXT NOT NULL, owner_verification TEXT, error TEXT
            );
        `);
        const step = {
            stepId: "read-status",
            desiredOutcome: "Read the current LifeOS status",
            dependencyIds: [],
            capabilityRequirement: "lifeos.query",
            inputRefs: ["refs/lifeos/status"],
            expectedAcceptance: ["status read"],
            effectClass: EffectClass.READ,
        };
        legacy.query(
            `INSERT INTO missions (
                mission_id, schema_version, source, sanitized_original_intent, original_intent_ref,
                interpreted_objective, constraints, acceptance_criteria, budget_policy,
                allowed_capability_scope, approval_requirements, context_refs, state,
                current_plan_revision_id, evidence_refs, criterion_verifications, unresolved_questions,
                created_at, updated_at, recovery_metadata
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            "legacy-mission",
            1,
            "cli",
            "Read the current LifeOS status",
            "sha256:legacy-mission",
            "Read the current LifeOS status",
            "[]",
            '["status read"]',
            "{}",
            JSON.stringify({
                capabilityIds: ["lifeos.query"],
                allowedEffectClasses: [EffectClass.READ],
                allowedRefPrefixes: ["refs/lifeos/"],
            }),
            "[]",
            "[]",
            "ready",
            null,
            "[]",
            "[]",
            "[]",
            BASE_TIME,
            BASE_TIME,
            '{"recovered":false,"recoveryCount":0}',
        );
        legacy.query(
            `INSERT INTO mission_plan_revisions (
                revision_id, mission_id, revision_number, plan_id, steps, status, reason,
                accepted_at, replaces_revision_id, rejection_reason, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            "revision-r1",
            "legacy-mission",
            1,
            "plan-r1",
            JSON.stringify([step]),
            "accepted",
            "only accepted plan",
            BASE_TIME,
            null,
            null,
            BASE_TIME,
        );
        legacy.query(
            `INSERT INTO mission_invocations (
                invocation_id, mission_id, step_id, capability_id, status, dispatched_at,
                completed_at, result_refs, owner_verification, error
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            "legacy-completed",
            "legacy-mission",
            step.stepId,
            step.capabilityRequirement,
            "completed",
            "2026-09-03T18:30:00.000Z",
            "2026-09-03T18:30:00.000Z",
            "[]",
            null,
            null,
        );
        legacy.close();

        const store = new SqliteMissionStore(db.path);
        await store.initialize();
        const expectedFingerprint = computeEffectFingerprint({
            capabilityId: step.capabilityRequirement,
            effectClass: step.effectClass,
            inputRefs: step.inputRefs,
            outcome: step.desiredOutcome,
        });
        const migrated = await store.getInvocation("legacy-completed");
        expect(migrated?.effectFingerprint).toBe(expectedFingerprint);
        expect(migrated?.planRevisionId).toBe("revision-r1");
        expect(await store.findInvocationByEffectFingerprint("legacy-mission", expectedFingerprint)).toEqual(migrated);
        await store.close();
    });

    it("preserves a replay barrier when a pre-#50 effect could belong to an older plan revision", async () => {
        const db = tempDb();
        cleanups.push(db.cleanup);
        const legacy = new Database(db.path);
        legacy.exec(`
            CREATE TABLE missions (
                mission_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, source TEXT NOT NULL,
                sanitized_original_intent TEXT NOT NULL, original_intent_ref TEXT NOT NULL,
                interpreted_objective TEXT NOT NULL, constraints TEXT NOT NULL, acceptance_criteria TEXT NOT NULL,
                budget_policy TEXT NOT NULL, allowed_capability_scope TEXT NOT NULL, approval_requirements TEXT NOT NULL,
                context_refs TEXT NOT NULL, state TEXT NOT NULL, current_plan_revision_id TEXT,
                evidence_refs TEXT NOT NULL, criterion_verifications TEXT NOT NULL, unresolved_questions TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, recovery_metadata TEXT NOT NULL
            );
            CREATE TABLE mission_plan_revisions (
                revision_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
                plan_id TEXT NOT NULL, steps TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
                accepted_at TEXT, replaces_revision_id TEXT, rejection_reason TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE mission_invocations (
                invocation_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, step_id TEXT NOT NULL,
                capability_id TEXT NOT NULL, status TEXT NOT NULL, dispatched_at TEXT, completed_at TEXT,
                result_refs TEXT NOT NULL, owner_verification TEXT, error TEXT
            );
        `);
        const stepA = {
            stepId: "prepare",
            desiredOutcome: "Prepare effect A",
            dependencyIds: [],
            capabilityRequirement: "lifeos.query",
            inputRefs: ["refs/lifeos/a"],
            expectedAcceptance: ["status read"],
            effectClass: EffectClass.READ,
        };
        const stepB = {
            stepId: "prepare",
            desiredOutcome: "Prepare effect B",
            dependencyIds: [],
            capabilityRequirement: "lifeos.query",
            inputRefs: ["refs/lifeos/b"],
            expectedAcceptance: ["status read"],
            effectClass: EffectClass.READ,
        };
        const dependentStep = {
            stepId: "dependent",
            desiredOutcome: "Run dependent effect",
            dependencyIds: ["prepare"],
            capabilityRequirement: "lifeos.query",
            inputRefs: ["refs/lifeos/dependent"],
            expectedAcceptance: ["status read"],
            effectClass: EffectClass.READ,
        };
        legacy.query(
            `INSERT INTO missions (
                mission_id, schema_version, source, sanitized_original_intent, original_intent_ref,
                interpreted_objective, constraints, acceptance_criteria, budget_policy,
                allowed_capability_scope, approval_requirements, context_refs, state,
                current_plan_revision_id, evidence_refs, criterion_verifications, unresolved_questions,
                created_at, updated_at, recovery_metadata
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            "legacy-mission",
            1,
            "cli",
            "Read the current LifeOS status",
            "sha256:legacy-mission",
            "Read the current LifeOS status",
            "[]",
            '["status read"]',
            "{}",
            JSON.stringify({
                capabilityIds: ["lifeos.query"],
                allowedEffectClasses: [EffectClass.READ],
                allowedRefPrefixes: ["refs/lifeos/"],
            }),
            "[]",
            "[]",
            "ready",
            "revision-r2",
            "[]",
            "[]",
            "[]",
            BASE_TIME,
            BASE_TIME,
            '{"recovered":false,"recoveryCount":0}',
        );
        legacy.query(
            `INSERT INTO mission_plan_revisions (
                revision_id, mission_id, revision_number, plan_id, steps, status, reason,
                accepted_at, replaces_revision_id, rejection_reason, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            "revision-r1",
            "legacy-mission",
            1,
            "plan-r1",
            JSON.stringify([stepA]),
            "superseded",
            "first accepted plan",
            BASE_TIME,
            null,
            null,
            BASE_TIME,
        );
        legacy.query(
            `INSERT INTO mission_plan_revisions (
                revision_id, mission_id, revision_number, plan_id, steps, status, reason,
                accepted_at, replaces_revision_id, rejection_reason, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            "revision-r2",
            "legacy-mission",
            2,
            "plan-r2",
            JSON.stringify([stepB, dependentStep]),
            "accepted",
            "later accepted plan with changed effect",
            "2026-09-03T19:00:00.000Z",
            "revision-r1",
            null,
            "2026-09-03T19:00:00.000Z",
        );
        legacy.query(
            `INSERT INTO mission_invocations (
                invocation_id, mission_id, step_id, capability_id, status, dispatched_at,
                completed_at, result_refs, owner_verification, error
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            "legacy-completed",
            "legacy-mission",
            stepA.stepId,
            stepA.capabilityRequirement,
            "completed",
            // The old row has no dispatch timestamp. With both accepted
            // revisions carrying the same step/capability, revision identity
            // is therefore not reconstructible during migration.
            null,
            "2026-09-03T18:30:00.000Z",
            "[]",
            null,
            null,
        );
        legacy.close();

        const firstStore = new SqliteMissionStore(db.path);
        await firstStore.initialize();
        await firstStore.close();

        const store = new SqliteMissionStore(db.path);
        await store.initialize();
        const currentEffectFingerprint = computeEffectFingerprint({
            capabilityId: stepB.capabilityRequirement,
            effectClass: stepB.effectClass,
            inputRefs: stepB.inputRefs,
            outcome: stepB.desiredOutcome,
        });
        const migrated = await store.getInvocation("legacy-completed");
        expect(migrated?.effectFingerprint).toBe("legacy:legacy-completed");
        expect(migrated?.effectFingerprint).not.toBe(currentEffectFingerprint);
        expect(await store.findInvocationByEffectFingerprint("legacy-mission", currentEffectFingerprint)).toBeNull();
        expect(migrated?.planRevisionId).toBe("");

        const engine = createEngine(store, new FakeIdGenerator("legacy-restart"));
        const registry = createRegistry();
        let invokes = 0;
        const seam = new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME));
        seam.registerConnector("lifeos.query", {
            connectorContractVersion: 1,
            capabilityId: "lifeos.query",
            describe: () => registry.requireDescriptor("lifeos.query"),
            invoke: async (request) => {
                invokes++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId: request.requestId,
                    summary: "should never be submitted",
                    evidence: [],
                };
            },
        });
        const scheduler = new MissionScheduler({
            engine,
            store,
            seam,
            clock: new FakeClock(BASE_TIME),
            recoveryBatchSize: 2,
        });

        const report = await scheduler.runOnce();
        expect(invokes).toBe(0);
        expect(report.dispatchedInvocationIds).toEqual([]);
        expect(await store.listInvocations("legacy-mission")).toHaveLength(1);
        expect(await store.getInvocation("legacy-dependent")).toBeNull();
        expect((await store.getInvocation("legacy-completed"))?.status).toBe(InvocationStatus.COMPLETED);
        await store.close();
    });

    it("dispatches a dependency-ready step once through the real connector seam", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const engine = createEngine(store, new FakeIdGenerator("dispatch"));
        const created = await engine.createMission({
            intent: {
                requestId: "request-dispatch",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const proposal = await engine.proposePlan(created.missionId, planFor(created));
        if (!proposal.ok) throw new Error("scheduler plan was rejected");
        await engine.acceptPlan(created.missionId, proposal.revision.revisionId);

        const registry = createRegistry();
        let invokeCount = 0;
        const seam = new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME));
        seam.registerConnector("lifeos.query", {
            connectorContractVersion: 1,
            capabilityId: "lifeos.query",
            describe: () => registry.requireDescriptor("lifeos.query"),
            invoke: async (request) => {
                invokeCount++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId: request.requestId,
                    summary: "status read",
                    evidence: [],
                };
            },
        });
        const scheduler = new MissionScheduler({
            engine,
            store,
            seam,
            clock: new FakeClock(BASE_TIME),
        });

        const report = await scheduler.runOnce();
        expect(invokeCount).toBe(1);
        expect(report.dispatchedInvocationIds).toHaveLength(1);
        const invocations = await store.listInvocations(created.missionId);
        expect(invocations).toHaveLength(1);
        expect(invocations[0].status).toBe(InvocationStatus.COMPLETED);
    });

    it("does not starve later reconciliation or hide its future wake behind permanent blockers", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const clock = new FakeClock(BASE_TIME);
        const engine = new MissionEngine({
            store,
            policy: new PlanPolicyValidator((() => {
                const resolver = new FakeCapabilityResolver();
                resolver.registerMany(makeDefaultCapabilityCatalog());
                return resolver;
            })()),
            clock,
            ids: new FakeIdGenerator("starvation"),
            interpreter: (intent) => intent.originalIntent,
            verificationAuthority: new FakeVerificationAuthority(),
        });
        const mission = await engine.createMission({
            intent: {
                requestId: "request-starvation",
                source: "cli",
                originalIntent: "Read several durable statuses",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const proposal = await engine.proposePlan(mission.missionId, {
            planId: "starvation-plan",
            missionId: mission.missionId,
            plannerNote: "starvation regression plan",
            steps: [
                {
                    stepId: "reconcile-later",
                    desiredOutcome: "Read later status",
                    dependencyIds: [],
                    capabilityRequirement: "lifeos.query",
                    inputRefs: ["refs/lifeos/later"],
                    expectedAcceptance: ["status read"],
                    effectClass: EffectClass.READ,
                },
                {
                    stepId: "future-retry",
                    desiredOutcome: "Read future status",
                    dependencyIds: [],
                    capabilityRequirement: "lifeos.query",
                    inputRefs: ["refs/lifeos/future"],
                    expectedAcceptance: ["status read"],
                    effectClass: EffectClass.READ,
                },
            ],
        });
        if (!proposal.ok) throw new Error("starvation plan was rejected");
        await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);

        const legacyBlocked = (index: number): CapabilityInvocation => ({
            invocationId: `old-blocked-${index}`,
            missionId: mission.missionId,
            stepId: `old-blocked-step-${index}`,
            capabilityId: "lifeos.query",
            planRevisionId: proposal.revision.revisionId,
            contractVersion: 1,
            moduleOwner: "lifeos",
            effectClass: EffectClass.READ,
            requestId: `old-request-${index}`,
            effectFingerprint: `old-effect-${index}`,
            inputRefs: [],
            idempotency: { mode: IdempotencyMode.IDEMPOTENT, key: `old-request-${index}` },
            retry: { maxAttempts: 0, attempt: 0, backoff: RetryBackoff.NONE, backoffMs: 0, nextEligibleAt: null },
            attempts: [],
            delivery: { state: "uncertain" },
            cancellation: { support: CancellationSupport.NONE, requested: false, state: "not_requested" },
            reconciliation: { support: ReconciliationSupport.STATUS_REPLAY, state: "unsupported" },
            ownerVerificationState: "not_required",
            status: InvocationStatus.BLOCKED,
            resultRefs: [],
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
        });
        for (let index = 1; index <= 3; index++) {
            await store.saveInvocation(legacyBlocked(index));
        }

        const later = await engine.dispatchStep(mission.missionId, "reconcile-later", {
            descriptor: {
                contractVersion: 1,
                moduleOwner: "lifeos",
                idempotency: { mode: IdempotencyMode.IDEMPOTENT, keyScope: "request" },
                retry: { maxAttempts: 3, backoff: RetryBackoff.FIXED },
                cancellationSupport: CancellationSupport.NONE,
                reconciliationSupport: ReconciliationSupport.STATUS_REPLAY,
            },
        });
        await engine.markInvocationHandoff(later.invocationId, { deliveryState: "uncertain" });

        const future = await engine.dispatchStep(mission.missionId, "future-retry", {
            descriptor: {
                contractVersion: 1,
                moduleOwner: "lifeos",
                idempotency: { mode: IdempotencyMode.IDEMPOTENT, keyScope: "request" },
                retry: { maxAttempts: 3, backoff: RetryBackoff.FIXED },
                cancellationSupport: CancellationSupport.NONE,
                reconciliationSupport: ReconciliationSupport.STATUS_REPLAY,
            },
        });
        await engine.recordInvocationResult(future.invocationId, {
            invocationId: future.invocationId,
            status: InvocationStatus.FAILED,
            summary: "transient failure before retry",
            evidenceRefs: [],
            completedAt: BASE_TIME,
        });
        const futureRetryAt = "2026-09-03T18:05:00.000Z";
        await engine.prepareInvocationRetry(future.invocationId, { backoffMs: 5 * 60 * 1000 });
        expect((await store.getInvocation(future.invocationId))?.retry.nextEligibleAt).toBe(futureRetryAt);

        let reconcileCount = 0;
        let invokeCount = 0;
        const registry = createRegistry();
        const seam = new ConnectorDispatchSeam(engine, registry, clock);
        seam.registerConnector("lifeos.query", {
            connectorContractVersion: 1,
            capabilityId: "lifeos.query",
            describe: () => registry.requireDescriptor("lifeos.query"),
            invoke: async (request) => {
                invokeCount++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId: request.requestId,
                    summary: "unexpected direct invocation",
                    evidence: [],
                };
            },
            reconcile: async (requestId) => {
                reconcileCount++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId,
                    summary: "reconciled later status",
                    evidence: [],
                };
            },
        });
        const scheduler = new MissionScheduler({
            engine,
            store,
            seam,
            clock,
            recoveryBatchSize: 2,
        });

        expect(await store.getInvocation(later.invocationId)).toMatchObject({
            status: InvocationStatus.DISPATCHED,
            delivery: { state: "uncertain" },
            reconciliation: { state: "pending" },
        });
        expect((await store.listActionableInvocations(2)).map((invocation) => invocation.invocationId)).toEqual([
            later.invocationId,
        ]);
        const report = await scheduler.runOnce();
        expect(reconcileCount).toBe(1);
        expect(invokeCount).toBe(0);
        expect(report.reconciledInvocationIds).toEqual([later.invocationId]);
        expect((await store.getInvocation(later.invocationId))?.status).toBe(InvocationStatus.COMPLETED);
        expect(report.nextWakeAt).toBe(futureRetryAt);
        await store.close();
    });

    it("resumes a durable pre-handoff invocation after restart without creating a second row", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const clock = new FakeClock(BASE_TIME);
        const engine = new MissionEngine({
            store,
            policy: new PlanPolicyValidator((() => {
                const resolver = new FakeCapabilityResolver();
                resolver.registerMany(makeDefaultCapabilityCatalog());
                return resolver;
            })()),
            clock,
            ids: new FakeIdGenerator("pre-handoff"),
            interpreter: (intent) => intent.originalIntent,
            verificationAuthority: new FakeVerificationAuthority(),
        });
        const created = await engine.createMission({
            intent: {
                requestId: "request-pre-handoff",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const proposal = await engine.proposePlan(created.missionId, planFor(created));
        if (!proposal.ok) throw new Error("pre-handoff plan was rejected");
        await engine.acceptPlan(created.missionId, proposal.revision.revisionId);
        const invocation = await engine.dispatchStep(created.missionId, "read-status", {
            descriptor: {
                contractVersion: 1,
                moduleOwner: "lifeos",
                idempotency: { mode: IdempotencyMode.IDEMPOTENT, keyScope: "request" },
                retry: { maxAttempts: 3, backoff: RetryBackoff.FIXED },
                cancellationSupport: CancellationSupport.NONE,
                reconciliationSupport: ReconciliationSupport.STATUS_REPLAY,
            },
        });
        expect(invocation.delivery.state).toBe("not_submitted");
        expect(await store.listDueInvocations(BASE_TIME, 10)).toHaveLength(1);

        const registry = createRegistry();
        const seam = new ConnectorDispatchSeam(engine, registry, clock);
        let invokes = 0;
        seam.registerConnector("lifeos.query", {
            connectorContractVersion: 1,
            capabilityId: "lifeos.query",
            describe: () => registry.requireDescriptor("lifeos.query"),
            invoke: async (request) => {
                invokes++;
                return { status: CapabilityResultStatus.COMPLETED, requestId: request.requestId, summary: "read", evidence: [] };
            },
        });

        const scheduler = new MissionScheduler({ engine, store, seam, clock });
        await scheduler.runOnce();

        expect(invokes).toBe(1);
        expect(await store.listInvocations(created.missionId)).toHaveLength(1);
        expect((await store.getInvocation(invocation.invocationId))?.status).toBe(InvocationStatus.COMPLETED);
    });

    it("reconciles an uncertain invocation after restart without a second invoke", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const engine = createEngine(store, new FakeIdGenerator("uncertain"));
        const created = await engine.createMission({
            intent: {
                requestId: "request-uncertain",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const proposal = await engine.proposePlan(created.missionId, planFor(created));
        if (!proposal.ok) throw new Error("scheduler plan was rejected");
        await engine.acceptPlan(created.missionId, proposal.revision.revisionId);

        const registry = createRegistry();
        let invokeCount = 0;
        let reconcileCount = 0;
        const seam = new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME));
        seam.registerConnector("lifeos.query", {
            connectorContractVersion: 1,
            capabilityId: "lifeos.query",
            describe: () => registry.requireDescriptor("lifeos.query"),
            invoke: async () => {
                invokeCount++;
                throw new Error("ack lost after owner accepted request");
            },
            reconcile: async (requestId) => {
                reconcileCount++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId,
                    summary: "status read",
                    evidence: [],
                };
            },
        });
        await expect(seam.dispatchThroughSeam(created.missionId, "read-status")).rejects.toThrow(/uncertain/);

        const scheduler = new MissionScheduler({
            engine,
            store,
            seam,
            clock: new FakeClock(BASE_TIME),
        });
        const report = await scheduler.runOnce();
        const invocation = (await store.listInvocations(created.missionId))[0];

        expect(invokeCount).toBe(1);
        expect(reconcileCount).toBe(1);
        expect(report.reconciledInvocationIds).toEqual([invocation.invocationId]);
        expect(invocation.status).toBe(InvocationStatus.COMPLETED);
    });

    it("returns a persisted future wakeup without polling or dispatching early", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const clock = new FakeClock(BASE_TIME);
        const engine = new MissionEngine({
            store,
            policy: new PlanPolicyValidator((() => {
                const resolver = new FakeCapabilityResolver();
                resolver.registerMany(makeDefaultCapabilityCatalog());
                return resolver;
            })()),
            clock,
            ids: new FakeIdGenerator("wake"),
            interpreter: (intent) => intent.originalIntent,
            verificationAuthority: new FakeVerificationAuthority(),
        });
        const created = await engine.createMission({
            intent: {
                requestId: "request-wake",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const proposal = await engine.proposePlan(created.missionId, planFor(created));
        if (!proposal.ok) throw new Error("scheduler plan was rejected");
        await engine.acceptPlan(created.missionId, proposal.revision.revisionId);
        const invocation = await engine.dispatchStep(created.missionId, "read-status", {
            descriptor: {
                contractVersion: 1,
                moduleOwner: "lifeos",
                idempotency: { mode: "idempotent", keyScope: "request" },
                retry: { maxAttempts: 3, backoff: "fixed" },
                cancellationSupport: "unsupported",
                reconciliationSupport: "none",
            },
        });
        await engine.recordInvocationResult(invocation.invocationId, {
            invocationId: invocation.invocationId,
            status: InvocationStatus.FAILED,
            summary: "definitive pre-effect validation failure",
            evidenceRefs: [],
            completedAt: BASE_TIME,
        });
        await engine.prepareInvocationRetry(invocation.invocationId, { backoffMs: 86_400_000 });

        const registry = createRegistry();
        const seam = new ConnectorDispatchSeam(engine, registry, clock);
        let invoked = 0;
        seam.registerConnector("lifeos.query", {
            connectorContractVersion: 1,
            capabilityId: "lifeos.query",
            describe: () => registry.requireDescriptor("lifeos.query"),
            invoke: async (request) => {
                invoked++;
                return { status: CapabilityResultStatus.COMPLETED, requestId: request.requestId, summary: "read", evidence: [] };
            },
        });
        const scheduler = new MissionScheduler({ engine, store, seam, clock });

        const report = await scheduler.runOnce();

        expect(invoked).toBe(0);
        expect(report.nextWakeAt).toBe("2026-09-04T18:00:00.000Z");
        expect((await store.getInvocation(invocation.invocationId))?.retry.nextEligibleAt).toBe(
            "2026-09-04T18:00:00.000Z",
        );
    });

    it("isolates an unavailable capability while dispatching an unrelated mission", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const engine = createEngine(store, new FakeIdGenerator("isolation"));
        const unavailableMission = await engine.createMission({
            intent: {
                requestId: "request-unavailable",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const unavailablePlan = await engine.proposePlan(unavailableMission.missionId, planFor(unavailableMission));
        if (!unavailablePlan.ok) throw new Error("unavailable plan was rejected");
        await engine.acceptPlan(unavailableMission.missionId, unavailablePlan.revision.revisionId);

        const otherMission = await engine.createMission({
            intent: {
                requestId: "request-other",
                source: "cli",
                originalIntent: "Review the Runstead change",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: {
                capabilityIds: ["runstead.code-review"],
                allowedEffectClasses: [EffectClass.EXECUTION],
                allowedRefPrefixes: ["refs/runstead/"],
            },
        });
        const otherPlan = await engine.proposePlan(otherMission.missionId, planFor(otherMission, {
            capabilityId: "runstead.code-review",
            effectClass: EffectClass.EXECUTION,
            inputRef: "refs/runstead/change-1",
        }));
        if (!otherPlan.ok) throw new Error("other plan was rejected");
        await engine.acceptPlan(otherMission.missionId, otherPlan.revision.revisionId);

        const registry = createRegistry();
        registry.setAvailability("lifeos.query", CapabilityAvailability.UNAVAILABLE, "LifeOS offline");
        const seam = new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME));
        let otherInvokes = 0;
        seam.registerConnector("lifeos.query", {
            connectorContractVersion: 1,
            capabilityId: "lifeos.query",
            describe: () => registry.requireDescriptor("lifeos.query"),
            invoke: async (request) => ({ status: CapabilityResultStatus.COMPLETED, requestId: request.requestId, summary: "unused", evidence: [] }),
        });
        seam.registerConnector("runstead.code-review", {
            connectorContractVersion: 1,
            capabilityId: "runstead.code-review",
            describe: () => registry.requireDescriptor("runstead.code-review"),
            invoke: async (request) => {
                otherInvokes++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId: request.requestId,
                    summary: "reviewed",
                    evidence: [],
                    ownerVerification: {
                        owner: "runstead",
                        verified: true,
                        reason: "reviewed",
                    },
                };
            },
        });
        const scheduler = new MissionScheduler({
            engine,
            store,
            seam,
            clock: new FakeClock(BASE_TIME),
            maxInFlight: 2,
        });

        const report = await scheduler.runOnce();

        expect(otherInvokes).toBe(1);
        expect(report.waitingMissionIds).toContain(unavailableMission.missionId);
        expect((await store.getMission(unavailableMission.missionId))?.state).toBe(
            MissionState.WAITING_FOR_CAPABILITY,
        );
        expect((await store.getMission(otherMission.missionId))?.invocationRefs[0].status).toBe(
            InvocationStatus.COMPLETED,
        );
    });

    it("isolates a missing recovery connector while preserving the uncertain invocation", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const engine = createEngine(store, new FakeIdGenerator("recovery-isolation"));
        const broken = await engine.createMission({
            intent: {
                requestId: "request-broken-recovery",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const brokenPlan = await engine.proposePlan(broken.missionId, planFor(broken));
        if (!brokenPlan.ok) throw new Error("broken recovery plan was rejected");
        await engine.acceptPlan(broken.missionId, brokenPlan.revision.revisionId);
        const uncertain = await engine.dispatchStep(broken.missionId, "read-status", {
            descriptor: {
                contractVersion: 1,
                moduleOwner: "lifeos",
                idempotency: { mode: IdempotencyMode.IDEMPOTENT, keyScope: "request" },
                retry: { maxAttempts: 3, backoff: RetryBackoff.FIXED },
                cancellationSupport: CancellationSupport.NONE,
                reconciliationSupport: ReconciliationSupport.STATUS_REPLAY,
            },
        });
        await engine.markInvocationHandoff(uncertain.invocationId, { deliveryState: "uncertain" });

        const other = await engine.createMission({
            intent: {
                requestId: "request-healthy-recovery",
                source: "cli",
                originalIntent: "Review the Runstead change",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: {
                capabilityIds: ["runstead.code-review"],
                allowedEffectClasses: [EffectClass.EXECUTION],
                allowedRefPrefixes: ["refs/runstead/"],
            },
        });
        const otherPlan = await engine.proposePlan(other.missionId, planFor(other, {
            capabilityId: "runstead.code-review",
            effectClass: EffectClass.EXECUTION,
            inputRef: "refs/runstead/change-recovery",
        }));
        if (!otherPlan.ok) throw new Error("healthy recovery plan was rejected");
        await engine.acceptPlan(other.missionId, otherPlan.revision.revisionId);

        const registry = createRegistry();
        const seam = new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME));
        let healthyInvokes = 0;
        seam.registerConnector("runstead.code-review", {
            connectorContractVersion: 1,
            capabilityId: "runstead.code-review",
            describe: () => registry.requireDescriptor("runstead.code-review"),
            invoke: async (request) => {
                healthyInvokes++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId: request.requestId,
                    summary: "reviewed",
                    evidence: [],
                    ownerVerification: { owner: "runstead", verified: true, reason: "owner reviewed" },
                };
            },
        });
        const scheduler = new MissionScheduler({ engine, store, seam, clock: new FakeClock(BASE_TIME), maxInFlight: 2 });

        await scheduler.runOnce();

        expect(healthyInvokes).toBe(1);
        expect((await store.getMission(broken.missionId))?.state).toBe(MissionState.WAITING_FOR_CAPABILITY);
        expect((await store.getInvocation(uncertain.invocationId))?.status).toBe(InvocationStatus.BLOCKED);
        expect((await store.getInvocation(uncertain.invocationId))?.delivery.state).toBe("uncertain");
        expect((await store.getMission(other.missionId))?.invocationRefs[0].status).toBe(InvocationStatus.COMPLETED);
    });

    it("does not overwrite an approval wait while an uncertain invocation lacks its connector", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const engine = createEngine(store, new FakeIdGenerator("wait-preservation"));
        const mission = await engine.createMission({
            intent: {
                requestId: "request-wait-preservation",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const proposal = await engine.proposePlan(mission.missionId, planFor(mission));
        if (!proposal.ok) throw new Error("wait-preservation plan was rejected");
        await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);
        const invocation = await engine.dispatchStep(mission.missionId, "read-status", {
            descriptor: {
                contractVersion: 1,
                moduleOwner: "lifeos",
                idempotency: { mode: IdempotencyMode.IDEMPOTENT, keyScope: "request" },
                retry: { maxAttempts: 3, backoff: RetryBackoff.FIXED },
                cancellationSupport: CancellationSupport.NONE,
                reconciliationSupport: ReconciliationSupport.STATUS_REPLAY,
            },
        });
        await engine.markInvocationHandoff(invocation.invocationId, { deliveryState: "uncertain" });
        await engine.setWaiting(mission.missionId, MissionState.WAITING_FOR_APPROVAL, "operator approval remains required");

        const registry = createRegistry();
        const scheduler = new MissionScheduler({
            engine,
            store,
            seam: new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME)),
            clock: new FakeClock(BASE_TIME),
        });

        await scheduler.runOnce();

        expect((await store.getMission(mission.missionId))?.state).toBe(MissionState.WAITING_FOR_APPROVAL);
        expect((await store.getInvocation(invocation.invocationId))?.delivery.state).toBe("uncertain");
    });

    it("does not invoke a completed effect again in a fresh scheduler instance", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const engine = createEngine(store, new FakeIdGenerator("completed"));
        const created = await engine.createMission({
            intent: {
                requestId: "request-completed",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const proposal = await engine.proposePlan(created.missionId, planFor(created));
        if (!proposal.ok) throw new Error("completed plan was rejected");
        await engine.acceptPlan(created.missionId, proposal.revision.revisionId);
        const registry = createRegistry();
        const seam = new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME));
        let invokes = 0;
        seam.registerConnector("lifeos.query", {
            connectorContractVersion: 1,
            capabilityId: "lifeos.query",
            describe: () => registry.requireDescriptor("lifeos.query"),
            invoke: async (request) => {
                invokes++;
                return { status: CapabilityResultStatus.COMPLETED, requestId: request.requestId, summary: "done", evidence: [] };
            },
        });

        const first = new MissionScheduler({ engine, store, seam, clock: new FakeClock(BASE_TIME) });
        await Promise.all([first.runOnce(), first.runOnce()]);
        const second = new MissionScheduler({ engine, store, seam, clock: new FakeClock(BASE_TIME) });
        await second.runOnce();

        expect(invokes).toBe(1);
        expect((await store.listInvocations(created.missionId))).toHaveLength(1);
    });

    it("waits for nextEligibleAt, then performs only the explicitly prepared retry", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const clock = new FakeClock(BASE_TIME);
        const engine = new MissionEngine({
            store,
            policy: new PlanPolicyValidator((() => {
                const resolver = new FakeCapabilityResolver();
                resolver.registerMany(makeDefaultCapabilityCatalog());
                return resolver;
            })()),
            clock,
            ids: new FakeIdGenerator("retry"),
            interpreter: (intent) => intent.originalIntent,
            verificationAuthority: new FakeVerificationAuthority(),
        });
        const created = await engine.createMission({
            intent: {
                requestId: "request-retry",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const proposal = await engine.proposePlan(created.missionId, planFor(created));
        if (!proposal.ok) throw new Error("retry plan was rejected");
        await engine.acceptPlan(created.missionId, proposal.revision.revisionId);
        const invocation = await engine.dispatchStep(created.missionId, "read-status", {
            descriptor: {
                contractVersion: 1,
                moduleOwner: "lifeos",
                idempotency: { mode: IdempotencyMode.IDEMPOTENT, keyScope: "request" },
                retry: { maxAttempts: 3, backoff: RetryBackoff.FIXED },
                cancellationSupport: CancellationSupport.NONE,
                reconciliationSupport: ReconciliationSupport.STATUS_REPLAY,
            },
        });
        await engine.recordInvocationResult(invocation.invocationId, {
            invocationId: invocation.invocationId,
            status: InvocationStatus.FAILED,
            summary: "definitive pre-effect failure",
            evidenceRefs: [],
            completedAt: BASE_TIME,
        });
        await engine.prepareInvocationRetry(invocation.invocationId, { backoffMs: 60 * 60 * 1000 });

        const registry = createRegistry();
        const seam = new ConnectorDispatchSeam(engine, registry, clock);
        let invokes = 0;
        seam.registerConnector("lifeos.query", {
            connectorContractVersion: 1,
            capabilityId: "lifeos.query",
            describe: () => registry.requireDescriptor("lifeos.query"),
            invoke: async (request) => {
                invokes++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId: request.requestId,
                    summary: "retried status read",
                    evidence: [],
                };
            },
        });
        const scheduler = new MissionScheduler({ engine, store, seam, clock });

        const beforeDue = await scheduler.runOnce();
        expect(invokes).toBe(0);
        expect(beforeDue.nextWakeAt).toBe("2026-09-03T19:00:00.000Z");
        clock.advance(60 * 60 * 1000);

        const due = await scheduler.runOnce();
        expect(invokes).toBe(1);
        expect(due.dispatchedInvocationIds).toEqual([invocation.invocationId]);
        expect((await store.getInvocation(invocation.invocationId))?.status).toBe(InvocationStatus.COMPLETED);
    });

    it("does not dispatch canceled waiting work and resumes paused work only after an explicit resume", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const engine = createEngine(store, new FakeIdGenerator("controls"));
        const canceled = await engine.createMission({
            intent: {
                requestId: "request-canceled-wait",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const canceledPlan = await engine.proposePlan(canceled.missionId, planFor(canceled));
        if (!canceledPlan.ok) throw new Error("canceled plan was rejected");
        await engine.acceptPlan(canceled.missionId, canceledPlan.revision.revisionId);
        await engine.setWaiting(canceled.missionId, MissionState.WAITING_FOR_CAPABILITY, "owner offline");
        await engine.cancelMission(canceled.missionId, "operator canceled while waiting");

        const paused = await engine.createMission({
            intent: {
                requestId: "request-paused",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const pausedPlan = await engine.proposePlan(paused.missionId, planFor(paused));
        if (!pausedPlan.ok) throw new Error("paused plan was rejected");
        await engine.acceptPlan(paused.missionId, pausedPlan.revision.revisionId);
        await engine.pauseMission(paused.missionId, "operator hold");

        const registry = createRegistry();
        const seam = new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME));
        let invokes = 0;
        seam.registerConnector("lifeos.query", {
            connectorContractVersion: 1,
            capabilityId: "lifeos.query",
            describe: () => registry.requireDescriptor("lifeos.query"),
            invoke: async (request) => {
                invokes++;
                return { status: CapabilityResultStatus.COMPLETED, requestId: request.requestId, summary: "read", evidence: [] };
            },
        });
        const scheduler = new MissionScheduler({ engine, store, seam, clock: new FakeClock(BASE_TIME) });

        await scheduler.runOnce();
        expect(invokes).toBe(0);
        expect((await store.getMission(canceled.missionId))?.state).toBe(MissionState.CANCELLED);
        expect((await store.getMission(paused.missionId))?.state).toBe(MissionState.PAUSED);

        await engine.resumeMission(paused.missionId);
        await scheduler.runOnce();
        expect(invokes).toBe(1);
        expect((await store.getMission(paused.missionId))?.invocationRefs[0].status).toBe(InvocationStatus.COMPLETED);
    });

    it("restores a capability wait only when the same capability becomes available", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const engine = createEngine(store, new FakeIdGenerator("availability"));
        const created = await engine.createMission({
            intent: {
                requestId: "request-availability",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const proposal = await engine.proposePlan(created.missionId, planFor(created));
        if (!proposal.ok) throw new Error("availability plan was rejected");
        await engine.acceptPlan(created.missionId, proposal.revision.revisionId);

        const registry = createRegistry();
        registry.setAvailability("lifeos.query", CapabilityAvailability.UNAVAILABLE, "LifeOS offline");
        const seam = new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME));
        let invokes = 0;
        seam.registerConnector("lifeos.query", {
            connectorContractVersion: 1,
            capabilityId: "lifeos.query",
            describe: () => registry.requireDescriptor("lifeos.query"),
            invoke: async (request) => {
                invokes++;
                return { status: CapabilityResultStatus.COMPLETED, requestId: request.requestId, summary: "read", evidence: [] };
            },
        });
        const scheduler = new MissionScheduler({ engine, store, seam, clock: new FakeClock(BASE_TIME) });

        await scheduler.runOnce();
        expect(invokes).toBe(0);
        expect((await store.getMission(created.missionId))?.state).toBe(MissionState.WAITING_FOR_CAPABILITY);

        registry.setAvailability("lifeos.query", CapabilityAvailability.AVAILABLE);
        await scheduler.runOnce();
        expect(invokes).toBe(1);
        expect((await store.getMission(created.missionId))?.invocationRefs[0].status).toBe(InvocationStatus.COMPLETED);
    });

    it("does not satisfy a revised dependency from a completed effect with the same step id", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const clock = new FakeClock(BASE_TIME);
        const engine = createEngine(store, new FakeIdGenerator("revision"));
        const created = await engine.createMission({
            intent: {
                requestId: "request-revision-dependency",
                source: "cli",
                originalIntent: "Read the current LifeOS status",
                constraints: [],
                acceptanceCriteria: ["status read"],
            },
            allowedCapabilityScope: makeMission("unused").allowedCapabilityScope,
        });
        const firstPlan: PlanCandidate = {
            planId: "plan-old",
            missionId: created.missionId,
            plannerNote: "old plan",
            steps: [
                {
                    stepId: "prepare",
                    desiredOutcome: "Read the old status",
                    dependencyIds: [],
                    capabilityRequirement: "lifeos.query",
                    inputRefs: ["refs/lifeos/old"],
                    expectedAcceptance: ["status read"],
                    effectClass: EffectClass.READ,
                },
                {
                    stepId: "consume",
                    desiredOutcome: "Consume the old status",
                    dependencyIds: ["prepare"],
                    capabilityRequirement: "lifeos.query",
                    inputRefs: ["refs/lifeos/consume-old"],
                    expectedAcceptance: ["status read"],
                    effectClass: EffectClass.READ,
                },
            ],
        };
        const proposedFirst = await engine.proposePlan(created.missionId, firstPlan);
        if (!proposedFirst.ok) throw new Error("old dependency plan was rejected");
        await engine.acceptPlan(created.missionId, proposedFirst.revision.revisionId);
        const registry = createRegistry();
        const seam = new ConnectorDispatchSeam(engine, registry, clock);
        const outcomes: string[] = [];
        seam.registerConnector("lifeos.query", {
            connectorContractVersion: 1,
            capabilityId: "lifeos.query",
            describe: () => registry.requireDescriptor("lifeos.query"),
            invoke: async (request) => {
                outcomes.push(request.desiredOutcome);
                return { status: CapabilityResultStatus.COMPLETED, requestId: request.requestId, summary: "read", evidence: [] };
            },
        });
        const scheduler = new MissionScheduler({ engine, store, seam, clock, maxInFlight: 2 });
        await scheduler.runOnce();
        expect(outcomes).toEqual(["Read the old status"]);

        const revisedPlan: PlanCandidate = {
            ...firstPlan,
            planId: "plan-new",
            plannerNote: "revised plan",
            steps: [
                {
                    ...firstPlan.steps[0],
                    desiredOutcome: "Read the new status",
                    inputRefs: ["refs/lifeos/new"],
                },
                firstPlan.steps[1],
            ],
        };
        const proposedRevision = await engine.proposePlan(created.missionId, revisedPlan);
        if (!proposedRevision.ok) throw new Error("new dependency plan was rejected");
        await engine.acceptPlan(created.missionId, proposedRevision.revision.revisionId);

        await scheduler.runOnce();
        expect(outcomes).toEqual(["Read the old status", "Read the new status"]);
        expect(await store.listInvocations(created.missionId)).toHaveLength(2);

        await scheduler.runOnce();
        expect(outcomes).toEqual(["Read the old status", "Read the new status", "Consume the old status"]);
    });
});
