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
    CapabilityContract,
    CapabilityInvocation,
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
    MissionPauseMetadata,
    OwnerVerification,
    PlanCandidate,
    PlanRevision,
    PolicyDecision,
    StepApprovalRequirement,
    WAITING_STATES,
    TERMINAL_STATES,
    assertValidInvocationIdentity,
    isInvocationTerminal,
    hasUncertainDelivery,
    computeEffectFingerprint,
} from "./contracts.js";
import type {
    CancellationSupport,
    IdempotencyMode,
    ReconciliationSupport,
    RetryBackoff,
} from "../capabilities/contracts.js";
import {
    CapabilityResolver,
    ClockService,
    IdGenerator,
    MissionStore,
    MissionVerifier,
    VerificationAuthority,
} from "./ports.js";
import { PlanPolicyValidator } from "./policy.js";
import { assertNoRawSecrets, sanitizeText, sanitizeStringArray, sanitizePlanStep } from "./sanitize.js";
import { createHash } from "node:crypto";

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
    /**
     * Attestation boundary for owner/criterion verification. When omitted,
     * the engine FAILS CLOSED: no owner or criterion verdict is accepted.
     * Real attestation (and connectors) belongs to #63/#66.
     */
    verificationAuthority?: VerificationAuthority;
}

/**
 * Default verification authority: fails closed. Matching identity fields
 * are NOT provenance — without an injected authority, no owner verdict and
 * no criterion verdict can be recorded.
 */
class FailClosedVerificationAuthority implements VerificationAuthority {
    async attestOwnerVerification(
        _submitted: OwnerVerification,
        _invocation: CapabilityInvocationRef,
        _contract: CapabilityContract,
    ): Promise<OwnerVerification> {
        throw new Error(
            "No verification authority configured: owner verifications are rejected by default (fail-closed)",
        );
    }

    async attestCriterionVerification(
        _submitted: {
            criterionId: string;
            satisfied: boolean;
            source: string;
            evidenceRefId?: string;
        },
        _mission: Mission,
    ): Promise<CriterionVerification> {
        throw new Error(
            "No verification authority configured: criterion verifications are rejected by default (fail-closed)",
        );
    }
}

export interface CreateMissionInput {
    intent: MissionIntent;
    allowedCapabilityScope: AllowedCapabilityScope;
    budgetPolicy?: BudgetPolicy;
    approvalRequirements?: ApprovalRequirement[];
}

/**
 * Already validated descriptor semantics supplied by the connector seam.
 * Planner data is intentionally absent: it can never authorize these fields.
 */
export interface DispatchDescriptorMetadata {
    contractVersion: number;
    moduleOwner: string;
    idempotency: { mode: IdempotencyMode; keyScope: "request" | "effect" | "none" };
    retry: { maxAttempts: number; backoff: RetryBackoff };
    cancellationSupport: CancellationSupport;
    reconciliationSupport: ReconciliationSupport;
}

/** Optional metadata path for the already validated capability descriptor. */
export interface DispatchStepOptions {
    descriptor?: DispatchDescriptorMetadata;
}

/** Compatibility alias for seam integrations that name this metadata explicitly. */
export type InvocationDispatchOptions = DispatchStepOptions;

/** Durable facts recorded immediately before a potentially effectful handoff. */
export interface InvocationHandoffUpdate {
    deliveryState?: "acknowledged" | "running" | "uncertain";
    remoteOperationHandle?: string;
    correlationId?: string;
}

/** Durable reconciliation facts. This method does not call a connector. */
export interface InvocationReconciliationUpdate {
    state: "not_required" | "pending" | "resolved" | "unsupported";
    outcome?: "performed" | "not_performed" | "unknown";
    nextAction?: string;
    lastCheckedAt?: string;
    deliveryState?: "acknowledged" | "running" | "failed" | "uncertain";
    status?: InvocationStatus;
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
    constructor(missionId: string, from: MissionState | InvocationStatus, to: MissionState | InvocationStatus, reason: string) {
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
        // an explicit, deterministic, satisfied CriterionVerification record
        // whose source is a module owner that has positively verified an
        // invocation of this Mission. A caller-supplied "module-owner:runstead"
        // string is not authority on its own.
        const trustedOwners = new Set(
            invocations
                .filter((inv) => inv.ownerVerification?.verified === true)
                .map((inv) => inv.ownerVerification!.owner),
        );
        const satisfiedCriteria = new Set(
            mission.criterionVerifications
                .filter((cv) => cv.satisfied && trustedOwners.has(cv.source))
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
    private readonly verificationAuthority: VerificationAuthority;

    constructor(options: MissionEngineOptions) {
        this.store = options.store;
        this.policy = options.policy;
        this.clock = options.clock ?? new SystemClock();
        this.ids = options.ids ?? new UuidGenerator();
        this.interpreter = options.interpreter ?? defaultInterpreter;
        this.verifier = options.verifier ?? new DefaultMissionVerifier(this.policy.resolver);
        this.verificationAuthority =
            options.verificationAuthority ?? new FailClosedVerificationAuthority();
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
        const interpretedObjective = sanitizeText(await this.interpreter(intent));

        // Free-form external text is sanitized before durable storage
        // (Authorization/Bearer/api-key/credentials/tokens are redacted).
        const sanitizedApprovals = (approvalRequirements ?? intent.approvals ?? []).map(
            (req) => ({ ...req, reason: sanitizeText(req.reason), approver: sanitizeText(req.approver) }),
        );

        const mission: Mission = {
            missionId,
            schemaVersion: MISSION_CONTRACT_VERSION,
            source: intent.source,
            // Original intent is preserved verbatim (raw). The persisted
            // representation is the sanitized snapshot + immutable reference;
            // the raw value itself is never written to durable storage.
            originalIntent: intent.originalIntent,
            sanitizedOriginalIntent: sanitizeText(intent.originalIntent),
            originalIntentRef: createHash("sha256")
                .update(intent.originalIntent)
                .digest("hex"),
            interpretedObjective,
            constraints: sanitizeStringArray(intent.constraints),
            acceptanceCriteria: sanitizeStringArray(intent.acceptanceCriteria),
            budgetPolicy: budgetPolicy ?? {},
            allowedCapabilityScope: {
                capabilityIds: [...allowedCapabilityScope.capabilityIds],
                allowedEffectClasses: [...allowedCapabilityScope.allowedEffectClasses],
                allowedRefPrefixes: [...allowedCapabilityScope.allowedRefPrefixes],
            },
            // Explicit approvals/permissions represented by the intent flow
            // into the Mission approval state (data, not implicit authority);
            // a caller-supplied policy wins over the intent's representation.
            approvalRequirements: sanitizedApprovals,
            contextRefs: (intent.contextRefs ?? []).map((ref) => ({
                ...ref,
                label: sanitizeText(ref.label),
                externalRef: sanitizeText(ref.externalRef),
            })),
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
            // Free-form planner text is sanitized before durable storage.
            // sanitizePlanStep structurally sanitizes ALL nested text fields.
            steps: candidate.steps.map(sanitizePlanStep),
            status: "proposed",
            reason: sanitizeText(candidate.plannerNote) || "Proposed by planner",
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
        this.guardNotTerminal(mission, "acceptPlan");

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
                    // The planner may reference an existing requirement only
                    // when it is exactly compatible. The requirement's
                    // authoritative metadata (scopeDescriptor, approver,
                    // reason, granted state) is IMMUTABLE: the planner can
                    // never rewrite it. Scope was already validated by policy;
                    // this is the defensive, authoritative double-check using
                    // the SAME authoritative effect fingerprint function.
                    const scopeOk =
                        existing.scopeDescriptor.capabilityId === step.capabilityRequirement &&
                        existing.scopeDescriptor.effectClass === step.effectClass &&
                        existing.scopeDescriptor.effectFingerprint ===
                            computeEffectFingerprint({
                                capabilityId: step.capabilityRequirement,
                                effectClass: step.effectClass,
                                inputRefs: step.inputRefs,
                                outcome: step.desiredOutcome,
                            });
                    if (!scopeOk) {
                        throw new Error(
                            `Approval requirement "${req.approvalId}" effect mismatch: planner cannot re-purpose a granted approval for a different effect`,
                        );
                    }
                    // Deliberately do NOT touch existing.approver /
                    // existing.reason / existing.scopeDescriptor.
                } else {
                    // New requirement proposed by the planner: authoritative
                    // state starts UN-GRANTED with an immutable effect scope
                    // derived from the step itself. Only sanitized values enter.
                    mergedApprovals.push({
                        approvalId: req.approvalId,
                        scopeDescriptor: {
                            capabilityId: step.capabilityRequirement,
                            effectClass: step.effectClass,
                            effectFingerprint: computeEffectFingerprint({
                                capabilityId: step.capabilityRequirement,
                                effectClass: step.effectClass,
                                inputRefs: step.inputRefs,
                                outcome: step.desiredOutcome,
                            }),
                        },
                        approver: sanitizeText(req.approver),
                        reason: sanitizeText(req.reason),
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
        await this.store.updatePlanRevisionStatus(revisionId, "rejected", sanitizeText(reason));
        return this.requireMission(missionId);
    }

    /** Record an explicit human/operator approval for a Mission requirement. */
    async recordApproval(
        missionId: string,
        approvalId: string,
        grantedBy: string,
    ): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        this.guardNotTerminal(mission, "recordApproval");
        const requirement = mission.approvalRequirements.find(
            (req) => req.approvalId === approvalId,
        );
        if (!requirement) {
            throw new Error(
                `Approval requirement not found on mission ${missionId}: ${approvalId}`,
            );
        }
        requirement.granted = true;
        requirement.grantedBy = sanitizeText(grantedBy);
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
    async dispatchStep(
        missionId: string,
        stepId: string,
        options?: DispatchStepOptions,
    ): Promise<CapabilityInvocation> {
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

        const effectFingerprint = computeEffectFingerprint({
            capabilityId: step.capabilityRequirement,
            effectClass: step.effectClass,
            inputRefs: step.inputRefs,
            outcome: step.desiredOutcome,
        });
        const priorEffect = await this.store.findInvocationByEffectFingerprint(effectFingerprint);
        if (priorEffect) {
            if (priorEffect.status === InvocationStatus.COMPLETED) return priorEffect;
            throw new InvocationConflictError(
                missionId,
                stepId,
                priorEffect.invocationId,
                priorEffect.status,
            );
        }

        const descriptor = options?.descriptor
            ? validateDispatchDescriptor(options.descriptor)
            : defaultDispatchDescriptor(contract);
        const now = this.clock.isoNow();
        const invocationId = this.ids.generate();
        const invocation: CapabilityInvocation = {
            invocationId,
            missionId,
            stepId,
            capabilityId: step.capabilityRequirement,
            status: InvocationStatus.DISPATCHED,
            resultRefs: [],
            planRevisionId: revision.revisionId,
            contractVersion: descriptor.contractVersion,
            moduleOwner: descriptor.moduleOwner,
            requestId: invocationId,
            effectFingerprint,
            inputRefs: [...step.inputRefs],
            idempotency: {
                mode: descriptor.idempotency.mode,
                key: descriptor.idempotency.keyScope === "request"
                    ? invocationId
                    : descriptor.idempotency.keyScope === "effect"
                        ? effectFingerprint
                        : undefined,
            },
            retry: {
                maxAttempts: descriptor.retry.maxAttempts,
                attempt: 0,
                backoff: descriptor.retry.backoff,
                backoffMs: 0,
                nextEligibleAt: null,
            },
            attempts: [{
                attempt: 0,
                correlationId: this.ids.generate(),
                state: "prepared",
                startedAt: now,
            }],
            delivery: { state: "not_submitted" },
            cancellation: {
                support: descriptor.cancellationSupport,
                requested: false,
                state: "not_requested",
            },
            reconciliation: {
                support: descriptor.reconciliationSupport,
                state: "not_required",
            },
            ownerVerificationState: "pending",
            createdAt: now,
            updatedAt: now,
        };
        // Identity-bearing refs are never silently redacted. The store repeats
        // this check, but the engine must fail closed before its transaction.
        assertValidInvocationIdentity(invocation);
        assertNoRawSecrets(invocation);

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
        ownerVerificationClaim?: OwnerVerification,
    ): Promise<Mission> {
        const invocation = await this.store.getInvocation(invocationId);
        if (!invocation) {
            throw new Error(`Invocation not found: ${invocationId}`);
        }
        // Fail closed on identity drift: the result's echoed invocationId
        // (when present) must match the invocation being updated. A result
        // for a DIFFERENT invocation is never silently accepted for this one.
        if (result.invocationId !== invocationId) {
            throw new Error(
                `InvocationResult declares invocationId "${result.invocationId}" but was submitted for "${invocationId}"; refusing to record a mismatched result`,
            );
        }
        const mission = await this.requireMission(invocation.missionId);
        // Completed/failed Missions reject late results. A cancelled Mission
        // may still receive an explicit owner/reconciliation fact, but the
        // Mission itself can never be revived.
        if (TERMINAL_STATES.has(mission.state) && mission.state !== MissionState.CANCELLED) {
            this.guardNotTerminal(mission, "recordInvocationResult");
        }
        validateInvocationResult(result);

        // Immutable invocation terminality makes duplicate delivery safe. Do
        // not re-attest or merge conflicting late payloads into a terminal row.
        if (isInvocationTerminal(invocation)) return mission;

        // OwnerVerification must be attested by the verification authority;
        // identity field matching is NOT provenance (fail-closed).
        let attestedOwnerVerification: OwnerVerification | undefined;
        if (ownerVerificationClaim) {
            const contract = await this.policy.resolver.resolve(invocation.capabilityId);
            if (!contract) {
                throw new Error(
                    `cannot verify invocation of unknown capability "${invocation.capabilityId}"`,
                );
            }
            attestedOwnerVerification =
                await this.verificationAuthority.attestOwnerVerification(
                    ownerVerificationClaim,
                    invocation,
                    contract,
                );
            // Sanitize the attested reason (free-form) before storage.
            attestedOwnerVerification = {
                ...attestedOwnerVerification,
                reason: sanitizeText(attestedOwnerVerification.reason),
            };
        }

        // Free-form text in result/evidence is sanitized before storage.
        const sanitizedSummary = sanitizeText(result.summary);
        const sanitizedEvidenceRefs = result.evidenceRefs.map((ref) => {
            assertNoRawSecrets({ refId: ref.refId, owner: ref.owner });
            return {
                ...ref,
                label: sanitizeText(ref.label),
                externalRef: sanitizeText(ref.externalRef),
            };
        });
        const resultRefs = mergeEvidenceRefs(invocation.resultRefs, sanitizedEvidenceRefs);
        const ownerVerification = invocation.ownerVerification?.verified === false
            ? invocation.ownerVerification
            : attestedOwnerVerification ?? invocation.ownerVerification;
        const ownerRejected = ownerVerification?.verified === false;
        const status = ownerRejected && result.status === InvocationStatus.COMPLETED
            ? InvocationStatus.FAILED
            : result.status;
        const completedAt = result.completedAt ?? (status === InvocationStatus.FAILED ? this.clock.isoNow() : undefined);
        const now = this.clock.isoNow();
        const attempts = updateAttempt(invocation, status, completedAt, sanitizedSummary);
        const delivery = updateDelivery(invocation, status, completedAt);
        const updated: CapabilityInvocation = {
            ...invocation,
            status,
            completedAt,
            resultRefs,
            error: status === InvocationStatus.FAILED ? sanitizedSummary : invocation.error,
            ownerVerification,
            ownerVerificationState: ownerVerification
                ? ownerVerification.verified ? "verified" : "rejected"
                : invocation.ownerVerificationState,
            attempts,
            delivery,
            retry: status === InvocationStatus.FAILED
                ? { ...invocation.retry, attempt: Math.max(invocation.retry.attempt, (attempts.at(-1)?.attempt ?? 0) + 1) }
                : invocation.retry,
            updatedAt: now,
        };

        const newEvidenceRefs = mergeEvidenceRefs(mission.evidenceRefs, sanitizedEvidenceRefs);

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
     * authority.
     *
     * `satisfied`/`source` are CLAIMS, not authority: the verdict is only
     * stored when the verification authority attests it. Without an
     * injected authority the engine fails closed.
     */
    async recordCriterionVerification(
        missionId: string,
        criterionId: string,
        satisfied: boolean,
        source: string,
        evidenceRefId?: string,
    ): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        this.guardNotTerminal(mission, "recordCriterionVerification");

        // The authority decides whether the criterion verdict is valid.
        const attested = await this.verificationAuthority.attestCriterionVerification(
            { criterionId, satisfied, source, evidenceRefId },
            mission,
        );

        const entry: CriterionVerification = {
            criterionId: attested.criterionId,
            satisfied: attested.satisfied,
            source: attested.source,
            verifiedAt: this.clock.isoNow(),
            evidenceRefId: attested.evidenceRefId,
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
        this.guardNotTerminal(mission, "completeMission");
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
        this.guardNotTerminal(mission, "setWaiting");
        if (!WAITING_STATES.has(state)) {
            throw new Error(`Not a waiting state: ${state}`);
        }
        const unresolvedQuestions = [...mission.unresolvedQuestions];
        if (unresolvedQuestion && !unresolvedQuestions.includes(unresolvedQuestion)) {
            unresolvedQuestions.push(sanitizeText(unresolvedQuestion));
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
        this.guardNotTerminal(mission, "blockMission");
        await this.store.updateMission(missionId, {
            state: MissionState.BLOCKED,
            unresolvedQuestions: [...mission.unresolvedQuestions, `blocked: ${sanitizeText(reason)}`],
            updatedAt: this.clock.isoNow(),
        });
        return this.requireMission(missionId);
    }

    /** Pause a Mission without cancelling or mutating active invocations. */
    async pauseMission(missionId: string, reason: string, pausedBy?: string): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        this.guardNotTerminal(mission, "pauseMission");
        if (mission.state === MissionState.PAUSED) return mission;
        const pauseMetadata: MissionPauseMetadata = {
            previousState: mission.state,
            reason: sanitizeText(reason),
            pausedAt: this.clock.isoNow(),
            ...(pausedBy === undefined ? {} : { pausedBy: sanitizeText(pausedBy) }),
        };
        await this.store.updateMission(missionId, {
            state: MissionState.PAUSED,
            pauseMetadata,
            updatedAt: this.clock.isoNow(),
        });
        return this.requireMission(missionId);
    }

    /** Resume a paused Mission to its persisted previous state. */
    async resumeMission(missionId: string): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        this.guardNotTerminal(mission, "resumeMission");
        if (mission.state !== MissionState.PAUSED) {
            throw new InvalidStateTransitionError(
                missionId,
                mission.state,
                MissionState.READY,
                "resumeMission requires a paused Mission",
            );
        }
        const pauseMetadata = mission.pauseMetadata;
        if (!pauseMetadata || pauseMetadata.previousState === MissionState.PAUSED || TERMINAL_STATES.has(pauseMetadata.previousState)) {
            throw new InvalidStateTransitionError(
                missionId,
                mission.state,
                MissionState.READY,
                "paused Mission has no valid resumable state",
            );
        }
        await this.store.updateMission(missionId, {
            state: pauseMetadata.previousState,
            pauseMetadata: undefined,
            updatedAt: this.clock.isoNow(),
        });
        return this.requireMission(missionId);
    }

    /** Explicitly restore one legitimate wait to READY; never automatic. */
    async restoreWaitingToReady(missionId: string): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        this.guardNotTerminal(mission, "restoreWaitingToReady");
        if (!WAITING_STATES.has(mission.state)) {
            throw new InvalidStateTransitionError(
                missionId,
                mission.state,
                MissionState.READY,
                "restoreWaitingToReady requires a waiting Mission",
            );
        }
        await this.store.updateMission(missionId, {
            state: MissionState.READY,
            updatedAt: this.clock.isoNow(),
        });
        return this.requireMission(missionId);
    }

    /** Cancel a Mission and persist conservative cancellation per invocation. */
    async cancelMission(missionId: string, reason: string, cancelledBy?: string): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        this.guardNotTerminal(mission, "cancelMission");
        const now = this.clock.isoNow();
        const sanitizedReason = sanitizeText(reason);
        await this.store.withTransaction(async () => {
            const invocations = await this.store.listInvocations(missionId);
            for (const invocation of invocations) {
                if (isInvocationTerminal(invocation)) continue;
                if (invocation.delivery.state === "not_submitted") {
                    await this.store.updateInvocation(invocation.invocationId, {
                        status: InvocationStatus.CANCELLED,
                        completedAt: now,
                        updatedAt: now,
                        delivery: { state: "not_submitted" },
                        cancellation: {
                            ...invocation.cancellation,
                            requested: true,
                            requestedAt: now,
                            ...(cancelledBy === undefined ? {} : { requestedBy: sanitizeText(cancelledBy) }),
                            state: "acknowledged",
                            reason: sanitizedReason,
                        },
                        attempts: invocation.attempts.map((attempt) =>
                            attempt.state === "prepared"
                                ? { ...attempt, state: "failed", finishedAt: now, error: `cancelled: ${sanitizedReason}` }
                                : attempt,
                        ),
                    });
                    continue;
                }
                await this.store.updateInvocation(invocation.invocationId, {
                    updatedAt: now,
                    cancellation: {
                        ...invocation.cancellation,
                        requested: true,
                        requestedAt: now,
                        ...(cancelledBy === undefined ? {} : { requestedBy: sanitizeText(cancelledBy) }),
                        state: invocation.cancellation.support === "unsupported" || invocation.cancellation.support === "none"
                            ? "unsupported"
                            : "requested",
                        reason: sanitizedReason,
                    },
                    reconciliation: hasUncertainDelivery(invocation)
                        ? {
                              ...invocation.reconciliation,
                              state: "pending",
                              nextAction: "reconcile cancellation before any retry",
                              lastCheckedAt: now,
                          }
                        : invocation.reconciliation,
                });
            }
            await this.store.updateMission(missionId, {
                state: MissionState.CANCELLED,
                unresolvedQuestions: [...mission.unresolvedQuestions, `cancelled: ${sanitizedReason}`],
                updatedAt: now,
            });
        });
        return this.requireMission(missionId);
    }

    /** Cancel a not-submitted invocation without crossing the connector seam. */
    async cancelUnsubmitted(invocationId: string, reason: string, cancelledBy?: string): Promise<CapabilityInvocation> {
        const invocation = await this.requireInvocation(invocationId);
        if (isInvocationTerminal(invocation)) return invocation;
        if (invocation.delivery.state !== "not_submitted") {
            throw new InvalidStateTransitionError(
                invocation.missionId,
                invocation.status,
                InvocationStatus.CANCELLED,
                "cancelUnsubmitted requires not_submitted delivery",
            );
        }
        const now = this.clock.isoNow();
        await this.store.updateInvocation(invocationId, {
            status: InvocationStatus.CANCELLED,
            completedAt: now,
            updatedAt: now,
            cancellation: {
                ...invocation.cancellation,
                requested: true,
                requestedAt: now,
                ...(cancelledBy === undefined ? {} : { requestedBy: sanitizeText(cancelledBy) }),
                state: "acknowledged",
                reason: sanitizeText(reason),
            },
        });
        return this.requireInvocation(invocationId);
    }

    /** Persist the handoff boundary before a connector call. */
    async markInvocationHandoff(
        invocationId: string,
        update: InvocationHandoffUpdate = {},
    ): Promise<CapabilityInvocation> {
        const invocation = await this.requireInvocation(invocationId);
        if (isInvocationTerminal(invocation)) return invocation;
        if (invocation.cancellation.requested) {
            throw new InvalidStateTransitionError(
                invocation.missionId,
                invocation.status,
                InvocationStatus.DISPATCHED,
                "cancelled invocations cannot cross the handoff boundary",
            );
        }
        const now = this.clock.isoNow();
        const deliveryState = update.deliveryState ?? "uncertain";
        const attempts = invocation.attempts.map((attempt, index) =>
            index === invocation.attempts.length - 1 && attempt.state === "prepared"
                ? {
                      ...attempt,
                      correlationId: update.correlationId ?? attempt.correlationId,
                      state: "submitted" as const,
                  }
                : attempt,
        );
        const delivery = {
            ...invocation.delivery,
            state: deliveryState,
            ...(deliveryState === "acknowledged" ? { acknowledgedAt: now } : {}),
            ...(update.remoteOperationHandle === undefined
                ? {}
                : { remoteOperationHandle: sanitizeOpaqueString(update.remoteOperationHandle, "remoteOperationHandle") }),
        };
        await this.store.updateInvocation(invocationId, {
            status: deliveryState === "running" ? InvocationStatus.RUNNING : invocation.status,
            dispatchedAt: invocation.dispatchedAt ?? now,
            delivery,
            attempts,
            reconciliation: deliveryState === "uncertain"
                ? { ...invocation.reconciliation, state: "pending", nextAction: "reconcile before retry" }
                : invocation.reconciliation,
            updatedAt: now,
        });
        return this.requireInvocation(invocationId);
    }

    /** Persist a typed reconciliation fact without invoking a connector. */
    async markInvocationReconciliation(
        invocationId: string,
        update: InvocationReconciliationUpdate,
    ): Promise<CapabilityInvocation> {
        const invocation = await this.requireInvocation(invocationId);
        if (isInvocationTerminal(invocation)) return invocation;
        const now = this.clock.isoNow();
        const status = update.status ?? reconciliationStatus(update.outcome, invocation.status);
        const deliveryState = update.deliveryState ?? reconciliationDelivery(update.outcome, invocation.delivery.state);
        if (status === InvocationStatus.PENDING || status === InvocationStatus.DISPATCHED) {
            throw new InvalidStateTransitionError(
                invocation.missionId,
                invocation.status,
                status,
                "reconciliation cannot regress an invocation to pre-handoff state",
            );
        }
        await this.store.updateInvocation(invocationId, {
            status,
            delivery: { ...invocation.delivery, state: deliveryState },
            reconciliation: {
                ...invocation.reconciliation,
                state: update.state,
                ...(update.outcome === undefined ? {} : { outcome: update.outcome }),
                lastCheckedAt: update.lastCheckedAt ?? now,
                ...(update.nextAction === undefined ? {} : { nextAction: sanitizeText(update.nextAction) }),
            },
            updatedAt: now,
        });
        return this.requireInvocation(invocationId);
    }

    /** Mark the Mission as failed_terminal (explicit, terminal). */
    async failMission(missionId: string, reason: string): Promise<Mission> {
        const mission = await this.requireMission(missionId);
        this.guardNotTerminal(mission, "failMission");
        await this.store.updateMission(missionId, {
            state: MissionState.FAILED_TERMINAL,
            unresolvedQuestions: [...mission.unresolvedQuestions, `failed: ${sanitizeText(reason)}`],
            updatedAt: this.clock.isoNow(),
        });
        return this.requireMission(missionId);
    }

    /** Read a Mission (works without any interface installed). */
    async getMission(missionId: string): Promise<Mission> {
        return this.requireMission(missionId);
    }

    /** Read a single plan revision (read-only; dispatch seam input source). */
    async getPlanRevision(revisionId: string): Promise<PlanRevision | null> {
        return this.store.getPlanRevision(revisionId);
    }

    /**
     * Resolve the authorization-shaped contract the policy validator sees
     * for a capability id (read-only). Exposed so the dispatch seam can
     * prove policy and dispatch operate on the SAME authority source
     * (split-brain guard) without reaching into private fields.
     */
    async getResolvedContract(capabilityId: string): Promise<CapabilityContract | null> {
        return this.policy.resolver.resolve(capabilityId);
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

    private async requireInvocation(invocationId: string): Promise<CapabilityInvocation> {
        const invocation = await this.store.getInvocation(invocationId);
        if (!invocation) throw new Error(`Invocation not found: ${invocationId}`);
        return invocation;
    }

    /**
     * Terminality is a code invariant, not a comment: no normal operation
     * may mutate a Mission in a terminal state. Future exceptional recovery
     * must be a distinct, explicit operation — not a side effect of these
     * methods.
     */
    private guardNotTerminal(mission: Mission, action: string): void {
        if (TERMINAL_STATES.has(mission.state)) {
            throw new InvalidStateTransitionError(
                mission.missionId,
                mission.state,
                mission.state,
                `${action} is forbidden on terminal Mission state "${mission.state}"`,
            );
        }
    }
}

function defaultDispatchDescriptor(contract: CapabilityContract): DispatchDescriptorMetadata {
    return {
        contractVersion: 0,
        moduleOwner: contract.moduleOwner,
        idempotency: { mode: "unknown" as IdempotencyMode, keyScope: "none" },
        retry: { maxAttempts: 0, backoff: "none" as RetryBackoff },
        cancellationSupport: "unsupported" as CancellationSupport,
        reconciliationSupport: "none" as ReconciliationSupport,
    };
}

function validateDispatchDescriptor(
    descriptor: DispatchDescriptorMetadata,
): DispatchDescriptorMetadata {
    assertNoRawSecrets(descriptor, "dispatch descriptor");
    if (!Number.isSafeInteger(descriptor.contractVersion) || descriptor.contractVersion <= 0) {
        throw new DispatchRejectedError("descriptor contractVersion must be a positive safe integer");
    }
    if (typeof descriptor.moduleOwner !== "string" || descriptor.moduleOwner.trim() === "") {
        throw new DispatchRejectedError("descriptor moduleOwner must be a non-empty string");
    }
    const modes = new Set(["idempotent", "non_idempotent", "unknown"]);
    const keyScopes = new Set(["request", "effect", "none"]);
    if (!modes.has(descriptor.idempotency.mode) || !keyScopes.has(descriptor.idempotency.keyScope)) {
        throw new DispatchRejectedError("descriptor idempotency semantics are invalid");
    }
    if (!Number.isSafeInteger(descriptor.retry.maxAttempts) || descriptor.retry.maxAttempts < 0) {
        throw new DispatchRejectedError("descriptor retry.maxAttempts must be a non-negative safe integer");
    }
    if (!["none", "fixed", "exponential"].includes(descriptor.retry.backoff)) {
        throw new DispatchRejectedError("descriptor retry.backoff is invalid");
    }
    if (!["none", "cooperative", "hard", "unsupported"].includes(descriptor.cancellationSupport)) {
        throw new DispatchRejectedError("descriptor cancellationSupport is invalid");
    }
    if (!["none", "status_replay", "full_replay"].includes(descriptor.reconciliationSupport)) {
        throw new DispatchRejectedError("descriptor reconciliationSupport is invalid");
    }
    return {
        contractVersion: descriptor.contractVersion,
        moduleOwner: descriptor.moduleOwner,
        idempotency: { ...descriptor.idempotency },
        retry: { ...descriptor.retry },
        cancellationSupport: descriptor.cancellationSupport,
        reconciliationSupport: descriptor.reconciliationSupport,
    };
}

function mergeEvidenceRefs<T extends { refId: string }>(existing: T[], additions: T[]): T[] {
    const refs = new Map(existing.map((ref) => [ref.refId, ref]));
    for (const ref of additions) {
        if (!refs.has(ref.refId)) refs.set(ref.refId, ref);
    }
    return [...refs.values()];
}

function updateAttempt(
    invocation: CapabilityInvocation,
    status: InvocationStatus,
    finishedAt: string | undefined,
    error: string,
): CapabilityInvocation["attempts"] {
    if (invocation.attempts.length === 0) return invocation.attempts;
    const index = invocation.attempts.length - 1;
    const current = invocation.attempts[index];
    if (status === InvocationStatus.FAILED && current.state === "failed") return invocation.attempts;
    const nextState = status === InvocationStatus.FAILED
        ? "failed"
        : status === InvocationStatus.COMPLETED || status === InvocationStatus.CANCELLED
            ? "acknowledged"
            : status === InvocationStatus.BLOCKED
                ? "uncertain"
                : current.state;
    if (nextState === current.state && status !== InvocationStatus.FAILED) return invocation.attempts;
    return invocation.attempts.map((attempt, attemptIndex) =>
        attemptIndex === index
            ? {
                  ...attempt,
                  state: nextState,
                  ...(finishedAt === undefined ? {} : { finishedAt }),
                  ...(nextState === "failed" ? { error } : {}),
              }
            : attempt,
    );
}

function updateDelivery(
    invocation: CapabilityInvocation,
    status: InvocationStatus,
    acknowledgedAt: string | undefined,
): CapabilityInvocation["delivery"] {
    const state = status === InvocationStatus.COMPLETED
        ? "acknowledged"
        : status === InvocationStatus.RUNNING
            ? "running"
            : status === InvocationStatus.FAILED
                ? "failed"
                : status === InvocationStatus.BLOCKED
                    ? "uncertain"
                    : status === InvocationStatus.CANCELLED
                        ? invocation.delivery.state === "not_submitted" ? "not_submitted" : "acknowledged"
                        : invocation.delivery.state;
    return {
        ...invocation.delivery,
        state,
        ...(state === "acknowledged" && acknowledgedAt
            ? { acknowledgedAt: invocation.delivery.acknowledgedAt ?? acknowledgedAt }
            : {}),
    };
}

function validateInvocationResult(result: InvocationResult): void {
    if (!Object.values(InvocationStatus).includes(result.status)) {
        throw new Error(`Invalid invocation result status: ${String(result.status)}`);
    }
    if (typeof result.summary !== "string") throw new Error("InvocationResult summary must be a string");
    if (!Array.isArray(result.evidenceRefs)) throw new Error("InvocationResult evidenceRefs must be an array");
    if ((result.status === InvocationStatus.COMPLETED
        || result.status === InvocationStatus.CANCELLED
        || result.status === InvocationStatus.FAILED)
        && typeof result.completedAt !== "string") {
        throw new Error(`InvocationResult ${result.status} requires completedAt`);
    }
    if (result.completedAt !== undefined && typeof result.completedAt !== "string") {
        throw new Error("InvocationResult completedAt must be a string");
    }
}

function sanitizeOpaqueString(value: string, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${field} must be a non-empty string`);
    }
    assertNoRawSecrets(value, field);
    return value;
}

function reconciliationStatus(
    outcome: InvocationReconciliationUpdate["outcome"],
    current: InvocationStatus,
): InvocationStatus {
    return outcome === "not_performed" ? InvocationStatus.FAILED : current;
}

function reconciliationDelivery(
    outcome: InvocationReconciliationUpdate["outcome"],
    current: CapabilityInvocation["delivery"]["state"],
): CapabilityInvocation["delivery"]["state"] {
    if (outcome === "performed") return "acknowledged";
    if (outcome === "not_performed") return "failed";
    if (outcome === "unknown") return "uncertain";
    return current;
}

/** Default interpreter: the interpreted objective starts as the preserved intent. */
function defaultInterpreter(intent: MissionIntent): string {
    return intent.originalIntent;
}
