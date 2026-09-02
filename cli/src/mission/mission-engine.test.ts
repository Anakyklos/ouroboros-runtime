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
    FakePlannerPort,
    FakeVerificationAuthority,
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
    authority: FakeVerificationAuthority;
    close: () => Promise<void>;
}

function createHarness(
    clock = new FakeClock(BASE_TIME),
    opts: { withAuthority?: boolean } = {},
): EngineHarness {
    const store = new SqliteMissionStore(":memory:");
    const resolver = new FakeCapabilityResolver();
    resolver.registerMany(makeDefaultCapabilityCatalog());
    const planner = new FakePlannerPort();
    const ids = new FakeIdGenerator("mission-id");
    const policy = new PlanPolicyValidator(resolver);
    const authority = new FakeVerificationAuthority();
    const engine = new MissionEngine({
        store,
        policy,
        clock,
        ids,
        interpreter: (i) => i.originalIntent,
        // Tests normally inject a deterministic attestation authority;
        // opts.withAuthority=false exercises the fail-closed default.
        verificationAuthority: opts.withAuthority === false ? undefined : authority,
    });

    return {
        engine,
        store,
        resolver,
        planner,
        clock,
        ids,
        authority,
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

    describe("durable execution transitions (Task 4)", () => {
        async function acceptedForStep(step = makeStep()): Promise<Mission> {
            const mission = await engine.createMission({
                intent: makeIntent("cli"),
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const proposal = await engine.proposePlan(
                mission.missionId,
                makeCandidate(mission.missionId, { steps: [step] }),
            );
            if (!proposal.ok) throw new Error("plan rejected");
            return engine.acceptPlan(mission.missionId, proposal.revision.revisionId);
        }

        it("persists a complete prepared, not-submitted invocation before handoff metadata", async () => {
            const mission = await acceptedForStep();
            const invocation = await engine.dispatchStep(mission.missionId, "step-1", {
                descriptor: {
                    contractVersion: 1,
                    moduleOwner: "runstead",
                    idempotency: { mode: IdempotencyMode.IDEMPOTENT, keyScope: "request" },
                    retry: { maxAttempts: 3, backoff: RetryBackoff.FIXED },
                    cancellationSupport: CancellationSupport.COOPERATIVE,
                    reconciliationSupport: ReconciliationSupport.STATUS_REPLAY,
                },
            });

            const stored = await harness.store.getInvocation(invocation.invocationId);
            expect(stored).toMatchObject({
                planRevisionId: mission.currentPlanRevisionId,
                contractVersion: 1,
                moduleOwner: "runstead",
                requestId: invocation.invocationId,
                effectFingerprint: expect.any(String),
                inputRefs: ["refs/runstead/pr/42"],
                idempotency: { mode: IdempotencyMode.IDEMPOTENT },
                retry: { maxAttempts: 3, backoff: RetryBackoff.FIXED, attempt: 0 },
                delivery: { state: "not_submitted" },
                cancellation: { support: CancellationSupport.COOPERATIVE, requested: false },
                reconciliation: { support: ReconciliationSupport.STATUS_REPLAY },
            });
            expect(stored?.attempts).toHaveLength(1);
            expect(stored?.attempts[0]).toMatchObject({
                attempt: 0,
                correlationId: expect.any(String),
                state: "prepared",
                startedAt: BASE_TIME,
            });
            expect(stored?.dispatchedAt).toBeUndefined();
        });

        it("merges duplicate completed results and evidence without changing the terminal record", async () => {
            const mission = await acceptedForStep();
            const invocation = await engine.dispatchStep(mission.missionId, "step-1");
            const result = {
                invocationId: invocation.invocationId,
                status: InvocationStatus.COMPLETED,
                summary: "done",
                evidenceRefs: [
                    { refId: "ev-1", owner: "runstead", externalRef: "review:1", label: "review" },
                ],
                completedAt: BASE_TIME,
            };
            await engine.recordInvocationResult(invocation.invocationId, result);
            const first = await harness.store.getInvocation(invocation.invocationId);
            await engine.recordInvocationResult(invocation.invocationId, {
                ...result,
                summary: "conflicting late summary",
                evidenceRefs: [
                    ...result.evidenceRefs,
                    { refId: "ev-2", owner: "runstead", externalRef: "review:2", label: "extra" },
                ],
                completedAt: "2026-09-02T12:00:00.000Z",
            });
            const second = await harness.store.getInvocation(invocation.invocationId);

            expect(second?.status).toBe(InvocationStatus.COMPLETED);
            expect(second?.completedAt).toBe(first?.completedAt);
            expect(second?.resultRefs.map((ref) => ref.refId)).toEqual(["ev-1"]);
            expect(second?.updatedAt).toBe(first?.updatedAt);
        });

        it("keeps a negative owner verdict sovereign over a later planner-level success", async () => {
            const mission = await acceptedForStep();
            const invocation = await engine.dispatchStep(mission.missionId, "step-1");
            await engine.recordInvocationResult(
                invocation.invocationId,
                {
                    invocationId: invocation.invocationId,
                    status: InvocationStatus.COMPLETED,
                    summary: "looks complete",
                    evidenceRefs: [],
                    completedAt: BASE_TIME,
                },
                {
                    invocationId: invocation.invocationId,
                    verified: false,
                    reason: "owner rejected the effect",
                    owner: "runstead",
                    verifiedAt: BASE_TIME,
                },
            );
            await engine.recordInvocationResult(invocation.invocationId, {
                invocationId: invocation.invocationId,
                status: InvocationStatus.COMPLETED,
                summary: "planner says complete",
                evidenceRefs: [],
                completedAt: BASE_TIME,
            });

            const stored = await harness.store.getInvocation(invocation.invocationId);
            expect(stored?.status).toBe(InvocationStatus.FAILED);
            expect(stored?.ownerVerification?.verified).toBe(false);
            expect((await engine.verifyMission(mission.missionId)).ownerBlocked).toBe(true);
        });

        it("pauses durably without cancelling active work and resumes without dispatching", async () => {
            const mission = await acceptedForStep();
            const invocation = await engine.dispatchStep(mission.missionId, "step-1");
            const paused = await engine.pauseMission(mission.missionId, "operator requested hold", "operator-1");
            expect(paused.state).toBe(MissionState.PAUSED);
            expect(paused.pauseMetadata).toMatchObject({
                previousState: MissionState.EXECUTING,
                reason: "operator requested hold",
                pausedBy: "operator-1",
            });
            expect((await harness.store.getInvocation(invocation.invocationId))?.status).toBe(
                InvocationStatus.DISPATCHED,
            );

            const resumed = await engine.resumeMission(mission.missionId);
            expect(resumed.state).toBe(MissionState.EXECUTING);
            expect(resumed.pauseMetadata).toBeUndefined();
            await expect(engine.dispatchStep(mission.missionId, "step-1")).rejects.toThrow(/already|conflict/i);
        });

        it("cancels not-submitted work locally and requests cancellation for active work conservatively", async () => {
            const mission = await acceptedForStep();
            const invocation = await engine.dispatchStep(mission.missionId, "step-1", {
                descriptor: {
                    contractVersion: 1,
                    moduleOwner: "runstead",
                    idempotency: { mode: IdempotencyMode.NON_IDEMPOTENT, keyScope: "request" },
                    retry: { maxAttempts: 0, backoff: RetryBackoff.NONE },
                    cancellationSupport: CancellationSupport.UNSUPPORTED,
                    reconciliationSupport: ReconciliationSupport.NONE,
                },
            });
            const cancelled = await engine.cancelMission(mission.missionId, "operator cancelled", "operator-1");
            expect(cancelled.state).toBe(MissionState.CANCELLED);
            const stored = await harness.store.getInvocation(invocation.invocationId);
            expect(stored?.status).toBe(InvocationStatus.CANCELLED);
            expect(stored?.delivery.state).toBe("not_submitted");
            expect(stored?.cancellation).toMatchObject({
                requested: true,
                requestedBy: "operator-1",
                state: "acknowledged",
            });
        });

        it("marks active or uncertain work for cancellation without fabricating a terminal outcome", async () => {
            const mission = await acceptedForStep();
            const invocation = await engine.dispatchStep(mission.missionId, "step-1", {
                descriptor: {
                    contractVersion: 1,
                    moduleOwner: "runstead",
                    idempotency: { mode: IdempotencyMode.IDEMPOTENT, keyScope: "request" },
                    retry: { maxAttempts: 2, backoff: RetryBackoff.FIXED },
                    cancellationSupport: CancellationSupport.COOPERATIVE,
                    reconciliationSupport: ReconciliationSupport.STATUS_REPLAY,
                },
            });
            await engine.markInvocationHandoff(invocation.invocationId, {
                deliveryState: "uncertain",
                remoteOperationHandle: "owner-operation-1",
            });
            await engine.cancelMission(mission.missionId, "stop active operation", "operator-1");

            const stored = await harness.store.getInvocation(invocation.invocationId);
            expect(stored?.status).toBe(InvocationStatus.DISPATCHED);
            expect(stored?.delivery.state).toBe("uncertain");
            expect(stored?.cancellation).toMatchObject({
                requested: true,
                state: "requested",
                requestedBy: "operator-1",
            });
            expect(stored?.reconciliation).toMatchObject({ state: "pending" });
        });

        it("rejects malformed or secret-bearing descriptor identity before durable write", async () => {
            const mission = await acceptedForStep();
            await expect(
                engine.dispatchStep(mission.missionId, "step-1", {
                    descriptor: {
                        contractVersion: 1,
                        moduleOwner: "token=abc123",
                        idempotency: { mode: IdempotencyMode.IDEMPOTENT, keyScope: "request" },
                        retry: { maxAttempts: 1, backoff: RetryBackoff.NONE },
                        cancellationSupport: CancellationSupport.UNSUPPORTED,
                        reconciliationSupport: ReconciliationSupport.NONE,
                    },
                }),
            ).rejects.toThrow(/raw secret/i);
            expect(await harness.store.listInvocations(mission.missionId)).toHaveLength(0);
        });

        it("allows an explicit waiting-to-ready transition but never auto-promotes waits", async () => {
            const mission = await acceptedForStep();
            const waiting = await engine.setWaiting(
                mission.missionId,
                MissionState.WAITING_FOR_CAPABILITY,
                "capability temporarily unavailable",
            );
            expect(waiting.state).toBe(MissionState.WAITING_FOR_CAPABILITY);
            await expect(engine.dispatchStep(mission.missionId, "step-1")).rejects.toThrow(/waiting/i);
            const ready = await engine.restoreWaitingToReady(mission.missionId);
            expect(ready.state).toBe(MissionState.READY);
        });

        it("does not recreate a completed effect when a later plan revision changes only the step id", async () => {
            const mission = await acceptedForStep();
            const first = await engine.dispatchStep(mission.missionId, "step-1");
            await engine.recordInvocationResult(first.invocationId, {
                invocationId: first.invocationId,
                status: InvocationStatus.COMPLETED,
                summary: "done",
                evidenceRefs: [],
                completedAt: BASE_TIME,
            });
            const proposal = await engine.proposePlan(
                mission.missionId,
                makeCandidate(mission.missionId, {
                    planId: "plan-2",
                    steps: [makeStep({ stepId: "step-2" })],
                }),
            );
            if (!proposal.ok) throw new Error("replan rejected");
            await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);

            const skipped = await engine.dispatchStep(mission.missionId, "step-2");
            expect(skipped.invocationId).toBe(first.invocationId);
            expect((await harness.store.listInvocations(mission.missionId))).toHaveLength(1);
        });

        it("records FAILED as an explicit attempt outcome without silently retrying", async () => {
            const mission = await acceptedForStep();
            const invocation = await engine.dispatchStep(mission.missionId, "step-1");
            await engine.recordInvocationResult(invocation.invocationId, {
                invocationId: invocation.invocationId,
                status: InvocationStatus.FAILED,
                summary: "definitive attempt failure",
                evidenceRefs: [],
                completedAt: BASE_TIME,
            });
            const stored = await harness.store.getInvocation(invocation.invocationId);
            expect(stored?.status).toBe(InvocationStatus.FAILED);
            expect(stored?.attempts.at(-1)).toMatchObject({ state: "failed", finishedAt: BASE_TIME });
            expect(stored?.retry.attempt).toBe(1);
            expect(stored?.retry.nextEligibleAt).toBeNull();
        });
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

        it("surfaces explicitly represented approvals from MissionIntent as Mission approval state (data, not authority)", async () => {
            const intent: MissionIntent = {
                ...makeIntent("mission_control"),
                approvals: [
                    {
                        approvalId: "ap-export",
                        scopeDescriptor: { capabilityId: "runstead.code-review", effectClass: EffectClass.EXECUTION, effectFingerprint: "0000000000000000000000000000000000000000000000000000000000000000" },
                        approver: "operator",
                        reason: "Export explicitly authorized by operator",
                        granted: true,
                        grantedBy: "operator",
                    },
                ],
            };
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            // Explicit approval represented on the intent flows to the Mission.
            expect(mission.approvalRequirements).toHaveLength(1);
            expect(mission.approvalRequirements[0].approvalId).toBe("ap-export");
            expect(mission.approvalRequirements[0].granted).toBe(true);
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

        it("proves the advisory-planner loop through PlannerPort: proposal rejected, replan accepted, intent preserved", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });

            // Planner (via PlannerPort) first proposes an unauthorized capability.
            harness.planner.setCandidate(makeCandidate(mission.missionId, {
                steps: [
                    makeStep({
                        capabilityRequirement: "tecer.health-check", // NOT in DEFAULT_SCOPE
                        inputRefs: ["refs/tecer/health"],
                    }),
                ],
            }));
            const firstProposal = await engine.proposePlan(
                mission.missionId,
                await harness.planner.proposePlan(mission),
            );
            expect(firstProposal.ok).toBe(false);

            // Planner replans with an authorized capability.
            harness.planner.setCandidate(makeCandidate(mission.missionId, {
                planId: "plan-2",
                steps: [makeStep({ inputRefs: ["refs/runstead/pr/42"] })],
            }));
            const secondProposal = await engine.proposePlan(
                mission.missionId,
                await harness.planner.replan(mission, "capability not authorized"),
            );
            expect(secondProposal.ok).toBe(true);
            if (!secondProposal.ok) return;
            const accepted = await engine.acceptPlan(mission.missionId, secondProposal.revision.revisionId);
            expect(accepted.state).toBe(MissionState.READY);
            // Original intent was never touched by the planner loop.
            expect(accepted.originalIntent).toBe(intent.originalIntent);
            expect(accepted.acceptanceCriteria).toEqual(intent.acceptanceCriteria);
        });

        it("rejects planning on a terminal Mission (cancelled)", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            await engine.cancelMission(mission.missionId, "operator cancelled");

            await expect(
                engine.proposePlan(mission.missionId, makeCandidate(mission.missionId)),
            ).rejects.toThrow(/terminal/i);
            // Durable state untouched.
            const after = await engine.getMission(mission.missionId);
            expect(after.state).toBe(MissionState.CANCELLED);
        });

        it("BLOCKER: a granted approval cannot be hijacked for another effect — mission never ready, no dispatch", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
                approvalRequirements: [
                    {
                        approvalId: "ap-write",
                        // Granted approval is bound to lifeos.write / WRITE.
                        scopeDescriptor: { capabilityId: "lifeos.write", effectClass: EffectClass.WRITE, effectFingerprint: "0000000000000000000000000000000000000000000000000000000000000000" },
                        approver: "operator",
                        reason: "Approved for life-domain write",
                        granted: true,
                        grantedBy: "operator",
                        grantedAt: BASE_TIME,
                    },
                ],
            });

            // Planner tries to reuse the SAME approval id for a different
            // capability/effect (runstead.deploy / NETWORK).
            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId, {
                steps: [
                    makeStep({
                        stepId: "step-deploy",
                        capabilityRequirement: "runstead.deploy",
                        effectClass: EffectClass.NETWORK,
                        inputRefs: ["refs/runstead/prod"],
                        approvalRequirement: {
                            approvalId: "ap-write",
                            approver: "operator",
                            reason: "Deploy to production",
                        },
                    }),
                ],
            }));
            // Rejected deterministically; old grant does NOT authorize the new step.
            expect(proposal.ok).toBe(false);
            if (proposal.ok) return;

            const after = await engine.getMission(mission.missionId);
            expect(after.state).not.toBe(MissionState.READY);
            // No accepted plan to dispatch from, and no invocation can exist.
            expect(after.currentPlanRevisionId).toBeNull();
            expect(after.invocationRefs).toHaveLength(0);
            await expect(engine.dispatchStep(mission.missionId, "step-deploy")).rejects.toThrow(
                /no accepted plan|dispatch/i,
            );
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

        it("rejects an InvocationResult whose echoed invocationId does not match (fail-closed identity)", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId));
            if (!proposal.ok) throw new Error("plan rejected");
            await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);

            const invocation = await engine.dispatchStep(mission.missionId, "step-1");
            expect(invocation.status).toBe(InvocationStatus.DISPATCHED);

            // A result declaring a DIFFERENT invocationId is identity drift,
            // never silently accepted for this invocation.
            await expect(
                engine.recordInvocationResult(invocation.invocationId, {
                    invocationId: "inv-other",
                    status: InvocationStatus.COMPLETED,
                    summary: "done",
                    evidenceRefs: [],
                    completedAt: BASE_TIME,
                }),
            ).rejects.toThrow(/mismatched result/);

            // The invocation was NOT updated by the rejected result.
            const invocations = await harness.store.listInvocations(mission.missionId);
            expect(invocations.find((i) => i.invocationId === invocation.invocationId)?.status).toBe(
                InvocationStatus.DISPATCHED,
            );
        });

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
                        scopeDescriptor: { capabilityId: "lifeos.write", effectClass: EffectClass.WRITE, effectFingerprint: "5852233e708b3de925eef53f1742bbc38dd0f93d80db8e1b4751151675e7f38d" },
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

        it("merges an approval declared only on the plan step into Mission approval state", async () => {
            const intent = makeIntent("cli");
            // No mission-level approval requirement at creation.
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            expect(mission.approvalRequirements).toEqual([]);

            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId, {
                steps: [
                    makeStep({
                        stepId: "step-write",
                        capabilityRequirement: "lifeos.write",
                        effectClass: EffectClass.WRITE,
                        inputRefs: ["refs/lifeos/journal"],
                        approvalRequirement: {
                            approvalId: "ap-step-only",
                            approver: "operator",
                            reason: "Write to life domain",
                        },
                    }),
                ],
            }));
            if (!proposal.ok) throw new Error("plan rejected");

            const waiting = await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);
            expect(waiting.state).toBe(MissionState.WAITING_FOR_APPROVAL);
            // Step approval surfaced on the Mission.
            expect(waiting.approvalRequirements.some((r) => r.approvalId === "ap-step-only")).toBe(true);

            const ready = await engine.recordApproval(mission.missionId, "ap-step-only", "operator");
            expect(ready.state).toBe(MissionState.READY);
        });

        it("rejects dispatch of a step that does not exist in the accepted plan", async () => {
            const mission = await acceptedMission();
            await expect(engine.dispatchStep(mission.missionId, "ghost-step")).rejects.toThrow(
                /not found in current plan/i,
            );
        });

        it("BLOCKER: rejects dispatch while waiting_for_approval with zero invocation created", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
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
                            reason: "Write to life domain",
                        },
                    }),
                ],
            }));
            if (!proposal.ok) throw new Error("plan rejected");
            await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);

            // Mission is waiting for approval.
            const waiting = await engine.getMission(mission.missionId);
            expect(waiting.state).toBe(MissionState.WAITING_FOR_APPROVAL);

            // Dispatch must be rejected and must NOT create an invocation.
            await expect(engine.dispatchStep(mission.missionId, "step-write")).rejects.toThrow(
                /approval/i,
            );
            const after = await engine.getMission(mission.missionId);
            expect(after.invocationRefs).toHaveLength(0);
            expect(await harness.store.listInvocations(mission.missionId)).toHaveLength(0);
            expect(after.state).toBe(MissionState.WAITING_FOR_APPROVAL);
        });

        it("BLOCKER: rejects dispatch when capability becomes unavailable (no invocation created)", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId, {
                steps: [
                    makeStep({
                        stepId: "step-deploy",
                        capabilityRequirement: "runstead.deploy",
                        effectClass: EffectClass.NETWORK,
                        inputRefs: ["refs/runstead/prod"],
                        approvalRequirement: {
                            approvalId: "ap-deploy",
                            approver: "operator",
                            reason: "Deployment requires approval",
                        },
                    }),
                ],
            }));
            if (!proposal.ok) throw new Error("plan rejected");
            await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);
            await engine.recordApproval(mission.missionId, "ap-deploy", "operator");

            const ready = await engine.getMission(mission.missionId);
            expect(ready.state).toBe(MissionState.READY);

            // Capability becomes unavailable after plan validation.
            harness.resolver.unregister("runstead.deploy");

            await expect(engine.dispatchStep(mission.missionId, "step-deploy")).rejects.toThrow(
                /no longer available/i,
            );
            const after = await engine.getMission(mission.missionId);
            expect(after.invocationRefs).toHaveLength(0);
            expect(await harness.store.listInvocations(mission.missionId)).toHaveLength(0);
        });

        it("BLOCKER: completed invocation cannot be re-dispatched (no second invocation)", async () => {
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

            // Re-dispatch of the same logical step is forbidden.
            await expect(engine.dispatchStep(mission.missionId, "step-1")).rejects.toThrow(
                /blind redispatch|already has invocation/i,
            );
            const after = await engine.getMission(mission.missionId);
            expect(after.invocationRefs).toHaveLength(1);
            expect(after.invocationRefs[0].invocationId).toBe(invocation.invocationId);
            expect(after.invocationRefs[0].status).toBe(InvocationStatus.COMPLETED);
            expect(await harness.store.listInvocations(mission.missionId)).toHaveLength(1);
        });

        it("BLOCKER: terminal states are immutable — no normal operation can resurrect or reclassify them", async () => {
            // COMPLETED
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
                    summary: "done",
                    evidenceRefs: [
                        { refId: "ev-1", owner: "runstead", externalRef: "r:1", label: "PR merged" },
                        { refId: "ev-2", owner: "runstead", externalRef: "r:2", label: "CI green" },
                    ],
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
            harness.authority.registerCriterionAttestation(mission.missionId, "PR merged", "runstead");
            harness.authority.registerCriterionAttestation(mission.missionId, "CI green", "runstead");
            harness.authority.registerCriterionAttestation(mission.missionId, "PR merged", "runstead");
            harness.authority.registerCriterionAttestation(mission.missionId, "CI green", "runstead");
            await engine.recordCriterionVerification(mission.missionId, "PR merged", true, "runstead", "ev-1");
            await engine.recordCriterionVerification(mission.missionId, "CI green", true, "runstead", "ev-2");
            const completed = await engine.completeMission(mission.missionId);
            expect(completed.state).toBe(MissionState.COMPLETED);

            // No normal operation may mutate a completed Mission.
            await expect(engine.setWaiting(mission.missionId, MissionState.WAITING_FOR_CONTEXT)).rejects.toThrow(/terminal/i);
            await expect(engine.cancelMission(mission.missionId, "late cancel")).rejects.toThrow(/terminal/i);
            await expect(engine.failMission(mission.missionId, "late fail")).rejects.toThrow(/terminal/i);
            await expect(engine.blockMission(mission.missionId, "late block")).rejects.toThrow(/terminal/i);
            await expect(engine.completeMission(mission.missionId)).rejects.toThrow(/terminal/i);
            await expect(engine.recordApproval(mission.missionId, "ap-write", "operator")).rejects.toThrow(/terminal/i);
            // State is still COMPLETED.
            expect((await engine.getMission(mission.missionId)).state).toBe(MissionState.COMPLETED);

            // CANCELLED
            const m2 = await engine.createMission({
                intent: makeIntent("cli"),
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            await engine.cancelMission(m2.missionId, "operator cancelled");
            await expect(engine.completeMission(m2.missionId)).rejects.toThrow(/terminal/i);
            await expect(engine.setWaiting(m2.missionId, MissionState.WAITING_FOR_CONTEXT)).rejects.toThrow(/terminal/i);
            await expect(engine.failMission(m2.missionId, "late fail")).rejects.toThrow(/terminal/i);
            await expect(engine.blockMission(m2.missionId, "late block")).rejects.toThrow(/terminal/i);
            expect((await engine.getMission(m2.missionId)).state).toBe(MissionState.CANCELLED);

            // FAILED_TERMINAL
            const m3 = await engine.createMission({
                intent: makeIntent("cli"),
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            await engine.failMission(m3.missionId, "fatal error");
            await expect(engine.blockMission(m3.missionId, "late block")).rejects.toThrow(/terminal/i);
            await expect(engine.completeMission(m3.missionId)).rejects.toThrow(/terminal/i);
            await expect(engine.setWaiting(m3.missionId, MissionState.WAITING_FOR_CONTEXT)).rejects.toThrow(/terminal/i);
            await expect(engine.cancelMission(m3.missionId, "late cancel")).rejects.toThrow(/terminal/i);
            expect((await engine.getMission(m3.missionId)).state).toBe(MissionState.FAILED_TERMINAL);
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

        it("BLOCKER: rejects OwnerVerification whose owner is not the capability's module owner", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId));
            if (!proposal.ok) throw new Error("plan rejected");
            await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);

            const invocation = await engine.dispatchStep(mission.missionId, "step-1");
            // runstead.code-review belongs to "runstead", but the caller
            // claims "katherine" verified it — must be rejected fail-closed.
            await expect(
                engine.recordInvocationResult(
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
                        reason: "looks good",
                        owner: "katherine",
                        verifiedAt: BASE_TIME,
                    },
                ),
            ).rejects.toThrow(/module owner/i);

            const after = await engine.getMission(mission.missionId);
            expect(after.invocationRefs[0].ownerVerification).toBeUndefined();
        });

        it("BLOCKER: rejects OwnerVerification whose invocationId does not match the real invocation", async () => {
            const intent = makeIntent("cli");
            const mission = await engine.createMission({
                intent,
                allowedCapabilityScope: DEFAULT_SCOPE,
            });
            const proposal = await engine.proposePlan(mission.missionId, makeCandidate(mission.missionId));
            if (!proposal.ok) throw new Error("plan rejected");
            await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);

            const invocation = await engine.dispatchStep(mission.missionId, "step-1");
            await expect(
                engine.recordInvocationResult(
                    invocation.invocationId,
                    {
                        invocationId: invocation.invocationId,
                        status: InvocationStatus.COMPLETED,
                        summary: "done",
                        evidenceRefs: [],
                        completedAt: BASE_TIME,
                    },
                    {
                        invocationId: "some-other-invocation",
                        verified: true,
                        reason: "ok",
                        owner: "runstead",
                        verifiedAt: BASE_TIME,
                    },
                ),
            ).rejects.toThrow(/invocationId/i);

            const after = await engine.getMission(mission.missionId);
            expect(after.invocationRefs[0].ownerVerification).toBeUndefined();
        });

        it("BLOCKER: criterion verification with a forged textual source cannot complete a Mission", async () => {
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

            // The caller tries to fabricate criterion verification with a
            // textual source that is NOT registered on the authority.
            await expect(
                engine.recordCriterionVerification(
                    mission.missionId,
                    "PR merged",
                    true,
                    "module-owner:runstead", // forged string, not the real owner "runstead"
                    "ev-1",
                ),
            ).rejects.toThrow(/attestation|verified module owner/i);

            const verification = await engine.verifyMission(mission.missionId);
            expect(verification.satisfied).toBe(false);
            await expect(engine.completeMission(mission.missionId)).rejects.toThrow();
        });

        it("completes a Mission only with typed criterion verification + positive owner verification", async () => {
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

            // Without typed criterion verification, evidence labels alone
            // must NOT satisfy acceptance (fail-closed).
            const beforeTyped = await engine.verifyMission(mission.missionId);
            expect(beforeTyped.satisfied).toBe(false);
            expect(beforeTyped.ownerBlocked).toBe(false);

            // Explicit deterministic typed verification per acceptance criterion.
            harness.authority.registerCriterionAttestation(mission.missionId, "PR merged", "runstead");
            harness.authority.registerCriterionAttestation(mission.missionId, "CI green", "runstead");
            await engine.recordCriterionVerification(
                mission.missionId,
                "PR merged",
                true,
                "runstead",
                "ev-1",
            );
            await engine.recordCriterionVerification(
                mission.missionId,
                "CI green",
                true,
                "runstead",
                "ev-2",
            );

            const verification = await engine.verifyMission(mission.missionId);
            expect(verification.satisfied).toBe(true);
            expect(verification.ownerBlocked).toBe(false);

            const completed = await engine.completeMission(mission.missionId);
            expect(completed.state).toBe(MissionState.COMPLETED);
        });

        it("does NOT complete when evidence labels match acceptance but typed verification is absent", async () => {
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
                    // Labels that happen to contain the acceptance text.
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

            // Text labels are NOT completion authority.
            const verification = await engine.verifyMission(mission.missionId);
            expect(verification.satisfied).toBe(false);
            expect(verification.ownerBlocked).toBe(false);
            await expect(engine.completeMission(mission.missionId)).rejects.toThrow();
            const after = await engine.getMission(mission.missionId);
            expect(after.state).not.toBe(MissionState.COMPLETED);
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

        it("BLOCKER: owner verification is rejected without an attestation authority (fail-closed)", async () => {
            // Engine WITHOUT an injected authority must fail closed even when
            // the caller submits the correct owner and invocationId.
            const noAuthority = createHarness(new FakeClock(BASE_TIME), { withAuthority: false });
            await noAuthority.store.initialize();
            const e = noAuthority.engine;
            try {
                const intent = makeIntent("cli");
                const mission = await e.createMission({
                    intent,
                    allowedCapabilityScope: DEFAULT_SCOPE,
                });
                const proposal = await e.proposePlan(mission.missionId, makeCandidate(mission.missionId));
                if (!proposal.ok) throw new Error("plan rejected");
                await e.acceptPlan(mission.missionId, proposal.revision.revisionId);

                const invocation = await e.dispatchStep(mission.missionId, "step-1");
                await expect(
                    e.recordInvocationResult(
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
                            reason: "looks good",
                            owner: "runstead",
                            verifiedAt: BASE_TIME,
                        },
                    ),
                ).rejects.toThrow(/no verification authority/i);

                const after = await e.getMission(mission.missionId);
                expect(after.invocationRefs[0].ownerVerification).toBeUndefined();
                expect(after.invocationRefs[0].status).toBe(InvocationStatus.DISPATCHED);
            } finally {
                await noAuthority.close();
            }
        });

        it("BLOCKER: criterion verification is rejected without an attestation authority (fail-closed)", async () => {
            const noAuthority = createHarness(new FakeClock(BASE_TIME), { withAuthority: false });
            await noAuthority.store.initialize();
            const e = noAuthority.engine;
            try {
                const intent = makeIntent("cli");
                const mission = await e.createMission({
                    intent,
                    allowedCapabilityScope: DEFAULT_SCOPE,
                });
                await expect(
                    e.recordCriterionVerification(mission.missionId, "PR merged", true, "runstead", "ev-1"),
                ).rejects.toThrow(/no verification authority/i);
            } finally {
                await noAuthority.close();
            }
        });

        it("BLOCKER: criterion verification cannot be fabricated for a non-acceptance criterion", async () => {
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

            // Criterion "B" is not an acceptance criterion; the authority
            // must reject it even though "runstead" is a trusted owner.
            await expect(
                engine.recordCriterionVerification(mission.missionId, "B", true, "runstead", "ev-1"),
            ).rejects.toThrow(/not one of the Mission acceptance criteria/i);

            const verification = await engine.verifyMission(mission.missionId);
            expect(verification.satisfied).toBe(false);
        });

        it("BLOCKER: criterion verification requires a specific attestation — A attested, B rejected until attested", async () => {
            // Acceptance criteria: A="PR merged", B="CI green".
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

            // Register attestation ONLY for criterion A ("PR merged").
            harness.authority.registerCriterionAttestation(mission.missionId, "PR merged", "runstead");

            // A is attested and can be recorded.
            await engine.recordCriterionVerification(mission.missionId, "PR merged", true, "runstead", "ev-1");

            // B is a VALID acceptance criterion but NOT attested — must be rejected.
            await expect(
                engine.recordCriterionVerification(mission.missionId, "CI green", true, "runstead", "ev-2"),
            ).rejects.toThrow(/no attestation registered/i);

            // Mission cannot complete without B verified.
            const verifyAOnly = await engine.verifyMission(mission.missionId);
            expect(verifyAOnly.satisfied).toBe(false);

            // Register attestation for B — now it can be recorded.
            harness.authority.registerCriterionAttestation(mission.missionId, "CI green", "runstead");
            await engine.recordCriterionVerification(mission.missionId, "CI green", true, "runstead", "ev-2");

            // Both criteria verified → completion can proceed.
            const verifyBoth = await engine.verifyMission(mission.missionId);
            expect(verifyBoth.satisfied).toBe(true);
            expect(verifyBoth.ownerBlocked).toBe(false);
            const completed = await engine.completeMission(mission.missionId);
            expect(completed.state).toBe(MissionState.COMPLETED);
        });

        it("BLOCKER: a terminal Mission rejects late invocation results (consistency)", async () => {
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
                    summary: "done",
                    evidenceRefs: [
                        { refId: "ev-1", owner: "runstead", externalRef: "r:1", label: "PR merged" },
                        { refId: "ev-2", owner: "runstead", externalRef: "r:2", label: "CI green" },
                    ],
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
            harness.authority.registerCriterionAttestation(mission.missionId, "PR merged", "runstead");
            harness.authority.registerCriterionAttestation(mission.missionId, "CI green", "runstead");
            await engine.recordCriterionVerification(mission.missionId, "PR merged", true, "runstead", "ev-1");
            await engine.recordCriterionVerification(mission.missionId, "CI green", true, "runstead", "ev-2");
            const completed = await engine.completeMission(mission.missionId);
            expect(completed.state).toBe(MissionState.COMPLETED);

            // Late owner verification (negative) must be rejected — the
            // terminal Mission cannot diverge from its canonical verification.
            await expect(
                engine.recordInvocationResult(
                    invocation.invocationId,
                    {
                        invocationId: invocation.invocationId,
                        status: InvocationStatus.COMPLETED,
                        summary: "late change",
                        evidenceRefs: [],
                        completedAt: BASE_TIME,
                    },
                    {
                        invocationId: invocation.invocationId,
                        verified: false,
                        reason: "late regression",
                        owner: "runstead",
                        verifiedAt: BASE_TIME,
                    },
                ),
            ).rejects.toThrow(/terminal/i);

            // Persisted Mission and invocation remain consistent.
            const after = await engine.getMission(mission.missionId);
            expect(after.state).toBe(MissionState.COMPLETED);
            expect(after.invocationRefs[0].ownerVerification?.verified).toBe(true);
            expect(after.invocationRefs[0].status).toBe(InvocationStatus.COMPLETED);
            const stored = await harness.store.getInvocation(invocation.invocationId);
            expect(stored!.ownerVerification?.verified).toBe(true);
        });
    });
});
