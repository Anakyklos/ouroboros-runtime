/**
 * ⚙️ Mission Engine Tests (Issue #62)
 *
 * Proves the Mission contract behavior end-to-end with injectable fakes:
 * single creation pipeline for all interfaces, intent preservation,
 * advisory-only planner output, durable state, distinct invocation state,
 * waiting states, blocking/replan, and layered verification.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
    EffectClass,
    InvocationStatus,
    MISSION_CONTRACT_VERSION,
    MissionIntent,
    MissionState,
    PolicyRejectionCode,
    PlanStep,
} from "./contracts.js";
import { MissionEngine } from "./mission-engine.js";
import { SqliteMissionStore } from "./sqlite-mission-store.js";
import { PlanPolicyValidator } from "./policy.js";
import {
    FakeCapabilityResolver,
    FakeClock,
    FakeIdGenerator,
    FakePlannerPort,
    makeDefaultCapabilityCatalog,
} from "./testing.js";
import type { PlanCandidate } from "./contracts.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const BASE_TIME = "2026-08-30T12:00:00.000Z";

function makeIntent(source: MissionIntent["source"] = "cli"): MissionIntent {
    return {
        requestId: `req-${source}`,
        source,
        originalIntent: "Review and merge the pending pull request",
        constraints: ["Do not modify unrelated files"],
        acceptanceCriteria: ["PR merged", "CI green"],
        contextRefs: [
            {
                refId: "ctx-1",
                owner: "katherine",
                label: "PR context",
                externalRef: "katherine:chat/123",
                authorizedBy: "user",
            },
        ],
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
        steps: [
            makeStep({
                inputRefs: ["refs/runstead/pr/42"],
            }),
        ],
        ...overrides,
    };
}

interface EngineHarness {
    engine: MissionEngine;
    store: SqliteMissionStore;
    resolver: FakeCapabilityResolver;
    planner: FakePlannerPort;
    clock: FakeClock;
    ids: FakeIdGenerator;
    close: () => Promise<void>;
}

function createHarness(clock = new FakeClock(BASE_TIME)): EngineHarness {
    const store = new SqliteMissionStore(":memory:");
    const resolver = new FakeCapabilityResolver();
    resolver.registerMany(makeDefaultCapabilityCatalog());
    const planner = new FakePlannerPort();
    const ids = new FakeIdGenerator("mission-id");
    const policy = new PlanPolicyValidator(resolver);
    const engine = new MissionEngine({ store, policy, clock, ids, interpreter: (i) => i.originalIntent });

    return {
        engine,
        store,
        resolver,
        planner,
        clock,
        ids,
        close: async () => {
            await store.close();
        },
    };
}

const DEFAULT_SCOPE = {
    capabilityIds: ["runstead.code-review", "lifeos.query", "lifeos.write", "runstead.deploy"],
    allowedEffectClasses: [EffectClass.EXECUTION, EffectClass.READ, EffectClass.WRITE, EffectClass.NETWORK],
    allowedRefPrefixes: ["refs/runstead/", "refs/lifeos/", "refs/katherine/", "refs/cli/", "refs/mission_control/"],
};

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

describe("MissionEngine", () => {
    let harness: EngineHarness;
    let engine: MissionEngine;

    beforeEach(async () => {
        harness = createHarness();
        engine = harness.engine;
        await harness.store.initialize();
    });

    afterEach(async () => {
        await harness.close();
    });

    describe("MissionIntent != Mission", () => {
        it("routes equivalent intents from Katherine and Mission Control through the same creation pipeline", async () => {
            const katherineIntent = makeIntent("katherine");
            const missionControlIntent: MissionIntent = {
                ...makeIntent("mission_control"),
                requestId: "req-mc",
            };

            const fromKatherine = await engine.createMission({
                intent: katherineIntent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const fromMissionControl = await engine.createMission({
                intent: missionControlIntent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });

            // Same pipeline: identical structure, source only records provenance.
            expect(fromKatherine.missionId).not.toBe(fromMissionControl.missionId);
            expect(fromKatherine.schemaVersion).toBe(MISSION_CONTRACT_VERSION);
            expect(fromMissionControl.schemaVersion).toBe(MISSION_CONTRACT_VERSION);
            expect(fromKatherine.originalIntent).toBe(katherineIntent.originalIntent);
            expect(fromMissionControl.originalIntent).toBe(missionControlIntent.originalIntent);
            expect(fromKatherine.source).toBe("katherine");
            expect(fromMissionControl.source).toBe("mission_control");
            expect(fromKatherine.state).toBe(MissionState.CREATED);
            expect(fromMissionControl.state).toBe(MissionState.CREATED);
        });

        it("preserves the original intent verbatim", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            expect(mission.originalIntent).toBe(intent.originalIntent);
            expect(mission.constraints).toEqual(intent.constraints);
            expect(mission.acceptanceCriteria).toEqual(intent.acceptanceCriteria);
            expect(mission.interpretedObjective).toBe(intent.originalIntent);
        });

        it("does not let the intent source grant authority beyond explicit approvals", async () => {
            // The intent's contextRefs are provenance only; the Mission scope
            // is decided by Ouroboros, not by the interface.
            const intent = makeIntent("katherine");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: {
                    capabilityIds: [],
                    allowedEffectClasses: [],
                    allowedRefPrefixes: [],
                },
            });
            expect(mission.allowedCapabilityScope.capabilityIds).toEqual([]);
            // Original intent is preserved but nothing is implicitly authorized.
            expect(mission.originalIntent).toBe(intent.originalIntent);
        });

        it("can be created, persisted and inspected without Katherine installed", async () => {
            const intent = makeIntent("operator");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });

            const reloaded = await engine.getMission(mission.missionId);
            expect(reloaded).not.toBeNull();
            expect(reloaded!.source).toBe("operator");
            expect(reloaded!.originalIntent).toBe(intent.originalIntent);
            expect(reloaded!.state).toBe(MissionState.CREATED);
            // No dependency on any interface: mission is inspectable standalone.
            expect(engine.listMissions).toBeDefined();
            const all = await engine.listMissions();
            expect(all.some((m) => m.missionId === mission.missionId)).toBe(true);
        });
    });

    describe("advisory planner + deterministic policy", () => {
        it("rejects an unauthorized capability before any dispatch", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });

            const candidate = makeCandidate(mission.missionId, {
                steps: [
                    makeStep({
                        capabilityRequirement: "tecer.health-check", // NOT in DEFAULT_SCOPE
                        inputRefs: ["refs/tecer/health"],
                    }),
                ],
            });

            const proposal = await engine.proposePlan(mission.missionId, candidate);
            expect(proposal.ok).toBe(false);
            if (!proposal.ok) {
                expect(proposal.decision.codes).toContain(
                    PolicyRejectionCode.CAPABILITY_NOT_AUTHORIZED,
                );
            }

            // Nothing was dispatched: no invocation refs.
            const after = await engine.getMission(mission.missionId);
            expect(after.invocationRefs).toEqual([]);
            expect(after.state).toBe(MissionState.CREATED);
        });

        it("rejects a planner attempt to change acceptance criteria without authority", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });

            const candidate = makeCandidate(mission.missionId, {
                proposedAcceptanceCriteria: ["PR merged", "planner-injected acceptance"],
            });

            const proposal = await engine.proposePlan(mission.missionId, candidate);
            expect(proposal.ok).toBe(false);
            if (!proposal.ok) {
                expect(proposal.decision.codes).toContain(
                    PolicyRejectionCode.ACCEPTANCE_MUTATION,
                );
            }

            const after = await engine.getMission(mission.missionId);
            expect(after.acceptanceCriteria).toEqual(intent.acceptanceCriteria);
        });

        it("rejects a dependency cycle through the engine", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });

            const candidate = makeCandidate(mission.missionId, {
                steps: [
                    makeStep({ stepId: "a", dependencyIds: ["b"] }),
                    makeStep({ stepId: "b", dependencyIds: ["c"] }),
                    makeStep({ stepId: "c", dependencyIds: ["a"] }),
                ],
            });

            const proposal = await engine.proposePlan(mission.missionId, candidate);
            expect(proposal.ok).toBe(false);
            if (!proposal.ok) {
                expect(proposal.decision.codes).toContain(PolicyRejectionCode.DEPENDENCY_CYCLE);
            }
        });

        it("fails closed when an effect requires approval and none is attached", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });

            const candidate = makeCandidate(mission.missionId, {
                steps: [
                    makeStep({
                        capabilityRequirement: "lifeos.write",
                        effectClass: EffectClass.WRITE,
                        approvalRequirement: undefined,
                    }),
                ],
            });

            const proposal = await engine.proposePlan(mission.missionId, candidate);
            expect(proposal.ok).toBe(false);
            if (!proposal.ok) {
                expect(proposal.decision.codes).toContain(PolicyRejectionCode.APPROVAL_MISSING);
            }
        });

        it("does not change durable Mission state when planner output is invalid", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const before = await engine.getMission(mission.missionId);

            const invalidCandidate = makeCandidate(mission.missionId, {
                steps: [
                    makeStep({
                        capabilityRequirement: "unknown.capability",
                        inputRefs: ["refs/unknown/x"],
                    }),
                ],
            });
            const proposal = await engine.proposePlan(mission.missionId, invalidCandidate);
            expect(proposal.ok).toBe(false);

            const after = await engine.getMission(mission.missionId);
            expect(after.state).toBe(before.state);
            expect(after.currentPlanRevisionId).toBeNull();
            expect(after.originalIntent).toBe(before.originalIntent);
            expect(after.acceptanceCriteria).toEqual(before.acceptanceCriteria);
        });

        it("accepts a valid plan, persists the revision and moves to ready", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });

            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId));
            expect(proposal.ok).toBe(true);
            if (!proposal.ok) return;
            const revision = proposal.revision;
            expect(revision.status).toBe("proposed");

            const accepted = await engine.acceptPlan(mission.missionId, revision.revisionId);
            expect(accepted.state).toBe(MissionState.READY);
            expect(accepted.currentPlanRevisionId).toBe(revision.revisionId);

            // Revision is durable and auditable.
            const revisions = await harness.store.getPlanRevisions(mission.missionId);
            expect(revisions).toHaveLength(1);
            expect(revisions[0].status).toBe("accepted");
        });
    });

    describe("state machine and invocation boundary", () => {
        async function acceptedMission() {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId));
            if (!proposal.ok) throw new Error("plan rejected");
            return engine.acceptPlan(mission.missionId, proposal.revision.revisionId);
        }

        it("keeps Mission state and invocation state as distinct entities", async () => {
            const mission = await acceptedMission();
            expect(mission.state).toBe(MissionState.READY);

            const invocation = await engine.dispatchStep(mission.missionId, "step-1");
            expect(invocation.status).toBe(InvocationStatus.DISPATCHED);
            expect(invocation.capabilityId).toBe("runstead.code-review");
            expect(invocation.missionId).toBe(mission.missionId);

            const after = await engine.getMission(mission.missionId);
            expect(after.state).toBe(MissionState.EXECUTING);
            // Mission references the invocation but its state is NOT the
            // invocation state: mission=executing, invocation=dispatched.
            expect(after.invocationRefs.some((i) => i.invocationId === invocation.invocationId)).toBe(true);
        });

        it("moves to waiting_for_approval when a step requires approval and resumes after it is granted", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
                approvalRequirements: [
                    {
                        approvalId: "ap-write",
                        approver: "operator",
                        reason: "Write to life domain requires operator approval",
                        granted: false,
                    },
                ],
            });
            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId, {
                steps: [
                    makeStep({
                        stepId: "step-write",
                        capabilityRequirement: "lifeos.write",
                        effectClass: EffectClass.WRITE,
                        inputRefs: ["refs/lifeos/journal"],
                        approvalRequirement: {
                            approvalId: "ap-write",
                            approver: "operator",
                            reason: "Write to life domain requires operator approval",
                            granted: false,
                        },
                    }),
                ],
            }));
            if (!proposal.ok) throw new Error("plan rejected");

            // Approval pending: Mission waits (never fails).
            const waiting = await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);
            expect(waiting.state).toBe(MissionState.WAITING_FOR_APPROVAL);
            expect(waiting.state).not.toBe(MissionState.FAILED_TERMINAL);

            // Operator grants approval; Mission becomes ready.
            const approved = await engine.recordApproval(mission.missionId, "ap-write", "operator");
            expect(approved.approvalRequirements[0].granted).toBe(true);
            expect(approved.approvalRequirements[0].grantedBy).toBe("operator");
            expect(approved.state).toBe(MissionState.READY);
        });

        it("rejects dispatch of a step that does not exist in the accepted plan", async () => {
            const mission = await acceptedMission();
            await expect(engine.dispatchStep(mission.missionId, "ghost-step")).rejects.toThrow(
                /not found in current plan/i,
            );
        });

        it("keeps a waiting_* state as waiting, never turning it into failure", async () => {
            const mission = await acceptedMission();
            const waiting = await engine.setWaiting(
                mission.missionId,
                MissionState.WAITING_FOR_APPROVAL,
                "Awaiting operator approval",
            );
            expect(waiting.state).toBe(MissionState.WAITING_FOR_APPROVAL);
            expect(waiting.state).not.toBe(MissionState.FAILED_TERMINAL);
            expect(waiting.unresolvedQuestions).toContain("Awaiting operator approval");

            // Other waiting states are equally legitimate.
            for (const state of [
                MissionState.WAITING_FOR_CONTEXT,
                MissionState.WAITING_FOR_CAPABILITY,
                MissionState.WAITING_FOR_PROVIDER,
                MissionState.WAITING_FOR_BUDGET,
            ]) {
                const m = await engine.setWaiting(mission.missionId, state as never);
                expect(m.state).toBe(state);
                expect(m.state).not.toBe(MissionState.FAILED_TERMINAL);
            }
        });

        it("blocks on unavailable capability without erasing intent, and allows replan", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });

            // Planner proposes a capability that is authorized in scope but
            // unavailable (removed from the catalog/resolver).
            const candidate = makeCandidate(mission.missionId, {
                steps: [
                    makeStep({
                        capabilityRequirement: "runstead.deploy",
                        effectClass: EffectClass.NETWORK,
                        approvalRequirement: {
                            approvalId: "ap-deploy",
                            approver: "operator",
                            reason: "Deployment requires approval",
                            granted: true,
                            grantedBy: "operator",
                            grantedAt: BASE_TIME,
                        },
                    }),
                ],
            });
            const proposal = await engine.proposePlan(mission.missionId, candidate);
            expect(proposal.ok).toBe(true);
            if (!proposal.ok) return;

            // Capability becomes unavailable before dispatch: the Mission
            // blocks explicitly instead of silently failing.
            harness.resolver.unregister("runstead.deploy");
            const blocked = await engine.blockMission(mission.missionId, "capability runstead.deploy unavailable");
            expect(blocked.state).toBe(MissionState.BLOCKED);
            expect(blocked.originalIntent).toBe(intent.originalIntent);
            expect(blocked.acceptanceCriteria).toEqual(intent.acceptanceCriteria);

            // Replan path: planner proposes a different authorized capability.
            const replanCandidate = makeCandidate(mission.missionId, {
                planId: "plan-2",
                steps: [
                    makeStep({
                        capabilityRequirement: "runstead.code-review",
                        inputRefs: ["refs/runstead/pr/42"],
                    }),
                ],
            });
            const replanProposal = await engine.proposePlan(mission.missionId, replanCandidate);
            expect(replanProposal.ok).toBe(true);
            if (!replanProposal.ok) return;
            const replanned = await engine.acceptPlan(mission.missionId, replanProposal.revision.revisionId);
            expect(replanned.state).toBe(MissionState.READY);
            expect(replanned.originalIntent).toBe(intent.originalIntent);
        });

        it("does not treat a retry as a hidden replan", async () => {
            const mission = await acceptedMission();
            const firstRevisionId = mission.currentPlanRevisionId;

            // Same plan proposed again is a new revision proposal, but the
            // accepted revision remains untouched until explicitly accepted.
            const proposal = await engine.proposePlan(
                mission.missionId,
                makeCandidate(mission.missionId, { planId: "plan-retry" }),
            );
            expect(proposal.ok).toBe(true);
            const after = await engine.getMission(mission.missionId);
            expect(after.currentPlanRevisionId).toBe(firstRevisionId);
        });
    });

    describe("plan revisions", () => {
        it("keeps completed invocation/effect references across replan (no loss, no duplication)", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId));
            if (!proposal.ok) throw new Error("plan rejected");
            await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);

            const invocation = await engine.dispatchStep(mission.missionId, "step-1");
            await engine.recordInvocationResult(
                invocation.invocationId,
                {
                    invocationId: invocation.invocationId,
                    status: InvocationStatus.COMPLETED,
                    summary: "Review completed",
                    evidenceRefs: [{ refId: "ev-1", owner: "runstead", externalRef: "runstead:review/1", label: "PR merged" }],
                    completedAt: BASE_TIME,
                },
                {
                    invocationId: invocation.invocationId,
                    verified: true,
                    reason: "Review verified",
                    owner: "runstead",
                    verifiedAt: BASE_TIME,
                },
            );

            const beforeReplan = await engine.getMission(mission.missionId);
            expect(beforeReplan.invocationRefs).toHaveLength(1);
            expect(beforeReplan.evidenceRefs).toHaveLength(1);

            // Replan: propose + accept a new revision.
            const replanProposal = await engine.proposePlan(
                mission.missionId,
                makeCandidate(mission.missionId, { planId: "plan-2", steps: [makeStep({ stepId: "step-2" })] }),
            );
            if (!replanProposal.ok) throw new Error("replan rejected");
            await engine.acceptPlan(mission.missionId, replanProposal.revision.revisionId);

            const afterReplan = await engine.getMission(mission.missionId);
            // Completed invocation/effect refs survive replan, without duplication.
            expect(afterReplan.invocationRefs).toHaveLength(1);
            expect(afterReplan.invocationRefs[0].invocationId).toBe(invocation.invocationId);
            expect(afterReplan.invocationRefs[0].status).toBe(InvocationStatus.COMPLETED);
            expect(afterReplan.evidenceRefs).toHaveLength(1);
            expect(afterReplan.evidenceRefs[0].refId).toBe("ev-1");
            expect(afterReplan.originalIntent).toBe(intent.originalIntent);
        });

        it("marks the previous accepted revision as superseded (auditable, kept)", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId));
            if (!proposal.ok) throw new Error("plan rejected");
            await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);

            const replanProposal = await engine.proposePlan(
                mission.missionId,
                makeCandidate(mission.missionId, { planId: "plan-2" }),
            );
            if (!replanProposal.ok) throw new Error("replan rejected");
            await engine.acceptPlan(mission.missionId, replanProposal.revision.revisionId);

            const revisions = await harness.store.getPlanRevisions(mission.missionId);
            expect(revisions).toHaveLength(2);
            expect(revisions[0].status).toBe("superseded");
            expect(revisions[1].status).toBe("accepted");
        });
    });

    describe("mission-level verification", () => {
        it("never turns a negative module-owner verification into Mission success", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId));
            if (!proposal.ok) throw new Error("plan rejected");
            await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);

            const invocation = await engine.dispatchStep(mission.missionId, "step-1");
            // Owner verification fails, planner says "looks good".
            await engine.recordInvocationResult(
                invocation.invocationId,
                {
                    invocationId: invocation.invocationId,
                    status: InvocationStatus.COMPLETED,
                    summary: "Review completed",
                    evidenceRefs: [{ refId: "ev-1", owner: "runstead", externalRef: "runstead:review/1", label: "PR merged" }],
                    completedAt: BASE_TIME,
                },
                {
                    invocationId: invocation.invocationId,
                    verified: false,
                    reason: "Owner found a regression in the diff",
                    owner: "runstead",
                    verifiedAt: BASE_TIME,
                },
            );

            const verification = await engine.verifyMission(mission.missionId);
            expect(verification.satisfied).toBe(false);
            expect(verification.ownerBlocked).toBe(true);

            // Mission cannot be completed.
            await expect(engine.completeMission(mission.missionId)).rejects.toThrow(
                /negative|owner/i,
            );
            const after = await engine.getMission(mission.missionId);
            expect(after.state).not.toBe(MissionState.COMPLETED);
        });

        it("completes a Mission only when evidence covers acceptance and owners verify positively", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId));
            if (!proposal.ok) throw new Error("plan rejected");
            await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);

            const invocation = await engine.dispatchStep(mission.missionId, "step-1");
            await engine.recordInvocationResult(
                invocation.invocationId,
                {
                    invocationId: invocation.invocationId,
                    status: InvocationStatus.COMPLETED,
                    summary: "Review completed",
                    evidenceRefs: [
                        { refId: "ev-1", owner: "runstead", externalRef: "runstead:review/1", label: "PR merged" },
                        { refId: "ev-2", owner: "runstead", externalRef: "runstead:ci/1", label: "CI green" },
                    ],
                    completedAt: BASE_TIME,
                },
                {
                    invocationId: invocation.invocationId,
                    verified: true,
                    reason: "Review verified",
                    owner: "runstead",
                    verifiedAt: BASE_TIME,
                },
            );

            const verification = await engine.verifyMission(mission.missionId);
            expect(verification.satisfied).toBe(true);
            expect(verification.ownerBlocked).toBe(false);

            const completed = await engine.completeMission(mission.missionId);
            expect(completed.state).toBe(MissionState.COMPLETED);
        });

        it("does not complete when an invocation is still in a non-terminal state", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId));
            if (!proposal.ok) throw new Error("plan rejected");
            await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);
            await engine.dispatchStep(mission.missionId, "step-1");

            const verification = await engine.verifyMission(mission.missionId);
            expect(verification.satisfied).toBe(false);
            expect(verification.ownerBlocked).toBe(false);
            await expect(engine.completeMission(mission.missionId)).rejects.toThrow();
        });
    });
});
