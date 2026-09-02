/**
 * 🔌 Mission Ports (Issue #62)
 *
 * Provider/persona-independent interfaces for the Mission subsystem.
 * Everything is injectable/pluggable — no real API calls, no secrets.
 */

import type {
    CapabilityContract,
    CapabilityInvocation,
    CapabilityInvocationRef,
    CriterionVerification,
    Mission,
    MissionState,
    OwnerVerification,
    PlanCandidate,
    PlanRevision,
    PlanRevisionStatus,
} from "./contracts.js";

/** ------------------------------------------------------------------ */
/**  MissionStore — durability for Missions and their plan revisions.   */
/** ------------------------------------------------------------------ */
export interface MissionStore {
    initialize(): Promise<void>;
    close(): Promise<void>;

    /**
     * Execute a function inside a single database transaction. If `fn`
     * throws, every write it performed is rolled back atomically.
     * Used to keep multi-record transitions (mission + invocation,
     * plan-revision supersede/accept + current pointer) consistent.
     */
    withTransaction<T>(fn: () => Promise<T>): Promise<T>;

    // Mission CRUD
    createMission(mission: Mission): Promise<Mission>;
    getMission(missionId: string): Promise<Mission | null>;
    updateMission(missionId: string, updates: Partial<Mission>): Promise<void>;
    listMissions(filter?: { state?: MissionState }): Promise<Mission[]>;
    deleteMission(missionId: string): Promise<void>;

    // Plan revisions
    savePlanRevision(revision: PlanRevision): Promise<PlanRevision>;
    getPlanRevision(revisionId: string): Promise<PlanRevision | null>;
    getPlanRevisions(missionId: string): Promise<PlanRevision[]>;
    updatePlanRevisionStatus(
        revisionId: string,
        status: PlanRevisionStatus,
        reason?: string,
    ): Promise<void>;

    // Full invocation durability is authoritative in mission_invocations.
    // Mission.invocationRefs remains the separate minimal projection.
    saveInvocation(invocation: CapabilityInvocation | CapabilityInvocationRef): Promise<CapabilityInvocationRef>;
    getInvocation(invocationId: string): Promise<CapabilityInvocation | null>;
    listInvocations(missionId: string): Promise<CapabilityInvocation[]>;
    updateInvocation(
        invocationId: string,
        updates: Partial<CapabilityInvocation> | Partial<CapabilityInvocationRef>,
    ): Promise<void>;

    /** Full-entity recovery queries over the authoritative invocation table. */
    listRecoverableInvocations(limit: number): Promise<CapabilityInvocation[]>;
    /** All invocations that have not reached an immutable terminal state. */
    listNonTerminalInvocations(limit: number): Promise<CapabilityInvocation[]>;
    /** Due invocations ordered by eligibility, bounded by the caller. */
    listDueInvocations(now: string, limit: number): Promise<CapabilityInvocation[]>;
    /** Preserve completed effects across plan revisions and duplicate requests. */
    findInvocationByEffectFingerprint(effectFingerprint: string): Promise<CapabilityInvocation | null>;
}

/** ------------------------------------------------------------------ */
/**  PlannerPort — advisory proposal generator.                        */
/** ------------------------------------------------------------------ */
export interface PlannerPort {
    /**
     * Given a Mission and optional context, propose a PlanCandidate.
     * The planner is advisory — it does NOT confer authority.
     * Implementation may be an LLM, a deterministic algorithm, or a fake.
     */
    proposePlan(mission: Mission, context?: unknown): Promise<PlanCandidate>;

    /**
     * Given a Mission and a rejection reason, produce a revised proposal.
     * The planner does NOT bypass policy — the revised candidate will
     * be validated again.
     */
    replan(
        mission: Mission,
        previousRejection: string,
        context?: unknown,
    ): Promise<PlanCandidate>;
}

/** ------------------------------------------------------------------ */
/**  CapabilityResolver — resolves capability ids to contracts.        */
/** ------------------------------------------------------------------ */
export interface CapabilityResolver {
    /**
     * Resolve a capability id to its declared contract.
     * Returns null when the capability is not found/registered.
     * Discovery does not equal authorization.
     */
    resolve(capabilityId: string): Promise<CapabilityContract | null>;

    /**
     * List all registered capability ids (for validation purposes).
     */
    listRegistered(): Promise<string[]>;
}

/** ------------------------------------------------------------------ */
/**  MissionVerifier — mission-level verification                       */
/** ------------------------------------------------------------------ */
export interface MissionVerifier {
    /**
     * Verify whether the Mission's acceptance criteria are satisfied
     * given the current evidence. This is executive-level verification
     * and MUST NOT override negative module-owner verification.
     */
    verify(mission: Mission): Promise<{
        satisfied: boolean;
        ownerBlocked: boolean;
        reasons: string[];
    }>;
}

/** ------------------------------------------------------------------ */
/**  VerificationAuthority — attestation boundary for lower-layer verdicts */
/** ------------------------------------------------------------------ */
/**
 * Injectable authority that attests module-owner verification and criterion
 * verification. Matching identity fields are NOT provenance: the caller
 * cannot make an owner verdict sovereign by filling in the right strings.
 * The default authority FAILS CLOSED (rejects everything) until a real
 * authority (or a deterministic fake in tests) is injected. #63/#66 will
 * provide the real implementation.
 */
export interface VerificationAuthority {
    /**
     * Attest that a module owner verified an invocation. The submitted
     * OwnerVerification is a claim; the returned value is the attested
     * verdict (or throws, fail-closed).
     */
    attestOwnerVerification(
        submitted: OwnerVerification,
        invocation: CapabilityInvocationRef,
        contract: CapabilityContract,
    ): Promise<OwnerVerification>;

    /**
     * Attest that an acceptance criterion was satisfied by a trusted source.
     * `satisfied`/`source` are claims, not authority; the authority decides
     * whether the criterion verdict is valid.
     */
    attestCriterionVerification(
        submitted: {
            criterionId: string;
            satisfied: boolean;
            source: string;
            evidenceRefId?: string;
        },
        mission: Mission,
    ): Promise<CriterionVerification>;
}

/** ------------------------------------------------------------------ */
/**  Shared services (injectable for determinism).                      */
/** ------------------------------------------------------------------ */
export interface ClockService {
    now(): Date;
    isoNow(): string;
}

export interface IdGenerator {
    generate(): string;
}
