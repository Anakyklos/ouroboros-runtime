/**
 * 🎯 Dispatch Seam Tests (PR #73 review round 2, blockers 1-5 + 7)
 *
 * Proves the ONE deterministic dispatch seam:
 *  - honest status mapping (no invented terminality);
 *  - declarative schema enforcement at the effectful boundary;
 *  - split-brain authority guard (policy contract == registry descriptor);
 *  - transient availability consumes NO dispatch (retake after recovery);
 *  - invoke() exceptions leave UNCERTAIN (blocked) state, never "failed";
 *  - owner verification verdicts propagate; verified:false never succeeds.
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

    it("keeps the honest status but records NO verdict when the fail-closed authority refuses to attest", async () => {
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
            // The connector's own COMPLETED status is honest and kept, but
            // the verdict is NOT stored: self-attestation never happens.
            expect(outcome.recordedStatus).toBe(InvocationStatus.COMPLETED);
            const recorded = (await store.listInvocations(missionId)).find(
                (i) => i.invocationId === outcome.invocation.invocationId,
            );
            expect(recorded?.ownerVerification).toBeUndefined();
        } finally {
            await store.close();
        }
    });
});
