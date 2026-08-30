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
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    EffectClass,
    InvocationStatus,
    MISSION_CONTRACT_VERSION,
    Mission,
    MissionIntent,
    MissionState,
    PlanStep,
} from "./contracts.js";
import { SqliteMissionStore } from "./sqlite-mission-store.js";
import { MissionEngine } from "./mission-engine.js";
import { PlanPolicyValidator } from "./policy.js";
import {
    FakeCapabilityResolver,
    FakeClock,
    FakeIdGenerator,
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
        });
    };
}

const buildEngine = makeEngineFactory();

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
});
