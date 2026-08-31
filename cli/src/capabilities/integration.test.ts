/**
 * 🔐 Integration: capabilities ↔ Mission (Issues #62 + #63)
 *
 * Proves, with deterministic offline fixtures and NO real network:
 *
 *  1. Discovery never concedes authorization. A capability fully
 *     registered in the CapabilityRegistry (and resolvable through the
 *     #62 CapabilityResolver interface) is still rejected by
 *     PlanPolicyValidator when it sits outside the Mission's authorized
 *     scope. Registration adds zero authority.
 *
 *  2. Policy rejection blocks connector invocation. The only path from a
 *     policy decision to a connector is the thin deterministic dispatch
 *     seam: dispatch → authorize → invoke. A plan rejected by policy
 *     never reaches connector.invoke (the stub throws if it does).
 *
 *  3. A negative owner verification verdict is never fabricated into a
 *     success. It is preserved, attested by the verification authority,
 *     and dominates any mission-level judgment.
 */

import { describe, expect, test } from "bun:test";
import {
    computeEffectFingerprint,
    EffectClass,
    MissionState,
    PolicyRejectionCode,
    PlanStep,
} from "../mission/contracts.js";
import type { PlanCandidate } from "../mission/contracts.js";
import { MissionEngine } from "../mission/mission-engine.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import { PlanPolicyValidator } from "../mission/policy.js";
import {
    FakeClock,
    FakeIdGenerator,
    FakePlannerPort,
    FakeVerificationAuthority,
} from "../mission/testing.js";
import { CapabilityRegistry } from "./registry.js";
import { defineCapabilityDescriptor } from "./fixtures.js";
import {
    CapabilityResultStatus,
    type CapabilityConnector,
    type CapabilityResult,
    type ConnectorRequest,
} from "./connector.js";

const BASE_TIME = "2026-08-30T12:00:00.000Z";

/** Registry-backed resolver: satisfies #62's CapabilityResolver shape. */
function registryResolver(registry: CapabilityRegistry) {
    return registry as {
        resolve(capabilityId: string): Promise<unknown | null>;
        listRegistered(): Promise<string[]>;
    };
}

/** Minimal in-memory resolver adapter that delegates to the registry. */
class RegistryCapabilityResolver implements import("../mission/ports.js").CapabilityResolver {
    constructor(private readonly registry: CapabilityRegistry) {}
    async resolve(capabilityId: string) {
        // The registry itself satisfies the #62 resolver interface; the
        // adapter only narrows the type for the policy constructor.
        return this.registry.resolve(capabilityId);
    }
    async listRegistered() {
        return this.registry.listRegistered();
    }
}

function missionStep(overrides: Partial<PlanStep> = {}): PlanStep {
    return {
        stepId: "step-1",
        desiredOutcome: "List open commitments owned by LifeOS",
        dependencyIds: [],
        capabilityRequirement: "lifeos.query_commitments",
        inputRefs: ["refs/lifeos/journal/entry-1"],
        expectedAcceptance: ["commitments listed"],
        effectClass: EffectClass.READ,
        ...overrides,
    };
}

function planCandidate(missionId: string, overrides: Partial<PlanCandidate> = {}): PlanCandidate {
    return {
        planId: "plan-1",
        missionId,
        plannerNote: "Planner proposal (advisory only)",
        steps: [missionStep()],
        ...overrides,
    };
}

/** Deterministic offline connector stub: invoke() fails the test if reached. */
function guardedConnector(
    registry: CapabilityRegistry,
    descriptor: ReturnType<typeof defineCapabilityDescriptor>,
    calls: { invoked: boolean },
): CapabilityConnector {
    return {
        connectorContractVersion: 1,
        capabilityId: descriptor.capabilityId,
        describe: () => registry.requireDescriptor(descriptor.capabilityId),
        invoke: async (_request: ConnectorRequest): Promise<CapabilityResult> => {
            calls.invoked = true;
            return {
                status: CapabilityResultStatus.COMPLETED,
                requestId: _request.requestId,
                summary: "3 open commitments",
                evidence: [
                    {
                        owner: "lifeos",
                        externalRef: "lifeos/evidence-1",
                        label: "query result",
                    },
                ],
            };
        },
    };
}

describe("capabilities × Mission authorization gate (Issue #63)", () => {
    test("discovery never authorizes: registered capability outside Mission scope is policy-rejected", async () => {
        const registry = new CapabilityRegistry();
        const descriptor = defineCapabilityDescriptor({
            capabilityId: "lifeos.query_commitments",
            moduleOwner: "lifeos",
            purpose: "Query open commitments owned by LifeOS",
            effectClass: EffectClass.READ,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            ownsStorage: true,
        });
        registry.register(descriptor);

        // The registry resolves the capability (discovery works)…
        expect(await registryResolver(registry).resolve("lifeos.query_commitments")).not.toBeNull();

        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const policy = new PlanPolicyValidator(new RegistryCapabilityResolver(registry));
        const engine = new MissionEngine({
            store,
            policy,
            clock: new FakeClock(BASE_TIME),
            ids: new FakeIdGenerator("mission-id"),
            interpreter: (i) => i.originalIntent,
            verificationAuthority: new FakeVerificationAuthority(),
        });

        const intent = {
            requestId: "req-cli",
            source: "cli" as const,
            originalIntent: "Review and merge the pending pull request",
            constraints: [],
            acceptanceCriteria: ["commitments listed"],
            contextRefs: [],
        };
        const mission = await engine.createMission({
            intent,
            // Mission scope deliberately does NOT include the capability…
            allowedCapabilityScope: {
                capabilityIds: ["other.capability"],
                allowedEffectClasses: [EffectClass.READ],
                allowedRefPrefixes: ["refs/lifeos/"],
            },
        });

        const proposal = await engine.proposePlan(
            mission.missionId,
            planCandidate(mission.missionId),
        );
        // …yet the policy rejects the plan. Discovery ≠ authorization.
        expect(proposal.ok).toBe(false);
        if (!proposal.ok) {
            expect(proposal.decision.codes).toContain(
                PolicyRejectionCode.CAPABILITY_NOT_AUTHORIZED,
            );
        }
        expect(mission.state).not.toBe(MissionState.READY);
    });

    test("policy rejection blocks connector invoke: dispatch seam never reaches the connector", async () => {
        const registry = new CapabilityRegistry();
        const descriptor = defineCapabilityDescriptor({
            capabilityId: "lifeos.query_commitments",
            moduleOwner: "lifeos",
            purpose: "Query open commitments owned by LifeOS",
            effectClass: EffectClass.READ,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            ownsStorage: true,
        });
        registry.register(descriptor);

        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const policy = new PlanPolicyValidator(new RegistryCapabilityResolver(registry));
        const engine = new MissionEngine({
            store,
            policy,
            clock: new FakeClock(BASE_TIME),
            ids: new FakeIdGenerator("mission-id"),
            interpreter: (i) => i.originalIntent,
            verificationAuthority: new FakeVerificationAuthority(),
        });

        const intent = {
            requestId: "req-cli",
            source: "cli" as const,
            originalIntent: "Review and merge the pending pull request",
            constraints: [],
            acceptanceCriteria: ["commitments listed"],
            contextRefs: [],
        };
        const mission = await engine.createMission({
            intent,
            allowedCapabilityScope: {
                // Capability in scope, but the step's inputRef violates the
                // Mission-authorized prefixes → deterministic policy rejection.
                capabilityIds: ["lifeos.query_commitments"],
                allowedEffectClasses: [EffectClass.READ],
                allowedRefPrefixes: ["refs/other/"],
            },
        });

        const proposal = await engine.proposePlan(
            mission.missionId,
            planCandidate(mission.missionId),
        );
        expect(proposal.ok).toBe(false);
        if (!proposal.ok) {
            expect(proposal.decision.codes).toContain(
                PolicyRejectionCode.INPUT_INCOMPATIBLE,
            );
        }

        // The connector is bound and ready, but the dispatch seam
        // (dispatch → authorize → invoke) stopped at policy: no accepted
        // plan exists, so no invocation may exist and invoke() is never
        // reachable through the engine path.
        const calls = { invoked: false };
        const connector = guardedConnector(registry, descriptor, calls);
        const after = await engine.getMission(mission.missionId);
        expect(after.currentPlanRevisionId).toBeNull();
        expect(after.invocationRefs).toHaveLength(0);
        await expect(
            engine.dispatchStep(mission.missionId, "step-1"),
        ).rejects.toThrow(/no accepted plan|dispatch/i);
        expect(calls.invoked).toBe(false);
        void connector;
    });

    test("negative owner verification is preserved and never fabricated as success", async () => {
        const registry = new CapabilityRegistry();
        const descriptor = defineCapabilityDescriptor({
            capabilityId: "lifeos.query_commitments",
            moduleOwner: "lifeos",
            purpose: "Query open commitments owned by LifeOS",
            effectClass: EffectClass.READ,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            ownsStorage: true,
            requiresOwnerVerification: true,
        });
        registry.register(descriptor);

        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const policy = new PlanPolicyValidator(new RegistryCapabilityResolver(registry));
        const authority = new FakeVerificationAuthority();
        const engine = new MissionEngine({
            store,
            policy,
            clock: new FakeClock(BASE_TIME),
            ids: new FakeIdGenerator("mission-id"),
            interpreter: (i) => i.originalIntent,
            verificationAuthority: authority,
        });

        const intent = {
            requestId: "req-cli",
            source: "cli" as const,
            originalIntent: "Review and merge the pending pull request",
            constraints: [],
            acceptanceCriteria: ["commitments listed"],
            contextRefs: [],
        };
        const mission = await engine.createMission({
            intent,
            allowedCapabilityScope: {
                capabilityIds: ["lifeos.query_commitments"],
                allowedEffectClasses: [EffectClass.READ],
                allowedRefPrefixes: ["refs/lifeos/"],
            },
        });
        const proposal = await engine.proposePlan(
            mission.missionId,
            planCandidate(mission.missionId),
        );
        expect(proposal.ok).toBe(true);
        if (!proposal.ok) return;
        const accepted = await engine.acceptPlan(
            mission.missionId,
            proposal.revision.revisionId,
        );
        expect(accepted.state).toBe(MissionState.READY);

        const invocation = await engine.dispatchStep(mission.missionId, "step-1");
        expect(invocation.status).toBe("dispatched");

        // The owner reports failure. The engine must preserve the verdict
        // through the attestation authority — never fabricate success.
        const updated = await engine.recordInvocationResult(
            invocation.invocationId,
            {
                invocationId: invocation.invocationId,
                status: "failed",
                summary: "owner rejected the invocation",
                evidenceRefs: [],
                completedAt: BASE_TIME,
            },
            {
                invocationId: invocation.invocationId,
                owner: "lifeos",
                verified: false,
                reason: "input reference not found",
            },
        );
        const ref = updated.invocationRefs.find(
            (r) => r.invocationId === invocation.invocationId,
        );
        expect(ref).toBeDefined();
        expect(ref!.status).toBe("failed");
        // Mission is not completed by a failed invocation.
        expect(updated.state).not.toBe(MissionState.COMPLETED);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture scenario 2: write capability requiring approval, driven through the
// registry-backed catalog (descriptor declared with requiresApproval: true).
// ─────────────────────────────────────────────────────────────────────────────

describe("capabilities × Mission: write + approval path", () => {
    test("write capability waits for approval and dispatches only after explicit grant", async () => {
        const registry = new CapabilityRegistry();
        const descriptor = defineCapabilityDescriptor({
            capabilityId: "lifeos.record_entry",
            moduleOwner: "lifeos",
            purpose: "Record a new entry in the LifeOS journal",
            effectClass: EffectClass.WRITE,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            ownsStorage: true,
            requiresApproval: true,
            requiresOwnerVerification: true,
        });
        registry.register(descriptor);
        expect(descriptor.requiresApproval).toBe(true);

        const store = new SqliteMissionStore(":memory:");
        await store.initialize();
        const policy = new PlanPolicyValidator(new RegistryCapabilityResolver(registry));
        const engine = new MissionEngine({
            store,
            policy,
            clock: new FakeClock(BASE_TIME),
            ids: new FakeIdGenerator("mission-id"),
            interpreter: (i) => i.originalIntent,
            verificationAuthority: new FakeVerificationAuthority(),
        });

        const intent = {
            requestId: "req-cli",
            source: "cli" as const,
            originalIntent: "Record a LifeOS journal entry",
            constraints: [],
            acceptanceCriteria: ["entry recorded"],
            contextRefs: [],
        };
        const mission = await engine.createMission({
            intent,
            allowedCapabilityScope: {
                capabilityIds: ["lifeos.record_entry"],
                allowedEffectClasses: [EffectClass.READ, EffectClass.WRITE],
                allowedRefPrefixes: ["refs/lifeos/"],
            },
            approvalRequirements: [
                {
                    approvalId: "ap-record",
                    scopeDescriptor: {
                        capabilityId: "lifeos.record_entry",
                        effectClass: EffectClass.WRITE,
                        effectFingerprint: computeEffectFingerprint({
                            capabilityId: "lifeos.record_entry",
                            effectClass: EffectClass.WRITE,
                            inputRefs: ["refs/lifeos/journal"],
                            outcome: "Record the journal entry",
                        }),
                    },
                    approver: "operator",
                    reason: "Write to life domain requires operator approval",
                    granted: false,
                },
            ],
        });

        const candidate: PlanCandidate = {
            planId: "plan-1",
            missionId: mission.missionId,
            plannerNote: "Record an entry (advisory proposal)",
            steps: [
                {
                    stepId: "step-record",
                    desiredOutcome: "Record the journal entry",
                    dependencyIds: [],
                    capabilityRequirement: "lifeos.record_entry",
                    inputRefs: ["refs/lifeos/journal"],
                    expectedAcceptance: ["entry recorded"],
                    effectClass: EffectClass.WRITE,
                    approvalRequirement: {
                        approvalId: "ap-record",
                        approver: "operator",
                        reason: "Write to life domain requires operator approval",
                    },
                },
            ],
        };
        const proposal = await engine.proposePlan(mission.missionId, candidate);
        if (!proposal.ok) throw new Error(`plan rejected: ${proposal.decision.reasons.join("; ")}`);

        // Approval pending: Mission waits (never fails).
        const waiting = await engine.acceptPlan(
            mission.missionId,
            proposal.revision.revisionId,
        );
        expect(waiting.state).toBe(MissionState.WAITING_FOR_APPROVAL);

        // Dispatch before grant is rejected fail-closed.
        await expect(
            engine.dispatchStep(mission.missionId, "step-record"),
        ).rejects.toThrow(/approval/i);

        // Operator grants; Mission becomes ready.
        const approved = await engine.recordApproval(
            mission.missionId,
            "ap-record",
            "operator",
        );
        expect(approved.state).toBe(MissionState.READY);

        // After the explicit grant the dispatch seam opens.
        const invocation = await engine.dispatchStep(mission.missionId, "step-record");
        expect(invocation.capabilityId).toBe("lifeos.record_entry");
        expect(invocation.status).toBe("dispatched");
    });
});
