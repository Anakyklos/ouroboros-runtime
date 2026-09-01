/**
 * 🧪 Seam Harness for Context Tests (Issue #64)
 *
 * Wires the REAL #62/#63 stack — MissionEngine (SQLite :memory:),
 * PlanPolicyValidator, CapabilityRegistry, ConnectorDispatchSeam,
 * FakeVerificationAuthority — so context reads are proven END-TO-END
 * through the one dispatch seam. Deterministic: fake clock/ids, no
 * network, no env.
 */

import {
    EffectClass,
    type Mission,
    type PlanCandidate,
    type PlanStep,
} from "../mission/contracts.js";
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
import { CapabilityRegistry } from "../capabilities/registry.js";
import { ConnectorDispatchSeam } from "../capabilities/dispatch-seam.js";
import type { CapabilityDescriptor } from "../capabilities/contracts.js";
import { makeContextContract } from "./fixtures.js";

export interface SeamHarness {
    engine: MissionEngine;
    registry: CapabilityRegistry;
    seam: ConnectorDispatchSeam;
    resolver: FakeCapabilityResolver;
    /** Create a mission + accepted READ plan; returns (mission, stepId). */
    acceptContextPlan: (
        descriptor: CapabilityDescriptor,
        subject: string,
        overrides?: { stepId?: string },
    ) => Promise<{ mission: Mission; stepId: string }>;
    close: () => Promise<void>;
}

/**
 * Create the harness. `descriptors` are registered in BOTH the registry
 * and the fake resolver (with a matching contract) so the seam's
 * split-brain guard sees ONE consistent authority source.
 */
export async function createSeamHarness(options: {
    descriptors: CapabilityDescriptor[];
}): Promise<SeamHarness> {
    const store = new SqliteMissionStore(":memory:");
    const resolver = new FakeCapabilityResolver();
    resolver.registerMany(makeDefaultCapabilityCatalog());
    for (const descriptor of options.descriptors) {
        resolver.register(makeContextContract(descriptor));
    }
    const clock = new FakeClock("2026-08-30T12:00:00.000Z");
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
    for (const descriptor of options.descriptors) registry.register(descriptor);
    const seam = new ConnectorDispatchSeam(engine, registry, clock);
    await store.initialize();

    return {
        engine,
        registry,
        seam,
        resolver,
        acceptContextPlan: async (descriptor, subject, overrides = {}) => {
            const mission = await engine.createMission({
                intent: {
                    requestId: `req-${descriptor.capabilityId}-${subject}`,
                    source: "cli" as const,
                    originalIntent: "Compile authorized context for the weekly review",
                    constraints: ["No destructive effects"],
                    acceptanceCriteria: ["Review drafted from authorized sources"],
                    contextRefs: [],
                },
                allowedCapabilityScope: {
                    capabilityIds: [descriptor.capabilityId],
                    allowedEffectClasses: [EffectClass.READ],
                    allowedRefPrefixes: ["refs/lifeos/", "refs/tecer/", "refs/ouroboros/"],
                },
            });
            const step: PlanStep = {
                stepId: overrides.stepId ?? "step-context-read",
                desiredOutcome: "read authorized context rows",
                dependencyIds: [],
                expectedAcceptance: ["context read"],
                effectClass: EffectClass.READ,
                capabilityRequirement: descriptor.capabilityId,
                inputRefs: [subject],
            };
            const candidate: PlanCandidate = {
                planId: "plan-1",
                missionId: mission.missionId,
                plannerNote: "context read plan",
                steps: [step],
            };
            const proposal = await engine.proposePlan(mission.missionId, candidate);
            if (!proposal.ok) {
                throw new Error(`plan rejected: ${JSON.stringify(proposal.decision)}`);
            }
            await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);
            const fresh = await engine.getMission(mission.missionId);
            return { mission: fresh, stepId: step.stepId };
        },
        close: async () => store.close(),
    };
}
