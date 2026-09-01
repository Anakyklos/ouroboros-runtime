/**
 * 🎯🔌 THE ONE SEAM (PR #73 review round 2: blockers 1-5, 7)
 *
 * Deterministic dispatch: an authorized invocation goes to the CONNECTOR
 * REGISTERED for the capability — never to a look-alike, never to a
 * re-implemented copy, never to whatever happens to answer first.
 *
 * Gating order (fail-closed at every step):
 *   PRE-MINT (nothing is created, no effect is possible, the step keeps
 *   its single dispatch):
 *     1. connector presence + identity (from declarations, zero calls);
 *     2. availability gate — registry data, not connector testimony; a
 *        transient state (busy/waiting/needs_user_action/degraded…) does
 *        NOT consume the step's one dispatch and is not recorded as a
 *        durable failure;
 *     3. split-brain guard — the contract the #62 policy resolver sees is
 *        compared (fail-closed) to the authorization projection of the
 *        descriptor that selects the connector; divergence rejects before
 *        any minting;
 *     4. version gate + describe() conformance (blocker 4 of round 1).
 *   MINT + EFFECT:
 *     5. engine.dispatchStep() — the ONLY invocation-minting authority
 *        (authorization, revalidation, approvals, replay protection);
 *     6. ConnectorRequest is validated against the descriptor's
 *        declarative inputSchema BEFORE invoke();
 *     7. invoke() — the only effectful connector call;
 *   POST-EFFECT (the effect may or may not have happened; the seam never
 *   invents terminality or attributability):
 *     8. CapabilityResult is validated against resultSchema on the RAW
 *        value BEFORE any property access (the contract is transport-
 *        agnostic; a hostile adapter returning null/primitive/missing
 *        fields must never cause a raw TypeError) — a malformed result is
 *        never consumed nor recorded as completed;
 *     9. evidence items are structurally re-gated by a runtime-controlled
 *        guard BEFORE any dereference (round 4, blocker 1) — and the
 *        ownerVerification outcome, when PRESENT, is structurally gated
 *        before any verdict consumption (round 5) — both independent of
 *        the descriptor's own schema, so a weaker descriptor cannot
 *        reintroduce a post-handoff TypeError or let a truthy-but-shapeless
 *        verdict decide whether mandatory verification exists;
 *    10. requestId echo must match (reconciliation key) — otherwise the
 *        invocation is UNCERTAIN, never "failed";
 *    11. ownerVerification verdicts: verified:false is FAILED (never
 *        success); verified:null is PENDING (never an artificial
 *        negative); missing mandatory verification blocks; authority
 *        refusal to attest degrades to BLOCKED with no verdict — and for
 *        a capability that REQUIRES owner verification, a refused
 *        POSITIVE attestation is also BLOCKED, never COMPLETED (round 4,
 *        blocker 2) — nothing persists an unattested claim or a stale
 *        DISPATCHED state;
 *    12. recordInvocationResult() — the engine's single atomic write path,
 *        with a status mapping that preserves non-terminality:
 *        COMPLETED→COMPLETED, FAILED→FAILED, STILL_RUNNING→RUNNING,
 *        UNKNOWN→BLOCKED. An invoke() exception is recorded as uncertain
 *        (BLOCKED), never as a definitive failure that would authorize
 *        blind replay; reconciliation/retry policy belongs to #50.
 */

import { MissionEngine } from "../mission/mission-engine.js";
import {
    InvocationStatus,
    type CapabilityInvocationRef,
    type OwnerVerification,
} from "../mission/contracts.js";
import type { CapabilityAvailability } from "./contracts.js";
import {
    assertConnectorMatchesDescriptor,
    authorizationProjection,
    type CapabilityRegistry,
} from "./registry.js";
import {
    CapabilityResultStatus,
    type CapabilityConnector,
    type CapabilityResult,
    type ConnectorRequest,
} from "./connector.js";
import { evaluateDeclarativeSchema, isDeclarativeSchema } from "./contracts.js";
import { sanitizeText } from "../mission/sanitize.js";
import type { ClockService } from "../mission/ports.js";

/**
 * Re-export so mission-side callers and tests import the seam and the
 * version gate from one place.
 */
export { assertConnectorMatchesDescriptor };

/** Thrown when dispatch cannot happen safely. Always before any invoke(). */
export class DispatchSeamError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DispatchSeamError";
    }
}

/** Thrown when no connector is registered for the capability. */
export class ConnectorNotRegisteredError extends DispatchSeamError {
    readonly capabilityId: string;
    constructor(capabilityId: string) {
        super(
            `No connector registered for capability "${capabilityId}"; dispatch fails closed (discovery is not authorization)`,
        );
        this.name = "ConnectorNotRegisteredError";
        this.capabilityId = capabilityId;
    }
}

/** Thrown when a connector is registered but its declared id is different. */
export class ConnectorIdentityMismatchError extends DispatchSeamError {
    readonly capabilityId: string;
    readonly declaredId: string;
    constructor(capabilityId: string, declaredId: string) {
        super(
            `Connector identity mismatch: dispatch target "${capabilityId}" but connector declares "${declaredId}"; a look-alike connector never receives invocations`,
        );
        this.name = "ConnectorIdentityMismatchError";
        this.capabilityId = capabilityId;
        this.declaredId = declaredId;
    }
}

/**
 * Thrown when the capability is registered but not currently dispatchable
 * (availability != AVAILABLE). No invocation is minted; the step's single
 * dispatch is NOT consumed, so the same step can be dispatched once the
 * capability returns to available. The state is carried so callers can
 * decide to wait (busy/waiting_dependency) or escalate
 * (needs_user_action/configuration_error) without string parsing.
 */
export class CapabilityUnavailableError extends DispatchSeamError {
    readonly capabilityId: string;
    readonly availability: CapabilityAvailability;
    readonly detail?: string;
    constructor(capabilityId: string, availability: CapabilityAvailability, detail?: string) {
        super(
            `Capability "${capabilityId}" is not dispatchable: availability is "${availability}"` +
                (detail ? ` (${detail})` : "") +
                `; no invocation was minted and the step keeps its dispatch`,
        );
        this.name = "CapabilityUnavailableError";
        this.capabilityId = capabilityId;
        this.availability = availability;
        this.detail = detail;
    }
}

/**
 * Thrown (pre-mint) when the contract the policy resolver sees differs
 * from the authorization projection of the descriptor that selects the
 * connector. Policy and dispatch must never operate on different catalogs.
 */
export class PolicyContractMismatchError extends DispatchSeamError {
    readonly capabilityId: string;
    readonly differences: string[];
    constructor(capabilityId: string, differences: string[]) {
        super(
            `Split-brain authority rejected for "${capabilityId}": policy resolver contract differs from the registry descriptor ` +
                `(differences: ${differences.join(", ")}); zero connector calls were made`,
        );
        this.name = "PolicyContractMismatchError";
        this.capabilityId = capabilityId;
        this.differences = differences;
    }
}

/** Thrown when ConnectorRequest violates the descriptor's inputSchema. */
export class ConnectorInputSchemaError extends DispatchSeamError {
    readonly capabilityId: string;
    readonly errors: string[];
    constructor(capabilityId: string, errors: string[]) {
        super(
            `ConnectorRequest rejected by inputSchema for "${capabilityId}": ${errors.join("; ")}`,
        );
        this.name = "ConnectorInputSchemaError";
        this.capabilityId = capabilityId;
        this.errors = errors;
    }
}

/** Thrown when CapabilityResult violates the descriptor's resultSchema. */
export class ConnectorResultSchemaError extends DispatchSeamError {
    readonly capabilityId: string;
    readonly errors: string[];
    constructor(capabilityId: string, errors: string[]) {
        super(
            `CapabilityResult rejected by resultSchema for "${capabilityId}": ${errors.join("; ")}`,
        );
        this.name = "ConnectorResultSchemaError";
        this.capabilityId = capabilityId;
        this.errors = errors;
    }
}

/**
 * Honest status mapping: the seam NEVER invents terminality.
 * STILL_RUNNING stays non-terminal (RUNNING); UNKNOWN stays uncertain
 * (BLOCKED); only the connector's own COMPLETED/FAILED become terminal.
 */
export function invocationStatusFor(result: CapabilityResult): InvocationStatus {
    switch (result.status) {
        case CapabilityResultStatus.COMPLETED:
            return InvocationStatus.COMPLETED;
        case CapabilityResultStatus.FAILED:
            return InvocationStatus.FAILED;
        case CapabilityResultStatus.STILL_RUNNING:
            return InvocationStatus.RUNNING;
        case CapabilityResultStatus.UNKNOWN:
        default:
            return InvocationStatus.BLOCKED;
    }
}

function isTerminalInvocationStatus(status: InvocationStatus): boolean {
    return (
        status === InvocationStatus.COMPLETED ||
        status === InvocationStatus.FAILED ||
        status === InvocationStatus.CANCELLED
    );
}

/** Result of a successful seam dispatch. */
export interface SeamDispatchOutcome {
    /** The invocation the engine minted (engine is the only id authority). */
    invocation: CapabilityInvocationRef;
    /** The typed result the ONE authorized connector produced. */
    result: CapabilityResult;
    /** The status actually recorded by the engine (honest mapping). */
    recordedStatus: InvocationStatus;
}

/**
 * The narrow, deterministic dispatch seam.
 *
 * Every rejection BEFORE invoke() leaves the step's single dispatch
 * unconsumed (no invocation is minted); every uncertainty AFTER invoke()
 * is preserved (never rewritten into success/failure without evidence).
 */
export class ConnectorDispatchSeam {
    private readonly connectors = new Map<string, CapabilityConnector>();

    constructor(
        private readonly engine: MissionEngine,
        private readonly registry: CapabilityRegistry,
        /** Injectable clock: determinism in tests, system time otherwise. */
        private readonly clock?: ClockService,
    ) {}

    private isoNow(): string {
        return this.clock ? this.clock.isoNow() : new Date().toISOString();
    }

    /**
     * Register the ONLY connector allowed to serve `capabilityId`.
     * Re-registration under the same id is a hard error: no silent
     * connector swaps. Contract/owner identity lives in the registry and
     * is immutable within a registration lifetime.
     */
    registerConnector(capabilityId: string, connector: CapabilityConnector): void {
        const existing = this.connectors.get(capabilityId);
        if (existing) {
            throw new DispatchSeamError(
                `Capability "${capabilityId}" already has a registered connector; silent connector swaps are forbidden`,
            );
        }
        if (connector.capabilityId !== capabilityId) {
            throw new ConnectorIdentityMismatchError(capabilityId, connector.capabilityId);
        }
        this.connectors.set(capabilityId, connector);
    }

    /** True when a connector is registered for the id (not an auth grant). */
    hasConnector(capabilityId: string): boolean {
        return this.connectors.has(capabilityId);
    }

    /**
     * Dispatch ONE step through the seam. Either the ONE registered,
     * identity-verified, availability-gated, split-brain-checked,
     * version-gated connector is invoked, or nothing is.
     */
    async dispatchThroughSeam(missionId: string, stepId: string): Promise<SeamDispatchOutcome> {
        // ── Pre-mint resolution (data-only; zero connector calls so far) ──
        const capabilityId = await this.capabilityIdFor(missionId, stepId);
        const descriptor = this.registry.requireDescriptor(capabilityId);

        // (1) Connector presence + identity, from declarations only.
        const connector = this.connectors.get(capabilityId);
        if (!connector) {
            throw new ConnectorNotRegisteredError(capabilityId);
        }
        if (connector.capabilityId !== capabilityId) {
            throw new ConnectorIdentityMismatchError(capabilityId, connector.capabilityId);
        }

        // (2) Availability gate: registry data, not testimony. Transient
        // states do NOT consume the step's single dispatch (no minting).
        if (descriptor.availability !== "available") {
            throw new CapabilityUnavailableError(
                capabilityId,
                descriptor.availability,
                descriptor.availabilityDetail,
            );
        }

        // (3) Split-brain guard: the policy resolver's contract for this id
        // must equal the registry's authorization projection of the
        // descriptor that selects the connector. Fail closed on divergence.
        const policyContract = await this.engine.getResolvedContract(capabilityId);
        if (!policyContract) {
            throw new PolicyContractMismatchError(capabilityId, [
                "capability unknown to the policy resolver",
            ]);
        }
        const projection = authorizationProjection(descriptor);
        const differences = compareContracts(policyContract, projection);
        if (differences.length > 0) {
            throw new PolicyContractMismatchError(capabilityId, differences);
        }

        // (4) Version gate + describe() conformance (zero calls before the
        // version check; describe() must match the registered descriptor).
        assertConnectorMatchesDescriptor(connector, descriptor);

        // ── Mint (engine-only authority; single dispatch is spent here) ──
        const invocation = await this.engine.dispatchStep(missionId, stepId);

        // (6) Input schema enforcement BEFORE invoke().
        const request: ConnectorRequest = {
            requestId: invocation.invocationId,
            inputRefs: await this.stepInputRefs(invocation),
            desiredOutcome: await this.stepDesiredOutcome(invocation),
        };
        const inputSchema = descriptor.inputSchema;
        if (!isDeclarativeSchema(inputSchema)) {
            await this.recordUncertain(invocation, "descriptor inputSchema is not declarative; refusing to invoke");
            throw new DispatchSeamError(
                `descriptor inputSchema for "${capabilityId}" is not a declarative schema; dispatch fails closed`,
            );
        }
        const inputCheck = evaluateDeclarativeSchema(inputSchema, request);
        if (!inputCheck.valid) {
            // Integration bug (deterministic, no effect happened): durable
            // failure with evidence, zero connector calls.
            await this.recordFailure(
                invocation,
                `ConnectorRequest violates the capability inputSchema: ${inputCheck.errors.join("; ")}`,
            );
            throw new ConnectorInputSchemaError(capabilityId, inputCheck.errors);
        }

        // (7) The authorized handoff — the ONLY effectful connector call.
        // rawResult is kept untouched: the schema gate below must run on the
        // RAW value BEFORE the seam dereferences anything (hostile adapter
        // may return null/primitive; property access on it must never
        // produce a raw TypeError that bypasses fail-closed handling).
        let rawResult: unknown;
        try {
            rawResult = await connector.invoke(request);
        } catch (error) {
            // The effect MAY have happened (request may have been sent
            // before the exception). The seam never asserts a definitive
            // outcome without evidence: record UNCERTAIN, never FAILED.
            const raw = error instanceof Error ? error.message : String(error);
            await this.recordUncertain(
                invocation,
                `connector invoke threw after handoff (outcome uncertain, reconciliation required per descriptor semantics): ${sanitizeText(raw)}`,
            );
            throw new DispatchSeamError(
                `invoke() of capability "${capabilityId}" threw; invocation "${invocation.invocationId}" left in an uncertain (blocked) state: ${sanitizeText(raw)}`,
            );
        }

        // (8) Result schema enforcement BEFORE consuming anything. The
        // connector contract is transport-agnostic and the runtime cannot
        // assume an external adapter respected the TS types: a hostile or
        // broken adapter may return null, a primitive, or a structurally
        // invalid object. The schema gate on the RAW value must run before
        // any property access, so no TypeError can bypass fail-closed
        // handling and strand the invocation unreconciled.
        const resultSchema = descriptor.resultSchema;
        if (!isDeclarativeSchema(resultSchema)) {
            await this.recordUncertain(invocation, "descriptor resultSchema is not declarative; result not consumed");
            throw new DispatchSeamError(
                `descriptor resultSchema for "${capabilityId}" is not a declarative schema; dispatch fails closed`,
            );
        }
        const resultCheck = evaluateDeclarativeSchema(resultSchema, rawResult);
        if (!resultCheck.valid) {
            // Effect already happened; a malformed result must never be
            // recorded as completed. Uncertain, reconciliation territory.
            await this.recordUncertain(
                invocation,
                `CapabilityResult violates the capability resultSchema (effect outcome uncertain): ${resultCheck.errors.join("; ")}`,
            );
            throw new ConnectorResultSchemaError(capabilityId, resultCheck.errors);
        }

        // Schema gate passed: the raw value is structurally a CapabilityResult.
        // `let` (round 5): when a supplementary verdict is structurally
        // malformed for a NON-verifying capability, the seam discards it —
        // the honest status then flows without the unusable verdict.
        let result = rawResult as CapabilityResult;

        // (9) Evidence items are structurally re-gated before ANY dereference
        // (round 4, blocker 1). The default resultSchema now constrains the
        // items, but a descriptor that ships a weaker schema must not be able
        // to reintroduce a post-handoff TypeError: this runtime-controlled
        // guard is independent of the descriptor's own schema and defends
        // exactly the fields evidenceRefsOf() consumes (owner, externalRef,
        // label). A malformed item means the result cannot be consumed —
        // the effect may have happened, so the state is UNCERTAIN (BLOCKED,
        // non-terminal), never COMPLETED, never a raw TypeError.
        const evidenceProblem = this.guardEvidenceItems(result.evidence);
        if (evidenceProblem) {
            await this.recordUncertain(
                invocation,
                `connector returned malformed evidence items that cannot be consumed: ${evidenceProblem}`,
            );
            throw new DispatchSeamError(
                `connector result evidence for capability "${capabilityId}" violates the EvidenceReference contract: ${evidenceProblem}`,
            );
        }

        // (9b) ownerVerification is structurally re-gated BEFORE any verdict
        // consumption (round 5). Runtime-controlled guard, independent of the
        // descriptor's own schema: `verified === false`, `verified === null`,
        // `verified === true` and `!result.ownerVerification` are all
        // truthiness/shape-sensitive — a hostile truthy-but-shapeless value
        // ({}, [], "yes", { verified: "true" }, missing owner, reason: 42)
        // must NEVER decide whether mandatory verification exists.
        if (result.ownerVerification !== undefined) {
            const verificationProblem = this.guardOwnerVerificationOutcome(
                result.ownerVerification,
            );
            if (verificationProblem) {
                if (descriptor.requiresOwnerVerification) {
                    // For a capability that REQUIRES owner verification a
                    // malformed verdict is missing valid provenance — the
                    // effect may have happened, so the invocation is UNCERTAIN
                    // (BLOCKED, non-terminal): no completedAt, no verdict
                    // persisted, never COMPLETED, never a fabricated FAILED.
                    await this.recordUncertain(
                        invocation,
                        `capability requires owner verification but the connector returned a structurally malformed verdict (${verificationProblem}); outcome uncertain pending reconciliation`,
                    );
                    throw new DispatchSeamError(
                        `owner verification outcome for capability "${capabilityId}" violates the OwnerVerificationOutcome contract: ${verificationProblem}`,
                    );
                }
                // Capability does NOT require owner verification: the verdict
                // is supplementary there. No runtime crash, no fabricated
                // data: the malformed verdict is DISCARDED (never treated as
                // authority, never persisted) and the honest connector status
                // flows without it.
                result = { ...result, ownerVerification: undefined };
            }
        }

        // (10) requestId echo: the reconciliation key. A connector that
        // returns a result under a different key leaves OUR invocation
        // unattributable → UNCERTAIN, never "failed".
        if (result.requestId !== invocation.invocationId) {
            await this.recordUncertain(
                invocation,
                `connector returned result for requestId "${result.requestId}" while dispatching invocation "${invocation.invocationId}"; result is unattributable and the outcome is uncertain`,
            );
            throw new DispatchSeamError(
                `connector requestId echo mismatch: expected "${invocation.invocationId}", got "${result.requestId}"`,
            );
        }

        // (11) Owner verification verdicts are evidence, not decoration.
        // The connector contract types `verified: boolean | null` where
        // null means unknown/pending. Only `verified === false` is a
        // NEGATIVE verdict; `null` is NEVER rewritten into one (no
        // artificial negative), and a capability that requires owner
        // verification can never complete while its verdict is pending or
        // unattested.
        if (result.ownerVerification && result.ownerVerification.verified === false) {
            // Evidence-backed negative verdict: the owner examined the
            // outcome and rejected it. The one post-effect state with a
            // definitive, evidenced answer: FAILED (never success). If the
            // authority refuses to attest the verdict (provenance/owner
            // mismatch), the state degrades to the conservative pending
            // form: BLOCKED, no verdict, no completion claim — never a
            // stale DISPATCHED invocation, never an unattested failure
            // claim, never success.
            try {
                await this.engine.recordInvocationResult(
                    invocation.invocationId,
                    {
                        invocationId: invocation.invocationId,
                        status: InvocationStatus.FAILED,
                        summary: `owner verification failed: ${sanitizeText(result.ownerVerification.reason || "owner reported the outcome as not verified")}`,
                        evidenceRefs: this.evidenceRefsOf(result),
                        completedAt: this.isoNow(),
                    },
                    this.ownerVerificationOf(invocation, result),
                );
                return { invocation, result, recordedStatus: InvocationStatus.FAILED };
            } catch {
                await this.recordUncertain(
                    invocation,
                    "owner verification was negative but the verification authority refused to attest it (provenance mismatch); invocation blocked pending a re-attested verdict",
                );
                return { invocation, result, recordedStatus: InvocationStatus.BLOCKED };
            }
        }

        // `verified: null` is an explicit PENDING verdict from the
        // connector: unknown — not negative, not positive. A capability
        // that requires owner verification blocks until an attested
        // verdict arrives; no completion is fabricated from an unknown.
        if (
            descriptor.requiresOwnerVerification &&
            result.ownerVerification &&
            result.ownerVerification.verified === null
        ) {
            await this.recordUncertain(
                invocation,
                "capability requires owner verification but the connector reported the verdict as pending (verified: null); invocation blocked pending an attested owner verdict",
            );
            return { invocation, result, recordedStatus: InvocationStatus.BLOCKED };
        }

        // Missing MANDATORY owner verification is never implicit success:
        // the invocation blocks until the owner verdict arrives (#50 can
        // drive reconciliation; no terminal claim is fabricated).
        if (descriptor.requiresOwnerVerification && !result.ownerVerification) {
            await this.recordUncertain(
                invocation,
                "capability requires owner verification but the connector result carried none; invocation blocked pending owner verdict",
            );
            return { invocation, result, recordedStatus: InvocationStatus.BLOCKED };
        }

        // (12) Engine-owned result recording (status + evidence, atomic).
        // A verdict is submitted to the engine's VerificationAuthority ONLY
        // when it is a positive claim (`verified === true`): negative
        // verdicts were handled above, and `null` pending verdicts are not
        // attestation material — they never become artificial negatives or
        // positives.
        const mapped = invocationStatusFor(result);
        const pendingVerdict =
            result.ownerVerification && result.ownerVerification.verified === true
                ? this.ownerVerificationOf(invocation, result)
                : undefined;
        try {
            await this.engine.recordInvocationResult(
                invocation.invocationId,
                {
                    invocationId: invocation.invocationId,
                    status: mapped,
                    summary: result.summary,
                    evidenceRefs: this.evidenceRefsOf(result),
                    completedAt: isTerminalInvocationStatus(mapped) ? this.isoNow() : undefined,
                },
                pendingVerdict,
            );
        } catch (error) {
            if (pendingVerdict) {
                // Authority refused to attest the positive verdict. The
                // verdict is never silently self-attested — and for a
                // capability that REQUIRES owner verification, a refused
                // attestation is missing provenance/authority: the honest
                // connector status is never promoted to a terminal claim
                // (round 4, blocker 2). Conservative pending form, exactly
                // like a refused negative verdict: BLOCKED, no verdict, no
                // completion claim — reconciliation territory.
                if (descriptor.requiresOwnerVerification) {
                    await this.recordUncertain(
                        invocation,
                        `capability requires owner verification but the verification authority refused to attest the positive verdict (provenance/authority mismatch): ${sanitizeText(
                            error instanceof Error ? error.message : String(error),
                        )}`,
                    );
                    return { invocation, result, recordedStatus: InvocationStatus.BLOCKED };
                }
                // Capability does NOT require owner verification: the
                // verdict is supplementary there, so keep the honest
                // connector status WITHOUT the unattested verdict.
                await this.engine.recordInvocationResult(invocation.invocationId, {
                    invocationId: invocation.invocationId,
                    status: mapped,
                    summary: `${result.summary} [owner verification unattested: ${sanitizeText(
                        error instanceof Error ? error.message : String(error),
                    )}]`,
                    evidenceRefs: this.evidenceRefsOf(result),
                    completedAt: isTerminalInvocationStatus(mapped) ? this.isoNow() : undefined,
                });
            } else {
                throw error;
            }
        }

        return { invocation, result, recordedStatus: mapped };
    }

    /** Deterministic evidence mapping (engine sanitizes on write). */
    private evidenceRefsOf(result: CapabilityResult) {
        return result.evidence.map((ref, index) => ({
            refId: `${result.requestId}:${index}`,
            owner: ref.owner,
            externalRef: ref.externalRef,
            label: ref.label,
        }));
    }

    /**
     * Runtime-controlled ownerVerification outcome guard (round 5).
     * Deterministic, data-only, independent of any descriptor schema: when a
     * verdict is PRESENT it must satisfy the full contract — `owner` a
     * non-empty string, `verified` exactly `boolean | null`, `reason` a
     * string — before the seam reads any of those fields. Returns a
     * sanitized problem description, or undefined when the outcome is
     * structurally valid. Never executes caller code.
     */
    private guardOwnerVerificationOutcome(outcome: unknown): string | undefined {
        if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
            return "ownerVerification is present but not an object";
        }
        const candidate = outcome as Record<string, unknown>;
        const owner = candidate["owner"];
        if (typeof owner !== "string" || owner.length === 0) {
            return "ownerVerification.owner must be a non-empty string";
        }
        const verified = candidate["verified"];
        if (typeof verified !== "boolean" && verified !== null) {
            return "ownerVerification.verified must be exactly true, false or null";
        }
        if (typeof candidate["reason"] !== "string") {
            return "ownerVerification.reason must be a string";
        }
        return undefined;
    }

    /**
     * Runtime-controlled evidence-item guard (round 4, blocker 1).
     * Deterministic, data-only, independent of any descriptor schema: it
     * defends exactly the fields `evidenceRefsOf()` dereferences. Returns a
     * sanitized problem description, or undefined when every item is a
     * structurally valid EvidenceReference. Never executes caller code.
     */
    private guardEvidenceItems(evidence: unknown): string | undefined {
        if (!Array.isArray(evidence)) return "evidence is not an array";
        for (const [index, item] of evidence.entries()) {
            if (item === null || typeof item !== "object" || Array.isArray(item)) {
                return `evidence[${index}] is not an object`;
            }
            const candidate = item as Record<string, unknown>;
            for (const field of ["owner", "externalRef", "label"] as const) {
                const value = candidate[field];
                if (typeof value !== "string" || value.length === 0) {
                    return `evidence[${index}].${field} must be a non-empty string`;
                }
            }
        }
        return undefined;
    }

    /** Typed OwnerVerification for the engine's attestation boundary. */
    private ownerVerificationOf(
        invocation: CapabilityInvocationRef,
        result: CapabilityResult,
    ): OwnerVerification {
        const outcome = result.ownerVerification!;
        return {
            invocationId: invocation.invocationId,
            // unknown (null) is NOT a positive verdict.
            verified: outcome.verified === true,
            reason: outcome.reason,
            owner: outcome.owner,
            verifiedAt: this.isoNow(),
        };
    }

    /**
     * Record UNCERTAIN state (post-effect doubt). Never terminal; never a
     * fabricated failure that would authorize blind replay.
     */
    private async recordUncertain(
        invocation: CapabilityInvocationRef,
        reason: string,
    ): Promise<void> {
        try {
            await this.engine.recordInvocationResult(invocation.invocationId, {
                invocationId: invocation.invocationId,
                status: InvocationStatus.BLOCKED,
                summary: `dispatch seam uncertainty — ${reason}`,
                evidenceRefs: [],
                completedAt: undefined,
            });
        } catch {
            // Intentional: the primary seam error must win.
        }
    }

    /** Record durable failure (pre-effect, evidence-backed causes only). */
    private async recordFailure(
        invocation: CapabilityInvocationRef,
        reason: string,
    ): Promise<void> {
        try {
            await this.engine.recordInvocationResult(invocation.invocationId, {
                invocationId: invocation.invocationId,
                status: InvocationStatus.FAILED,
                summary: `dispatch seam failure — ${reason}`,
                evidenceRefs: [],
                completedAt: this.isoNow(),
            });
        } catch {
            // Intentional: the primary seam error must win.
        }
    }

    /**
     * Resolve the capability id a step dispatches to BEFORE minting, so
     * pre-mint gates can run without consuming the single dispatch.
     */
    private async capabilityIdFor(missionId: string, stepId: string): Promise<string> {
        const revision = await this.currentRevisionFor(missionId, stepId);
        return revision.step.capabilityRequirement;
    }

    /**
     * Step data comes from the accepted plan revision (deterministic data,
     * no planner re-consultation).
     */
    private async currentRevisionFor(missionId: string, stepId: string) {
        const mission = await this.engine.getMission(missionId);
        if (!mission.currentPlanRevisionId) {
            throw new DispatchSeamError(
                `mission ${missionId} has no accepted plan revision; dispatch fails closed`,
            );
        }
        const revision = await this.engine.getPlanRevision(mission.currentPlanRevisionId);
        if (!revision) {
            throw new DispatchSeamError(
                `plan revision ${mission.currentPlanRevisionId} not found; dispatch fails closed`,
            );
        }
        const step = revision.steps.find((s) => s.stepId === stepId);
        if (!step) {
            throw new DispatchSeamError(
                `step "${stepId}" not found in the accepted plan revision; dispatch fails closed`,
            );
        }
        return { revision, step };
    }

    /** Step inputRefs come from the accepted plan revision. */
    private async stepInputRefs(invocation: CapabilityInvocationRef): Promise<string[]> {
        const { step } = await this.currentRevisionFor(invocation.missionId, invocation.stepId);
        return [...step.inputRefs];
    }

    /** Declarative desired outcome from the accepted plan revision. */
    private async stepDesiredOutcome(invocation: CapabilityInvocationRef): Promise<string> {
        const { step } = await this.currentRevisionFor(invocation.missionId, invocation.stepId);
        return step.desiredOutcome;
    }
}

/** Field-level comparison of authorization-relevant contract fields. */
function compareContracts(a: unknown, b: unknown): string[] {
    const differences: string[] = [];
    const recordA = a as Record<string, unknown>;
    const recordB = b as Record<string, unknown>;
    for (const field of [
        "capabilityId",
        "moduleOwner",
        "effectClass",
        "requiresApproval",
        "requiresOwnerVerification",
        "ownsStorage",
        "factRowsOnly",
        "allowedInputRefPrefixes",
    ] as const) {
        if (JSON.stringify(recordA[field]) !== JSON.stringify(recordB[field])) {
            differences.push(field);
        }
    }
    return differences;
}
