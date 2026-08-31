/**
 * 🧪 Mission Test Helpers (Issue #62)
 *
 * Injectable fakes for deterministic, provider-free testing of the
 * Mission contract, policy, and engine.
 *
 * These are NOT shipped to production — they exist only in the test
 * module. Importing them in production code is a lint error.
 *
 * @module test-only
 */

import type {
    CapabilityContract,
    CapabilityInvocationRef,
    CriterionVerification,
    Mission,
    OwnerVerification,
    PlanCandidate,
    PlanStep,
} from "./contracts.js";
import { EffectClass } from "./contracts.js";
import type {
    CapabilityResolver,
    ClockService,
    IdGenerator,
    PlannerPort,
    VerificationAuthority,
} from "./ports.js";

/** ------------------------------------------------------------------ */
/**  FakeCapabilityResolver — in-memory capability catalog.             */
/** ------------------------------------------------------------------ */
export class FakeCapabilityResolver implements CapabilityResolver {
    private readonly contracts: Map<string, CapabilityContract> = new Map();

    /** Register a capability contract. */
    register(contract: CapabilityContract): void {
        this.contracts.set(contract.capabilityId, contract);
    }

    /** Register multiple. */
    registerMany(contracts: CapabilityContract[]): void {
        for (const c of contracts) {
            this.contracts.set(c.capabilityId, c);
        }
    }

    /** Remove a capability (simulates it becoming unavailable). */
    unregister(capabilityId: string): void {
        this.contracts.delete(capabilityId);
    }

    async resolve(capabilityId: string): Promise<CapabilityContract | null> {
        return this.contracts.get(capabilityId) ?? null;
    }

    async listRegistered(): Promise<string[]> {
        return [...this.contracts.keys()];
    }
}

/** ------------------------------------------------------------------ */
/**  FakePlannerPort — returns a pre-set PlanCandidate.                */
/** ------------------------------------------------------------------ */
export class FakePlannerPort implements PlannerPort {
    private candidate: PlanCandidate = {
        planId: "fake-plan-1",
        missionId: "mission-1",
        plannerNote: "Fake planner proposal",
        steps: [],
    };
    private rejectOnPropose: string | null = null;

    /** Set the candidate the planner returns. */
    setCandidate(candidate: PlanCandidate): void {
        this.candidate = candidate;
    }

    /** Set steps for the current candidate. */
    setSteps(steps: PlanStep[]): void {
        this.candidate.steps = steps;
    }

    /** Make `proposePlan` throw (simulates planner error). */
    setRejectOnPropose(reason: string): void {
        this.rejectOnPropose = reason;
    }

    clearReject(): void {
        this.rejectOnPropose = null;
    }

    async proposePlan(_mission: Mission, _context?: unknown): Promise<PlanCandidate> {
        if (this.rejectOnPropose) {
            throw new Error(this.rejectOnPropose);
        }
        return { ...this.candidate, missionId: _mission.missionId };
    }

    async replan(
        _mission: Mission,
        _previousRejection: string,
        _context?: unknown,
    ): Promise<PlanCandidate> {
        if (this.rejectOnPropose) {
            throw new Error(this.rejectOnPropose);
        }
        return { ...this.candidate, missionId: _mission.missionId };
    }
}

/** ------------------------------------------------------------------ */
/**  FakeClock — deterministic time.                                   */
/** ------------------------------------------------------------------ */
export class FakeClock implements ClockService {
    private currentDate: Date;

    constructor(isoString: string = "2026-08-30T12:00:00.000Z") {
        this.currentDate = new Date(isoString);
    }

    /** Advance by a fixed number of milliseconds. */
    advance(ms: number): void {
        this.currentDate = new Date(this.currentDate.getTime() + ms);
    }

    setTime(isoString: string): void {
        this.currentDate = new Date(isoString);
    }

    now(): Date {
        return new Date(this.currentDate);
    }

    isoNow(): string {
        return this.currentDate.toISOString();
    }
}

/** ------------------------------------------------------------------ */
/**  FakeIdGenerator — deterministic sequential IDs.                    */
/** ------------------------------------------------------------------ */
export class FakeIdGenerator implements IdGenerator {
    private counter = 0;
    private readonly prefix: string;

    constructor(prefix: string = "test-id") {
        this.prefix = prefix;
    }

    generate(): string {
        this.counter++;
        return `${this.prefix}-${this.counter}`;
    }

    reset(): void {
        this.counter = 0;
    }
}

/** ------------------------------------------------------------------ */
/**  Convenience: build the default capability catalog for tests.      */
/** ------------------------------------------------------------------ */

export function makeDefaultCapabilityCatalog(): CapabilityContract[] {
    return [
        {
            capabilityId: "runstead.code-review",
            moduleOwner: "runstead",
            effectClass: EffectClass.EXECUTION,
            requiresApproval: false,
            requiresOwnerVerification: true,
            allowedInputRefPrefixes: ["refs/runstead/"],
            ownsStorage: false,
        },
        {
            capabilityId: "runstead.implement",
            moduleOwner: "runstead",
            effectClass: EffectClass.EXECUTION,
            requiresApproval: false,
            requiresOwnerVerification: true,
            allowedInputRefPrefixes: ["refs/runstead/"],
            ownsStorage: false,
        },
        {
            capabilityId: "lifeos.query",
            moduleOwner: "lifeos",
            effectClass: EffectClass.READ,
            requiresApproval: false,
            requiresOwnerVerification: false,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            ownsStorage: true,
        },
        {
            capabilityId: "lifeos.write",
            moduleOwner: "lifeos",
            effectClass: EffectClass.WRITE,
            requiresApproval: true,
            requiresOwnerVerification: true,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            ownsStorage: true,
        },
        {
            capabilityId: "tecer.health-check",
            moduleOwner: "tecer",
            effectClass: EffectClass.READ,
            requiresApproval: false,
            requiresOwnerVerification: true,
            allowedInputRefPrefixes: ["refs/tecer/"],
            ownsStorage: true,
        },
        {
            capabilityId: "runstead.deploy",
            moduleOwner: "runstead",
            effectClass: EffectClass.NETWORK,
            requiresApproval: true,
            requiresOwnerVerification: true,
            allowedInputRefPrefixes: ["refs/runstead/"],
            ownsStorage: false,
        },
        {
            capabilityId: "storage.read-local",
            moduleOwner: "ouroboros",
            effectClass: EffectClass.STORAGE_ACCESS,
            requiresApproval: true,
            requiresOwnerVerification: true,
            allowedInputRefPrefixes: ["refs/ouroboros/", "storage://ouroboros/"],
            ownsStorage: true,
        },
    ];
}
/** ------------------------------------------------------------------ */
/**  FakeVerificationAuthority — deterministic attestation for tests.  */
/** ------------------------------------------------------------------ */
/**
 * Test authority that attests owner and criterion verdicts with explicit
 * identity/provenance checks AND an explicit attestation registry.
 *
 *  - Owner verification: invocationId must match the invocation and owner
 *    must match the capability's module owner; the attested verdict carries
 *    a deterministic attestation marker.
 *  - Criterion verification: the criterion MUST be explicitly registered
 *    for this authority (`registerCriterionAttestation(missionId,
 *    criterionId, source)`). An owner having some positive invocation is
 *    NOT enough to attest arbitrary criteria — the authority only emits
 *    the verdicts it is explicitly authorized to emit.
 */
export class FakeVerificationAuthority implements VerificationAuthority {
    private counter = 0;
    /** Explicit registry: `missionId|criterionId|source` -> true. */
    private readonly criterionAttestations = new Map<string, boolean>();

    /** Register a criterion attestation the authority is authorized to emit. */
    registerCriterionAttestation(missionId: string, criterionId: string, source: string): void {
        this.criterionAttestations.set(`${missionId}|${criterionId}|${source}`, true);
    }

    async attestOwnerVerification(
        submitted: OwnerVerification,
        invocation: CapabilityInvocationRef,
        contract: CapabilityContract,
    ): Promise<OwnerVerification> {
        if (submitted.invocationId !== invocation.invocationId) {
            throw new Error(
                `OwnerVerification.invocationId "${submitted.invocationId}" does not match invocation "${invocation.invocationId}"`,
            );
        }
        if (submitted.owner !== contract.moduleOwner) {
            throw new Error(
                `OwnerVerification.owner "${submitted.owner}" does not match module owner "${contract.moduleOwner}" for capability "${invocation.capabilityId}"`,
            );
        }
        this.counter++;
        return {
            ...submitted,
            // Deterministic attestation marker: the verdict was attested by
            // the authority, not merely submitted with matching strings.
            reason: `[attested:${this.counter}] ${submitted.reason ?? ""}`.trim(),
        };
    }

    async attestCriterionVerification(
        submitted: {
            criterionId: string;
            satisfied: boolean;
            source: string;
            evidenceRefId?: string;
        },
        mission: Mission,
    ): Promise<CriterionVerification> {
        if (!mission.acceptanceCriteria.includes(submitted.criterionId)) {
            throw new Error(
                `Criterion "${submitted.criterionId}" is not one of the Mission acceptance criteria`,
            );
        }
        // The authority must be EXPLICITLY authorized to emit this specific
        // (mission, criterion, source) verdict. An owner having some positive
        // invocation is not enough to attest arbitrary criteria.
        const key = `${mission.missionId}|${submitted.criterionId}|${submitted.source}`;
        if (!this.criterionAttestations.get(key)) {
            throw new Error(
                `No attestation registered for criterion "${submitted.criterionId}" by source "${submitted.source}" on mission ${mission.missionId}`,
            );
        }
        if (submitted.satisfied) {
            const trustedOwners = new Set(
                mission.invocationRefs
                    .filter((inv) => inv.ownerVerification?.verified === true)
                    .map((inv) => inv.ownerVerification!.owner),
            );
            if (!trustedOwners.has(submitted.source)) {
                throw new Error(
                    `CriterionVerification source "${submitted.source}" is not a positively verified module owner of this Mission`,
                );
            }
        }
        if (submitted.evidenceRefId !== undefined) {
            const evidenceExists = mission.evidenceRefs.some(
                (ref) => ref.refId === submitted.evidenceRefId,
            );
            if (!evidenceExists) {
                throw new Error(
                    `CriterionVerification references unknown evidence ref "${submitted.evidenceRefId}"`,
                );
            }
        }
        this.counter++;
        return {
            criterionId: submitted.criterionId,
            satisfied: submitted.satisfied,
            source: submitted.source,
            evidenceRefId: submitted.evidenceRefId,
            verifiedAt: `attested:${this.counter}`,
        };
    }
}
