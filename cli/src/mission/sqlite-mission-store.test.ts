/**
 * 💾 Mission Store Tests (Issue #62)
 *
 * Proves durable persistence and recovery of the Mission contract:
 *  - Mission + current plan revision survive restart/reinstantiation;
 *  - completed invocation/effect references are neither lost nor
 *    duplicated by recovery or replan;
 *  - waiting_* states persist as waiting states;
 *  - no credential/Authorization/CoT/prompt/raw provider response is
 *    ever persisted.
 *
 * No real sleeps are used: durability is proven by closing and reopening
 * the store against the same database file.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    EffectClass,
    CapabilityInvocation,
    CapabilityInvocationRef,
    InvocationStatus,
    MISSION_CONTRACT_VERSION,
    Mission,
    MissionIntent,
    MissionState,
    PlanStep,
} from "./contracts.js";
import {
    CancellationSupport,
    IdempotencyMode,
    ReconciliationSupport,
    RetryBackoff,
} from "../capabilities/contracts.js";
import { SqliteMissionStore } from "./sqlite-mission-store.js";
import { MissionEngine } from "./mission-engine.js";
import { PlanPolicyValidator } from "./policy.js";
import {
    FakeCapabilityResolver,
    FakeClock,
    FakeIdGenerator,
    FakeVerificationAuthority,
    makeDefaultCapabilityCatalog,
} from "./testing.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const BASE_TIME = "2026-08-30T12:00:00.000Z";

function makeIntent(source: MissionIntent["source"] = "cli"): MissionIntent {
    return {
        requestId: "req-1",
        source,
        originalIntent: "Review and merge the pending pull request",
        constraints: ["Do not modify unrelated files"],
        acceptanceCriteria: ["PR merged", "CI green"],
        contextRefs: [],
    };
}

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
    return {
        stepId: "step-1",
        desiredOutcome: "Run code review",
        dependencyIds: [],
        capabilityRequirement: "runstead.code-review",
        inputRefs: ["refs/runstead/pr/42"],
        expectedAcceptance: ["Review completed"],
        effectClass: EffectClass.EXECUTION,
        ...overrides,
    };
}

const DEFAULT_SCOPE = {
    capabilityIds: ["runstead.code-review"],
    allowedEffectClasses: [EffectClass.EXECUTION],
    allowedRefPrefixes: ["refs/runstead/"],
};

interface TempDir {
    path: string;
    cleanup: () => void;
}

function makeTempDir(prefix: string): TempDir {
    const path = mkdtempSync(join(tmpdir(), prefix));
    return {
        path,
        cleanup: () => rmSync(path, { recursive: true, force: true }),
    };
}

interface EngineFactory {
    (clock: FakeClock, ids: FakeIdGenerator, store: SqliteMissionStore): MissionEngine;
}

function makeEngineFactory(): EngineFactory {
    return (clock, ids, store) => {
        const resolver = new FakeCapabilityResolver();
        resolver.registerMany(makeDefaultCapabilityCatalog());
        const policy = new PlanPolicyValidator(resolver);
        return new MissionEngine({
            store,
            policy,
            clock,
            ids,
            interpreter: (i) => i.originalIntent,
            verificationAuthority: new FakeVerificationAuthority(),
        });
    };
}

const buildEngine = makeEngineFactory();

const INVOCATION_TIME = "2026-08-30T12:00:00.000Z";

function makeFullInvocation(
    missionId: string,
    overrides: Partial<CapabilityInvocation> = {},
): CapabilityInvocation {
    return {
        invocationId: "invocation-full-1",
        missionId,
        stepId: "step-1",
        capabilityId: "runstead.code-review",
        planRevisionId: "revision-1",
        effectFingerprint: "fingerprint-1",
        contractVersion: 7,
        moduleOwner: "runstead",
        status: InvocationStatus.PENDING,
        requestId: "request-1",
        inputRefs: ["refs/runstead/pr/42"],
        idempotency: { mode: IdempotencyMode.IDEMPOTENT, key: "idempotency-1" },
        retry: {
            maxAttempts: 3,
            attempt: 0,
            backoff: RetryBackoff.FIXED,
            backoffMs: 5_000,
            nextEligibleAt: "2026-08-30T12:05:00.000Z",
        },
        attempts: [
            {
                attempt: 0,
                correlationId: "correlation-1",
                state: "prepared",
                startedAt: INVOCATION_TIME,
            },
        ],
        delivery: {
            state: "acknowledged",
            acknowledgedAt: INVOCATION_TIME,
            remoteOperationHandle: "remote-operation-1",
        },
        cancellation: {
            support: CancellationSupport.COOPERATIVE,
            requested: false,
            state: "not_requested",
        },
        reconciliation: {
            support: ReconciliationSupport.STATUS_REPLAY,
            state: "not_required",
        },
        resultRefs: [
            {
                refId: "evidence-1",
                owner: "runstead",
                externalRef: "refs/runstead/review/1",
                label: "review result",
            },
        ],
        ownerVerification: {
            invocationId: "invocation-full-1",
            verified: true,
            reason: "owner accepted",
            owner: "runstead",
            verifiedAt: INVOCATION_TIME,
        },
        ownerVerificationState: "verified",
        createdAt: INVOCATION_TIME,
        updatedAt: INVOCATION_TIME,
        ...overrides,
    };
}

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

describe("SqliteMissionStore (durability + recovery)", () => {
    const tempDirs: TempDir[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            dir.cleanup();
        }
        tempDirs.length = 0;
    });

    function track(dir: TempDir): TempDir {
        tempDirs.push(dir);
        return dir;
    }

    it("recovers a Mission and its current plan revision after store restart", async () => {
        const dir = track(makeTempDir("mission-store-"));
        const dbPath = join(dir.path, "missions.db");

        // First process lifetime.
        const clock = new FakeClock(BASE_TIME);
        const ids = new FakeIdGenerator("id-a");
        const store1 = new SqliteMissionStore(dbPath);
        await store1.initialize();
        const engine1 = buildEngine(clock, ids, store1);

        const intent = makeIntent("katherine");
        const mission = await engine1.createMission({
            intent,
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        const proposal = await engine1.proposePlan(
            mission.missionId,
            {
                planId: "plan-1",
                missionId: mission.missionId,
                plannerNote: "proposal",
                steps: [makeStep()],
            },
        );
        if (!proposal.ok) throw new Error("plan rejected");
        await engine1.acceptPlan(mission.missionId, proposal.revision.revisionId);

        await store1.close();

        // Second process lifetime: same file, fresh instances.
        const store2 = new SqliteMissionStore(dbPath);
        await store2.initialize();
        const engine2 = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-b"), store2);

        const recovered = await engine2.getMission(mission.missionId);
        expect(recovered).not.toBeNull();
        expect(recovered!.originalIntent).toBe(intent.originalIntent);
        expect(recovered!.acceptanceCriteria).toEqual(intent.acceptanceCriteria);
        expect(recovered!.constraints).toEqual(intent.constraints);
        expect(recovered!.state).toBe(MissionState.READY);
        expect(recovered!.currentPlanRevisionId).toBe(proposal.revision.revisionId);
        expect(recovered!.recoveryMetadata.recovered).toBe(false); // store does not mutate on read

        // Current plan revision is fully recoverable, steps intact.
        const revisions = await store2.getPlanRevisions(mission.missionId);
        expect(revisions).toHaveLength(1);
        expect(revisions[0].revisionId).toBe(proposal.revision.revisionId);
        expect(revisions[0].steps).toHaveLength(1);
        expect(revisions[0].steps[0].capabilityRequirement).toBe("runstead.code-review");
        expect(revisions[0].status).toBe("accepted");

        await store2.close();
    });

    it("does not lose or duplicate completed invocation refs across recovery", async () => {
        const dir = track(makeTempDir("mission-recovery-"));
        const dbPath = join(dir.path, "missions.db");

        const clock = new FakeClock(BASE_TIME);
        const store1 = new SqliteMissionStore(dbPath);
        await store1.initialize();
        const engine1 = buildEngine(clock, new FakeIdGenerator("id-a"), store1);

        const mission = await engine1.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        const proposal = await engine1.proposePlan(
            mission.missionId,
            {
                planId: "plan-1",
                missionId: mission.missionId,
                plannerNote: "proposal",
                steps: [makeStep()],
            },
        );
        if (!proposal.ok) throw new Error("plan rejected");
        await engine1.acceptPlan(mission.missionId, proposal.revision.revisionId);

        const invocation = await engine1.dispatchStep(mission.missionId, "step-1");
        await engine1.recordInvocationResult(
            invocation.invocationId,
            {
                invocationId: invocation.invocationId,
                status: InvocationStatus.COMPLETED,
                summary: "done",
                evidenceRefs: [{ refId: "ev-1", owner: "runstead", externalRef: "r:1", label: "PR merged" }],
                completedAt: BASE_TIME,
            },
            {
                invocationId: invocation.invocationId,
                verified: true,
                reason: "ok",
                owner: "runstead",
                verifiedAt: BASE_TIME,
            },
        );

        await store1.close();

        // Recover: the completed invocation must appear exactly once.
        const store2 = new SqliteMissionStore(dbPath);
        await store2.initialize();
        const recovered = await store2.getMission(mission.missionId);
        expect(recovered!.invocationRefs).toHaveLength(1);
        expect(recovered!.invocationRefs[0].invocationId).toBe(invocation.invocationId);
        expect(recovered!.invocationRefs[0].status).toBe(InvocationStatus.COMPLETED);
        expect(recovered!.invocationRefs[0].ownerVerification?.verified).toBe(true);
        expect(recovered!.evidenceRefs).toHaveLength(1);

        const invocations = await store2.listInvocations(mission.missionId);
        expect(invocations).toHaveLength(1);
        expect(invocations[0].resultRefs).toHaveLength(1);

        await store2.close();
    });

    it("persists waiting_* states as waiting states, never as failure", async () => {
        const dir = track(makeTempDir("mission-waiting-"));
        const dbPath = join(dir.path, "missions.db");

        const store1 = new SqliteMissionStore(dbPath);
        await store1.initialize();
        const engine1 = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store1);

        const mission = await engine1.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        await engine1.setWaiting(
            mission.missionId,
            MissionState.WAITING_FOR_CAPABILITY,
            "capability temporarily unavailable",
        );

        await store1.close();

        const store2 = new SqliteMissionStore(dbPath);
        await store2.initialize();
        const recovered = await store2.getMission(mission.missionId);
        expect(recovered!.state).toBe(MissionState.WAITING_FOR_CAPABILITY);
        expect(recovered!.state).not.toBe(MissionState.FAILED_TERMINAL);
        expect(recovered!.unresolvedQuestions).toContain(
            "capability temporarily unavailable",
        );

        await store2.close();
    });

    it("keeps the current plan revision after a replan supersedes the old one", async () => {
        const dir = track(makeTempDir("mission-replan-"));
        const dbPath = join(dir.path, "missions.db");

        const store1 = new SqliteMissionStore(dbPath);
        await store1.initialize();
        const engine1 = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store1);

        const mission = await engine1.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        const p1 = await engine1.proposePlan(mission.missionId, {
            planId: "plan-1",
            missionId: mission.missionId,
            plannerNote: "v1",
            steps: [makeStep({ stepId: "step-1" })],
        });
        if (!p1.ok) throw new Error("plan rejected");
        await engine1.acceptPlan(mission.missionId, p1.revision.revisionId);

        const p2 = await engine1.proposePlan(mission.missionId, {
            planId: "plan-2",
            missionId: mission.missionId,
            plannerNote: "v2 after new evidence",
            steps: [makeStep({ stepId: "step-2" })],
        });
        if (!p2.ok) throw new Error("replan rejected");
        await engine1.acceptPlan(mission.missionId, p2.revision.revisionId);

        await store1.close();

        const store2 = new SqliteMissionStore(dbPath);
        await store2.initialize();
        const recovered = await store2.getMission(mission.missionId);
        expect(recovered!.currentPlanRevisionId).toBe(p2.revision.revisionId);

        const revisions = await store2.getPlanRevisions(mission.missionId);
        expect(revisions).toHaveLength(2);
        expect(revisions.find((r) => r.revisionId === p1.revision.revisionId)?.status).toBe(
            "superseded",
        );
        expect(revisions.find((r) => r.revisionId === p2.revision.revisionId)?.status).toBe(
            "accepted",
        );
        // Original intent survived replan and recovery.
        expect(recovered!.originalIntent).toBe(makeIntent().originalIntent);

        await store2.close();
    });

    it("persists no credential, Authorization, CoT, prompt or raw provider response", async () => {
        const dir = track(makeTempDir("mission-safe-"));
        const dbPath = join(dir.path, "missions.db");

        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        const engine = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store);

        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        const proposal = await engine.proposePlan(mission.missionId, {
            planId: "plan-1",
            missionId: mission.missionId,
            plannerNote: "proposal",
            steps: [makeStep()],
        });
        if (!proposal.ok) throw new Error("plan rejected");
        await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);

        const serialized = JSON.stringify(mission);

        // Forbidden content must never appear in persisted Mission state.
        const forbiddenPatterns = [
            /api[_-]?key/i,
            /authorization/i,
            /bearer\s+[a-z0-9]/i,
            /chain[-_ ]?of[-_ ]?thought/i,
            /"prompt"\s*:/i,
            /rawproviderresponse/i,
            /secret/i,
        ];
        for (const pattern of forbiddenPatterns) {
            expect(serialized.match(pattern)).toBeNull();
        }

        // The schema has no field to carry these (structural guarantee).
        const forbiddenFields = [
            "apiKey",
            "authorization",
            "chainOfThought",
            "rawPrompt",
            "rawOutput",
            "prompt",
            "credentials",
        ];
        for (const field of forbiddenFields) {
            expect(Object.keys(mission).includes(field)).toBe(false);
        }
        expect(mission.schemaVersion).toBe(MISSION_CONTRACT_VERSION);

        await store.close();
    });

    it("listMissions can filter by state and returns full contract", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const engine = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store);

        const m1 = await engine.createMission({
            intent: makeIntent("operator"),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        const m2 = await engine.createMission({
            intent: makeIntent("cli"),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        await engine.cancelMission(m2.missionId, "operator cancelled");

        const created = await store.listMissions({ state: MissionState.CREATED });
        expect(created.map((m: Mission) => m.missionId)).toContain(m1.missionId);

        const cancelled = await store.listMissions({ state: MissionState.CANCELLED });
        expect(cancelled.map((m: Mission) => m.missionId)).toContain(m2.missionId);

        const all = await store.listMissions();
        expect(all).toHaveLength(2);

        await store.close();
    });

    it("creates the database file on disk (persistence evidence)", async () => {
        const dir = track(makeTempDir("mission-file-"));
        const dbPath = join(dir.path, "missions.db");
        expect(existsSync(dbPath)).toBe(false);

        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        const engine = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store);
        await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        await store.close();

        expect(existsSync(dbPath)).toBe(true);
    });

    it("BLOCKER: restart does not authorize replay — same logical step cannot create a second invocation", async () => {
        const dir = track(makeTempDir("mission-replay-"));
        const dbPath = join(dir.path, "missions.db");

        // First lifetime: create, accept plan, dispatch, complete.
        const store1 = new SqliteMissionStore(dbPath);
        await store1.initialize();
        const engine1 = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store1);

        const mission = await engine1.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        const proposal = await engine1.proposePlan(mission.missionId, {
            planId: "plan-1",
            missionId: mission.missionId,
            plannerNote: "proposal",
            steps: [makeStep()],
        });
        if (!proposal.ok) throw new Error("plan rejected");
        await engine1.acceptPlan(mission.missionId, proposal.revision.revisionId);

        const invocation = await engine1.dispatchStep(mission.missionId, "step-1");
        await engine1.recordInvocationResult(
            invocation.invocationId,
            {
                invocationId: invocation.invocationId,
                status: InvocationStatus.COMPLETED,
                summary: "done",
                evidenceRefs: [],
                completedAt: BASE_TIME,
            },
            {
                invocationId: invocation.invocationId,
                verified: true,
                reason: "ok",
                owner: "runstead",
                verifiedAt: BASE_TIME,
            },
        );
        await store1.close();

        // Second lifetime: reopen, then try to dispatch the same step.
        const store2 = new SqliteMissionStore(dbPath);
        await store2.initialize();
        const engine2 = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-b"), store2);

        const recovered = await engine2.getMission(mission.missionId);
        expect(recovered!.invocationRefs).toHaveLength(1);
        expect(recovered!.invocationRefs[0].status).toBe(InvocationStatus.COMPLETED);

        // Dispatch after restart of the same logical step is forbidden.
        await expect(engine2.dispatchStep(mission.missionId, "step-1")).rejects.toThrow(
            /blind redispatch|already has invocation/i,
        );
        expect(await store2.listInvocations(mission.missionId)).toHaveLength(1);
        expect((await store2.getMission(mission.missionId))!.invocationRefs).toHaveLength(1);

        await store2.close();
    });

    it("BLOCKER: a rolled-back transaction leaves no partial writes (atomicity)", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const engine = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store);

        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        const before = await store.getMission(mission.missionId);
        expect(before!.invocationRefs).toHaveLength(0);

        const invocation = {
            invocationId: "inv-rollback",
            missionId: mission.missionId,
            stepId: "step-1",
            capabilityId: "runstead.code-review",
            status: InvocationStatus.DISPATCHED,
            dispatchedAt: BASE_TIME,
            resultRefs: [],
        };

        // Simulate a crash mid-transition: invocation inserted, then error.
        await expect(
            store.withTransaction(async () => {
                await store.saveInvocation(invocation);
                await store.updateMission(mission.missionId, {
                    state: MissionState.EXECUTING,
                    updatedAt: BASE_TIME,
                });
                throw new Error("simulated crash after partial writes");
            }),
        ).rejects.toThrow(/simulated crash/);

        // Rollback: no invocation row, Mission state untouched.
        expect(await store.listInvocations(mission.missionId)).toHaveLength(0);
        const after = await store.getMission(mission.missionId);
        expect(after!.invocationRefs).toHaveLength(0);
        expect(after!.state).toBe(MissionState.CREATED);
        expect(after!.currentPlanRevisionId).toBeNull();

        await store.close();
    });

    it("BLOCKER: invocation refs are derived from the canonical table (no divergent duplicate authority)", async () => {
        const dir = track(makeTempDir("mission-canonical-"));
        const dbPath = join(dir.path, "missions.db");

        const store1 = new SqliteMissionStore(dbPath);
        await store1.initialize();
        const engine1 = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store1);

        const mission = await engine1.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        const proposal = await engine1.proposePlan(mission.missionId, {
            planId: "plan-1",
            missionId: mission.missionId,
            plannerNote: "proposal",
            steps: [makeStep()],
        });
        if (!proposal.ok) throw new Error("plan rejected");
        await engine1.acceptPlan(mission.missionId, proposal.revision.revisionId);
        const invocation = await engine1.dispatchStep(mission.missionId, "step-1");
        await store1.close();

        // After restart the Mission view is rebuilt from mission_invocations.
        const store2 = new SqliteMissionStore(dbPath);
        await store2.initialize();
        const recovered = await store2.getMission(mission.missionId);
        const tableRows = await store2.listInvocations(mission.missionId);
        expect(recovered!.invocationRefs).toHaveLength(1);
        expect(recovered!.invocationRefs[0].invocationId).toBe(invocation.invocationId);
        expect(recovered!.invocationRefs[0].stepId).toBe(tableRows[0].stepId);
        expect(recovered!.invocationRefs[0].status).toBe(tableRows[0].status);
        // The Mission view and the table cannot diverge after restart, while
        // retaining the deliberate minimal/full entity boundary.
        expect(recovered!.invocationRefs).toEqual(
            tableRows.map(({ invocationId, missionId, stepId, capabilityId, status, dispatchedAt, completedAt, resultRefs, ownerVerification, error }) => ({
                invocationId,
                missionId,
                stepId,
                capabilityId,
                status,
                dispatchedAt,
                completedAt,
                resultRefs,
                ownerVerification,
                error,
            })),
        );

        await store2.close();
    });

    it("BLOCKER: raw secrets injected via MissionIntent/plannerNote never reach persisted data", async () => {
        const dir = track(makeTempDir("mission-secrets-"));
        const dbPath = join(dir.path, "missions.db");

        const store1 = new SqliteMissionStore(dbPath);
        await store1.initialize();
        const engine1 = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store1);

        // Intent and planner note contain real secret patterns.
        const intent = makeIntent("cli");
        intent.originalIntent = "Review the PR using Authorization: Bearer test-secret-value";
        intent.constraints = ["Use api_key=test-constraint-secret only for auth"];
        const mission = await engine1.createMission({
            intent,
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        const proposal = await engine1.proposePlan(mission.missionId, {
            planId: "plan-1",
            missionId: mission.missionId,
            plannerNote: "use token=test-planner-secret for deploy",
            steps: [makeStep()],
        });
        if (!proposal.ok) throw new Error("plan rejected");
        await store1.close();

        // Reopen the store and read everything back.
        const store2 = new SqliteMissionStore(dbPath);
        await store2.initialize();
        const recovered = await store2.getMission(mission.missionId);
        const revisions = await store2.getPlanRevisions(mission.missionId);

        const persistedBlob = JSON.stringify({
            originalIntent: recovered!.originalIntent,
            constraints: recovered!.constraints,
            acceptanceCriteria: recovered!.acceptanceCriteria,
            revisionReason: revisions[0].reason,
            steps: revisions[0].steps,
        });

        // The raw secret values must never appear in persisted data.
        for (const secret of ["test-secret-value", "test-constraint-secret", "test-planner-secret"]) {
            expect(persistedBlob).not.toContain(secret);
        }
        // Redaction markers are present (the structure is preserved).
        expect(persistedBlob).toContain("[REDACTED]");
        expect(persistedBlob).toContain("Bearer");
        expect(persistedBlob).toContain("api_key");

        await store2.close();
    });

    it("BLOCKER: secrets in ALL free-form persisted paths are redacted (result, evidence, owner reason, wait, block, reject, approval)", async () => {
        const dir = track(makeTempDir("mission-secrets-all-"));
        const dbPath = join(dir.path, "missions.db");

        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        const engine = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store);

        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        const proposal = await engine.proposePlan(mission.missionId, {
            planId: "plan-1",
            missionId: mission.missionId,
            plannerNote: "ok",
            steps: [makeStep()],
        });
        if (!proposal.ok) throw new Error("plan rejected");
        await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);

        // Inject secrets through every free-form persisted path.
        const invocation = await engine.dispatchStep(mission.missionId, "step-1");
        await engine.recordInvocationResult(
            invocation.invocationId,
            {
                invocationId: invocation.invocationId,
                status: InvocationStatus.COMPLETED,
                summary: "Authorization: Bearer result-secret-xyz",
                evidenceRefs: [
                    { refId: "ev-secret", owner: "runstead", externalRef: "token=evidence-secret-abc", label: "PR merged api_key=evidence-secret-abc" },
                ],
                completedAt: BASE_TIME,
            },
            {
                invocationId: invocation.invocationId,
                verified: true,
                reason: "ok Authorization: Basic owner-secret-xyz",
                owner: "runstead",
                verifiedAt: BASE_TIME,
            },
        );
        await engine.setWaiting(
            mission.missionId,
            MissionState.WAITING_FOR_CONTEXT,
            "need token=wait-secret-abc",
        );
        await engine.blockMission(mission.missionId, "blocked: Authorization: Bearer block-secret-xyz");
        await engine.rejectPlan(mission.missionId, proposal.revision.revisionId, "reject: api_key=reject-secret-abc");

        await store.close();

        // Reopen and inspect the full persisted blob.
        const store2 = new SqliteMissionStore(dbPath);
        await store2.initialize();
        const recovered = await store2.getMission(mission.missionId);
        const invocations = await store2.listInvocations(mission.missionId);
        const revisions = await store2.getPlanRevisions(mission.missionId);

        const blob = JSON.stringify({
            mission: recovered,
            invocations,
            revisions,
        });

        for (const secret of [
            "result-secret-xyz",
            "evidence-secret-abc",
            "owner-secret-xyz",
            "wait-secret-abc",
            "block-secret-xyz",
            "reject-secret-abc",
        ]) {
            expect(blob).not.toContain(secret);
        }

        await store2.close();
    });

    it("BLOCKER: benign originalIntent is preserved exactly; secret-bearing intent keeps raw value + immutable ref while only sanitized payload persists", async () => {
        const dir = track(makeTempDir("mission-intent-preserve-"));
        const dbPath = join(dir.path, "missions.db");

        // Benign intent: raw originalIntent is preserved verbatim.
        const store1 = new SqliteMissionStore(dbPath);
        await store1.initialize();
        const engine1 = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store1);
        const benign = await engine1.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        expect(benign.originalIntent).toBe(makeIntent().originalIntent);
        expect(benign.sanitizedOriginalIntent).toBe(makeIntent().originalIntent);
        expect(benign.originalIntentRef).toMatch(/^[0-9a-f]{64}$/);
        await store1.close();

        // Secret-bearing intent: raw value kept on the returned Mission,
        // persisted representation is sanitized, immutable ref preserved.
        const store2 = new SqliteMissionStore(dbPath);
        await store2.initialize();
        const engine2 = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-b"), store2);
        const secretIntent = makeIntent();
        secretIntent.originalIntent = "use Authorization: Bearer real-secret-token to fetch";
        const secretMission = await engine2.createMission({
            intent: secretIntent,
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        // Raw original preserved on the in-memory/returned Mission.
        expect(secretMission.originalIntent).toBe(secretIntent.originalIntent);
        expect(secretMission.sanitizedOriginalIntent).not.toContain("real-secret-token");
        expect(secretMission.sanitizedOriginalIntent).toContain("[REDACTED]");
        // Immutable reference to the raw original survives.
        expect(secretMission.originalIntentRef).toMatch(/^[0-9a-f]{64}$/);
        await store2.close();

        // After reopen: persisted representation is sanitized; the raw secret
        // value is never present, and the ref is stable.
        const store3 = new SqliteMissionStore(dbPath);
        await store3.initialize();
        const recoveredSecret = await store3.getMission(secretMission.missionId);
        expect(recoveredSecret!.originalIntent).not.toContain("real-secret-token");
        expect(recoveredSecret!.sanitizedOriginalIntent).not.toContain("real-secret-token");
        expect(recoveredSecret!.sanitizedOriginalIntent).toContain("[REDACTED]");
        expect(recoveredSecret!.originalIntentRef).toBe(secretMission.originalIntentRef);
        await store3.close();
    });

    it("BLOCKER: nested PlanStep free-form fields are structurally sanitized before persistence (approval reason/approver, fallback reasons)", async () => {
        const dir = track(makeTempDir("mission-nested-step-secrets-"));
        const dbPath = join(dir.path, "missions.db");

        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        const engine = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store);

        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: {
                capabilityIds: ["lifeos.write"],
                allowedEffectClasses: [EffectClass.WRITE],
                allowedRefPrefixes: ["refs/lifeos/"],
            },
        });

        // A valid candidate whose nested free-form fields contain secrets:
        // approvalRequirement.reason/approver and fallbacks[].reason.
        const proposal = await engine.proposePlan(mission.missionId, {
            planId: "plan-secrets",
            missionId: mission.missionId,
            plannerNote: "ok",
            steps: [
                makeStep({
                    capabilityRequirement: "lifeos.write",
                    effectClass: EffectClass.WRITE,
                    inputRefs: ["refs/lifeos/journal"],
                    desiredOutcome: "append note",
                    approvalRequirement: {
                        approvalId: "ap-nested",
                        approver: "operator Authorization: Bearer test-approver-secret",
                        reason: "Authorization: Bearer test-approval-secret",
                    },
                    fallbacks: [
                        { capabilityRequirement: "lifeos.write", reason: "api_key=test-fallback-secret" },
                    ],
                }),
            ],
        });
        if (!proposal.ok) throw new Error("plan rejected");

        await store.close();

        // Reopen and inspect the persisted revision steps.
        const store2 = new SqliteMissionStore(dbPath);
        await store2.initialize();
        const revisions = await store2.getPlanRevisions(mission.missionId);
        const stepsBlob = JSON.stringify(revisions[0].steps);

        for (const secret of ["test-approval-secret", "test-approver-secret", "test-fallback-secret"]) {
            expect(stepsBlob).not.toContain(secret);
        }
        // Redaction markers are present in the nested fields.
        expect(stepsBlob).toContain("[REDACTED]");

        await store2.close();
    });

    it("BLOCKER: raw secrets in non-free-form ID/ref fields are rejected fail-closed before any durable write", async () => {
        const dir = track(makeTempDir("mission-id-secrets-"));
        const dbPath = join(dir.path, "missions.db");

        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        const engine = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store);

        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });

        // 1. Secret in planId.
        await expect(
            engine.proposePlan(mission.missionId, {
                planId: "api_key=test-plan-id-secret",
                missionId: mission.missionId,
                plannerNote: "ok",
                steps: [makeStep()],
            }),
        ).rejects.toThrow(/raw secret/i);
        expect(await store.getPlanRevisions(mission.missionId)).toHaveLength(0);

        // 2. Secret in stepId.
        await expect(
            engine.proposePlan(mission.missionId, {
                planId: "plan-ok",
                missionId: mission.missionId,
                plannerNote: "ok",
                steps: [makeStep({ stepId: "step-token=test-step-secret" })],
            }),
        ).rejects.toThrow(/raw secret/i);
        expect(await store.getPlanRevisions(mission.missionId)).toHaveLength(0);

        // 3. Secret inside an inputRef that passes the authorized prefix check.
        await expect(
            engine.proposePlan(mission.missionId, {
                planId: "plan-ok",
                missionId: mission.missionId,
                plannerNote: "ok",
                steps: [makeStep({ inputRefs: ["refs/runstead/pr/42?api_key=test-ref-secret"] })],
            }),
        ).rejects.toThrow(/raw secret/i);
        expect(await store.getPlanRevisions(mission.missionId)).toHaveLength(0);

        // 4. Secret in approvalId.
        await expect(
            engine.proposePlan(mission.missionId, {
                planId: "plan-ok",
                missionId: mission.missionId,
                plannerNote: "ok",
                steps: [
                    makeStep({
                        approvalRequirement: {
                            approvalId: "ap-token=test-approval-secret",
                            approver: "operator",
                            reason: "ok",
                        },
                    }),
                ],
            }),
        ).rejects.toThrow(/raw secret/i);
        expect(await store.getPlanRevisions(mission.missionId)).toHaveLength(0);

        // 5. Secret in a fallback capability/ref.
        await expect(
            engine.proposePlan(mission.missionId, {
                planId: "plan-ok",
                missionId: mission.missionId,
                plannerNote: "ok",
                steps: [
                    makeStep({
                        fallbacks: [
                            { capabilityRequirement: "runstead.code-review?api_key=test-fallback-cap-secret", reason: "ok" },
                        ],
                    }),
                ],
            }),
        ).rejects.toThrow(/raw secret/i);
        expect(await store.getPlanRevisions(mission.missionId)).toHaveLength(0);

        await store.close();
    });

    it("BLOCKER: benign IDs/refs are persisted byte-for-byte (identity is never redacted)", async () => {
        const dir = track(makeTempDir("mission-benign-ids-"));
        const dbPath = join(dir.path, "missions.db");

        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        const engine = buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store);

        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });

        const planId = "plan-custom-1";
        const stepId = "step-custom-1";
        const inputRefs = ["refs/runstead/pr/42"];
        const approvalId = "ap-custom-1";
        const fallbackCap = "runstead.code-review";

        const proposal = await engine.proposePlan(mission.missionId, {
            planId,
            missionId: mission.missionId,
            plannerNote: "benign",
            steps: [
                makeStep({
                    stepId,
                    inputRefs,
                    approvalRequirement: { approvalId, approver: "operator", reason: "ok" },
                    fallbacks: [{ capabilityRequirement: fallbackCap, reason: "fallback" }],
                }),
            ],
        });
        if (!proposal.ok) throw new Error("plan rejected");

        const revisions = await store.getPlanRevisions(mission.missionId);
        expect(revisions[0].planId).toBe(planId);
        expect(revisions[0].steps[0].stepId).toBe(stepId);
        expect(revisions[0].steps[0].inputRefs).toEqual(inputRefs);
        expect(revisions[0].steps[0].approvalRequirement?.approvalId).toBe(approvalId);
        expect(revisions[0].steps[0].fallbacks?.[0].capabilityRequirement).toBe(fallbackCap);

        await store.close();
    });

    it("round-trips every full invocation field while keeping Mission refs minimal", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const mission = await buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store).createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        const invocation = makeFullInvocation(mission.missionId);

        await store.saveInvocation(invocation);

        const recovered = await store.getInvocation(invocation.invocationId);
        expect(recovered).toEqual(invocation);
        expect((await store.listInvocations(mission.missionId))[0]).toEqual(invocation);
        const projected = (await store.getMission(mission.missionId))!.invocationRefs[0];
        expect(projected).toEqual({
            invocationId: invocation.invocationId,
            missionId: invocation.missionId,
            stepId: invocation.stepId,
            capabilityId: invocation.capabilityId,
            status: invocation.status,
            resultRefs: invocation.resultRefs,
            dispatchedAt: undefined,
            completedAt: undefined,
            ownerVerification: invocation.ownerVerification,
        });
        expect(projected).not.toHaveProperty("planRevisionId");
        expect(projected).not.toHaveProperty("retry");

        await store.close();
    });

    it("migrates the old schema idempotently and persists safe pause metadata defaults", async () => {
        const dir = track(makeTempDir("mission-migration-"));
        const dbPath = join(dir.path, "missions.db");
        const legacy = new Database(dbPath);
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
            CREATE TABLE mission_invocations (
                invocation_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, step_id TEXT NOT NULL,
                capability_id TEXT NOT NULL, status TEXT NOT NULL, dispatched_at TEXT, completed_at TEXT,
                result_refs TEXT NOT NULL, owner_verification TEXT, error TEXT
            );
            INSERT INTO missions VALUES (
                'legacy-mission', 1, 'cli', 'legacy', 'legacy-ref', 'legacy objective', '[]', '[]', '{}', '{}',
                '[]', '[]', 'ready', NULL, '[]', '[]', '[]', '2026-08-30T12:00:00.000Z',
                '2026-08-30T12:00:00.000Z', '{}'
            );
            INSERT INTO mission_invocations VALUES (
                'legacy-invocation', 'legacy-mission', 'step-1', 'runstead.code-review', 'dispatched',
                '2026-08-30T12:00:00.000Z', NULL, '[]', NULL, NULL
            );
        `);
        legacy.close();

        const first = new SqliteMissionStore(dbPath);
        await first.initialize();
        await first.close();
        const second = new SqliteMissionStore(dbPath);
        await second.initialize();
        await second.initialize();

        const inspector = new Database(dbPath);
        const missionColumns = inspector.query("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
        inspector.close();
        expect(missionColumns.some((column) => column.name === "pause_metadata")).toBe(true);
        const migrated = await second.getInvocation("legacy-invocation");
        expect(migrated?.effectFingerprint).toBe("legacy:legacy-invocation");
        const persisted = new Database(dbPath)
            .query("SELECT effect_fingerprint FROM mission_invocations WHERE invocation_id = ?")
            .get("legacy-invocation") as { effect_fingerprint: string };
        expect(persisted.effect_fingerprint).toBe("legacy:legacy-invocation");
        expect(await second.findInvocationByEffectFingerprint("legacy:legacy-invocation")).toEqual(migrated);
        expect(migrated?.delivery.state).toBe("uncertain");
        expect(migrated?.retry.nextEligibleAt).toBeNull();
        expect(migrated?.attempts).toEqual([]);
        expect(migrated?.resultRefs).toEqual([]);
        expect(migrated?.reconciliation.state).toBe("unsupported");
        expect(await second.listDueInvocations("2026-08-30T13:00:00.000Z", 10)).toEqual([]);

        await second.close();
    });

    it("orders due invocations deterministically and applies the SQL limit", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const mission = await buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store).createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        await store.saveInvocation(makeFullInvocation(mission.missionId, {
            invocationId: "due-late",
            retry: { maxAttempts: 3, attempt: 0, backoff: RetryBackoff.FIXED, backoffMs: 1, nextEligibleAt: "2026-08-30T12:30:00.000Z" },
        }));
        await store.saveInvocation(makeFullInvocation(mission.missionId, {
            invocationId: "due-early",
            retry: { maxAttempts: 3, attempt: 0, backoff: RetryBackoff.FIXED, backoffMs: 1, nextEligibleAt: "2026-08-30T12:10:00.000Z" },
        }));
        await store.saveInvocation(makeFullInvocation(mission.missionId, {
            invocationId: "due-now",
            retry: { maxAttempts: 3, attempt: 0, backoff: RetryBackoff.NONE, backoffMs: 0, nextEligibleAt: null },
        }));
        await store.saveInvocation(makeFullInvocation(mission.missionId, {
            invocationId: "future",
            retry: { maxAttempts: 3, attempt: 0, backoff: RetryBackoff.FIXED, backoffMs: 1, nextEligibleAt: "2026-08-30T14:00:00.000Z" },
        }));
        await store.saveInvocation(makeFullInvocation(mission.missionId, {
            invocationId: "completed",
            status: InvocationStatus.COMPLETED,
            completedAt: INVOCATION_TIME,
            retry: { maxAttempts: 3, attempt: 1, backoff: RetryBackoff.NONE, backoffMs: 0, nextEligibleAt: null },
        }));

        const due = await store.listDueInvocations("2026-08-30T13:00:00.000Z", 2);
        expect(due.map((invocation) => invocation.invocationId)).toEqual(["due-now", "due-early"]);
        expect((await store.listNonTerminalInvocations(2)).map((invocation) => invocation.invocationId)).toEqual([
            "due-early",
            "due-late",
        ]);
        expect((await store.listRecoverableInvocations(2)).map((invocation) => invocation.invocationId)).toEqual([
            "due-early",
            "due-late",
        ]);
        expect(await store.listNonTerminalInvocations(0)).toEqual([]);
        expect(await store.listRecoverableInvocations(Number.MAX_SAFE_INTEGER + 1)).toEqual([]);

        await store.close();
    });

    it("finds an effect fingerprint and prevents terminal replay or evidence multiplication", async () => {
        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const mission = await buildEngine(new FakeClock(BASE_TIME), new FakeIdGenerator("id-a"), store).createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        const completed = makeFullInvocation(mission.missionId, {
            status: InvocationStatus.COMPLETED,
            completedAt: INVOCATION_TIME,
        });
        await store.saveInvocation(completed);
        await store.updateInvocation(completed.invocationId, {
            status: InvocationStatus.RUNNING,
            resultRefs: [...completed.resultRefs, ...completed.resultRefs],
            updatedAt: "2026-08-30T12:10:00.000Z",
        });

        const recovered = await store.getInvocation(completed.invocationId);
        expect(recovered?.status).toBe(InvocationStatus.COMPLETED);
        expect(recovered?.resultRefs).toEqual(completed.resultRefs);
        expect(await store.findInvocationByEffectFingerprint(completed.effectFingerprint)).toEqual(completed);
        expect(await store.listInvocations(mission.missionId)).toHaveLength(1);

        const cancelled = makeFullInvocation(mission.missionId, {
            invocationId: "cancelled",
            status: InvocationStatus.CANCELLED,
            completedAt: INVOCATION_TIME,
        });
        await store.saveInvocation(cancelled);
        await store.updateInvocation(cancelled.invocationId, { status: InvocationStatus.PENDING });
        expect((await store.getInvocation(cancelled.invocationId))?.status).toBe(InvocationStatus.CANCELLED);

        const legacyRef: CapabilityInvocationRef = {
            invocationId: "legacy-ref-invocation",
            missionId: mission.missionId,
            stepId: "step-legacy",
            capabilityId: "runstead.code-review",
            status: InvocationStatus.PENDING,
            resultRefs: [],
        };
        await store.saveInvocation(legacyRef);
        const normalized = await store.getInvocation(legacyRef.invocationId);
        expect(normalized?.planRevisionId).toBe("");
        expect(normalized?.contractVersion).toBe(0);
        expect(normalized?.idempotency.mode).toBe(IdempotencyMode.UNKNOWN);
        expect(normalized?.delivery.state).toBe("not_submitted");
        expect(normalized?.retry.nextEligibleAt).toBeNull();

        await store.close();
    });
});
