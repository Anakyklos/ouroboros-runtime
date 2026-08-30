/**
 * 🛡️ Deterministic Plan Policy Tests (Issue #62)
 *
 * Proves the core rule: **planner output is advisory, deterministic policy
 * authorizes.** Every rejection must happen before any dispatch and with a
 * stable, testable code.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
    EffectClass,
    MISSION_CONTRACT_VERSION,
    Mission,
    MissionIntent,
    MissionState,
    PlanCandidate,
    PlanStep,
    PolicyRejectionCode,
} from "./contracts.js";
import { PlanPolicyValidator } from "./policy.js";
import {
    FakeCapabilityResolver,
    makeDefaultCapabilityCatalog,
} from "./testing.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

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

function makeMission(intent: MissionIntent, overrides: Partial<Mission> = {}): Mission {
    const now = "2026-08-30T12:00:00.000Z";
    return {
        missionId: "mission-1",
        schemaVersion: MISSION_CONTRACT_VERSION,
        source: intent.source,
        originalIntent: intent.originalIntent,
        interpretedObjective: intent.originalIntent,
        constraints: [...intent.constraints],
        acceptanceCriteria: [...intent.acceptanceCriteria],
        budgetPolicy: {},
        allowedCapabilityScope: {
            capabilityIds: [
                "runstead.code-review",
                "runstead.implement",
                "lifeos.query",
                "lifeos.write",
                "tecer.health-check",
                "runstead.deploy",
                "storage.read-local",
            ],
            allowedEffectClasses: [
                EffectClass.EXECUTION,
                EffectClass.READ,
                EffectClass.WRITE,
                EffectClass.NETWORK,
                EffectClass.STORAGE_ACCESS,
            ],
            allowedRefPrefixes: ["refs/runstead/", "refs/lifeos/", "refs/tecer/", "refs/ouroboros/"],
        },
        approvalRequirements: [],
        contextRefs: [],
        state: MissionState.CREATED,
        currentPlanRevisionId: null,
        invocationRefs: [],
        evidenceRefs: [],
        unresolvedQuestions: [],
        createdAt: now,
        updatedAt: now,
        recoveryMetadata: { recovered: false, recoveryCount: 0 },
        ...overrides,
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

function makeCandidate(overrides: Partial<PlanCandidate> = {}): PlanCandidate {
    return {
        planId: "plan-1",
        missionId: "mission-1",
        plannerNote: "Proposed by fake planner",
        steps: [makeStep()],
        ...overrides,
    };
}

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

describe("PlanPolicyValidator (deterministic policy)", () => {
    let resolver: FakeCapabilityResolver;
    let policy: PlanPolicyValidator;

    beforeEach(() => {
        resolver = new FakeCapabilityResolver();
        resolver.registerMany(makeDefaultCapabilityCatalog());
        policy = new PlanPolicyValidator(resolver);
    });

    it("accepts a valid plan whose capability is authorized and known", async () => {
        const decision = await policy.validate(makeMission(makeIntent()), makeCandidate());
        expect(decision.valid).toBe(true);
        expect(decision.codes).toEqual([]);
    });

    it("rejects a capability outside the Mission's authorized scope before dispatch", async () => {
        const mission = makeMission(makeIntent(), {
            allowedCapabilityScope: {
                capabilityIds: ["runstead.code-review"],
                allowedEffectClasses: [EffectClass.EXECUTION],
                allowedRefPrefixes: ["refs/runstead/"],
            },
        });
        const candidate = makeCandidate({
            steps: [
                makeStep({ capabilityRequirement: "lifeos.query", inputRefs: ["refs/lifeos/x"] }),
            ],
        });
        const decision = await policy.validate(mission, candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.CAPABILITY_NOT_AUTHORIZED);
    });

    it("rejects a capability unknown to the catalog (discovery != authorization)", async () => {
        // In scope (authorized by Mission) but unknown to the catalog.
        const mission = makeMission(makeIntent(), {
            allowedCapabilityScope: {
                capabilityIds: ["katherine.mind-read"],
                allowedEffectClasses: [EffectClass.READ],
                allowedRefPrefixes: ["refs/katherine/"],
            },
        });
        const candidate = makeCandidate({
            steps: [
                makeStep({
                    capabilityRequirement: "katherine.mind-read",
                    inputRefs: ["refs/katherine/x"],
                }),
            ],
        });
        const decision = await policy.validate(mission, candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.CAPABILITY_UNKNOWN);
    });

    it("rejects a dependency cycle", async () => {
        const candidate = makeCandidate({
            steps: [
                makeStep({ stepId: "a", dependencyIds: ["b"] }),
                makeStep({ stepId: "b", dependencyIds: ["c"] }),
                makeStep({ stepId: "c", dependencyIds: ["a"] }),
            ],
        });
        const decision = await policy.validate(makeMission(makeIntent()), candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.DEPENDENCY_CYCLE);
    });

    it("rejects unknown step references", async () => {
        const candidate = makeCandidate({
            steps: [
                makeStep({ stepId: "a", dependencyIds: ["ghost-step"] }),
                makeStep({ stepId: "b" }),
            ],
        });
        const decision = await policy.validate(makeMission(makeIntent()), candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.UNKNOWN_STEP_REFERENCE);
    });

    it("rejects an effect class not authorized for the Mission", async () => {
        const mission = makeMission(makeIntent(), {
            allowedCapabilityScope: {
                capabilityIds: ["runstead.deploy"],
                allowedEffectClasses: [EffectClass.NETWORK],
                allowedRefPrefixes: ["refs/runstead/"],
            },
        });
        const candidate = makeCandidate({
            steps: [
                makeStep({
                    capabilityRequirement: "runstead.deploy",
                    effectClass: EffectClass.EXECUTION, // catalog says NETWORK
                }),
            ],
        });
        const decision = await policy.validate(mission, candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.EFFECT_NOT_AUTHORIZED);
    });

    it("rejects an effect class that mismatches the catalog contract", async () => {
        const candidate = makeCandidate({
            steps: [
                makeStep({
                    capabilityRequirement: "lifeos.query",
                    effectClass: EffectClass.EXECUTION, // catalog says READ
                }),
            ],
        });
        const decision = await policy.validate(makeMission(makeIntent()), candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.EFFECT_NOT_AUTHORIZED);
    });

    it("fails closed when an effect requires approval and none is attached", async () => {
        const candidate = makeCandidate({
            steps: [
                makeStep({
                    capabilityRequirement: "lifeos.write",
                    effectClass: EffectClass.WRITE,
                    approvalRequirement: undefined, // capability requires approval
                }),
            ],
        });
        const decision = await policy.validate(makeMission(makeIntent()), candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.APPROVAL_MISSING);
    });

    it("accepts a proposed approval (requirement only, no grant) — Mission will wait for approval", async () => {
        const candidate = makeCandidate({
            steps: [
                makeStep({
                    capabilityRequirement: "lifeos.write",
                    effectClass: EffectClass.WRITE,
                    inputRefs: ["refs/lifeos/journal"],
                    // Planner can only propose the requirement; grant state
                    // is forbidden and will be rejected.
                    approvalRequirement: {
                        approvalId: "ap-1",
                        approver: "operator",
                        reason: "Write to life domain",
                    },
                }),
            ],
        });
        const decision = await policy.validate(makeMission(makeIntent()), candidate);
        // The policy accepts the proposal; the Mission engine will
        // transition to WAITING_FOR_APPROVAL at plan-acceptance time.
        expect(decision.valid).toBe(true);
    });

    it("rejects a planner-fabricated approval grant — the planner cannot concede approval", async () => {
        // The planner sends an approval requirement with granted:true.
        // The policy must reject this deterministically (APPROVAL_GRANT_FORBIDDEN).
        // TypeScript cannot prevent plain-object construction, so the policy
        // performs a runtime check.
        const candidate = makeCandidate({
            steps: [
                makeStep({
                    capabilityRequirement: "lifeos.write",
                    effectClass: EffectClass.WRITE,
                    inputRefs: ["refs/lifeos/journal"],
                    approvalRequirement: {
                        approvalId: "ap-1",
                        approver: "operator",
                        reason: "Write to life domain",
                        granted: true,
                        grantedBy: "operator",
                        grantedAt: "2026-08-30T12:00:00.000Z",
                    } as any,
                }),
            ],
        });
        const decision = await policy.validate(makeMission(makeIntent()), candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.APPROVAL_GRANT_FORBIDDEN);
    });

    it("rejects input references incompatible with the capability contract", async () => {
        const candidate = makeCandidate({
            steps: [
                makeStep({
                    capabilityRequirement: "runstead.code-review",
                    inputRefs: ["refs/tecer/private-health-record"],
                }),
            ],
        });
        const decision = await policy.validate(makeMission(makeIntent()), candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.INPUT_INCOMPATIBLE);
    });

    it("rejects a planner attempt to mutate acceptance criteria without authority", async () => {
        const candidate = makeCandidate({
            proposedAcceptanceCriteria: ["PR merged", "Different acceptance injected"],
        });
        const decision = await policy.validate(makeMission(makeIntent()), candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.ACCEPTANCE_MUTATION);
    });

    it("rejects a planner attempt to mutate constraints without authority", async () => {
        const candidate = makeCandidate({
            proposedConstraints: ["Planner may now touch anything"],
        });
        const decision = await policy.validate(makeMission(makeIntent()), candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.CONSTRAINT_MUTATION);
    });

    it("rejects storage access outside the capability contract", async () => {
        const candidate = makeCandidate({
            steps: [
                makeStep({
                    capabilityRequirement: "storage.read-local",
                    effectClass: EffectClass.STORAGE_ACCESS,
                    inputRefs: ["storage://lifeos/private-db"],
                }),
            ],
        });
        const decision = await policy.validate(makeMission(makeIntent()), candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.STORAGE_ACCESS_DENIED);
    });

    it("rejects an explicit attempt to bypass a module owner", async () => {
        const candidate = makeCandidate({
            steps: [
                makeStep({
                    capabilityRequirement: "runstead.code-review",
                    inputRefs: ["bypass:lifeos"],
                }),
            ],
        });
        const decision = await policy.validate(makeMission(makeIntent()), candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.MODULE_OWNER_BYPASS);
    });

    it("rejects direct private-area access to another module", async () => {
        const candidate = makeCandidate({
            steps: [
                makeStep({
                    capabilityRequirement: "runstead.code-review",
                    inputRefs: ["private/tecer/internal"],
                }),
            ],
        });
        const decision = await policy.validate(makeMission(makeIntent()), candidate);
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.MODULE_OWNER_BYPASS);
    });

    it("rejects an empty plan", async () => {
        const decision = await policy.validate(makeMission(makeIntent()), makeCandidate({ steps: [] }));
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.EMPTY_PLAN);
    });

    it("rejects a candidate targeting a different Mission", async () => {
        const decision = await policy.validate(
            makeMission(makeIntent()),
            makeCandidate({ missionId: "mission-other" }),
        );
        expect(decision.valid).toBe(false);
        expect(decision.codes).toContain(PolicyRejectionCode.MISSION_ID_MISMATCH);
    });

    it("is deterministic: same input always yields the same decision", async () => {
        const mission = makeMission(makeIntent());
        const candidate = makeCandidate({
            steps: [
                makeStep({ stepId: "a", dependencyIds: ["b"] }),
                makeStep({ stepId: "b", dependencyIds: ["a"] }),
            ],
        });
        const first = await policy.validate(mission, candidate);
        const second = await policy.validate(mission, candidate);
        expect(first).toEqual(second);
        expect(first.valid).toBe(false);
        expect(first.codes).toContain(PolicyRejectionCode.DEPENDENCY_CYCLE);
    });
});
