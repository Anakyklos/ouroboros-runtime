/**
 * ⚙️ Mission Engine (Issue #62)
 *
 * The executable heart of the Mission contract:
 *
 *   1. `MissionIntent` (from any authorized interface) enters ONE creation
 *      pipeline — there is no per-interface state machine.
 *   2. Planner output (`PlanCandidate`) is advisory: it is only accepted
 *      after deterministic policy validation.
 *   3. Mission state and invocation state are distinct entities.
 *   4. Mission-level verification never overrides negative owner
 *      verification.
 *
 * The engine is provider-free: no LLM, no network, no keys. The planner
 * and capability resolver are injected ports (fakes in tests).
 */

import {
    AllowedCapabilityScope,
    ApprovalRequirement,
    BudgetPolicy,
    CapabilityInvocationRef,
    CriterionVerification,
    EvidenceRef,
    InvocationResult,
    InvocationStatus,
    MISSION_CONTRACT_VERSION,
    Mission,
    MissionIntent,
    MissionState,
    MissionVerificationResult,
    OwnerVerification,
    PlanCandidate,
    PlanRevision,
    PolicyDecision,
    StepApprovalRequirement,
    WAITING_STATES,
    TERMINAL_STATES,
} from "./contracts.js";
import {
    CapabilityResolver,
    ClockService,
    IdGenerator,
    MissionStore,
    MissionVerifier,
} from "./ports.js";
import { PlanPolicyValidator } from "./policy.js";

/** Default clock (real time). */
class SystemClock implements ClockService {
    now(): Date {
        return new Date();
    }
    isoNow(): string {
        return this.now().toISOString();
    }
}

/** Default id generator (UUID). */
class UuidGenerator implements IdGenerator {
    generate(): string {
        // Deterministic alternative: crypto.randomUUID (bun/node global).
        return crypto.randomUUID();
    }
}

/** Interpreted objective derivation — injectable, provider-free by default. */
export type IntentInterpreter = (intent: MissionIntent) => Promise<string> | string;

export interface MissionEngineOptions {
    store: MissionStore;
    policy: PlanPolicyValidator;
    clock?: ClockService;
    ids?: IdGenerator;
    interpreter?: IntentInterpreter;
    verifier?: MissionVerifier;
}

export interface CreateMissionInput {
    intent: MissionIntent;
    allowedCapabilityScope: AllowedCapabilityScope;
    budgetPolicy?: BudgetPolicy;
    approvalRequirements?: ApprovalRequirement[];
}

export type PlanProposalResult =
    | { ok: true; revision: PlanRevision; decision: PolicyDecision }
    | { ok: false; decision: PolicyDecision };

/**
 * Rejection result carries the deterministic decision so the caller can
 * react (e.g. ask the planner to replan) without touching Mission state.
 */
export class PlanRejectedError extends Error {
    readonly decision: PolicyDecision;
    constructor(decision: PolicyDecision) {
        const first = decision.reasons[0] ?? "Plan rejected by deterministic policy";
        super(`Plan rejected by deterministic policy: ${first}`);
        this.name = "PlanRejectedError";
        this.decision = decision;
    }
}

export class MissionNotFoundError extends Error {
    constructor(missionId: string) {
        super(`Mission not found: ${missionId}`);
        this.name = "MissionNotFoundError";
    }
}

export class InvalidStateTransitionError extends Error {
    constructor(missionId: string, from: MissionState, to: MissionState, reason: string) {
        super(
            `Invalid state transition for mission ${missionId}: ${from} -> ${to} (${reason})`,
        );
        this.name = "InvalidStateTransitionError";
    }
}

/**
 * Deterministic dispatch rejection. The Mission/step is not authorized to
 * dispatch right now (state, approval, availability, policy). No invocation
 * is created when this is thrown.
 */
export class DispatchRejectedError extends Error {
    readonly reason: string;
    constructor(reason: string) {
        super(`Dispatch rejected: ${reason}`);
        this.name = "DispatchRejectedError";
        this.reason = reason;
    }
}

/**
 * An invocation already exists for the same logical step. Thrown to prevent
 * replay after restart and blind redispatch of effects whose outcome is
 * completed or uncertain. Never a second invocation row.
 */
export class InvocationConflictError extends Error {
    readonly invocationId: string;
    readonly status: InvocationStatus;
    constructor(missionId: string, stepId: string, invocationId: string, status: InvocationStatus) {
        super(
            `Step "${stepId}" of mission ${missionId} already has invocation ${invocationId} (${status}); blind redispatch is forbidden`,
        );
        this.name = "InvocationConflictError";
        this.invocationId = invocationId;
        this.status = status;
    }
}

/**
 * Deterministic Mission-level verifier (fail-closed).
 *
 * Satisfaction rules (all mandatory):
 *  - every invocation must be terminal and successful;
 *  - negative module-owner verification blocks completion (ownerBlocked),
 *    and the planner's opinion can never override it;
 *  - for every invocation whose capability REQUIRES owner verification
 *    (per the capability catalog), a positive owner verification must be
 *    present — a missing mandatory lower-layer verification is never
 *    implicit success;
 *  - every acceptance criterion must have an explicit typed
 *    `CriterionVerification` record with `satisfied: true` recorded through
 *    the engine's authorized path (`recordCriterionVerification`).
 *
 * Text labels are NEVER completion authority: an `EvidenceRef.label` that
 * happens to contain the acceptance text proves nothing.
 */
class DefaultMissionVerifier implements MissionVerifier {
    private readonly resolver: CapabilityResolver;

    constructor(resolver: CapabilityResolver) {
        this.resolver = resolver;
    }

    async verify(mission: Mission): Promise<{
        satisfied: boolean;
        ownerBlocked: boolean;
        reasons: string[];
    }> {
        const reasons: string[] = [];
        const invocations = mission.invocationRefs;

        if (invocations.length === 0) {
            reasons.push("Mission has no recorded invocations");
            return { satisfied: false, ownerBlocked: false, reasons };
        }

        const terminal = new Set<InvocationStatus>([
            InvocationStatus.COMPLETED,
            InvocationStatus.FAILED,
            InvocationStatus.CANCELLED,
            InvocationStatus.BLOCKED,
        ]);

        const pendingInvocations = invocations.filter(
            (inv) => !terminal.has(inv.status),
        );
        if (pendingInvocations.length > 0) {
            reasons.push(
                `Mission has ${pendingInvocations.length} invocation(s) still in non-terminal state`,
            );
            return { satisfied: false, ownerBlocked: false, reasons };
        }

        const failedInvocations = invocations.filter(
            (inv) =>
                inv.status === InvocationStatus.FAILED ||
                inv.status === InvocationStatus.CANCELLED ||
                inv.status === InvocationStatus.BLOCKED,
        );
        if (failedInvocations.length > 0) {
            reasons.push(
                `${failedInvocations.length} invocation(s) did not complete successfully`,
            );
            return { satisfied: false, ownerBlocked: false, reasons };
        }

        // Negative owner verification blocks completion (binding rule).
        const negativeOwners = invocations.filter(
            (inv) => inv.ownerVerification !== undefined && !inv.ownerVerification.verified,
        );
        if (negativeOwners.length > 0) {
            reasons.push(
                `Module owner verification is negative for ${negativeOwners.length} invocation(s); mission-level verification cannot override it`,
            );
            return { satisfied: false, ownerBlocked: true, reasons };
        }

        // Mandatory owner verification: fail closed when the capability's
        // catalog contract requires it and the owner has not positively
        // verified the invocation.
        for (const inv of invocations) {
            const contract = await this.resolver.resolve(inv.capabilityId);
            if (!contract) {
                reasons.push(
                    `Invocation ${inv.invocationId} references unknown capability "${inv.capabilityId}"; cannot be trusted`,
                );
                return { satisfied: false, ownerBlocked: false, reasons };
            }
            if (
                contract.requiresOwnerVerification &&
                (inv.ownerVerification === undefined || !inv.ownerVerification.verified)
            ) {
                reasons.push(
                    `Invocation ${inv.invocationId} requires module-owner verification by "${contract.moduleOwner}" which is missing or negative; missing lower-layer verification is not implicit success`,
                );
                return { satisfied: false, ownerBlocked: false, reasons };
            }
        }

        // Typed criterion verification: every acceptance criterion must have
        // an explicit, deterministic, satisfied CriterionVerification record.
        // Text labels are NOT acceptance evidence.
        const satisfiedCriteria = new Set(
            mission.criterionVerifications
                .filter((cv) => cv.satisfied)
                .map((cv) => cv.criterionId),
        );
        const missingCriteria = mission.acceptanceCriteria.filter(
            (criterion) => !satisfiedCriteria.has(criterion),
        );
        if (missingCriteria.length > 0) {
            reasons.push(
                `Acceptance criteria lack typed verification: ${missingCriteria.join(", ")} (text labels are not completion authority)`,
            );
            return { satisfied: false, ownerBlocked: false, reasons };
        }

        reasons.push(
            "All invocations completed, mandatory owner verifications positive, all acceptance criteria verified by typed records",
        );
        return { satisfied: true, ownerBlocked: false, reasons };
    }
}

export class MissionEngine {
    private readonly store: MissionStore;
    private readonly policy: PlanPolicyValidator;
    private readonly clock: ClockService;
    private readonly ids: IdGenerator;
    private readonly interpreter: IntentInterpreter;
    private readonly verifier: MissionVerifier;

    constructor(options: MissionEngineOptions) {
        this.store = options.store;
        this.policy = options.policy;
        this.clock = options.clock ?? new SystemClock();
        this.ids = options.ids ?? new UuidGenerator();
        this.interpreter = options.interpreter ?? defaultInterpreter;
        this.verifier = options.verifier ?? new DefaultMissionVerifier(this.policy.resolver);
    }

    /**
     * Create a durable Mission from a MissionIntent.
     * All authorized interfaces (Katherine, Mission Control, CLI, API,
     * operator) funnel through this single pipeline.
     */
    async createMission(input: CreateMissionInput): Promise<Mission> {
        const { intent, allowedCapabilityScope, budgetPolicy, approvalRequirements } = input;
        const now = this.clock.isoNow();
        const missionId = this.ids.generate();
        const interpretedObjective = await this.interpreter(intent);

        const mission: Mission = {
            missionId,
            schemaVersion: MISSION_CONTRACT_VERSION,
            source: intent.source,
            originalIntent: intent.originalIntent,
            interpretedObjective,
            constraints: [...intent.constraints],
            acceptanceCriteria: [...intent.acceptanceCriteria],
            budgetPolicy: budgetPolicy ?? {},
            allowedCapabilityScope: {
                capabilityIds: [...allowedCapabilityScope.capabilityIds],
                allowedEffectClasses: [...allowedCapabilityScope.allowedEffectClasses],
                allowedRefPrefixes: [...allowedCapabilityScope.allowedRefPrefixes],
            },
            // Explicit approvals/permissions represented by the intent flow
            // into the Mission approval state (data, not implicit authority);
            // a caller-supplied policy wins over the intent's representation.
            approvalRequirements: approvalRequirements ?? intent.approvals ?? [],
            contextRefs: intent.contextRefs ?? [],
            state: MissionState.CREATED,
            currentPlanRevisionId: null,
            invocationRefs: [],
            evidenceRefs: [],
            criterionVerifications: [],
            unresolvedQuestions: [],
            createdAt: now,
            updatedAt: now,
            recoveryMetadata: {
                recovered: false,
                recoveryCount: 0,
            },
        };

        await this.store.createMission(mission);
        return mission;
    }

    /**
     * Validate a planner proposal deterministically and, when valid,
     * persist it as a proposed plan revision. Invalid planner output does
     * NOT change durable Mission state (fail-closed, no side effects).
     */
    async proposePlan(missionId: string, candidate: PlanCandidate): Promise<PlanProposalResult> {
        const mission = await this.requireMission(missionId);

        // No planning from terminal states — the Mission is done.
        if (TERMINAL_STATES.has(mission.state)) {
            throw new InvalidStateTransitionError(
                missionId,
                mission.state,
                MissionState.PLANNING,
                `terminal missions cannot be re-planned`,
            );
        }

        const decision = await this.policy.validate(mission, candidate);

        if (!decision.valid) {
            return { ok: false, decision };
        }

        const revisions = await this.store.getPlanRevisions(missionId);
        const revisionNumber = revisions.length + 1;
        const revision: PlanRevision = {
            revisionId: this.ids.generate(),
            revisionNumber,
            planId: candidate.planId,
            missionId,
            steps: candidate.steps.map((step) => ({ ...step })),
            status: "proposed",
            reason: candidate.plannerNote || "Proposed by planner",
            createdAt: this.clock.isoNow(),
        };
        await this.store.savePlanRevision(revision);

        // Invalid output never mutates state; valid proposal moves to planning.
        await this.store.updateMission(missionId, {
            state: MissionState.PLANNING,
            updatedAt: this.clock.isoNow(),
        });

        return { ok: true, revision, decision };
    }

    /**
     * Accept a proposed revision as the Mission's current plan.
     * The previous accepted revision is marked superseded (never deleted:
     * completed effects/invocation refs are preserved).
     *
     * Step-level approval requirements become UN-GRANTED Mission requirements
     * (the planner proposes the requirement; grant comes from the explicit
     * `recordApproval()` path only). Any grant fields smuggled by the planner
     * are stripped.
     */
    async acceptPlan(missionId: string, revisionId: string): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        const revision = await this.store.getPlanRevision(revisionId);
        if (!revision) {
            throw new Error(`Plan revision not found: ${revisionId}`);
        }
        if (revision.missionId !== missionId) {
            throw new Error(
                `Plan revision ${revisionId} does not belong to mission ${missionId}`,
            );
        }
        if (revision.status !== "proposed") {
            throw new Error(`Plan revision ${revisionId} is not in 'proposed' status`);
        }

        await this.store.withTransaction(async () => {
            // Mark previous accepted revision superseded (auditable, kept).
            if (mission.currentPlanRevisionId) {
                await this.store.updatePlanRevisionStatus(
                    mission.currentPlanRevisionId,
                    "superseded",
                    `Superseded by revision ${revisionId}`,
                );
            }
            await this.store.updatePlanRevisionStatus(revisionId, "accepted");

            // Step approval requirements become UN-GRANTED Mission requirements.
            // The planner proposes requirement, the grant comes from the
            // explicit `recordApproval()` path. Any grant fields the planner
            // smuggled are stripped (authoritative grant state is on the Mission).
            const mergedApprovals = [...mission.approvalRequirements];
            for (const step of revision.steps) {
                const req = step.approvalRequirement;
                if (!req) continue;
                const existing = mergedApprovals.find((r) => r.approvalId === req.approvalId);
                if (existing) {
                    // Planner proposed requirement metadata can update the
                    // requirement description, but the authoritative grant state
                    // (granted/grantedBy/grantedAt) is never touched by the planner.
                    existing.reason = req.reason;
                    existing.approver = req.approver;
                } else {
                    // New requirement, always starts un-granted.
                    mergedApprovals.push({
                        approvalId: req.approvalId,
                        approver: req.approver,
                        reason: req.reason,
                        granted: false,
                    });
                }
            }

            const needsApproval = mergedApprovals.some((r) => !r.granted);
            const nextState = needsApproval
                ? MissionState.WAITING_FOR_APPROVAL
                : MissionState.READY;

            await this.store.updateMission(missionId, {
                currentPlanRevisionId: revisionId,
                state: nextState,
                approvalRequirements: mergedApprovals,
                updatedAt: this.clock.isoNow(),
            });
        });

        return this.requireMission(missionId);
    }

    /** Reject a proposed revision (auditable rejection, no state regression). */
    async rejectPlan(missionId: string, revisionId: string, reason: string): Promise<Mission> {
        await this.requireMission(missionId);
        await this.store.updatePlanRevisionStatus(revisionId, "rejected", reason);
        return this.requireMission(missionId);
    }

    /** Record an explicit human/operator approval for a Mission requirement. */
    async recordApproval(
        missionId: string,
        approvalId: string,
        grantedBy: string,
    ): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        const requirement = mission.approvalRequirements.find(
            (req) => req.approvalId === approvalId,
        );
        if (!requirement) {
            throw new Error(
                `Approval requirement not found on mission ${missionId}: ${approvalId}`,
            );
        }
        requirement.granted = true;
        requirement.grantedBy = grantedBy;
        requirement.grantedAt = this.clock.isoNow();

        const allGranted = mission.approvalRequirements.every((req) => req.granted);
        // Once every approval is granted, a waiting Mission becomes ready.
        const nextState =
            allGranted && mission.state === MissionState.WAITING_FOR_APPROVAL
                ? MissionState.READY
                : mission.state;

        await this.store.updateMission(missionId, {
            approvalRequirements: [...mission.approvalRequirements],
            state: nextState,
            updatedAt: this.clock.isoNow(),
        });

        return this.requireMission(missionId);
    }

    /**
     * Dispatch one step of the current accepted plan as a capability
     * invocation reference. Mission state and invocation state are kept
     * distinct: this only records the reference; the durable scheduler
     * machinery belongs to #50.
     *
     * Authoritative gate (fail-closed before any invocation is created):
     *  1. Mission state must be READY or EXECUTING.
     *  2. Step must exist in the current accepted revision.
     *  3. No existing invocation for the same logical step (replay/uncertainty
     *     protection — see Blocker 3).
     *  4. Required approvals are granted (authoritative Mission state).
     *  5. Capability is still available in the current catalog.
     *  6. The accepted plan is revalidated against current policy (authorization
     *     is not frozen at proposal time).
     *
     * Writes are atomic (invocation row + mission state in one transaction).
     */
    async dispatchStep(missionId: string, stepId: string): Promise<CapabilityInvocationRef> {
        const mission = await this.requireMission(missionId);

        // Gate 1: Mission state must be authorizable.
        if (mission.state !== MissionState.READY && mission.state !== MissionState.EXECUTING) {
            throw new DispatchRejectedError(
                `mission ${missionId} is in state "${mission.state}"; dispatch requires ready/executing`,
            );
        }

        if (!mission.currentPlanRevisionId) {
            throw new DispatchRejectedError(
                `mission ${missionId} has no accepted plan to dispatch from`,
            );
        }
        const revision = await this.store.getPlanRevision(mission.currentPlanRevisionId);
        if (!revision) {
            throw new Error(`Current plan revision not found: ${mission.currentPlanRevisionId}`);
        }
        const step = revision.steps.find((s) => s.stepId === stepId);
        if (!step) {
            throw new Error(`Step not found in current plan: ${stepId}`);
        }

        // Gate 2: replay/uncertainty protection — one invocation per logical step.
        const existing = await this.store.listInvocations(missionId);
        const prior = existing.find((inv) => inv.stepId === stepId);
        if (prior) {
            throw new InvocationConflictError(missionId, stepId, prior.invocationId, prior.status);
        }

        // Gate 3: required approvals granted (authoritative Mission state).
        if (step.approvalRequirement) {
            const requirement = mission.approvalRequirements.find(
                (r) => r.approvalId === step.approvalRequirement!.approvalId,
            );
            if (!requirement || !requirement.granted) {
                throw new DispatchRejectedError(
                    `step "${stepId}" requires approval "${step.approvalRequirement.approvalId}" which is not granted`,
                );
            }
        }

        // Gate 4: capability still available in the current catalog.
        const contract = await this.policy.resolver.resolve(step.capabilityRequirement);
        if (!contract) {
            throw new DispatchRejectedError(
                `capability "${step.capabilityRequirement}" is no longer available`,
            );
        }

        // Gate 5: revalidate the accepted plan against current policy.
        // Authorization is not frozen at proposal time.
        const revalidation = await this.policy.validate(mission, {
            planId: revision.planId,
            missionId,
            plannerNote: revision.reason,
            steps: revision.steps,
        });
        if (!revalidation.valid) {
            throw new DispatchRejectedError(
                `plan no longer authorized: ${revalidation.reasons.join("; ")}`,
            );
        }

        const invocation: CapabilityInvocationRef = {
            invocationId: this.ids.generate(),
            missionId,
            stepId,
            capabilityId: step.capabilityRequirement,
            status: InvocationStatus.DISPATCHED,
            dispatchedAt: this.clock.isoNow(),
            resultRefs: [],
        };

        // Atomic: invocation row + mission state in one transaction.
        await this.store.withTransaction(async () => {
            await this.store.saveInvocation(invocation);
            await this.store.updateMission(missionId, {
                state: MissionState.EXECUTING,
                updatedAt: this.clock.isoNow(),
            });
        });

        return invocation;
    }

    /**
     * Record an invocation result with optional owner verification.
     * A negative owner verification is preserved and dominates any
     * mission-level "looks good" judgment.
     * Writes are atomic (invocation row + Mission evidence in one transaction).
     */
    async recordInvocationResult(
        invocationId: string,
        result: InvocationResult,
        ownerVerification?: OwnerVerification,
    ): Promise<Mission> {
        const invocation = await this.store.getInvocation(invocationId);
        if (!invocation) {
            throw new Error(`Invocation not found: ${invocationId}`);
        }
        const mission = await this.requireMission(invocation.missionId);

        const updated: CapabilityInvocationRef = {
            ...invocation,
            status: result.status,
            completedAt: result.completedAt,
            resultRefs: result.evidenceRefs,
            error: result.status === InvocationStatus.FAILED ? result.summary : invocation.error,
            ownerVerification: ownerVerification ?? invocation.ownerVerification,
        };

        const newEvidenceRefs = [...mission.evidenceRefs];
        for (const ref of result.evidenceRefs) {
            if (!newEvidenceRefs.some((existing) => existing.refId === ref.refId)) {
                newEvidenceRefs.push(ref);
            }
        }

        await this.store.withTransaction(async () => {
            await this.store.updateInvocation(invocationId, updated);
            await this.store.updateMission(invocation.missionId, {
                evidenceRefs: newEvidenceRefs,
                updatedAt: this.clock.isoNow(),
            });
        });

        return this.requireMission(invocation.missionId);
    }

    /**
     * Record an explicit, deterministic, typed verification for one
     * acceptance criterion. This is the ONLY path through which acceptance
     * can be proven for completion — text labels are never completion
     * authority. `source` must be an authorized deterministic verifier
     * (e.g. a module owner or an operator), not planner narrative.
     */
    async recordCriterionVerification(
        missionId: string,
        criterionId: string,
        satisfied: boolean,
        source: string,
        evidenceRefId?: string,
    ): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        const entry: CriterionVerification = {
            criterionId,
            satisfied,
            source,
            verifiedAt: this.clock.isoNow(),
            evidenceRefId,
        };
        const existing = mission.criterionVerifications.find(
            (cv) => cv.criterionId === criterionId,
        );
        const criterionVerifications = existing
            ? mission.criterionVerifications.map((cv) =>
                  cv.criterionId === criterionId ? entry : cv,
              )
            : [...mission.criterionVerifications, entry];

        await this.store.updateMission(missionId, {
            criterionVerifications,
            updatedAt: this.clock.isoNow(),
        });
        return this.requireMission(missionId);
    }

    /**
     * Mission-level verification. Respects the layered-verification rule:
     * negative module-owner verification can never be overwritten into
     * Mission success.
     */
    async verifyMission(missionId: string): Promise<MissionVerificationResult> {
        const mission = await this.requireMission(missionId);
        const result = await this.verifier.verify(mission);
        return {
            satisfied: result.satisfied,
            ownerBlocked: result.ownerBlocked,
            reasons: result.reasons,
            invocationSummary: mission.invocationRefs.map((inv) => ({
                invocationId: inv.invocationId,
                status: inv.status,
                ownerVerified:
                    inv.ownerVerification === undefined ? null : inv.ownerVerification.verified,
            })),
        };
    }

    /**
     * Transition the Mission to COMPLETED only when mission-level
     * verification is satisfied and no owner verification is negative.
     */
    async completeMission(missionId: string): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        const verification = await this.verifyMission(missionId);
        if (!verification.satisfied || verification.ownerBlocked) {
            throw new InvalidStateTransitionError(
                missionId,
                mission.state,
                MissionState.COMPLETED,
                verification.reasons.join("; "),
            );
        }
        await this.store.updateMission(missionId, {
            state: MissionState.COMPLETED,
            updatedAt: this.clock.isoNow(),
        });
        return this.requireMission(missionId);
    }

    /**
     * Explicit wait states — a waiting_* state is a legitimate waiting
     * state, never a failure.
     */
    async setWaiting(
        missionId: string,
        state:
            | MissionState.WAITING_FOR_APPROVAL
            | MissionState.WAITING_FOR_CONTEXT
            | MissionState.WAITING_FOR_CAPABILITY
            | MissionState.WAITING_FOR_PROVIDER
            | MissionState.WAITING_FOR_BUDGET,
        unresolvedQuestion?: string,
    ): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        if (!WAITING_STATES.has(state)) {
            throw new Error(`Not a waiting state: ${state}`);
        }
        const unresolvedQuestions = [...mission.unresolvedQuestions];
        if (unresolvedQuestion && !unresolvedQuestions.includes(unresolvedQuestion)) {
            unresolvedQuestions.push(unresolvedQuestion);
        }
        await this.store.updateMission(missionId, {
            state,
            unresolvedQuestions,
            updatedAt: this.clock.isoNow(),
        });
        return this.requireMission(missionId);
    }

    /**
     * Block the Mission (e.g. capability unavailable). Intent and
     * acceptance remain untouched; replanning can resume from BLOCKED.
     */
    async blockMission(missionId: string, reason: string): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        if (mission.state === MissionState.COMPLETED || mission.state === MissionState.CANCELLED) {
            throw new InvalidStateTransitionError(
                missionId,
                mission.state,
                MissionState.BLOCKED,
                "terminal missions cannot be blocked",
            );
        }
        await this.store.updateMission(missionId, {
            state: MissionState.BLOCKED,
            unresolvedQuestions: [...mission.unresolvedQuestions, `blocked: ${reason}`],
            updatedAt: this.clock.isoNow(),
        });
        return this.requireMission(missionId);
    }

    /** Cancel a Mission (cooperative, terminal). */
    async cancelMission(missionId: string, reason: string): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        await this.store.updateMission(missionId, {
            state: MissionState.CANCELLED,
            unresolvedQuestions: [...mission.unresolvedQuestions, `cancelled: ${reason}`],
            updatedAt: this.clock.isoNow(),
        });
        return this.requireMission(missionId);
    }

    /** Mark the Mission as failed_terminal (explicit, terminal). */
    async failMission(missionId: string, reason: string): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        await this.store.updateMission(missionId, {
            state: MissionState.FAILED_TERMINAL,
            unresolvedQuestions: [...mission.unresolvedQuestions, `failed: ${reason}`],
            updatedAt: this.clock.isoNow(),
        });
        return this.requireMission(missionId);
    }

    /** Read a Mission (works without any interface installed). */
    async getMission(missionId: string): Promise<Mission> {
        return this.requireMission(missionId);
    }

    async listMissions(filter?: { state?: MissionState }): Promise<Mission[]> {
        return this.store.listMissions(filter);
    }

    private async requireMission(missionId: string): Promise<Mission> {
        const mission = await this.store.getMission(missionId);
        if (!mission) {
            throw new MissionNotFoundError(missionId);
        }
        return mission;
    }
}

/** Default interpreter: the interpreted objective starts as the preserved intent. */
function defaultInterpreter(intent: MissionIntent): string {
    return intent.originalIntent;
}
