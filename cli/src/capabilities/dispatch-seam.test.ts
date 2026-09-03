/**
 * 🎯 Dispatch Seam Tests (PR #73 review rounds 2-5)
 *
 * Proves the ONE deterministic dispatch seam:
 *  - honest status mapping (no invented terminality);
 *  - declarative schema enforcement at the effectful boundary (raw result
 *    AND evidence items, rounds 3-4);
 *  - split-brain authority guard (policy contract == registry descriptor);
 *  - transient availability consumes NO dispatch (retake after recovery);
 *  - invoke() exceptions leave UNCERTAIN (blocked) state, never "failed";
 *  - owner verification verdicts propagate; verified:false never succeeds;
 *  - a refused POSITIVE attestation on a verification-required capability
 *    is BLOCKED, never COMPLETED (round 4);
 *  - a PRESENT ownerVerification outcome is structurally gated before any
 *    verdict consumption (round 5): malformed truthy values never decide
 *    whether mandatory verification exists.
 *
 * Deterministic: in-memory SQLite, fake clock/ids, no network, no env.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EffectClass, InvocationStatus } from "../mission/contracts.js";
import { MissionEngine } from "../mission/mission-engine.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import { PlanPolicyValidator } from "../mission/policy.js";
import {
    FakeCapabilityResolver,
    FakeClock,
    FakeIdGenerator,
    FakeVerificationAuthority,
    makeDefaultCapabilityCatalog,
} from "../mission/testing.js";
import {
    CapabilityContractConflictError,
    CapabilityRegistry,
    ConnectorContractVersionError,
} from "./registry.js";
import { defineCapabilityDescriptor } from "./fixtures.js";
import { CapabilityAvailability, type CapabilityDescriptor } from "./contracts.js";
import {
    CapabilityResultStatus,
    type CapabilityConnector,
    type CapabilityResult,
    type ConnectorRequest,
} from "./connector.js";
import type { PlanCandidate } from "../mission/contracts.js";
import {
    CapabilityUnavailableError,
    ConnectorDispatchSeam,
    ConnectorIdentityMismatchError,
    ConnectorInputSchemaError,
    ConnectorNotRegisteredError,
    ConnectorResultSchemaError,
    DispatchSeamError,
    invocationStatusFor,
    PolicyContractMismatchError,
} from "./dispatch-seam.js";

const BASE_TIME = "2026-08-30T12:00:00.000Z";

const REVIEW_DESCRIPTOR = defineCapabilityDescriptor({
    capabilityId: "runstead.code-review",
    moduleOwner: "runstead",
    purpose: "Review a pull request and produce evidence-backed findings",
    effectClass: EffectClass.EXECUTION,
    allowedInputRefPrefixes: ["refs/runstead/"],
    requiresOwnerVerification: true,
    cancellationSupport: "cooperative" as const,
    reconciliationSupport: "status_replay" as const,
});

// ownsStorage mirrors the default #62 catalog contract for this id: policy
// and registry must agree or the split-brain guard would (rightly) trip.
const HEALTH_DESCRIPTOR = defineCapabilityDescriptor({
    capabilityId: "tecer.health-check",
    moduleOwner: "tecer",
    purpose: "Check the health of the tecer service",
    effectClass: EffectClass.READ,
    allowedInputRefPrefixes: ["refs/tecer/"],
    requiresOwnerVerification: true,
    ownsStorage: true,
    availability: CapabilityAvailability.UNAVAILABLE,
    availabilityDetail: "owner offline for scheduled maintenance",
});

// Non-verifying capability: status mapping flows without owner verdicts.
const QUERY_DESCRIPTOR = defineCapabilityDescriptor({
    capabilityId: "lifeos.query",
    moduleOwner: "lifeos",
    purpose: "Query the life domain",
    effectClass: EffectClass.READ,
    allowedInputRefPrefixes: ["refs/lifeos/"],
    requiresOwnerVerification: false,
    ownsStorage: true,
});

function makeStep(overrides: {
    stepId: string;
    capabilityRequirement: string;
    inputRefs: string[];
    effectClass?: EffectClass;
}) {
    return {
        desiredOutcome: `satisfy ${overrides.stepId}`,
        dependencyIds: [],
        expectedAcceptance: [`${overrides.stepId} done`],
        effectClass: overrides.effectClass ?? EffectClass.EXECUTION,
        ...overrides,
    };
}

interface Harness {
    engine: MissionEngine;
    store: SqliteMissionStore;
    registry: CapabilityRegistry;
    resolver: FakeCapabilityResolver;
    seam: ConnectorDispatchSeam;
    clock: FakeClock;
    authority: FakeVerificationAuthority;
    close: () => Promise<void>;
}

function createHarness(): Harness {
    const store = new SqliteMissionStore(":memory:");
    const resolver = new FakeCapabilityResolver();
    resolver.registerMany(makeDefaultCapabilityCatalog());
    const clock = new FakeClock(BASE_TIME);
    const authority = new FakeVerificationAuthority();
    const engine = new MissionEngine({
        store,
        policy: new PlanPolicyValidator(resolver),
        clock,
        ids: new FakeIdGenerator("inv"),
        interpreter: (i) => i.originalIntent,
        verificationAuthority: authority,
    });
    const registry = new CapabilityRegistry();
    registry.register(REVIEW_DESCRIPTOR);
    registry.register(HEALTH_DESCRIPTOR);
    registry.register(QUERY_DESCRIPTOR);
    const seam = new ConnectorDispatchSeam(engine, registry, clock);
    return { engine, store, registry, resolver, seam, clock, authority, close: () => store.close() };
}

/**
 * Deterministic counting connector. The default result echoes the request
 * id and carries a POSITIVE owner verdict (the REVIEW capability requires
 * one); overrides replace invoke() wholesale and MUST count themselves.
 */
function makeSeamConnector(
    descriptor: CapabilityDescriptor,
    counters: { describe: number; invoke: number },
    overrides: Partial<CapabilityConnector> = {},
): CapabilityConnector {
    return {
        connectorContractVersion: 1,
        capabilityId: descriptor.capabilityId,
        describe: () => {
            counters.describe++;
            return descriptor;
        },
        invoke: async (request: ConnectorRequest): Promise<CapabilityResult> => {
            counters.invoke++;
            return {
                status: CapabilityResultStatus.COMPLETED,
                requestId: request.requestId,
                summary: `done ${request.requestId}`,
                evidence: [
                    {
                        owner: descriptor.moduleOwner,
                        externalRef: "review/report-1",
                        label: "review report",
                    },
                ],
                ownerVerification: {
                    owner: descriptor.moduleOwner,
                    verified: true,
                    reason: "verified by fixture owner",
                },
            };
        },
        ...overrides,
    };
}

const INTENT = {
    requestId: "req-seam",
    source: "cli" as const,
    originalIntent: "Run the planned steps",
    constraints: [],
    acceptanceCriteria: ["steps done"],
    contextRefs: [],
};

async function acceptMission(
    harness: Harness,
    steps: ReturnType<typeof makeStep>[],
): Promise<string> {
    const mission = await harness.engine.createMission({
        intent: { ...INTENT, requestId: `req-${steps[0].stepId}` },
        allowedCapabilityScope: {
            capabilityIds: steps.map((s) => s.capabilityRequirement),
            allowedEffectClasses: [EffectClass.EXECUTION, EffectClass.READ],
            allowedRefPrefixes: ["refs/runstead/", "refs/tecer/", "refs/lifeos/"],
        },
    });
    const candidate: PlanCandidate = {
        planId: "plan-1",
        missionId: mission.missionId,
        plannerNote: "seam test plan",
        steps,
    };
    const proposal = await harness.engine.proposePlan(mission.missionId, candidate);
    if (!proposal.ok) throw new Error(`plan rejected: ${JSON.stringify(proposal)}`);
    await harness.engine.acceptPlan(mission.missionId, proposal.revision.revisionId);
    return mission.missionId;
}

// Two-step mission: the first step targets the UNAVAILABLE health check.
async function acceptTwoStepMission(harness: Harness): Promise<string> {
    return acceptMission(harness, [
        makeStep({
            stepId: "step-broken",
            capabilityRequirement: "tecer.health-check",
            inputRefs: ["refs/tecer/status"],
            effectClass: EffectClass.READ,
        }),
        makeStep({
            stepId: "step-good",
            capabilityRequirement: "runstead.code-review",
            inputRefs: ["refs/runstead/pr/42"],
        }),
    ]);
}

describe("ConnectorDispatchSeam", () => {
    let harness: Harness;
    beforeEach(async () => {
        harness = createHarness();
        await harness.store.initialize();
    });
    afterEach(async () => {
        await harness.close();
    });

    it("routes an authorized invocation to the REGISTERED connector and records its typed result", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters),
        );

        const outcome = await harness.seam.dispatchThroughSeam(missionId, "step-good");

        expect(outcome.recordedStatus).toBe(InvocationStatus.COMPLETED);
        expect(counters.invoke).toBe(1);
        expect(outcome.result.requestId).toBe(outcome.invocation.invocationId);

        const stored = await harness.store.getInvocation(outcome.invocation.invocationId);
        expect(stored?.status).toBe(InvocationStatus.COMPLETED);
        expect(stored?.completedAt).toBe(BASE_TIME);
        expect(stored?.resultRefs).toHaveLength(1);
        expect(stored?.resultRefs[0].externalRef).toBe("review/report-1");
        expect(stored?.ownerVerification?.verified).toBe(true);
    });

    it("persists the submitted delivery boundary before connector.invoke", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        let observedDelivery: string | undefined;
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    const invocation = (await harness.store.getInvocation(request.requestId));
                    observedDelivery = invocation?.delivery.state;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "done",
                        evidence: [],
                        ownerVerification: {
                            owner: REVIEW_DESCRIPTOR.moduleOwner,
                            verified: true,
                            reason: "verified by fixture owner",
                        },
                    };
                },
            }),
        );

        await harness.seam.dispatchThroughSeam(missionId, "step-good");

        expect(observedDelivery).toBe("submitted");
        expect(counters.invoke).toBe(0);
        const stored = await harness.store.getInvocation(
            (await harness.store.listInvocations(missionId))[0].invocationId,
        );
        expect(stored?.cancellation.support).toBe("cooperative");
        expect(stored?.reconciliation.support).toBe("status_replay");
    });

    it("resumes a durable not-submitted invocation without minting a second row", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const invocation = await harness.engine.dispatchStep(missionId, "step-good", {
            descriptor: {
                contractVersion: 1,
                moduleOwner: "runstead",
                idempotency: { mode: "idempotent", keyScope: "request" },
                retry: { maxAttempts: 0, backoff: "none" },
                cancellationSupport: "cooperative",
                reconciliationSupport: "status_replay",
            },
        });
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters),
        );

        const outcome = await harness.seam.dispatchPersistedInvocation(invocation.invocationId);

        expect(outcome.recordedStatus).toBe(InvocationStatus.COMPLETED);
        expect(counters.invoke).toBe(1);
        expect(await harness.store.listInvocations(missionId)).toHaveLength(1);
    });

    it("reconciles uncertain delivery by request identity without invoking again", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0, reconcile: 0 };
        let reconciledRequestId: string | undefined;
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async () => {
                    counters.invoke++;
                    throw new Error("ack lost after submission");
                },
                reconcile: async (requestId) => {
                    counters.reconcile++;
                    reconciledRequestId = requestId;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId,
                        summary: "owner confirms completion",
                        evidence: [],
                        ownerVerification: {
                            owner: REVIEW_DESCRIPTOR.moduleOwner,
                            verified: true,
                            reason: "reconciled by owner",
                        },
                    };
                },
            }),
        );

        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(/uncertain/);
        const uncertain = (await harness.store.listInvocations(missionId))[0];
        const reconciled = await harness.seam.reconcileInvocation(uncertain.invocationId);

        expect(counters.invoke).toBe(1);
        expect(counters.reconcile).toBe(1);
        expect(reconciled.recordedStatus).toBe(InvocationStatus.COMPLETED);
        expect(reconciledRequestId).toBe(uncertain.requestId);
        expect((await harness.store.getInvocation(uncertain.invocationId))?.status).toBe(
            InvocationStatus.COMPLETED,
        );
        const duplicate = await harness.seam.reconcileInvocation(uncertain.invocationId);
        expect(duplicate.recordedStatus).toBe(InvocationStatus.COMPLETED);
        expect(duplicate.result).toBeNull();
        expect(counters.reconcile).toBe(1);
    });

    it("blocks conservatively and never re-invokes when reconciliation is unsupported", async () => {
        const missionId = await acceptMission(harness, [
            makeStep({
                stepId: "step-query",
                capabilityRequirement: "lifeos.query",
                inputRefs: ["refs/lifeos/status"],
                effectClass: EffectClass.READ,
            }),
        ]);
        const counters = { describe: 0, invoke: 0, reconcile: 0 };
        harness.seam.registerConnector(
            QUERY_DESCRIPTOR.capabilityId,
            makeSeamConnector(QUERY_DESCRIPTOR, counters, {
                invoke: async () => {
                    counters.invoke++;
                    throw new Error("owner disconnected");
                },
                reconcile: async () => {
                    counters.reconcile++;
                    return null;
                },
            }),
        );

        await expect(harness.seam.dispatchThroughSeam(missionId, "step-query")).rejects.toThrow(/uncertain/);
        const uncertain = (await harness.store.listInvocations(missionId))[0];
        const reconciled = await harness.seam.reconcileInvocation(uncertain.invocationId);

        expect(counters.invoke).toBe(1);
        expect(counters.reconcile).toBe(0);
        expect(reconciled.recordedStatus).toBe(InvocationStatus.BLOCKED);
        expect(reconciled.invocation.reconciliation.state).toBe("unsupported");
        expect(reconciled.invocation.reconciliation.nextAction).toMatch(/blind replay/i);
    });

    it("rejects dispatch with NO connector registered — pre-mint, no invocation exists", async () => {
        const missionId = await acceptTwoStepMission(harness);
        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(
            ConnectorNotRegisteredError,
        );
        expect(await harness.store.listInvocations(missionId)).toHaveLength(0);
    });

    it("never lets a look-alike connector register under another capability's id", () => {
        expect(() =>
            harness.seam.registerConnector(
                "tecer.health-check",
                makeSeamConnector(REVIEW_DESCRIPTOR, { describe: 0, invoke: 0 }),
            ),
        ).toThrow(ConnectorIdentityMismatchError);
    });

    it("forbids silent connector swaps at registration", async () => {
        const missionId = await acceptTwoStepMission(harness);
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, { describe: 0, invoke: 0 }),
        );
        expect(() =>
            harness.seam.registerConnector(
                REVIEW_DESCRIPTOR.capabilityId,
                makeSeamConnector(REVIEW_DESCRIPTOR, { describe: 0, invoke: 0 }),
            ),
        ).toThrow(/silent connector swaps are forbidden/);
        void missionId;
    });

    it("stops stale connectors at the version gate with ZERO connector calls and no minting", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, { connectorContractVersion: 99 }),
        );
        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(
            ConnectorContractVersionError,
        );
        expect(counters.describe).toBe(0);
        expect(counters.invoke).toBe(0);
        expect(await harness.store.listInvocations(missionId)).toHaveLength(0);
    });

    it("rejects connectors whose describe() diverges from the registered descriptor — zero invoke calls", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector({ ...REVIEW_DESCRIPTOR, purpose: "diverged purpose" }, counters),
        );
        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(
            CapabilityContractConflictError,
        );
        expect(counters.invoke).toBe(0);
        expect(await harness.store.listInvocations(missionId)).toHaveLength(0);
    });

    it("maps connector statuses honestly: STILL_RUNNING→RUNNING, UNKNOWN→BLOCKED (blocker 1)", () => {
        const base = { requestId: "r", summary: "s", evidence: [] };
        expect(invocationStatusFor({ ...base, status: CapabilityResultStatus.COMPLETED })).toBe(
            InvocationStatus.COMPLETED,
        );
        expect(invocationStatusFor({ ...base, status: CapabilityResultStatus.FAILED })).toBe(
            InvocationStatus.FAILED,
        );
        expect(invocationStatusFor({ ...base, status: CapabilityResultStatus.STILL_RUNNING })).toBe(
            InvocationStatus.RUNNING,
        );
        expect(invocationStatusFor({ ...base, status: CapabilityResultStatus.UNKNOWN })).toBe(
            InvocationStatus.BLOCKED,
        );
    });

    it("records STILL_RUNNING as non-terminal (RUNNING, no completedAt) through the real seam", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.STILL_RUNNING,
                        requestId: request.requestId,
                        summary: "long-running review",
                        evidence: [],
                        ownerVerification: {
                            owner: "runstead",
                            verified: true,
                            reason: "in progress, owner notified",
                        },
                    };
                },
            }),
        );

        const outcome = await harness.seam.dispatchThroughSeam(missionId, "step-good");
        expect(outcome.recordedStatus).toBe(InvocationStatus.RUNNING);
        expect(counters.invoke).toBe(1);
        const stored = await harness.store.getInvocation(outcome.invocation.invocationId);
        expect(stored?.status).toBe(InvocationStatus.RUNNING);
        expect(stored?.completedAt).toBeUndefined();
    });

    it("persists the owner operation handle and requests active cancellation without invoking again", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        let cancelledHandle: string | undefined;
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.STILL_RUNNING,
                        requestId: request.requestId,
                        summary: "review running",
                        evidence: [],
                        ownerOperationRef: "owner-operation-1",
                        ownerVerification: {
                            owner: REVIEW_DESCRIPTOR.moduleOwner,
                            verified: true,
                            reason: "owner accepted the running operation",
                        },
                    };
                },
                cancel: async (ownerOperationRef) => {
                    cancelledHandle = ownerOperationRef;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: (await harness.store.listInvocations(missionId))[0].requestId,
                        summary: "cancellation accepted",
                        evidence: [],
                    };
                },
            }),
        );

        const dispatched = await harness.seam.dispatchThroughSeam(missionId, "step-good");
        await harness.engine.cancelMission(missionId, "operator stopped the active review", "operator-1");
        const outcome = await harness.seam.cancelInvocation(dispatched.invocation.invocationId);
        const stored = await harness.store.getInvocation(dispatched.invocation.invocationId);

        expect(counters.invoke).toBe(1);
        expect(cancelledHandle).toBe("owner-operation-1");
        expect(outcome.recordedStatus).toBe(InvocationStatus.RUNNING);
        expect(stored?.status).toBe(InvocationStatus.RUNNING);
        expect(stored?.delivery.remoteOperationHandle).toBe("owner-operation-1");
        expect(stored?.cancellation).toMatchObject({
            requested: true,
            requestedBy: "operator-1",
            state: "acknowledged",
        });
        expect(stored?.reconciliation).toMatchObject({ state: "pending" });
    });

    it("reacquires a completed external result through reconciliation without a second submission", async () => {
        const missionId = await acceptMission(harness, [
            makeStep({
                stepId: "step-review",
                capabilityRequirement: REVIEW_DESCRIPTOR.capabilityId,
                inputRefs: ["refs/runstead/pr/42"],
                effectClass: EffectClass.EXECUTION,
            }),
        ]);
        const counters = { describe: 0, invoke: 0, reconcile: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "initial read",
                        evidence: [],
                        ownerVerification: {
                            owner: REVIEW_DESCRIPTOR.moduleOwner,
                            verified: true,
                            reason: "owner completed the review",
                        },
                    };
                },
                reconcile: async (requestId) => {
                    counters.reconcile++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId,
                        summary: "reacquired read",
                        evidence: [],
                        ownerVerification: {
                            owner: REVIEW_DESCRIPTOR.moduleOwner,
                            verified: true,
                            reason: "owner confirmed the review",
                        },
                    };
                },
            }),
        );

        const first = await harness.seam.dispatchThroughSeam(missionId, "step-review");
        const reacquired = await harness.seam.reacquireCompletedInvocation(first.invocation.invocationId);

        expect(counters.invoke).toBe(1);
        expect(counters.reconcile).toBe(1);
        expect(reacquired.recordedStatus).toBe(InvocationStatus.COMPLETED);
        expect(reacquired.result?.summary).toBe("reacquired read");
        expect(await harness.store.listInvocations(missionId)).toHaveLength(1);
        expect((await harness.store.getInvocation(first.invocation.invocationId))?.status).toBe(
            InvocationStatus.COMPLETED,
        );
    });

    it("records UNKNOWN as uncertain (BLOCKED, never completed) through the real seam", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.UNKNOWN,
                        requestId: request.requestId,
                        summary: "provider gave no status",
                        evidence: [],
                    };
                },
            }),
        );

        const outcome = await harness.seam.dispatchThroughSeam(missionId, "step-good");
        expect(outcome.recordedStatus).toBe(InvocationStatus.BLOCKED);
        const stored = await harness.store.getInvocation(outcome.invocation.invocationId);
        expect(stored?.status).toBe(InvocationStatus.BLOCKED);
        expect(stored?.completedAt).toBeUndefined();
    });

    it("uses persisted ownerOperationRef with observeStatus when reconcile is not exposed", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0, observe: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.STILL_RUNNING,
                        requestId: request.requestId,
                        summary: "review running",
                        evidence: [],
                        ownerOperationRef: "owner-operation-observe",
                    };
                },
                observeStatus: async (ownerOperationRef) => {
                    counters.observe++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: (await harness.store.listInvocations(missionId))[0].requestId,
                        summary: `observed ${ownerOperationRef}`,
                        evidence: [],
                        ownerVerification: {
                            owner: REVIEW_DESCRIPTOR.moduleOwner,
                            verified: true,
                            reason: "owner confirmed completion",
                        },
                    };
                },
            }),
        );

        const running = await harness.seam.dispatchThroughSeam(missionId, "step-good");
        expect((await harness.store.getInvocation(running.invocation.invocationId))?.delivery.remoteOperationHandle).toBe(
            "owner-operation-observe",
        );
        const reconciled = await harness.seam.reconcileInvocation(running.invocation.invocationId);

        expect(counters.invoke).toBe(1);
        expect(counters.observe).toBe(1);
        expect(reconciled.recordedStatus).toBe(InvocationStatus.COMPLETED);
        expect((await harness.store.getInvocation(running.invocation.invocationId))?.status).toBe(
            InvocationStatus.COMPLETED,
        );
    });

    it("enforces the declarative inputSchema BEFORE invoke: zero calls, durable FAILED record (blocker 2)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters),
        );

        // A descriptor whose inputSchema demands a field the engine-minted
        // request cannot carry. Schemas are registration identity (blocker
        // 6), so this registers under a NEW capability id; allowedInputRef
        // prefixes are untouched so plan acceptance is unaffected.
        const strictDescriptor = defineCapabilityDescriptor({
            capabilityId: "lifeos.query.strict",
            moduleOwner: "lifeos",
            purpose: "Query the life domain (strict input shape)",
            effectClass: EffectClass.READ,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            requiresOwnerVerification: false,
            ownsStorage: true,
            inputSchema: {
                kind: "declarative",
                fields: [
                    { path: "requestId", types: ["string"], minLength: 1 },
                    { path: "inputRefs", types: ["array"] },
                    { path: "desiredOutcome", types: ["string"], minLength: 5000 },
                ],
            },
        });
        harness.registry.register(strictDescriptor);
        harness.resolver.registerMany([
            ...makeDefaultCapabilityCatalog(),
            {
                capabilityId: "lifeos.query.strict",
                moduleOwner: "lifeos",
                effectClass: EffectClass.READ,
                requiresApproval: false,
                requiresOwnerVerification: false,
                allowedInputRefPrefixes: ["refs/lifeos/"],
                ownsStorage: true,
            },
        ]);

        const strictMission = await acceptMission(harness, [
            makeStep({
                stepId: "step-strict",
                capabilityRequirement: "lifeos.query.strict",
                inputRefs: ["refs/lifeos/journal"],
                effectClass: EffectClass.READ,
            }),
        ]);
        harness.seam.registerConnector(
            strictDescriptor.capabilityId,
            makeSeamConnector(strictDescriptor, counters),
        );

        await expect(
            harness.seam.dispatchThroughSeam(strictMission, "step-strict"),
        ).rejects.toThrow(ConnectorInputSchemaError);

        // Effect boundary held: zero invokes. A durable failure WAS recorded
        // (deterministic integration bug, no effect ever happened).
        expect(counters.invoke).toBe(0);
        const invocations = await harness.store.listInvocations(strictMission);
        expect(invocations).toHaveLength(1);
        expect(invocations[0].status).toBe(InvocationStatus.FAILED);
        expect(invocations[0].completedAt).toBe(BASE_TIME);
    });

    it("rejects a result violating resultSchema: never completed, uncertain state recorded (blocker 2)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        // status is a number: violates resultSchema (string).
                        status: 42,
                        requestId: request.requestId,
                        summary: "malformed",
                        evidence: [],
                    } as unknown as CapabilityResult;
                },
            }),
        );

        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(
            ConnectorResultSchemaError,
        );
        expect(counters.invoke).toBe(1); // the effect MAY have happened
        const stored = await harness.store.getInvocation(
            (await harness.store.listInvocations(missionId))[0].invocationId,
        );
        expect(stored?.status).toBe(InvocationStatus.BLOCKED);
        expect(stored?.completedAt).toBeUndefined();
    });

    it("stops dispatch when policy resolver and registry descriptor disagree (split-brain, blocker 3) — zero connector calls, no minting", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters),
        );

        // Corrupt ONLY the policy-side catalog: the registry still holds the
        // true descriptor; the resolver now claims a different owner.
        harness.resolver.registerMany(
            makeDefaultCapabilityCatalog().map((c) =>
                c.capabilityId === "runstead.code-review"
                    ? { ...c, moduleOwner: "an-impostor" }
                    : c,
            ),
        );

        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(
            PolicyContractMismatchError,
        );
        expect(counters.describe).toBe(0);
        expect(counters.invoke).toBe(0);
        expect(await harness.store.listInvocations(missionId)).toHaveLength(0);
    });

    it("rejects dispatch when the capability is unknown to the policy resolver (blocker 3)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters),
        );

        // Policy side forgets the capability entirely.
        harness.resolver.unregister("runstead.code-review");

        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(
            PolicyContractMismatchError,
        );
        expect(counters.invoke).toBe(0);
        expect(await harness.store.listInvocations(missionId)).toHaveLength(0);
    });

    it("does NOT consume the step's dispatch on transient unavailability; a later dispatch succeeds once (blocker 4)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        const currentHealthDescriptor = (): CapabilityDescriptor => {
            const registered = harness.registry.requireDescriptor("tecer.health-check");
            return { ...HEALTH_DESCRIPTOR, availability: registered.availability, availabilityDetail: registered.availabilityDetail };
        };
        harness.seam.registerConnector(HEALTH_DESCRIPTOR.capabilityId, {
            connectorContractVersion: 1,
            capabilityId: HEALTH_DESCRIPTOR.capabilityId,
            describe: () => {
                counters.describe++;
                return currentHealthDescriptor();
            },
            invoke: async (request) => {
                counters.invoke++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId: request.requestId,
                    summary: `done ${request.requestId}`,
                    evidence: [],
                    ownerVerification: { owner: "tecer", verified: true, reason: "healthy" },
                };
            },
        });

        // UNAVAILABLE (transient): pre-mint rejection, nothing recorded.
        await expect(harness.seam.dispatchThroughSeam(missionId, "step-broken")).rejects.toThrow(
            CapabilityUnavailableError,
        );
        expect(await harness.store.listInvocations(missionId)).toHaveLength(0);
        expect(counters.invoke).toBe(0);

        // Recovery via registry data (no descriptor identity touched).
        harness.registry.setAvailability(
            "tecer.health-check",
            CapabilityAvailability.AVAILABLE,
        );

        const outcome = await harness.seam.dispatchThroughSeam(missionId, "step-broken");
        expect(outcome.recordedStatus).toBe(InvocationStatus.COMPLETED);
        expect(counters.invoke).toBe(1);
        const invocations = await harness.store.listInvocations(missionId);
        expect(invocations).toHaveLength(1);
        expect(invocations[0].status).toBe(InvocationStatus.COMPLETED);
    });

    it("carries the availability state + detail on the pre-mint rejection", async () => {
        const missionId = await acceptTwoStepMission(harness);
        harness.seam.registerConnector(
            HEALTH_DESCRIPTOR.capabilityId,
            makeSeamConnector(HEALTH_DESCRIPTOR, { describe: 0, invoke: 0 }),
        );
        try {
            await harness.seam.dispatchThroughSeam(missionId, "step-broken");
            throw new Error("expected CapabilityUnavailableError");
        } catch (error) {
            expect(error).toBeInstanceOf(CapabilityUnavailableError);
            const unavailable = error as CapabilityUnavailableError;
            expect(unavailable.availability).toBe(CapabilityAvailability.UNAVAILABLE);
            expect(unavailable.detail).toBe("owner offline for scheduled maintenance");
        }
        void missionId;
    });

    it("records invoke() exceptions as UNCERTAIN (BLOCKED, never FAILED) — blocker 5", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async () => {
                    counters.invoke++;
                    throw new Error("network cable pulled mid-request");
                },
            }),
        );

        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(
            /uncertain \(blocked\) state/,
        );
        expect(counters.invoke).toBe(1);
        const stored = await harness.store.getInvocation(
            (await harness.store.listInvocations(missionId))[0].invocationId,
        );
        expect(stored?.status).toBe(InvocationStatus.BLOCKED);
        expect(stored?.completedAt).toBeUndefined();
    });

    it("propagates an attested owner verification verdict to the invocation (blocker 7)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "reviewed",
                        evidence: [],
                        ownerVerification: {
                            owner: "runstead",
                            verified: true,
                            reason: "review report checked against events",
                        },
                    };
                },
            }),
        );

        const outcome = await harness.seam.dispatchThroughSeam(missionId, "step-good");
        expect(outcome.recordedStatus).toBe(InvocationStatus.COMPLETED);
        const stored = await harness.store.getInvocation(outcome.invocation.invocationId);
        expect(stored?.ownerVerification).toBeDefined();
        expect(stored?.ownerVerification?.verified).toBe(true);
        // Attested by the authority, never self-attested by the seam.
        expect(stored?.ownerVerification?.reason).toContain("[attested:");
    });

    it("records verified:false as FAILED with the negative verdict — never success (blocker 7)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "reviewed",
                        evidence: [],
                        ownerVerification: {
                            owner: "runstead",
                            verified: false,
                            reason: "findings contradict the report",
                        },
                    };
                },
            }),
        );

        const outcome = await harness.seam.dispatchThroughSeam(missionId, "step-good");
        expect(outcome.recordedStatus).toBe(InvocationStatus.FAILED);
        const stored = await harness.store.getInvocation(outcome.invocation.invocationId);
        expect(stored?.status).toBe(InvocationStatus.FAILED);
        expect(stored?.ownerVerification?.verified).toBe(false);
        expect(stored?.completedAt).toBe(BASE_TIME);
    });

    it("blocks when mandatory owner verification is missing — never implicit success (blocker 7)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "reviewed",
                        evidence: [],
                    };
                },
            }),
        );

        const outcome = await harness.seam.dispatchThroughSeam(missionId, "step-good");
        expect(outcome.recordedStatus).toBe(InvocationStatus.BLOCKED);
        const stored = await harness.store.getInvocation(outcome.invocation.invocationId);
        expect(stored?.status).toBe(InvocationStatus.BLOCKED);
        expect(stored?.completedAt).toBeUndefined();
        expect(stored?.ownerVerification).toBeUndefined();
    });

    it("records BLOCKED (never COMPLETED) when the authority refuses a POSITIVE attestation on a verification-required capability (round 4, blocker 2)", async () => {
        const store = new SqliteMissionStore(":memory:");
        const resolver = new FakeCapabilityResolver();
        resolver.registerMany(makeDefaultCapabilityCatalog());
        const engine = new MissionEngine({
            store,
            policy: new PlanPolicyValidator(resolver),
            clock: new FakeClock(BASE_TIME),
            ids: new FakeIdGenerator("inv"),
            interpreter: (i) => i.originalIntent,
            // verificationAuthority omitted: default fail-closed authority
            // refuses every verdict (simulates provenance/authority mismatch).
        });
        try {
            await store.initialize();
            const registry = new CapabilityRegistry();
            registry.register(REVIEW_DESCRIPTOR);
            const seam = new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME));
            const bareHarness: Harness = {
                engine,
                store,
                registry,
                resolver,
                seam,
                clock: new FakeClock(BASE_TIME),
                authority: new FakeVerificationAuthority(),
                close: () => store.close(),
            };
            const missionId = await acceptMission(bareHarness, [
                makeStep({
                    stepId: "step-good",
                    capabilityRequirement: "runstead.code-review",
                    inputRefs: ["refs/runstead/pr/42"],
                }),
            ]);
            const counters = { describe: 0, invoke: 0 };
            seam.registerConnector(
                REVIEW_DESCRIPTOR.capabilityId,
                makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                    invoke: async (request) => {
                        counters.invoke++;
                        return {
                            status: CapabilityResultStatus.COMPLETED,
                            requestId: request.requestId,
                            summary: "reviewed",
                            evidence: [],
                            ownerVerification: {
                                owner: "runstead",
                                verified: true,
                                reason: "checked",
                            },
                        };
                    },
                }),
            );

            const outcome = await seam.dispatchThroughSeam(missionId, "step-good");
            // The connector's own COMPLETED status is honest, but for a
            // capability that REQUIRES owner verification a refused positive
            // attestation is missing provenance/authority: the invocation is
            // NEVER promoted to a terminal claim. Conservative pending form:
            // BLOCKED, no verdict, no completedAt — exactly like a refused
            // negative verdict.
            expect(outcome.recordedStatus).toBe(InvocationStatus.BLOCKED);
            const recorded = (await store.listInvocations(missionId)).find(
                (i) => i.invocationId === outcome.invocation.invocationId,
            );
            expect(recorded?.status).toBe(InvocationStatus.BLOCKED);
            expect(recorded?.completedAt).toBeUndefined();
            expect(recorded?.ownerVerification).toBeUndefined();
        } finally {
            await store.close();
        }
    });

    // ── Round 3: hostile / pending values at the untrusted boundary ──

    it("schema-gates the RAW result BEFORE any property access: null adapter return never TypeErrors, never completes (blocker 1)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async () => {
                    counters.invoke++;
                    return null as unknown as CapabilityResult;
                },
            }),
        );

        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(
            ConnectorResultSchemaError,
        );
        expect(counters.invoke).toBe(1); // the effect MAY have happened
        const stored = await harness.store.getInvocation(
            (await harness.store.listInvocations(missionId))[0].invocationId,
        );
        // No raw TypeError escaped; the invocation is durably uncertain.
        expect(stored?.status).toBe(InvocationStatus.BLOCKED);
        expect(stored?.completedAt).toBeUndefined();
    });

    it("schema-gates primitive adapter returns before any property access (blocker 1)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async () => {
                    counters.invoke++;
                    return 42 as unknown as CapabilityResult;
                },
            }),
        );

        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(
            ConnectorResultSchemaError,
        );
        const stored = await harness.store.getInvocation(
            (await harness.store.listInvocations(missionId))[0].invocationId,
        );
        expect(stored?.status).toBe(InvocationStatus.BLOCKED);
        expect(stored?.completedAt).toBeUndefined();
    });

    it("rejects a structurally-invalid object missing requestId BEFORE the echo check dereferences it (blocker 1)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async () => {
                    counters.invoke++;
                    return {
                        status: "completed",
                        summary: "no requestId",
                        evidence: [],
                    } as unknown as CapabilityResult;
                },
            }),
        );

        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(
            ConnectorResultSchemaError,
        );
        const stored = await harness.store.getInvocation(
            (await harness.store.listInvocations(missionId))[0].invocationId,
        );
        expect(stored?.status).toBe(InvocationStatus.BLOCKED);
        expect(stored?.completedAt).toBeUndefined();
    });

    it("treats verified:null as PENDING — never an artificial negative, never completed (blocker 2)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "owner has not examined the outcome yet",
                        evidence: [],
                        ownerVerification: {
                            owner: "runstead",
                            verified: null,
                            reason: "pending owner review",
                        },
                    };
                },
            }),
        );

        const outcome = await harness.seam.dispatchThroughSeam(missionId, "step-good");
        // Pending stays pending: BLOCKED, non-terminal, no verdict stored.
        expect(outcome.recordedStatus).toBe(InvocationStatus.BLOCKED);
        const stored = await harness.store.getInvocation(outcome.invocation.invocationId);
        expect(stored?.status).toBe(InvocationStatus.BLOCKED);
        expect(stored?.completedAt).toBeUndefined();
        expect(stored?.ownerVerification).toBeUndefined();
    });

    it("degrades verified:false to BLOCKED (no verdict persisted) when the authority refuses attestation (blocker 2)", async () => {
        const store = new SqliteMissionStore(":memory:");
        const resolver = new FakeCapabilityResolver();
        resolver.registerMany(makeDefaultCapabilityCatalog());
        const engine = new MissionEngine({
            store,
            policy: new PlanPolicyValidator(resolver),
            clock: new FakeClock(BASE_TIME),
            ids: new FakeIdGenerator("inv"),
            interpreter: (i) => i.originalIntent,
            // verificationAuthority omitted: default fail-closed authority
            // refuses every verdict (simulates wrong-owner provenance).
        });
        try {
            await store.initialize();
            const registry = new CapabilityRegistry();
            registry.register(REVIEW_DESCRIPTOR);
            const seam = new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME));
            const bareHarness: Harness = {
                engine,
                store,
                registry,
                resolver,
                seam,
                clock: new FakeClock(BASE_TIME),
                authority: new FakeVerificationAuthority(),
                close: () => store.close(),
            };
            const missionId = await acceptMission(bareHarness, [
                makeStep({
                    stepId: "step-good",
                    capabilityRequirement: "runstead.code-review",
                    inputRefs: ["refs/runstead/pr/42"],
                }),
            ]);
            const counters = { describe: 0, invoke: 0 };
            seam.registerConnector(
                REVIEW_DESCRIPTOR.capabilityId,
                makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                    invoke: async (request) => {
                        counters.invoke++;
                        return {
                            status: CapabilityResultStatus.COMPLETED,
                            requestId: request.requestId,
                            summary: "reviewed",
                            evidence: [],
                            ownerVerification: {
                                owner: "runstead",
                                verified: false,
                                reason: "findings contradict the report",
                            },
                        };
                    },
                }),
            );

            const outcome = await seam.dispatchThroughSeam(missionId, "step-good");
            // Attestation refused => conservative pending form: BLOCKED with
            // NO verdict persisted (not FAILED-with-unattested-verdict, not
            // success, not a stale DISPATCHED state).
            expect(outcome.recordedStatus).toBe(InvocationStatus.BLOCKED);
            const recorded = (await store.listInvocations(missionId)).find(
                (i) => i.invocationId === outcome.invocation.invocationId,
            );
            expect(recorded?.status).toBe(InvocationStatus.BLOCKED);
            expect(recorded?.completedAt).toBeUndefined();
            expect(recorded?.ownerVerification).toBeUndefined();
        } finally {
            await store.close();
        }
    });

    // ── Round 4: evidence-item gate + refused positive attestation ──

    it("schema-gates malformed EVIDENCE ITEMS on the raw result: [null] never TypeErrors, never completes (round 4, blocker 1)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "reviewed",
                        // Hostile adapter: non-object items inside evidence.
                        evidence: [null, 42] as unknown as CapabilityResult["evidence"],
                    };
                },
            }),
        );

        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(
            ConnectorResultSchemaError,
        );
        expect(counters.invoke).toBe(1); // the effect MAY have happened
        const stored = await harness.store.getInvocation(
            (await harness.store.listInvocations(missionId))[0].invocationId,
        );
        // No raw TypeError escaped; the invocation is durably uncertain,
        // never COMPLETED, never assigned a completion timestamp.
        expect(stored?.status).toBe(InvocationStatus.BLOCKED);
        expect(stored?.completedAt).toBeUndefined();
        expect(stored?.resultRefs).toHaveLength(0);
    });

    it("runtime evidence guard rejects malformed items even when the descriptor ships a weaker schema (round 4, blocker 1)", async () => {
        const counters = { describe: 0, invoke: 0 };

        // A descriptor whose resultSchema does NOT constrain evidence items
        // (weaker than the default). Schemas are registration identity, so
        // it registers under a NEW capability id; the catalog contract is
        // mirrored so the split-brain guard stays silent. This proves the
        // runtime guard is independent of the descriptor's own schema: a
        // weaker descriptor cannot reintroduce a post-handoff TypeError.
        const looseDescriptor = defineCapabilityDescriptor({
            capabilityId: "lifeos.query.loose-evidence",
            moduleOwner: "lifeos",
            purpose: "Query the life domain (unconstrained evidence items)",
            effectClass: EffectClass.READ,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            requiresOwnerVerification: false,
            ownsStorage: true,
            resultSchema: {
                kind: "declarative",
                fields: [
                    { path: "status", types: ["string"] },
                    { path: "requestId", types: ["string"], minLength: 1 },
                    { path: "summary", types: ["string"] },
                    { path: "evidence", types: ["array"] },
                ],
            },
        });
        harness.registry.register(looseDescriptor);
        harness.resolver.registerMany([
            ...makeDefaultCapabilityCatalog(),
            {
                capabilityId: "lifeos.query.loose-evidence",
                moduleOwner: "lifeos",
                effectClass: EffectClass.READ,
                requiresApproval: false,
                requiresOwnerVerification: false,
                allowedInputRefPrefixes: ["refs/lifeos/"],
                ownsStorage: true,
            },
        ]);
        const looseMission = await acceptMission(harness, [
            makeStep({
                stepId: "step-loose",
                capabilityRequirement: "lifeos.query.loose-evidence",
                inputRefs: ["refs/lifeos/journal"],
                effectClass: EffectClass.READ,
            }),
        ]);
        harness.seam.registerConnector(
            looseDescriptor.capabilityId,
            makeSeamConnector(looseDescriptor, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "queried",
                        // Passes the weak schema gate (evidence is "just an
                        // array") but violates the EvidenceReference
                        // contract the seam dereferences.
                        evidence: [{ owner: "lifeos" }] as unknown as CapabilityResult["evidence"],
                    };
                },
            }),
        );

        await expect(harness.seam.dispatchThroughSeam(looseMission, "step-loose")).rejects.toThrow(
            DispatchSeamError,
        );
        expect(counters.invoke).toBe(1); // the effect MAY have happened
        const stored = await harness.store.getInvocation(
            (await harness.store.listInvocations(looseMission))[0].invocationId,
        );
        // Guard caught it post-schema: durably uncertain, never COMPLETED,
        // never a raw TypeError from evidenceRefsOf().
        expect(stored?.status).toBe(InvocationStatus.BLOCKED);
        expect(stored?.completedAt).toBeUndefined();
    });

    it("keeps honest-status-without-verdict semantics for capabilities that do NOT require owner verification (round 4, blocker 2)", async () => {
        const store = new SqliteMissionStore(":memory:");
        const resolver = new FakeCapabilityResolver();
        resolver.registerMany(makeDefaultCapabilityCatalog());
        const engine = new MissionEngine({
            store,
            policy: new PlanPolicyValidator(resolver),
            clock: new FakeClock(BASE_TIME),
            ids: new FakeIdGenerator("inv"),
            interpreter: (i) => i.originalIntent,
            // verificationAuthority omitted: default fail-closed authority.
        });
        try {
            await store.initialize();
            const registry = new CapabilityRegistry();
            registry.register(QUERY_DESCRIPTOR);
            const seam = new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME));
            const bareHarness: Harness = {
                engine,
                store,
                registry,
                resolver,
                seam,
                clock: new FakeClock(BASE_TIME),
                authority: new FakeVerificationAuthority(),
                close: () => store.close(),
            };
            const missionId = await acceptMission(bareHarness, [
                makeStep({
                    stepId: "step-query",
                    capabilityRequirement: "lifeos.query",
                    inputRefs: ["refs/lifeos/journal"],
                    effectClass: EffectClass.READ,
                }),
            ]);
            const counters = { describe: 0, invoke: 0 };
            seam.registerConnector(
                QUERY_DESCRIPTOR.capabilityId,
                makeSeamConnector(QUERY_DESCRIPTOR, counters, {
                    invoke: async (request) => {
                        counters.invoke++;
                        return {
                            status: CapabilityResultStatus.COMPLETED,
                            requestId: request.requestId,
                            summary: "queried",
                            evidence: [
                                {
                                    owner: "lifeos",
                                    externalRef: "lifeos/evidence-1",
                                    label: "query result",
                                },
                            ],
                            ownerVerification: {
                                owner: "lifeos",
                                verified: true,
                                reason: "checked",
                            },
                        };
                    },
                }),
            );

            const outcome = await seam.dispatchThroughSeam(missionId, "step-query");
            // Supplementary verdict refused: the honest connector status is
            // kept, WITHOUT the unattested verdict (self-attestation never
            // happens). No BLOCKED promotion for non-verifying capabilities.
            expect(outcome.recordedStatus).toBe(InvocationStatus.COMPLETED);
            const recorded = (await store.listInvocations(missionId)).find(
                (i) => i.invocationId === outcome.invocation.invocationId,
            );
            expect(recorded?.status).toBe(InvocationStatus.COMPLETED);
            expect(recorded?.completedAt).toBeDefined();
            expect(recorded?.ownerVerification).toBeUndefined();
        } finally {
            await store.close();
        }
    });

    // ── Round 5: structural gate on ownerVerification itself ──

    // Hostile truthy-but-shapeless verdicts (round 5 cases 1-7). For a
    // capability that REQUIRES owner verification, every one of these must
    // be BLOCKED (no completedAt, no verdict persisted, no TypeError,
    // never COMPLETED): none of `verified === false`, `verified === null`,
    // `verified === true` nor `!result.ownerVerification` may decide the
    // mandatory-verification branches on a structurally invalid value.
    const MALFORMED_OUTCOMES: Array<[string, unknown]> = [
        ["empty object", {}],
        ["array", []],
        ["truthy string", "truthy"],
        [
            "verified typed as string",
            { verified: "true", owner: "runstead", reason: "x" },
        ],
        ["missing owner", { verified: true, reason: "x" }],
        ["empty owner", { verified: true, owner: "", reason: "x" }],
        ["reason typed as number", { verified: true, owner: "runstead", reason: 42 }],
    ];

    for (const [label, malformed] of MALFORMED_OUTCOMES) {
        it(`blocks a verification-required capability when ownerVerification is malformed: ${label} (round 5)`, async () => {
            const missionId = await acceptTwoStepMission(harness);
            const counters = { describe: 0, invoke: 0 };
            harness.seam.registerConnector(
                REVIEW_DESCRIPTOR.capabilityId,
                makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                    invoke: async (request) => {
                        counters.invoke++;
                        return {
                            status: CapabilityResultStatus.COMPLETED,
                            requestId: request.requestId,
                            summary: "reviewed",
                            evidence: [],
                            // Hostile adapter: truthy-but-shapeless verdict.
                            ownerVerification:
                                malformed as unknown as CapabilityResult["ownerVerification"],
                        };
                    },
                }),
            );

            await expect(
                harness.seam.dispatchThroughSeam(missionId, "step-good"),
            ).rejects.toThrow(DispatchSeamError);
            expect(counters.invoke).toBe(1); // the effect MAY have happened
            const stored = await harness.store.getInvocation(
                (await harness.store.listInvocations(missionId))[0].invocationId,
            );
            expect(stored?.status).toBe(InvocationStatus.BLOCKED);
            expect(stored?.completedAt).toBeUndefined();
            expect(stored?.ownerVerification).toBeUndefined();
        });
    }

    it("schema-gates malformed ownerVerification BEFORE the runtime guard consumes it (round 5)", async () => {
        const missionId = await acceptTwoStepMission(harness);
        const counters = { describe: 0, invoke: 0 };
        harness.seam.registerConnector(
            REVIEW_DESCRIPTOR.capabilityId,
            makeSeamConnector(REVIEW_DESCRIPTOR, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "reviewed",
                        evidence: [],
                        ownerVerification: {} as unknown as CapabilityResult["ownerVerification"],
                    };
                },
            }),
        );

        // The default resultSchema carries the ownerVerification spec, so
        // the raw-result gate rejects the malformed verdict before the
        // runtime guard would; the invocation is durably uncertain either way.
        await expect(harness.seam.dispatchThroughSeam(missionId, "step-good")).rejects.toThrow(
            ConnectorResultSchemaError,
        );
        const stored = await harness.store.getInvocation(
            (await harness.store.listInvocations(missionId))[0].invocationId,
        );
        expect(stored?.status).toBe(InvocationStatus.BLOCKED);
        expect(stored?.completedAt).toBeUndefined();
    });

    it("runtime ownerVerification guard rejects malformed verdicts even when the descriptor ships a weaker schema (round 5)", async () => {
        const counters = { describe: 0, invoke: 0 };

        // Weaker descriptor: resultSchema does NOT constrain ownerVerification
        // (and only partially constrains evidence). Schemas are registration
        // identity, so it registers under a NEW capability id with a mirrored
        // catalog contract. Proves the runtime guard is independent of the
        // descriptor's own schema: without it, `verified: "true"` would slip
        // past every truthiness branch and a COMPLETED-without-attested-
        // verdict could be persisted.
        const looseDescriptor = defineCapabilityDescriptor({
            capabilityId: "lifeos.query.loose-verification",
            moduleOwner: "lifeos",
            purpose: "Query the life domain (unconstrained owner verdict)",
            effectClass: EffectClass.READ,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            requiresOwnerVerification: true,
            ownsStorage: true,
            resultSchema: {
                kind: "declarative",
                fields: [
                    { path: "status", types: ["string"] },
                    { path: "requestId", types: ["string"], minLength: 1 },
                    { path: "summary", types: ["string"] },
                    { path: "evidence", types: ["array"] },
                ],
            },
        });
        harness.registry.register(looseDescriptor);
        harness.resolver.registerMany([
            ...makeDefaultCapabilityCatalog(),
            {
                capabilityId: "lifeos.query.loose-verification",
                moduleOwner: "lifeos",
                effectClass: EffectClass.READ,
                requiresApproval: false,
                requiresOwnerVerification: true,
                allowedInputRefPrefixes: ["refs/lifeos/"],
                ownsStorage: true,
            },
        ]);
        const looseMission = await acceptMission(harness, [
            makeStep({
                stepId: "step-loose-verdict",
                capabilityRequirement: "lifeos.query.loose-verification",
                inputRefs: ["refs/lifeos/journal"],
                effectClass: EffectClass.READ,
            }),
        ]);
        harness.seam.registerConnector(
            looseDescriptor.capabilityId,
            makeSeamConnector(looseDescriptor, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "queried",
                        evidence: [],
                        // Truthy, typed-lookalike verdict: would slip past
                        // every `verified === …` branch without the guard.
                        ownerVerification: {
                            verified: "true",
                            owner: "lifeos",
                            reason: "x",
                        } as unknown as CapabilityResult["ownerVerification"],
                    };
                },
            }),
        );

        await expect(
            harness.seam.dispatchThroughSeam(looseMission, "step-loose-verdict"),
        ).rejects.toThrow(DispatchSeamError);
        expect(counters.invoke).toBe(1); // the effect MAY have happened
        const stored = await harness.store.getInvocation(
            (await harness.store.listInvocations(looseMission))[0].invocationId,
        );
        expect(stored?.status).toBe(InvocationStatus.BLOCKED);
        expect(stored?.completedAt).toBeUndefined();
        expect(stored?.ownerVerification).toBeUndefined();
    });

    it("discards a malformed supplementary verdict for a NON-verifying capability and keeps the honest status (round 5)", async () => {
        const counters = { describe: 0, invoke: 0 };

        // Loose NON-verifying descriptor: its resultSchema does not constrain
        // the supplementary verdict, so the malformed value survives the raw
        // gate and reaches the runtime guard — proving the no-crash /
        // no-forged-persistence semantics are NOT carried by the schema gate
        // alone. (With the default schema the raw gate rejects the value
        // first, as the schema-gates test proves; either way the invocation
        // is never completed WITH the malformed verdict attached.)
        const looseDescriptor = defineCapabilityDescriptor({
            capabilityId: "lifeos.query.loose-verdict",
            moduleOwner: "lifeos",
            purpose: "Query the life domain (unconstrained supplementary verdict)",
            effectClass: EffectClass.READ,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            requiresOwnerVerification: false,
            ownsStorage: true,
            resultSchema: {
                kind: "declarative",
                fields: [
                    { path: "status", types: ["string"] },
                    { path: "requestId", types: ["string"], minLength: 1 },
                    { path: "summary", types: ["string"] },
                    { path: "evidence", types: ["array"] },
                ],
            },
        });
        harness.registry.register(looseDescriptor);
        harness.resolver.registerMany([
            ...makeDefaultCapabilityCatalog(),
            {
                capabilityId: "lifeos.query.loose-verdict",
                moduleOwner: "lifeos",
                effectClass: EffectClass.READ,
                requiresApproval: false,
                requiresOwnerVerification: false,
                allowedInputRefPrefixes: ["refs/lifeos/"],
                ownsStorage: true,
            },
        ]);
        const missionId = await acceptMission(harness, [
            makeStep({
                stepId: "step-loose-verdict",
                capabilityRequirement: "lifeos.query.loose-verdict",
                inputRefs: ["refs/lifeos/journal"],
                effectClass: EffectClass.READ,
            }),
        ]);
        harness.seam.registerConnector(
            looseDescriptor.capabilityId,
            makeSeamConnector(looseDescriptor, counters, {
                invoke: async (request) => {
                    counters.invoke++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "queried",
                        evidence: [
                            {
                                owner: "lifeos",
                                externalRef: "lifeos/evidence-1",
                                label: "query result",
                            },
                        ],
                        // Truthy garbage verdict on a capability that does
                        // NOT require owner verification: no crash, no
                        // forged persistence — the verdict is discarded.
                        ownerVerification: {
                            verified: "true",
                        } as unknown as CapabilityResult["ownerVerification"],
                    };
                },
            }),
        );

        const outcome = await harness.seam.dispatchThroughSeam(missionId, "step-loose-verdict");
        expect(outcome.recordedStatus).toBe(InvocationStatus.COMPLETED);
        const stored = await harness.store.getInvocation(outcome.invocation.invocationId);
        expect(stored?.status).toBe(InvocationStatus.COMPLETED);
        expect(stored?.completedAt).toBe(BASE_TIME);
        // The malformed verdict was never treated as authority.
        expect(stored?.ownerVerification).toBeUndefined();
    });

    it("keeps a structurally VALID verdict on a NON-verifying capability discarded by the authority but honest in status (round 5, control)", async () => {
        const store = new SqliteMissionStore(":memory:");
        const resolver = new FakeCapabilityResolver();
        resolver.registerMany(makeDefaultCapabilityCatalog());
        const engine = new MissionEngine({
            store,
            policy: new PlanPolicyValidator(resolver),
            clock: new FakeClock(BASE_TIME),
            ids: new FakeIdGenerator("inv"),
            interpreter: (i) => i.originalIntent,
            // verificationAuthority omitted: default fail-closed authority.
        });
        try {
            await store.initialize();
            const registry = new CapabilityRegistry();
            registry.register(QUERY_DESCRIPTOR);
            const seam = new ConnectorDispatchSeam(engine, registry, new FakeClock(BASE_TIME));
            const bareHarness: Harness = {
                engine,
                store,
                registry,
                resolver,
                seam,
                clock: new FakeClock(BASE_TIME),
                authority: new FakeVerificationAuthority(),
                close: () => store.close(),
            };
            const missionId = await acceptMission(bareHarness, [
                makeStep({
                    stepId: "step-query",
                    capabilityRequirement: "lifeos.query",
                    inputRefs: ["refs/lifeos/journal"],
                    effectClass: EffectClass.READ,
                }),
            ]);
            const counters = { describe: 0, invoke: 0 };
            seam.registerConnector(
                QUERY_DESCRIPTOR.capabilityId,
                makeSeamConnector(QUERY_DESCRIPTOR, counters, {
                    invoke: async (request) => {
                        counters.invoke++;
                        return {
                            status: CapabilityResultStatus.COMPLETED,
                            requestId: request.requestId,
                            summary: "queried",
                            evidence: [
                                {
                                    owner: "lifeos",
                                    externalRef: "lifeos/evidence-1",
                                    label: "query result",
                                },
                            ],
                            ownerVerification: {
                                owner: "lifeos",
                                verified: true,
                                reason: "checked",
                            },
                        };
                    },
                }),
            );

            const outcome = await seam.dispatchThroughSeam(missionId, "step-query");
            expect(outcome.recordedStatus).toBe(InvocationStatus.COMPLETED);
            const recorded = (await store.listInvocations(missionId)).find(
                (i) => i.invocationId === outcome.invocation.invocationId,
            );
            expect(recorded?.status).toBe(InvocationStatus.COMPLETED);
            expect(recorded?.completedAt).toBeDefined();
            expect(recorded?.ownerVerification).toBeUndefined();
        } finally {
            await store.close();
        }
    });
});
