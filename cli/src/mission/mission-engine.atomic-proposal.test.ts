/**
 * ⚙️ Mission Engine — atomic plan proposal regression tests
 *
 * Proves that `proposePlan()` persists the proposed revision and the Mission
 * state transition atomically, using a real SQLite store.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    EffectClass,
    MISSION_CONTRACT_VERSION,
    MissionIntent,
    MissionState,
    PolicyRejectionCode,
    PlanStep,
} from "./contracts.js";
import {
    CancellationSupport,
    IdempotencyMode,
    ReconciliationSupport,
    RetryBackoff,
} from "../capabilities/contracts.js";
import { MissionEngine } from "./mission-engine.js";
import { SqliteMissionStore } from "./sqlite-mission-store.js";
import { PlanPolicyValidator } from "./policy.js";
import {
    FakeCapabilityResolver,
    FakeClock,
    FakeIdGenerator,
    makeDefaultCapabilityCatalog,
} from "./testing.js";
import type { PlanCandidate } from "./contracts.js";

const BASE_TIME = "2026-08-30T12:00:00.000Z";

function makeIntent(): MissionIntent {
    return {
        requestId: "req-atomic",
        source: "cli",
        originalIntent: "Review and merge the pending pull request",
        constraints: ["Do not modify unrelated files"],
        acceptanceCriteria: ["PR merged", "CI green"],
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

function makeCandidate(missionId: string, overrides: Partial<PlanCandidate> = {}): PlanCandidate {
    return {
        planId: "plan-1",
        missionId,
        plannerNote: "Fake planner proposal",
        steps: [makeStep()],
        ...overrides,
    };
}

const DEFAULT_SCOPE = {
    capabilityIds: ["runstead.code-review"],
    allowedEffectClasses: [EffectClass.EXECUTION],
    allowedRefPrefixes: ["refs/runstead/"],
};

async function buildHarness(dbPath: string) {
    const store = new SqliteMissionStore(dbPath);
    await store.initialize();
    const resolver = new FakeCapabilityResolver();
    resolver.registerMany(makeDefaultCapabilityCatalog());
    const ids = new FakeIdGenerator("atomic");
    const clock = new FakeClock(BASE_TIME);
    const policy = new PlanPolicyValidator(resolver);
    const engine = new MissionEngine({
        store,
        policy,
        clock,
        ids,
        interpreter: (i: any) => i.originalIntent,
    });
    return { store, resolver, ids, clock, policy, engine };
}

describe("MissionEngine atomic plan proposal", () => {
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "ouro-atomic-"));
        dbPath = join(dir, "missions.db");
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("rolls back the revision when updateMission fails", async () => {
        const { store, engine } = await buildHarness(dbPath);
        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });

        const originalUpdate = store.updateMission.bind(store);
        (store as any).updateMission = async () => {
            throw new Error("injected failure");
        };

        const candidate = makeCandidate(mission.missionId);
        await expect(engine.proposePlan(mission.missionId, candidate)).rejects.toThrow("injected failure");

        (store as any).updateMission = originalUpdate;

        const revs = await store.getPlanRevisions(mission.missionId);
        expect(revs).toHaveLength(0);
        const reloaded = await store.getMission(mission.missionId);
        expect(reloaded!.state).toBe(MissionState.CREATED);

        await store.close();
    });

    it("publishes no mission events for a reverted transaction", async () => {
        const { store, engine } = await buildHarness(dbPath);
        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });

        const events: unknown[] = [];
        const unsubscribe = store.onMutation((m) => {
            events.push(m);
        });

        const originalUpdate = store.updateMission.bind(store);
        (store as any).updateMission = async () => {
            throw new Error("injected failure");
        };

        const candidate = makeCandidate(mission.missionId);
        await expect(engine.proposePlan(mission.missionId, candidate)).rejects.toThrow("injected failure");

        (store as any).updateMission = originalUpdate;
        unsubscribe();

        expect(events).toHaveLength(0);
        const revs = await store.getPlanRevisions(mission.missionId);
        expect(revs).toHaveLength(0);

        await store.close();
    });

    it("confirms a valid proposal with revision and PLANNING state", async () => {
        const { store, engine } = await buildHarness(dbPath);
        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });

        const candidate = makeCandidate(mission.missionId);
        const result = await engine.proposePlan(mission.missionId, candidate);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.revision.status).toBe("proposed");
            expect(result.revision.revisionNumber).toBe(1);
        }

        const revs = await store.getPlanRevisions(mission.missionId);
        expect(revs).toHaveLength(1);
        const reloaded = await store.getMission(mission.missionId);
        expect(reloaded!.state).toBe(MissionState.PLANNING);
        expect(reloaded!.currentPlanRevisionId).toBeNull();

        await store.close();
    });

    it("allocates distinct revision numbers under concurrency", async () => {
        const { store, engine } = await buildHarness(dbPath);
        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });

        const candidate = (n: number) => makeCandidate(mission.missionId, { planId: `plan-${n}` });
        await Promise.all([
            engine.proposePlan(mission.missionId, candidate(1)),
            engine.proposePlan(mission.missionId, candidate(2)),
        ]);

        const revs = await store.getPlanRevisions(mission.missionId);
        expect(revs).toHaveLength(2);
        const nums = revs.map((r) => r.revisionNumber).sort();
        expect(nums).toEqual([1, 2]);

        await store.close();
    });

    it("preserves previous revisions on a new proposal", async () => {
        const { store, engine } = await buildHarness(dbPath);
        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });

        const first = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId, { planId: "plan-1" }));
        expect(first.ok).toBe(true);
        // move back to a non-terminal re-plannable state is not needed: PLANNING allows proposePlan
        const second = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId, { planId: "plan-2" }));
        expect(second.ok).toBe(true);

        const revs = await store.getPlanRevisions(mission.missionId);
        expect(revs).toHaveLength(2);
        expect(revs.map((r) => r.planId)).toEqual(["plan-1", "plan-2"]);

        await store.close();
    });

    it("leaves an invalid candidate without mutation", async () => {
        const { store, engine } = await buildHarness(dbPath);
        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });

        const invalid = makeCandidate(mission.missionId, {
            steps: [makeStep({ capabilityRequirement: "tecer.health-check" })],
        });
        const result = await engine.proposePlan(mission.missionId, invalid);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.decision.codes).toContain(PolicyRejectionCode.CAPABILITY_NOT_AUTHORIZED);
        }

        const revs = await store.getPlanRevisions(mission.missionId);
        expect(revs).toHaveLength(0);
        const reloaded = await store.getMission(mission.missionId);
        expect(reloaded!.state).toBe(MissionState.CREATED);

        await store.close();
    });

    it("rejects proposal when mission becomes terminal before commit", async () => {
        const { store, engine, policy } = await buildHarness(dbPath);
        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });

        const originalValidate = policy.validate.bind(policy);
        (policy as any).validate = async (m: any, c: any) => {
            const decision = await originalValidate(m, c);
            if (decision.valid) {
                await store.createMission({ ...m, state: MissionState.CANCELLED, updatedAt: BASE_TIME });
            }
            return decision;
        };

        const candidate = makeCandidate(mission.missionId);
        await expect(engine.proposePlan(mission.missionId, candidate)).rejects.toThrow(/terminal/i);

        (policy as any).validate = originalValidate;

        const revs = await store.getPlanRevisions(mission.missionId);
        expect(revs).toHaveLength(0);

        await store.close();
    });

    it("survives restart after commit", async () => {
        const { store, engine } = await buildHarness(dbPath);
        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId));
        await store.close();

        const store2 = new SqliteMissionStore(dbPath);
        await store2.initialize();
        const revs = await store2.getPlanRevisions(mission.missionId);
        expect(revs).toHaveLength(1);
        const reloaded = await store2.getMission(mission.missionId);
        expect(reloaded!.state).toBe(MissionState.PLANNING);
        await store2.close();
    });

    it("survives restart after rollback with no partial revision", async () => {
        const { store, engine } = await buildHarness(dbPath);
        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });

        const originalUpdate = store.updateMission.bind(store);
        (store as any).updateMission = async () => {
            throw new Error("injected failure");
        };
        await expect(engine.proposePlan(mission.missionId, makeCandidate(mission.missionId))).rejects.toThrow("injected failure");
        (store as any).updateMission = originalUpdate;
        await store.close();

        const store2 = new SqliteMissionStore(dbPath);
        await store2.initialize();
        const revs = await store2.getPlanRevisions(mission.missionId);
        expect(revs).toHaveLength(0);
        const reloaded = await store2.getMission(mission.missionId);
        expect(reloaded!.state).toBe(MissionState.CREATED);
        await store2.close();
    });

    it("does not create invocations or dispatch during proposal", async () => {
        const { store, engine } = await buildHarness(dbPath);
        const mission = await engine.createMission({
            intent: makeIntent(),
            allowedCapabilityScope: DEFAULT_SCOPE,
        });
        await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId));

        const invocations = await store.listInvocations(mission.missionId);
        expect(invocations).toHaveLength(0);
        const reloaded = await store.getMission(mission.missionId);
        expect(reloaded!.invocationRefs).toEqual([]);

        await store.close();
    });
});
