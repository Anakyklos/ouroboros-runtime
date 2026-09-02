import { createHash } from "node:crypto";
import type {
    CancellationSupport,
    IdempotencyMode,
    ReconciliationSupport,
    RetryBackoff,
} from "../capabilities/contracts.js";

/**
 * 🎯 Mission Contracts (Issue #62)
 *
 * First-class contracts for the Ouroboros Mission entity and the boundary
 * between advisory planning and deterministic policy.
 *
 * Core rule: **The LLM/planner proposes. Code/policy authorizes.**
 *
 * `MissionIntent` is input from an authorized interface. The authoritative
 * `Mission` is born inside Ouroboros (interpretation + durable creation).
 *
 * This module is provider/persona independent and versionable. It does NOT
 * depend on the legacy `OrchestratorTask` — the opposite direction is the
 * intended migration (see docs/ORCHESTRATOR_MIGRATION_MAP.md).
 */

/** Version of this contract. Bump on breaking schema changes. */
export const MISSION_CONTRACT_VERSION = 1 as const;

/** Semantic Mission states (kept separate from invocation state). */
export enum MissionState {
    CREATED = "created",
    PLANNING = "planning",
    WAITING_FOR_CONTEXT = "waiting_for_context",
    WAITING_FOR_APPROVAL = "waiting_for_approval",
    READY = "ready",
    EXECUTING = "executing",
    WAITING_FOR_CAPABILITY = "waiting_for_capability",
    WAITING_FOR_PROVIDER = "waiting_for_provider",
    WAITING_FOR_BUDGET = "waiting_for_budget",
    VERIFYING = "verifying",
    PAUSED = "paused",
    COMPLETED = "completed",
    BLOCKED = "blocked",
    FAILED_TERMINAL = "failed_terminal",
    CANCELLED = "cancelled",
}

/** All waiting_* states — must never be collapsed into failed_terminal. */
export const WAITING_STATES: ReadonlySet<MissionState> = new Set<MissionState>([
    MissionState.WAITING_FOR_CONTEXT,
    MissionState.WAITING_FOR_APPROVAL,
    MissionState.WAITING_FOR_CAPABILITY,
    MissionState.WAITING_FOR_PROVIDER,
    MissionState.WAITING_FOR_BUDGET,
]);

/** Terminal states from which a Mission will not resume automatically. */
export const TERMINAL_STATES: ReadonlySet<MissionState> = new Set<MissionState>([
    MissionState.COMPLETED,
    MissionState.FAILED_TERMINAL,
    MissionState.CANCELLED,
]);

/**
 * Authorized intent source. Records provenance (origin) only — it never
 * grants ownership nor special executive authority to the interface.
 * "operator" covers direct human operation (CLI/API admin).
 */
export type IntentSource = "katherine" | "mission_control" | "cli" | "api" | "operator";

/** A reference to external context with explicit authorization provenance. */
export interface ContextReference {
    refId: string;
    /** Owner/namespace of the referenced context (e.g. "lifeos", "runstead"). */
    owner: string;
    /** Sanitized, human-readable label. */
    label: string;
    /** Opaque pointer to the source of truth owned by `owner`. */
    externalRef: string;
    /** Who authorized this reference to be used by this Mission. */
    authorizedBy: string;
}

/** A budget/resource policy — hints for the deterministic policy, not text. */
export interface BudgetPolicy {
    /** Optional maximum number of invocations for the whole Mission. */
    maxInvocations?: number;
    /** Optional maximum wall-clock duration in ms. */
    maxDurationMs?: number;
    /** Optional currency-agnostic budget hint. */
    budgetUnits?: number;
}

/** Approval requirement that a Mission step may declare. */
export interface ApprovalRequirement {
    approvalId: string;
    /**
     * Immutable scope of what was approved. A grant is bound to exactly this
     * capability+effect+target; the planner cannot reuse a granted approval
     * for a different scope (APPROVAL_SCOPE_MISMATCH).
     */
    scopeDescriptor: {
        capabilityId: string;
        effectClass: EffectClass;
        /**
         * Deterministic, unambiguous fingerprint of the AUTHORIZED EFFECT
         * (computed by policy/code, never provided by the planner): a sha256
         * of the canonical structural serialization of capability, effect
         * class, sorted input refs and the semantic operation/outcome.
         * Two steps with different targets OR different operations/outcomes
         * produce different fingerprints and cannot share a grant.
         */
        effectFingerprint: string;
    };
    /** Who must approve (role/interface), not a free-form narrative. */
    approver: string;
    /** Why the approval is needed (sanitized, no CoT). */
    reason: string;
    /** Granted flag — fail-closed until explicitly set true. */
    granted: boolean;
    /** Who granted (operator/interface) and when. */
    grantedBy?: string;
    grantedAt?: string;
}

/** Scope of capabilities this Mission is allowed to invoke. */
export interface AllowedCapabilityScope {
    /** Explicit allowlist of capability IDs (authoritative). */
    capabilityIds: string[];
    /** Effect-class level allow (used only in addition to the allowlist). */
    allowedEffectClasses: EffectClass[];
    /**
     * Allowed prefixes for context/input references. Anything outside these
     * prefixes (e.g. another module's private storage) is denied.
     */
    allowedRefPrefixes: string[];
}

/** Effect class of a capability — coarse, deterministic, registry-independent. */
export enum EffectClass {
    READ = "read",
    WRITE = "write",
    EXECUTION = "execution",
    NETWORK = "network",
    STORAGE_ACCESS = "storage_access",
    MODULE_OWNER_OPERATION = "module_owner_operation",
    APPROVAL = "approval",
    COMMUNICATION = "communication",
}

/**
 * Deterministic, unambiguous fingerprint of the AUTHORIZED EFFECT, computed
 * by policy/code (never provided by the planner): a sha256 of the canonical
 * structural serialization (stable key order, sorted arrays) of capability
 * id, effect class, canonical input refs and the semantic operation/outcome.
 *
 * Two steps with different targets OR different operations/outcomes produce
 * different fingerprints and cannot share an approval grant. JSON structural
 * serialization (not `join("|")`) makes collisions impossible for distinct
 * input-ref arrays.
 */
export interface EffectFingerprintInput {
    capabilityId: string;
    effectClass: EffectClass;
    inputRefs: string[];
    /** Semantic identity of the operation/outcome that changes authorization. */
    outcome: string;
}

export function computeEffectFingerprint(input: EffectFingerprintInput): string {
    const canonical = JSON.stringify({
        capabilityId: input.capabilityId,
        effectClass: input.effectClass,
        inputRefs: [...input.inputRefs].sort(),
        outcome: input.outcome,
    });
    return createHash("sha256").update(canonical).digest("hex");
}

/** A raw intent entry from an authorized interface. Not yet a Mission. */
export interface MissionIntent {
    /** Stable id of the request as received from the interface. */
    requestId: string;
    /** Where the intent came from (provenance, not ownership). */
    source: IntentSource;
    /**
     * Original user-visible intent, preserved verbatim.
     * A Mission may keep it by immutable reference, but the contract
     * requires it to be representable here.
     */
    originalIntent: string;
    /** Explicit constraints stated by the user/interface. */
    constraints: string[];
    /** Acceptance the user/interface already knows. */
    acceptanceCriteria: string[];
    /** Explicit choices the user already made (preferences, not commands). */
    explicitChoices?: string[];
    /** Authorized context references the interface is allowed to attach. */
    contextRefs?: ContextReference[];
    /**
     * Approvals/permissions explicitly represented by the interface.
     * These are data, not implicit authorization for arbitrary effects.
     */
    approvals?: ApprovalRequirement[];
    /** Optional id of the authorized request at the source interface. */
    sourceRequestRef?: string;
}

/** A sanitized, event/evidence-based note. Never chain-of-thought. */
export interface EvidenceRef {
    refId: string;
    /** Owner/namespace of the evidence source. */
    owner: string;
    /** Opaque pointer to the evidence owned by `owner`. */
    externalRef: string;
    /** Short sanitized label. */
    label: string;
}

/**
 * Advisory declaration by the planner that a step REQUIRES approval.
 *
 * This is a proposal, never a grant: it carries NO `granted`/`grantedBy`/
 * `grantedAt` fields. The authoritative grant state lives only on the
 * Mission (`Mission.approvalRequirements`) and can only change through an
 * explicit authorized path such as `MissionEngine.recordApproval()`.
 *
 * Any candidate that smuggles grant fields inside this object is
 * deterministically rejected by the policy (`APPROVAL_GRANT_FORBIDDEN`).
 */
export interface StepApprovalRequirement {
    /** Id referencing the approval requirement (Mission-level or proposed). */
    approvalId: string;
    /** Who must approve (role/interface), declared by the planner. */
    approver: string;
    /** Why approval is needed (sanitized, no CoT). */
    reason: string;
}

/**
 * A declarative step proposed by the planner. Proposals are advisory —
 * nothing in here grants authority to execute effects.
 */
export interface PlanStep {
    /** Stable id of the step within the plan. */
    stepId: string;
    /** Desired outcome (declarative). */
    desiredOutcome: string;
    /** Ids of steps this step depends on. */
    dependencyIds: string[];
    /** Capability requirement (capability id or capability-class requirement). */
    capabilityRequirement: string;
    /** Input/context references this step intends to use. */
    inputRefs: string[];
    /** Expected acceptance for this step (declarative). */
    expectedAcceptance: string[];
    /** Effect class the planner believes the capability has. */
    effectClass: EffectClass;
    /** Whether this step requires explicit human approval (advisory only). */
    approvalRequirement?: StepApprovalRequirement;
    /** Budget hint for this step (proposal only). */
    budgetHint?: { units?: number; maxDurationMs?: number };
    /** Alternatives/fallbacks — always only proposals. */
    fallbacks?: Array<{ capabilityRequirement: string; reason: string }>;
}

/**
 * A plan proposal from the planner. It is advisory: it only becomes
 * authoritative after deterministic validation + acceptance.
 */
export interface PlanCandidate {
    /** Proposal id (planner-generated or caller-generated). */
    planId: string;
    /** Mission this proposal targets. */
    missionId: string;
    /**
     * Sanitized proposal note (no CoT). Optionally cites the trigger for a
     * replan (e.g. "capability unavailable", "new evidence ref X").
     */
    plannerNote: string;
    steps: PlanStep[];
    /**
     * If present, the acceptance the planner proposes. Policy requires this
     * to exactly match the Mission acceptance — the planner has NO authority
     * to change acceptance silently.
     */
    proposedAcceptanceCriteria?: string[];
    /**
     * If present, the constraints the planner proposes. Policy requires this
     * to exactly match the Mission constraints.
     */
    proposedConstraints?: string[];
}

/** Lifecycle of a plan revision (durable + auditable). */
export type PlanRevisionStatus = "proposed" | "accepted" | "superseded" | "rejected";

/** An auditable, versioned revision of a Mission plan. */
export interface PlanRevision {
    revisionId: string;
    /** Monotonic revision number within the Mission. */
    revisionNumber: number;
    planId: string;
    missionId: string;
    steps: PlanStep[];
    status: PlanRevisionStatus;
    /** Sanitized, event/evidence-based reason (no CoT). */
    reason: string;
    /** When the revision was accepted (if ever). */
    acceptedAt?: string;
    /** Previous accepted revision this one supersedes (if any). */
    replacesRevisionId?: string;
    /** Rejection reason when status === "rejected". */
    rejectionReason?: string;
    createdAt: string;
}

/** Invocation state — semantically distinct from Mission state. */
export enum InvocationStatus {
    PENDING = "pending",
    DISPATCHED = "dispatched",
    RUNNING = "running",
    COMPLETED = "completed",
    FAILED = "failed",
    CANCELLED = "cancelled",
    BLOCKED = "blocked",
}

/** Result of a capability invocation (evidence-level, sanitized). */
export interface InvocationResult {
    invocationId: string;
    /** Status at result time. */
    status: InvocationStatus;
    /** Sanitized summary (no raw provider response by default). */
    summary: string;
    /** Optional evidence refs produced by the invocation. */
    evidenceRefs: EvidenceRef[];
    /**
     * When this result was produced. Required for COMPLETED/CANCELLED and for
     * FAILED attempt outcomes. FAILED describes a definitive attempt failure,
     * but remains retryable when the invocation retry metadata permits it.
     */
    completedAt?: string;
}

/** A deterministic, typed criterion-level verification result. */
export interface CriterionVerification {
    /** The acceptance criterion text (immutable, stable for Mission lifetime). */
    criterionId: string;
    /** Whether the criterion is satisfied (deterministic, not planner narrative). */
    satisfied: boolean;
    /** Source of the verdict (e.g. "module-owner:runstead", "operator"). */
    source: string;
    /** When the verification was recorded. */
    verifiedAt: string;
    /** Optional reference to supporting evidence. */
    evidenceRefId?: string;
}

/** Verification reported by the module owner for an invocation. */
export interface OwnerVerification {
    invocationId: string;
    /** Whether the module owner verified the work as correct. */
    verified: boolean;
    /** Sanitized reason for the owner decision. */
    reason: string;
    /** Owner identity (module). */
    owner: string;
    verifiedAt: string;
}

/**
 * A capability invocation reference attached to a Mission. The full
 * invocation/scheduler machinery belongs to #50; here we define the
 * minimal reference + state needed to keep Mission and invocation state
 * as semantically different entities.
 */
export interface CapabilityInvocationRef {
    invocationId: string;
    missionId: string;
    stepId: string;
    capabilityId: string;
    status: InvocationStatus;
    dispatchedAt?: string;
    completedAt?: string;
    resultRefs: EvidenceRef[];
    /** Owner verification (module-owned), when the owner has reported. */
    ownerVerification?: OwnerVerification;
    /** Sanitized error (no raw provider dump). */
    error?: string;
}

/** A durable attempt made against a capability connector. */
export interface CapabilityInvocationAttempt {
    attempt: number;
    correlationId: string;
    state: "prepared" | "submitted" | "acknowledged" | "failed" | "uncertain";
    startedAt: string;
    finishedAt?: string;
    error?: string;
}

/** Durable delivery state, kept separate from the logical invocation status. */
export interface CapabilityInvocationDelivery {
    state: "not_submitted" | "acknowledged" | "running" | "failed" | "uncertain";
    acknowledgedAt?: string;
    remoteOperationHandle?: string;
}

/** Connector idempotency identity and declared retry policy. */
export interface CapabilityInvocationIdempotency {
    mode: IdempotencyMode;
    key?: string;
}

export interface CapabilityInvocationRetry {
    maxAttempts: number;
    attempt: number;
    backoff: RetryBackoff;
    backoffMs: number;
    nextEligibleAt: string | null;
}

export interface CapabilityInvocationCancellation {
    support: CancellationSupport;
    requested: boolean;
    requestedAt?: string;
    requestedBy?: string;
    state: "not_requested" | "requested" | "acknowledged" | "unsupported";
    reason?: string;
}

export interface CapabilityInvocationReconciliation {
    support: ReconciliationSupport;
    state: "not_required" | "pending" | "resolved" | "unsupported";
    lastCheckedAt?: string;
    outcome?: "performed" | "not_performed" | "unknown";
    nextAction?: string;
}

export type OwnerVerificationState = "not_required" | "pending" | "verified" | "rejected";

/**
 * Canonical durable invocation record. `CapabilityInvocationRef` intentionally
 * remains the minimal Mission projection and is source-compatible with #62.
 */
export interface CapabilityInvocation extends CapabilityInvocationRef {
    planRevisionId: string;
    contractVersion: number;
    moduleOwner: string;
    requestId: string;
    effectFingerprint: string;
    inputRefs: string[];
    idempotency: CapabilityInvocationIdempotency;
    retry: CapabilityInvocationRetry;
    attempts: CapabilityInvocationAttempt[];
    delivery: CapabilityInvocationDelivery;
    cancellation: CapabilityInvocationCancellation;
    reconciliation: CapabilityInvocationReconciliation;
    ownerVerificationState: OwnerVerificationState;
    createdAt: string;
    updatedAt: string;
}

/**
 * Validate the identity-bearing portion of a full invocation before a durable
 * write. Opaque refs are rejected when malformed, never silently redacted.
 * Secret detection remains the store's recursive fail-closed responsibility.
 */
export function assertValidInvocationIdentity(
    invocation: Pick<CapabilityInvocation, "invocationId" | "missionId" | "stepId" | "capabilityId" | "requestId" | "effectFingerprint" | "inputRefs">,
): void {
    const identityFields: Array<[string, string]> = [
        ["invocationId", invocation.invocationId],
        ["missionId", invocation.missionId],
        ["stepId", invocation.stepId],
        ["capabilityId", invocation.capabilityId],
        ["requestId", invocation.requestId],
        ["effectFingerprint", invocation.effectFingerprint],
    ];
    for (const [name, value] of identityFields) {
        if (typeof value !== "string" || value.length === 0) {
            throw new Error(`Invalid invocation identity field "${name}"; opaque identities must be non-empty strings`);
        }
    }
    if (!Array.isArray(invocation.inputRefs) || invocation.inputRefs.some((ref) => typeof ref !== "string")) {
        throw new Error("Invalid invocation identity field \"inputRefs\"; opaque refs must be a string array");
    }
}

/** Explicit pause information for a Mission that is not cancelled. */
export interface MissionPauseMetadata {
    previousState: MissionState;
    reason: string;
    pausedAt: string;
    pausedBy?: string;
}

/** Only COMPLETED and CANCELLED are immutable invocation terminal states. */
export function isInvocationTerminal(invocation: Pick<CapabilityInvocationRef, "status">): boolean {
    return invocation.status === InvocationStatus.COMPLETED
        || invocation.status === InvocationStatus.CANCELLED;
}

export function hasUncertainDelivery(invocation: Pick<CapabilityInvocation, "delivery" | "attempts">): boolean {
    return invocation.delivery.state === "uncertain"
        || invocation.attempts.some((attempt) => attempt.state === "uncertain");
}

export function isInvocationDue(
    invocation: Pick<CapabilityInvocation, "retry">,
    now: string | Date,
): boolean {
    const nextEligibleAt = invocation.retry.nextEligibleAt;
    return nextEligibleAt === null || Date.parse(typeof now === "string" ? now : now.toISOString()) >= Date.parse(nextEligibleAt);
}

export function isSafeRetryEligible(
    invocation: Pick<CapabilityInvocation, "status" | "retry" | "delivery" | "attempts" | "idempotency">,
    now: string | Date,
): boolean {
    return invocation.status === InvocationStatus.FAILED
        && invocation.retry.attempt < invocation.retry.maxAttempts
        && invocation.idempotency.mode === "idempotent"
        && !hasUncertainDelivery(invocation)
        && isInvocationDue(invocation, now);
}

/** FAILED is an attempt outcome; retry metadata controls an explicit retry transition. */
export function isInvocationUpdateAllowed(
    current: Pick<CapabilityInvocationRef, "status">,
    next: Pick<CapabilityInvocationRef, "status">,
): boolean {
    if (current.status === next.status) return true;
    const allowed: Record<InvocationStatus, ReadonlySet<InvocationStatus>> = {
        [InvocationStatus.PENDING]: new Set([
            InvocationStatus.DISPATCHED,
            InvocationStatus.RUNNING,
            InvocationStatus.COMPLETED,
            InvocationStatus.FAILED,
            InvocationStatus.BLOCKED,
            InvocationStatus.CANCELLED,
        ]),
        [InvocationStatus.DISPATCHED]: new Set([
            InvocationStatus.RUNNING,
            InvocationStatus.COMPLETED,
            InvocationStatus.FAILED,
            InvocationStatus.BLOCKED,
            InvocationStatus.CANCELLED,
        ]),
        [InvocationStatus.RUNNING]: new Set([
            InvocationStatus.COMPLETED,
            InvocationStatus.FAILED,
            InvocationStatus.BLOCKED,
            InvocationStatus.CANCELLED,
        ]),
        [InvocationStatus.FAILED]: new Set([InvocationStatus.PENDING]),
        [InvocationStatus.BLOCKED]: new Set([
            InvocationStatus.RUNNING,
            InvocationStatus.COMPLETED,
            InvocationStatus.FAILED,
            InvocationStatus.CANCELLED,
        ]),
        [InvocationStatus.COMPLETED]: new Set(),
        [InvocationStatus.CANCELLED]: new Set(),
    };
    return allowed[current.status].has(next.status);
}

/** Merge a result without mutating an immutable terminal record or duplicating refs. */
export function mergeInvocationResult(
    invocation: CapabilityInvocation,
    result: InvocationResult,
): CapabilityInvocation {
    if (isInvocationTerminal(invocation)) return invocation;
    const refs = new Map(invocation.resultRefs.map((ref) => [ref.refId, ref]));
    for (const ref of result.evidenceRefs) refs.set(ref.refId, ref);
    return {
        ...invocation,
        status: isInvocationTerminal(invocation) ? invocation.status : result.status,
        completedAt: result.completedAt ?? invocation.completedAt,
        resultRefs: [...refs.values()],
        updatedAt: result.completedAt ?? invocation.updatedAt,
    };
}

export function computeInvocationEffectFingerprint(input: EffectFingerprintInput): string {
    return computeEffectFingerprint(input);
}

/** Durable Mission entity — the first-class contract of this issue. */
export interface Mission {
    /** Stable Mission id, generated inside Ouroboros. */
    missionId: string;
    /** Contract/schema version (see MISSION_CONTRACT_VERSION). */
    schemaVersion: number;
    /** Source/interface that supplied the intent (provenance only). */
    source: IntentSource;
    /** Original user-visible intent, preserved verbatim (raw, in-memory). */
    originalIntent: string;
    /**
     * Sanitized snapshot of the original intent, safe for persistence.
     * For benign input this is identical to originalIntent; for secret-bearing
     * input the prohibited patterns are redacted to [REDACTED].
     */
    sanitizedOriginalIntent: string;
    /** Immutable reference (sha256 hex) to the raw original intent. */
    originalIntentRef: string;
    /** Objective interpreted by Ouroboros (advisory input, durable). */
    interpretedObjective: string;
    /** Explicit constraints (immutable by planner). */
    constraints: string[];
    /** Acceptance criteria (immutable by planner). */
    acceptanceCriteria: string[];
    /** Budget/resource policy. */
    budgetPolicy: BudgetPolicy;
    /** Allowed capability scope. */
    allowedCapabilityScope: AllowedCapabilityScope;
    /** Approval requirements/state. */
    approvalRequirements: ApprovalRequirement[];
    /** Authorized context references/provenance. */
    contextRefs: ContextReference[];
    /** Current durable Mission state. */
    state: MissionState;
    /** Current accepted plan revision id (null before first acceptance). */
    currentPlanRevisionId: string | null;
    /** References to child/capability invocations (derived from canonical store). */
    invocationRefs: CapabilityInvocationRef[];
    /** Evidence/result references collected so far. */
    evidenceRefs: EvidenceRef[];
    /** Typed criterion-level verification results (completion authority). */
    criterionVerifications: CriterionVerification[];
    /** Unresolved questions (may require user/operator input). */
    unresolvedQuestions: string[];
    /** Timestamps/recovery metadata. */
    createdAt: string;
    updatedAt: string;
    recoveryMetadata: {
        /** True once the Mission has been recovered from storage. */
        recovered: boolean;
        /** Monotonic counter of recovery/reinstantiation events. */
        recoveryCount: number;
        /** Last recovery timestamp (undefined until first recovery). */
        lastRecoveredAt?: string;
    };
    /** Present only while a Mission is paused. */
    pauseMetadata?: MissionPauseMetadata;
}

/** Result of deterministic plan validation. */
export interface PolicyDecision {
    valid: boolean;
    /** Deterministic rejection codes (stable, testable). */
    codes: PolicyRejectionCode[];
    /** Human-readable sanitized reasons for each code. */
    reasons: string[];
}

/** Stable, testable rejection codes from the deterministic policy. */
export enum PolicyRejectionCode {
    CAPABILITY_NOT_AUTHORIZED = "capability_not_authorized",
    CAPABILITY_UNKNOWN = "capability_unknown",
    DEPENDENCY_CYCLE = "dependency_cycle",
    EFFECT_NOT_AUTHORIZED = "effect_not_authorized",
    APPROVAL_MISSING = "approval_missing",
    APPROVAL_GRANT_FORBIDDEN = "approval_grant_forbidden",
    APPROVAL_SCOPE_MISMATCH = "approval_scope_mismatch",
    INPUT_INCOMPATIBLE = "input_incompatible",
    ACCEPTANCE_MUTATION = "acceptance_mutation",
    CONSTRAINT_MUTATION = "constraint_mutation",
    STORAGE_ACCESS_DENIED = "storage_access_denied",
    MODULE_OWNER_BYPASS = "module_owner_bypass",
    EMPTY_PLAN = "empty_plan",
    UNKNOWN_STEP_REFERENCE = "unknown_step_reference",
    MISSION_ID_MISMATCH = "mission_id_mismatch",
}

/** Outcome of mission-level verification. */
export interface MissionVerificationResult {
    /** Whether the Mission satisfied its own acceptance criteria. */
    satisfied: boolean;
    /**
     * True when any owner verification was negative and therefore the
     * Mission MUST NOT be completed (higher layer cannot erase lower layer).
     */
    ownerBlocked: boolean;
    /** Deterministic reasons. */
    reasons: string[];
    /** Sanitized per-invocation summary. */
    invocationSummary: Array<{
        invocationId: string;
        status: InvocationStatus;
        ownerVerified: boolean | null;
    }>;
}

/** Minimal catalog entry a resolver returns for a known capability. */
export interface CapabilityContract {
    capabilityId: string;
    /** Module owner of the capability (e.g. "runstead", "lifeos", "tecer"). */
    moduleOwner: string;
    /** Effect class the capability performs. */
    effectClass: EffectClass;
    /** Whether the capability requires explicit human approval. */
    requiresApproval: boolean;
    /**
     * Whether the module owner MUST verify the invocation result before it
     * can count toward Mission completion. Missing mandatory owner
     * verification is never implicit success.
     */
    requiresOwnerVerification: boolean;
    /** Allowed prefixes for input references (schema-ish, deterministic). */
    allowedInputRefPrefixes: string[];
    /**
     * Whether the capability legitimately touches storage/database of its
     * OWN module. Cross-module private storage is always denied.
     */
    ownsStorage: boolean;
    /**
     * Owner guarantee that every row this capability produces is a fact
     * (declared ≠ implemented — the compiler still sanitizes and stamps
     * provenance; this only licenses unclassified rows as FACT).
     */
    factRowsOnly?: boolean;
}
