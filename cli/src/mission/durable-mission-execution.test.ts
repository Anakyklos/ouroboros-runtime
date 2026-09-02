import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    EffectClass,
    InvocationStatus,
    MissionState,
    type CapabilityInvocation,
    type Mission,
} from "./contracts.js";
import { CancellationSupport, IdempotencyMode, ReconciliationSupport, RetryBackoff } from "../capabilities/contracts.js";
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

const NOW = "2026-09-02T18:00:00.000Z";
const LATER = "2026-09-02T18:05:00.000Z";
const MISSION_ID = "mission-durable-1";
const PLAN_REVISION_ID = "revision-accepted-1";
const EFFECT_FINGERPRINT = "effect-fingerprint-sha256";
const PAUSED_STATE = MissionState.PAUSED;
type DurableInvocation = CapabilityInvocation;

interface DurableMissionEngine {
    pauseMission(missionId: string, reason: string): Promise<Mission>;
    resumeMission(missionId: string): Promise<Mission>;
}

function durableInvocation(overrides: Partial<DurableInvocation> = {}): DurableInvocation {
    return {
        invocationId: "invocation-1",
        missionId: MISSION_ID,
        stepId: "step-1",
        capabilityId: "runstead.code-review",
        planRevisionId: PLAN_REVISION_ID,
        effectFingerprint: EFFECT_FINGERPRINT,
        contractVersion: 1,
        moduleOwner: "runstead",
        status: InvocationStatus.PENDING,
        requestId: "request-1",
        inputRefs: [],
        idempotency: { mode: IdempotencyMode.IDEMPOTENT, key: "idempotency-key-1" },
        retry: { maxAttempts: 3, attempt: 0, backoff: RetryBackoff.FIXED, backoffMs: 30_000, nextEligibleAt: LATER },
        attempts: [{
            attempt: 0,
            correlationId: "attempt-correlation-0",
            state: "prepared",
            startedAt: NOW,
        }],
        delivery: { state: "not_submitted" },
        cancellation: { support: CancellationSupport.UNSUPPORTED, requested: false, state: "not_requested" },
        reconciliation: { support: ReconciliationSupport.NONE, state: "not_required" },
        ownerVerificationState: "pending",
        resultRefs: [],
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    };
}

function mission(): Mission {
    return {
        missionId: MISSION_ID,
        schemaVersion: 1,
        source: "cli",
        originalIntent: "Review the pending pull request",
        sanitizedOriginalIntent: "Review the pending pull request",
        originalIntentRef: "sha256:mission-intent",
        interpretedObjective: "Review the pending pull request",
        constraints: [],
        acceptanceCriteria: ["review complete"],
        budgetPolicy: {},
        allowedCapabilityScope: {
            capabilityIds: ["runstead.code-review"],
            allowedEffectClasses: [EffectClass.EXECUTION],
            allowedRefPrefixes: ["refs/runstead/"],
        },
        approvalRequirements: [],
        contextRefs: [],
        state: MissionState.READY,
        currentPlanRevisionId: PLAN_REVISION_ID,
        invocationRefs: [],
        evidenceRefs: [],
        criterionVerifications: [],
        unresolvedQuestions: [],
        createdAt: NOW,
        updatedAt: NOW,
        recoveryMetadata: { recovered: false, recoveryCount: 0 },
    };
}

function tempDb(): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "durable-mission-execution-"));
    return {
        path: join(dir, "missions.db"),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

function durableEngine(store: SqliteMissionStore): MissionEngine {
    const resolver = new FakeCapabilityResolver();
    resolver.registerMany(makeDefaultCapabilityCatalog());
    return new MissionEngine({
        store,
        policy: new PlanPolicyValidator(resolver),
        clock: new FakeClock(NOW),
        ids: new FakeIdGenerator("durable-test"),
        interpreter: (intent) => intent.originalIntent,
        verificationAuthority: new FakeVerificationAuthority(),
    });
}

function isDue(invocation: DurableInvocation, now: string): boolean {
    const nextEligibleAt = invocation.retry.nextEligibleAt;
    return nextEligibleAt === null || Date.parse(now) >= Date.parse(nextEligibleAt);
}

describe("durable mission execution contract (Task 1 red phase)", () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        for (const cleanup of cleanups.splice(0)) cleanup();
    });

    it("persists the complete invocation record while projecting only a legacy Mission ref", async () => {
        const db = tempDb();
        cleanups.push(db.cleanup);
        const store = new SqliteMissionStore(db.path);
        await store.initialize();
        await store.createMission(mission());

        const invocation = durableInvocation();
        await store.saveInvocation(invocation);
        const recovered = await store.getInvocation(invocation.invocationId) as DurableInvocation;
        const recoveredMission = await store.getMission(MISSION_ID);

        expect(recovered).toMatchObject(invocation);
        expect(recovered.retry.nextEligibleAt).toBe(LATER);
        expect(recovered.attempts[0].correlationId).toBe("attempt-correlation-0");
        expect(recoveredMission?.invocationRefs).toEqual([
            expect.objectContaining({
                invocationId: invocation.invocationId,
                missionId: MISSION_ID,
                stepId: "step-1",
                capabilityId: "runstead.code-review",
                status: InvocationStatus.PENDING,
            }),
        ]);
        expect(recoveredMission?.invocationRefs[0]).not.toHaveProperty("attempts");
        expect(recoveredMission?.invocationRefs[0]).not.toHaveProperty("retry");
    });

    it("durably records delivery and attempt transitions without losing nextEligibleAt", async () => {
        const db = tempDb();
        cleanups.push(db.cleanup);
        const store = new SqliteMissionStore(db.path);
        await store.initialize();
        await store.createMission(mission());
        await store.saveInvocation(durableInvocation());

        await store.updateInvocation("invocation-1", {
            status: InvocationStatus.FAILED,
            updatedAt: LATER,
            ...( {
                delivery: { state: "failed" },
                retry: { maxAttempts: 3, attempt: 1, backoff: RetryBackoff.FIXED, backoffMs: 30_000, nextEligibleAt: LATER },
                attempts: [
                    {
                        attempt: 0,
                        correlationId: "attempt-correlation-0",
                        state: "prepared",
                        startedAt: NOW,
                    },
                    {
                        attempt: 1,
                        correlationId: "attempt-correlation-1",
                        state: "failed",
                        startedAt: LATER,
                        finishedAt: LATER,
                        error: "sanitized connector timeout",
                    },
                ],
            } as Partial<DurableInvocation>),
        });

        const failed = await store.getInvocation("invocation-1") as DurableInvocation;
        expect(failed.delivery.state).toBe("failed");
        expect(failed.retry.attempt).toBe(1);
        expect(failed.retry.nextEligibleAt).toBe(LATER);
        expect(failed.attempts).toEqual([
            {
                attempt: 0,
                correlationId: "attempt-correlation-0",
                state: "prepared",
                startedAt: NOW,
            },
            {
                attempt: 1,
                correlationId: "attempt-correlation-1",
                state: "failed",
                startedAt: LATER,
                finishedAt: LATER,
                error: "sanitized connector timeout",
            },
        ]);
    });

    it("persists cancellation and conservative reconciliation metadata", async () => {
        const db = tempDb();
        cleanups.push(db.cleanup);
        const store = new SqliteMissionStore(db.path);
        await store.initialize();
        await store.createMission(mission());
        await store.saveInvocation(durableInvocation({
            delivery: { state: "uncertain" },
            cancellation: {
                support: CancellationSupport.UNSUPPORTED,
                requested: true,
                requestedAt: LATER,
                requestedBy: "operator-1",
                state: "unsupported",
                reason: "connector does not expose cancellation",
            },
            reconciliation: {
                support: ReconciliationSupport.NONE,
                state: "pending",
                lastCheckedAt: LATER,
                nextAction: "operator intervention",
            },
        }));

        const recovered = await store.getInvocation("invocation-1") as DurableInvocation;
        expect(recovered.delivery.state).toBe("uncertain");
        expect(recovered.cancellation).toMatchObject({ requested: true, state: "unsupported" });
        expect(recovered.reconciliation).toMatchObject({ state: "pending", nextAction: "operator intervention" });
    });

    it("persists PAUSED separately from cancellation and resumes the previous state", async () => {
        const db = tempDb();
        cleanups.push(db.cleanup);
        const store = new SqliteMissionStore(db.path);
        await store.initialize();
        await store.createMission(mission());
        const engine = durableEngine(store) as unknown as DurableMissionEngine;

        const paused = await engine.pauseMission(MISSION_ID, "operator requested a hold");
        expect(paused.state).toBe(PAUSED_STATE);
        expect((paused as Mission & { pauseMetadata: unknown }).pauseMetadata).toEqual(
            expect.objectContaining({ previousState: MissionState.READY, reason: "operator requested a hold" }),
        );
        expect(paused.state).not.toBe(MissionState.CANCELLED);

        const reopened = await new SqliteMissionStore(db.path);
        await reopened.initialize();
        expect((await reopened.getMission(MISSION_ID))?.state).toBe(PAUSED_STATE);
        const resumed = await engine.resumeMission(MISSION_ID);
        expect(resumed.state).toBe(MissionState.READY);
    });

    it("migrates a legacy invocation row with conservative non-replayable defaults and survives repeated initialization", async () => {
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
            CREATE TABLE mission_invocations (
                invocation_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, step_id TEXT NOT NULL,
                capability_id TEXT NOT NULL, status TEXT NOT NULL, dispatched_at TEXT, completed_at TEXT,
                result_refs TEXT NOT NULL, owner_verification TEXT, error TEXT
            );
        `);
        legacy.exec(`
            INSERT INTO missions VALUES (
                'legacy-mission', 1, 'cli', 'legacy intent', 'sha256:legacy', 'legacy objective',
                '[]', '["done"]', '{}', '{"capabilityIds":[]}', '[]', '[]', 'ready', NULL,
                '[]', '[]', '[]', '${NOW}', '${NOW}', '{"recovered":false,"recoveryCount":0}'
            );
            INSERT INTO mission_invocations VALUES (
                'legacy-invocation', 'legacy-mission', 'legacy-step', 'runstead.code-review',
                'dispatched', '${NOW}', NULL, '[]', NULL, NULL
            );
        `);
        legacy.close();

        const first = new SqliteMissionStore(db.path);
        await first.initialize();
        await first.close();
        const second = new SqliteMissionStore(db.path);
        await second.initialize();

        const invocation = await second.getInvocation("legacy-invocation") as DurableInvocation | null;
        expect(invocation?.retry.nextEligibleAt).toBeNull();
        expect(invocation?.reconciliation.state).toBe("unsupported");
        expect(invocation?.delivery.state).toBe("uncertain");
        expect(invocation?.attempts).toEqual([]);
    });

    it("rejects raw secrets recursively in invocation identity, errors, attempts, and references", async () => {
        const db = tempDb();
        cleanups.push(db.cleanup);
        const store = new SqliteMissionStore(db.path);
        await store.initialize();
        await store.createMission(mission());

        const secretCases: Array<[string, Partial<DurableInvocation>]> = [
            ["request identity", { requestId: "request-api_key=raw-secret" }],
            ["error", { error: "provider failed: Authorization: Bearer raw-token-value" }],
            ["attempt correlation identity", { attempts: [{ attempt: 0, correlationId: "token=raw-secret", state: "prepared", startedAt: NOW }] }],
            ["result reference", { resultRefs: [{ refId: "ref-1", owner: "runstead", externalRef: "credentials=raw-secret", label: "result" }] }],
        ];

        for (const [field, updates] of secretCases) {
            let rejection: unknown;
            try {
                await store.saveInvocation(durableInvocation(updates));
            } catch (error) {
                rejection = error;
            }

            expect(rejection, `secret case ${field} must be rejected`).toBeDefined();
            expect(
                rejection instanceof Error ? rejection.message : String(rejection),
                `secret case ${field} must identify raw-secret rejection`,
            ).toMatch(/Raw secret detected/);
        }
    });

    it("uses the injected fake clock for eligibility and preserves long waits across reopen", async () => {
        const clock = new FakeClock(NOW);
        const db = tempDb();
        cleanups.push(db.cleanup);
        const store = new SqliteMissionStore(db.path);
        await store.initialize();
        await store.createMission(mission());
        await store.saveInvocation(durableInvocation({
            retry: { maxAttempts: 3, attempt: 1, backoff: RetryBackoff.FIXED, backoffMs: 86_400_000, nextEligibleAt: "2026-09-03T18:00:00.000Z" },
        }));

        const recovered = await store.getInvocation("invocation-1") as DurableInvocation;
        const persistedNextEligibleAt = recovered.retry.nextEligibleAt;
        expect(clock.isoNow()).toBe(NOW);
        expect(persistedNextEligibleAt).toBe("2026-09-03T18:00:00.000Z");
        expect(isDue(recovered, clock.isoNow())).toBe(false);

        clock.advance(86_399_999);
        expect(clock.isoNow()).toBe("2026-09-03T17:59:59.999Z");
        expect(isDue(recovered, clock.isoNow())).toBe(false);

        clock.advance(1);
        expect(clock.isoNow()).toBe(persistedNextEligibleAt);
        expect(isDue(recovered, clock.isoNow())).toBe(true);

        clock.advance(1);
        expect(isDue(recovered, clock.isoNow())).toBe(true);
    });
});
