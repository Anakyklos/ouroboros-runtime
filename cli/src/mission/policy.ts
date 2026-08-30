/**
 * 🛡️ Deterministic Plan Policy (Issue #62)
 *
 * The boundary that proves **planner output is not authority**.
 *
 * The LLM/planner proposes a `PlanCandidate`; this validator decides,
 * with pure deterministic code (no model, no network, no randomness),
 * whether the proposal may proceed. Rejection happens BEFORE any dispatch.
 *
 * Rejection rules (stable codes, see PolicyRejectionCode):
 *  - capability outside the Mission's allowed scope
 *  - capability unknown to the capability resolver/catalog
 *  - dependency cycle among steps
 *  - effect class not authorized for the Mission
 *  - mandatory approval missing (fail-closed)
 *  - input references incompatible with the capability contract
 *  - attempt to mutate Mission acceptance/constraints without authority
 *  - attempt to access storage/database outside authorized prefixes
 *  - explicit attempt to bypass the module owner
 */

import {
    PolicyDecision,
    PolicyRejectionCode,
    Mission,
    PlanCandidate,
    PlanStep,
    CapabilityContract,
} from "./contracts.js";
import type { CapabilityResolver } from "./ports.js";

/** Collects deterministic rejection codes and reasons. */
class DecisionBuilder {
    private readonly codes: PolicyRejectionCode[] = [];
    private readonly reasons: string[] = [];

    reject(code: PolicyRejectionCode, reason: string): void {
        if (!this.codes.includes(code)) {
            this.codes.push(code);
            this.reasons.push(reason);
        }
    }

    build(): PolicyDecision {
        return {
            valid: this.codes.length === 0,
            codes: [...this.codes],
            reasons: [...this.reasons],
        };
    }
}

/** Detect dependency cycles and unknown step references in a plan. */
function findCycleOrUnknownSteps(steps: PlanStep[]): {
    cycle: boolean;
    unknownReferences: string[];
} {
    const stepIds = new Set(steps.map((s) => s.stepId));
    const unknownReferences: string[] = [];
    for (const step of steps) {
        for (const dep of step.dependencyIds) {
            if (!stepIds.has(dep)) {
                unknownReferences.push(`${step.stepId} -> ${dep}`);
            }
        }
    }

    // DFS-based cycle detection over dependency edges.
    const visiting = new Set<string>();
    const visited = new Set<string>();
    let cycle = false;

    const visit = (stepId: string): void => {
        if (cycle || visited.has(stepId)) return;
        if (visiting.has(stepId)) {
            cycle = true;
            return;
        }
        visiting.add(stepId);
        const step = steps.find((s) => s.stepId === stepId);
        if (step) {
            for (const dep of step.dependencyIds) {
                visit(dep);
            }
        }
        visiting.delete(stepId);
        visited.add(stepId);
    };

    for (const step of steps) {
        visit(step.stepId);
        if (cycle) break;
    }

    return { cycle, unknownReferences };
}

/** Deterministic validation of a PlanCandidate against a Mission. */
export class PlanPolicyValidator {
    private readonly resolver: CapabilityResolver;

    constructor(resolver: CapabilityResolver) {
        this.resolver = resolver;
    }

    /**
     * Validate a PlanCandidate before any dispatch.
     * Pure function of (mission, candidate, capability catalog) — the same
     * input always yields the same decision.
     */
    async validate(mission: Mission, candidate: PlanCandidate): Promise<PolicyDecision> {
        const decision = new DecisionBuilder();

        if (candidate.missionId !== mission.missionId) {
            decision.reject(
                PolicyRejectionCode.MISSION_ID_MISMATCH,
                `PlanCandidate targets mission "${candidate.missionId}" but the Mission is "${mission.missionId}".`,
            );
            return decision.build();
        }

        // 1. Empty plan is never acceptable.
        if (candidate.steps.length === 0) {
            decision.reject(PolicyRejectionCode.EMPTY_PLAN, "Plan contains no steps.");
            return decision.build();
        }

        // 2. No silent acceptance/constraint mutation.
        if (candidate.proposedAcceptanceCriteria !== undefined) {
            if (!sameStringList(candidate.proposedAcceptanceCriteria, mission.acceptanceCriteria)) {
                decision.reject(
                    PolicyRejectionCode.ACCEPTANCE_MUTATION,
                    "Planner attempted to change Mission acceptance criteria without authority.",
                );
            }
        }
        if (candidate.proposedConstraints !== undefined) {
            if (!sameStringList(candidate.proposedConstraints, mission.constraints)) {
                decision.reject(
                    PolicyRejectionCode.CONSTRAINT_MUTATION,
                    "Planner attempted to change Mission constraints without authority.",
                );
            }
        }

        // 3. Dependency graph integrity: cycles and unknown references.
        const { cycle, unknownReferences } = findCycleOrUnknownSteps(candidate.steps);
        if (cycle) {
            decision.reject(
                PolicyRejectionCode.DEPENDENCY_CYCLE,
                "Plan step dependency graph contains a cycle.",
            );
        }
        for (const ref of unknownReferences) {
            decision.reject(
                PolicyRejectionCode.UNKNOWN_STEP_REFERENCE,
                `Step references an unknown step: ${ref}.`,
            );
        }

        // 4. Per-step checks against Mission scope and capability catalog.
        for (const step of candidate.steps) {
            await this.validateStep(mission, step, decision);
        }

        return decision.build();
    }

    private async validateStep(
        mission: Mission,
        step: PlanStep,
        decision: DecisionBuilder,
    ): Promise<void> {
        // Capability must be inside the Mission's authorized scope.
        const inScope = mission.allowedCapabilityScope.capabilityIds.includes(
            step.capabilityRequirement,
        );
        if (!inScope) {
            decision.reject(
                PolicyRejectionCode.CAPABILITY_NOT_AUTHORIZED,
                `Capability "${step.capabilityRequirement}" is outside the Mission's authorized scope.`,
            );
            return; // Unknown to catalog is irrelevant once out of scope.
        }

        // Capability must be known to the catalog/resolver.
        // Discovery does not equal authorization, but unknown != authorized.
        const contract = await this.resolver.resolve(step.capabilityRequirement);
        if (!contract) {
            decision.reject(
                PolicyRejectionCode.CAPABILITY_UNKNOWN,
                `Capability "${step.capabilityRequirement}" is not registered in the capability catalog.`,
            );
            return;
        }

        // Effect class must be authorized at Mission scope.
        if (!mission.allowedCapabilityScope.allowedEffectClasses.includes(step.effectClass)) {
            decision.reject(
                PolicyRejectionCode.EFFECT_NOT_AUTHORIZED,
                `Effect class "${step.effectClass}" of step "${step.stepId}" is not authorized for this Mission.`,
            );
        }

        // Effect class declared by the planner must match the catalog.
        if (contract.effectClass !== step.effectClass) {
            decision.reject(
                PolicyRejectionCode.EFFECT_NOT_AUTHORIZED,
                `Step "${step.stepId}" declares effect class "${step.effectClass}" but capability "${step.capabilityRequirement}" is cataloged as "${contract.effectClass}".`,
            );
        }

        // Mandatory approval: fail-closed when required but not attached.
        // An attached approval that is not yet granted is acceptable for
        // proposal — the Mission Engine will transition to WAITING_FOR_APPROVAL.
        const requiresApproval = contract.requiresApproval;
        if (requiresApproval && step.approvalRequirement === undefined) {
            decision.reject(
                PolicyRejectionCode.APPROVAL_MISSING,
                `Step "${step.stepId}" requires approval but none is attached (fail-closed).`,
            );
        }

        // Input references must be compatible with the capability contract.
        this.validateInputRefs(mission, step, contract, decision);

        // Module-owner bypass: capability must own the module it targets.
        this.validateModuleOwnership(mission, step, contract, decision);
    }

    private validateInputRefs(
        mission: Mission,
        step: PlanStep,
        contract: CapabilityContract,
        decision: DecisionBuilder,
    ): void {
        for (const inputRef of step.inputRefs) {
            // References must fall inside Mission-authorized prefixes.
            const inMissionScope = mission.allowedCapabilityScope.allowedRefPrefixes.some((p) =>
                inputRef.startsWith(p),
            );
            // And inside the capability contract's declared input prefixes.
            const inContractScope = contract.allowedInputRefPrefixes.some((p) =>
                inputRef.startsWith(p),
            );

            // Storage access outside authorized prefixes is denied outright.
            if (inputRef.includes("storage://") || inputRef.includes("db://")) {
                if (!inContractScope) {
                    decision.reject(
                        PolicyRejectionCode.STORAGE_ACCESS_DENIED,
                        `Step "${step.stepId}" attempts storage access "${inputRef}" outside the capability's declared contract.`,
                    );
                }
                if (!inMissionScope) {
                    decision.reject(
                        PolicyRejectionCode.STORAGE_ACCESS_DENIED,
                        `Step "${step.stepId}" attempts storage access "${inputRef}" outside the Mission's authorized reference prefixes.`,
                    );
                }
                continue;
            }

            if (!inMissionScope) {
                decision.reject(
                    PolicyRejectionCode.INPUT_INCOMPATIBLE,
                    `Step "${step.stepId}" input reference "${inputRef}" is outside the Mission's authorized reference prefixes.`,
                );
            }
            if (!inContractScope && contract.allowedInputRefPrefixes.length > 0) {
                decision.reject(
                    PolicyRejectionCode.INPUT_INCOMPATIBLE,
                    `Step "${step.stepId}" input reference "${inputRef}" is incompatible with capability "${contract.capabilityId}" contract.`,
                );
            }
        }
    }

    private validateModuleOwnership(
        mission: Mission,
        step: PlanStep,
        contract: CapabilityContract,
        decision: DecisionBuilder,
    ): void {
        // A capability that owns storage may only touch its own module's
        // namespaces. Reject explicit attempts to bypass the module owner:
        // e.g. referencing another module's private area, or requesting
        // direct "bypass:<owner>" semantics.
        for (const inputRef of step.inputRefs) {
            const bypassMarker = inputRef.match(/^bypass:([a-zA-Z0-9_-]+)/);
            if (bypassMarker) {
                decision.reject(
                    PolicyRejectionCode.MODULE_OWNER_BYPASS,
                    `Step "${step.stepId}" explicitly attempts to bypass module owner "${bypassMarker[1]}".`,
                );
            }
            const privateOwnerMatch = inputRef.match(/^private\/([a-zA-Z0-9_-]+)\//);
            if (privateOwnerMatch && privateOwnerMatch[1] !== contract.moduleOwner) {
                decision.reject(
                    PolicyRejectionCode.MODULE_OWNER_BYPASS,
                    `Step "${step.stepId}" attempts direct access to private area of module "${privateOwnerMatch[1]}" instead of invoking module owner "${contract.moduleOwner}".`,
                );
            }
        }
    }
}

/** Case-sensitive set equality on string arrays (order-insensitive). */
function sameStringList(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((value, index) => value === sortedB[index]);
}
