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
    MissionState,
    InvocationStatus,
    isInvocationDue,
    type CapabilityInvocation,
    type CapabilityInvocationRef,
    type OwnerVerification,
} from "../mission/contracts.js";
import type { CapabilityAvailability, CapabilityDescriptor } from "./contracts.js";
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

/** Result of reconciling a prior handoff; no new effect is submitted. */
export interface SeamReconciliationOutcome {
    invocation: CapabilityInvocationRef;
    result: CapabilityResult | null;
    recordedStatus: InvocationStatus;
}

/** Result of a cancellation request; cancellation is not invocation replay. */
export interface SeamCancellationOutcome {
    invocation: CapabilityInvocationRef;
    result: CapabilityResult | null;
    recordedStatus: InvocationStatus;
}

interface PersistedDispatchOptions {
    invocationId?: string;
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
    async dispatchThroughSeam(
        missionId: string,
        stepId: string,
        options: PersistedDispatchOptions = {},
    ): Promise<SeamDispatchOutcome> {
        // ── Pre-mint resolution (data-only; zero connector calls so far) ──
        const persisted = options.invocationId
            ? await this.engine.getInvocation(options.invocationId)
            : null;
        if (options.invocationId && (!persisted || persisted.missionId !== missionId || persisted.stepId !== stepId)) {
            throw new DispatchSeamError(
                `durable invocation "${options.invocationId}" does not belong to mission "${missionId}" step "${stepId}"; dispatch fails closed`,
            );
        }
        const capabilityId = persisted?.capabilityId ?? await this.capabilityIdFor(missionId, stepId);
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

        // ── Mint or resume (engine-only authority) ──
        const invocation = options.invocationId
            ? await this.persistedInvocationForDispatch(options.invocationId, missionId, stepId, descriptor)
            : await this.engine.dispatchStep(missionId, stepId, {
                  descriptor: {
                      contractVersion: descriptor.contractVersion,
                      moduleOwner: descriptor.moduleOwner,
                      idempotency: descriptor.idempotency,
                      retry: descriptor.retry,
                      cancellationSupport: descriptor.cancellationSupport,
                      reconciliationSupport: descriptor.reconciliationSupport,
                  },
              });

        // (6) Input schema enforcement BEFORE invoke().
        const request: ConnectorRequest = {
            requestId: invocation.requestId,
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

        // Persist the handoff boundary before entering connector code. A
        // process crash after this write is conservatively recoverable: the
        // invocation is known to have crossed the seam and must be observed
        // or reconciled, never blindly invoked a second time.
        await this.engine.markInvocationHandoff(invocation.invocationId, {
            deliveryState: "submitted",
        });

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

        // Long-running owners return an opaque operation identity. Persist it
        // before result handling so cancellation/reconciliation after a crash
        // can address the same owner operation without a second invoke().
        if (
            result.ownerOperationRef !== undefined
            && invocation.delivery.remoteOperationHandle === undefined
        ) {
            const deliveryState = result.status === CapabilityResultStatus.STILL_RUNNING
                ? "running" as const
                : result.status === CapabilityResultStatus.COMPLETED
                    ? "acknowledged" as const
                    : "uncertain" as const;
            await this.engine.markInvocationHandoff(invocation.invocationId, {
                deliveryState,
                remoteOperationHandle: result.ownerOperationRef,
            });
        }

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
        if (result.requestId !== invocation.requestId) {
            await this.recordUncertain(
                invocation,
                `connector returned result for requestId "${result.requestId}" while dispatching request "${invocation.requestId}"; result is unattributable and the outcome is uncertain`,
            );
            throw new DispatchSeamError(
                `connector requestId echo mismatch: expected "${invocation.requestId}", got "${result.requestId}"`,
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

    /**
     * Continue a durable invocation that was minted before a process restart.
     * This path never calls `MissionEngine.dispatchStep()` and therefore cannot
     * create a second invocation row or reset its request identity.
     */
    async dispatchPersistedInvocation(invocationId: string): Promise<SeamDispatchOutcome> {
        const invocation = await this.engine.getInvocation(invocationId);
        if (!invocation) {
            throw new DispatchSeamError(`invocation "${invocationId}" is not durable; dispatch fails closed`);
        }
        return this.dispatchThroughSeam(invocation.missionId, invocation.stepId, { invocationId });
    }

    /**
     * Re-acquire data for a completed external invocation after restart. This
     * is a read-only owner reconciliation: it never changes the terminal
     * invocation and never calls invoke(). It exists for Context Compiler
     * recovery, where prior owner rows are intentionally not stored in the
     * executive database.
     */
    async reacquireCompletedInvocation(invocationId: string): Promise<SeamReconciliationOutcome> {
        const invocation = await this.engine.getInvocation(invocationId);
        if (!invocation) {
            throw new DispatchSeamError(`invocation "${invocationId}" is not durable; reacquisition fails closed`);
        }
        if (invocation.status !== InvocationStatus.COMPLETED) {
            throw new DispatchSeamError(
                `invocation "${invocationId}" is not completed; external content cannot be reacquired as a terminal fact`,
            );
        }
        const descriptor = this.registry.requireDescriptor(invocation.capabilityId);
        const connector = this.connectors.get(invocation.capabilityId);
        if (!connector) throw new ConnectorNotRegisteredError(invocation.capabilityId);
        const canObserve = typeof connector.observeStatus === "function"
            && invocation.delivery.remoteOperationHandle !== undefined;
        if (
            descriptor.reconciliationSupport === "none"
            || (typeof connector.reconcile !== "function" && !canObserve)
        ) {
            throw new DispatchSeamError(
                `capability "${invocation.capabilityId}" does not declare completed-result reconciliation; external content remains unavailable`,
            );
        }
        if (descriptor.availability !== "available") {
            throw new CapabilityUnavailableError(
                invocation.capabilityId,
                descriptor.availability,
                descriptor.availabilityDetail,
            );
        }
        assertConnectorMatchesDescriptor(connector, descriptor);

        let rawResult: unknown;
        try {
            rawResult = typeof connector.reconcile === "function"
                ? await connector.reconcile(invocation.requestId)
                : await connector.observeStatus!(invocation.delivery.remoteOperationHandle!);
        } catch (error) {
            throw new DispatchSeamError(
                `completed invocation "${invocationId}" could not be reacquired: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
            );
        }
        const result = this.validateConnectorResult(
            invocation,
            descriptor,
            rawResult,
        );
        if (invocationStatusFor(result) !== InvocationStatus.COMPLETED) {
            throw new DispatchSeamError(
                `completed invocation "${invocationId}" was reacquired with status "${result.status}"; terminal content was not accepted`,
            );
        }
        if (result.ownerVerification?.verified === false) {
            throw new DispatchSeamError(
                `completed invocation "${invocationId}" was reacquired with a negative owner verification; content was not accepted`,
            );
        }
        return { invocation, result, recordedStatus: InvocationStatus.COMPLETED };
    }

    /**
     * Request cancellation of an active invocation through the registered
     * connector. This path never calls invoke(). Cooperative cancellation is
     * only an acknowledgement of the request and therefore remains pending
     * until reconciliation. Hard cancellation may safely become CANCELLED.
     */
    async cancelInvocation(invocationId: string): Promise<SeamCancellationOutcome> {
        const invocation = await this.engine.getInvocation(invocationId);
        if (!invocation) {
            throw new DispatchSeamError(`invocation "${invocationId}" is not durable; cancellation fails closed`);
        }
        if (invocation.status === InvocationStatus.COMPLETED || invocation.status === InvocationStatus.CANCELLED) {
            return { invocation, result: null, recordedStatus: invocation.status };
        }
        if (!invocation.cancellation.requested) {
            throw new DispatchSeamError(
                `invocation "${invocationId}" has no persisted cancellation request; cancellation must be authorized first`,
            );
        }
        if (invocation.cancellation.state !== "requested") {
            return { invocation, result: null, recordedStatus: invocation.status };
        }
        if (invocation.delivery.state === "not_submitted") {
            return { invocation, result: null, recordedStatus: invocation.status };
        }

        const descriptor = this.registry.requireDescriptor(invocation.capabilityId);
        const connector = this.connectors.get(invocation.capabilityId);
        if (
            descriptor.cancellationSupport === "none"
            || descriptor.cancellationSupport === "unsupported"
            || typeof connector?.cancel !== "function"
            || !invocation.delivery.remoteOperationHandle
        ) {
            const updated = await this.engine.recordInvocationCancellationOutcome(invocationId, {
                state: "unsupported",
                reconciliationState: "pending",
                nextAction: "connector cancellation is unavailable; reconcile conservatively before any further action",
            });
            return { invocation: updated, result: null, recordedStatus: updated.status };
        }
        if (descriptor.availability !== "available") {
            throw new CapabilityUnavailableError(
                invocation.capabilityId,
                descriptor.availability,
                descriptor.availabilityDetail,
            );
        }
        assertConnectorMatchesDescriptor(connector, descriptor);

        let rawResult: unknown;
        try {
            rawResult = await connector.cancel(invocation.delivery.remoteOperationHandle);
        } catch (error) {
            const updated = await this.engine.recordInvocationCancellationOutcome(invocationId, {
                state: "requested",
                status: InvocationStatus.BLOCKED,
                deliveryState: "uncertain",
                reconciliationState: "pending",
                nextAction: `connector cancellation outcome is uncertain: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
            });
            return { invocation: updated, result: null, recordedStatus: updated.status };
        }

        let result: CapabilityResult;
        try {
            result = this.validateConnectorResult(invocation, descriptor, rawResult, {
                requireOwnerVerification: false,
            });
        } catch (error) {
            const updated = await this.engine.recordInvocationCancellationOutcome(invocationId, {
                state: "requested",
                status: InvocationStatus.BLOCKED,
                deliveryState: "uncertain",
                reconciliationState: "pending",
                nextAction: `connector cancellation returned an unusable result: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
            });
            return { invocation: updated, result: null, recordedStatus: updated.status };
        }

        let updated: CapabilityInvocation;
        const activeDeliveryState = invocation.delivery.state === "submitted"
            ? "running" as const
            : invocation.delivery.state;
        if (result.status === CapabilityResultStatus.COMPLETED) {
            updated = await this.engine.recordInvocationCancellationOutcome(invocationId,
                descriptor.cancellationSupport === "hard"
                    ? {
                          state: "acknowledged",
                          status: InvocationStatus.CANCELLED,
                          deliveryState: "failed",
                          reconciliationState: "resolved",
                          outcome: "not_performed",
                          nextAction: "hard cancellation acknowledged by owner",
                      }
                    : {
                          state: "acknowledged",
                          deliveryState: activeDeliveryState,
                          reconciliationState: "pending",
                          outcome: "unknown",
                          nextAction: "cooperative cancellation acknowledged; reconcile the owner operation",
                      },
            );
        } else if (result.status === CapabilityResultStatus.UNKNOWN) {
            updated = await this.engine.recordInvocationCancellationOutcome(invocationId, {
                state: "requested",
                status: InvocationStatus.BLOCKED,
                deliveryState: "uncertain",
                reconciliationState: "pending",
                outcome: "unknown",
                nextAction: "cancellation status unknown; reconcile the owner operation",
            });
        } else {
            updated = await this.engine.recordInvocationCancellationOutcome(invocationId, {
                state: "requested",
                deliveryState: result.status === CapabilityResultStatus.STILL_RUNNING
                    ? "running"
                    : activeDeliveryState,
                reconciliationState: "pending",
                outcome: "unknown",
                nextAction: result.status === CapabilityResultStatus.STILL_RUNNING
                    ? "cancellation is still running; reconcile the owner operation"
                    : "owner did not acknowledge cancellation; reconcile before any retry",
            });
        }
        return { invocation: updated, result, recordedStatus: updated.status };
    }

    /**
     * Reconcile a prior handoff using only its durable request identity. The
     * connector's `reconcile()` path is the only operation reachable here;
     * this method never falls back to `invoke()`.
     */
    async reconcileInvocation(invocationId: string): Promise<SeamReconciliationOutcome> {
        const invocation = await this.engine.getInvocation(invocationId);
        if (!invocation) {
            throw new DispatchSeamError(`invocation "${invocationId}" is not durable; reconciliation fails closed`);
        }
        if (invocation.status === InvocationStatus.COMPLETED || invocation.status === InvocationStatus.CANCELLED) {
            return {
                invocation,
                result: null,
                recordedStatus: invocation.status,
            };
        }
        if (invocation.reconciliation.state !== "pending") {
            throw new DispatchSeamError(
                `invocation "${invocationId}" has no pending reconciliation; refusing an unsolicited owner status`,
            );
        }
        const descriptor = this.registry.requireDescriptor(invocation.capabilityId);
        const connector = this.connectors.get(invocation.capabilityId);
        if (!connector) {
            await this.recordReconciliationProblem(
                invocation,
                "connector is unavailable after restart; no replay is permitted",
            );
            throw new ConnectorNotRegisteredError(invocation.capabilityId);
        }
        const canObserve = typeof connector.observeStatus === "function"
            && invocation.delivery.remoteOperationHandle !== undefined;
        if (
            descriptor.reconciliationSupport === "none"
            || (typeof connector.reconcile !== "function" && !canObserve)
        ) {
            const status = invocation.status === InvocationStatus.FAILED
                ? InvocationStatus.FAILED
                : InvocationStatus.BLOCKED;
            await this.engine.markInvocationReconciliation(invocationId, {
                state: "unsupported",
                outcome: "unknown",
                deliveryState: "uncertain",
                status,
                nextAction: "operator reconciliation required; blind replay is forbidden",
                lastCheckedAt: this.isoNow(),
            });
            const blocked = await this.engine.getInvocation(invocationId);
            if (!blocked) throw new DispatchSeamError(`invocation "${invocationId}" disappeared during reconciliation`);
            return { invocation: blocked, result: null, recordedStatus: blocked.status };
        }
        if (descriptor.availability !== "available") {
            await this.recordReconciliationProblem(
                invocation,
                `capability unavailable during reconciliation: ${descriptor.availability}`,
            );
            throw new CapabilityUnavailableError(
                invocation.capabilityId,
                descriptor.availability,
                descriptor.availabilityDetail,
            );
        }
        try {
            assertConnectorMatchesDescriptor(connector, descriptor);
        } catch (error) {
            await this.recordReconciliationProblem(
                invocation,
                `connector conformance failed during reconciliation: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
            );
            throw error;
        }

        let rawResult: unknown;
        try {
            rawResult = typeof connector.reconcile === "function"
                ? await connector.reconcile(invocation.requestId)
                : await connector.observeStatus!(invocation.delivery.remoteOperationHandle!);
        } catch (error) {
            await this.engine.markInvocationReconciliation(invocationId, {
                state: "pending",
                outcome: "unknown",
                deliveryState: "uncertain",
                status: InvocationStatus.BLOCKED,
                nextAction: `reconciliation failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
                lastCheckedAt: this.isoNow(),
            });
            const blocked = await this.engine.getInvocation(invocationId);
            if (!blocked) throw error;
            return { invocation: blocked, result: null, recordedStatus: blocked.status };
        }
        if (rawResult === null) {
            await this.engine.markInvocationReconciliation(invocationId, {
                state: "pending",
                outcome: "unknown",
                deliveryState: "uncertain",
                status: InvocationStatus.BLOCKED,
                nextAction: "owner returned no status; reconcile again or request operator action",
                lastCheckedAt: this.isoNow(),
            });
            const blocked = await this.engine.getInvocation(invocationId);
            if (!blocked) throw new DispatchSeamError(`invocation "${invocationId}" disappeared during reconciliation`);
            return { invocation: blocked, result: null, recordedStatus: blocked.status };
        }
        const resultSchema = descriptor.resultSchema;
        if (!isDeclarativeSchema(resultSchema)) {
            await this.engine.markInvocationReconciliation(invocationId, {
                state: "pending",
                outcome: "unknown",
                deliveryState: "uncertain",
                status: InvocationStatus.BLOCKED,
                nextAction: "reconciliation result schema is not declarative",
                lastCheckedAt: this.isoNow(),
            });
            throw new DispatchSeamError(`descriptor resultSchema for "${invocation.capabilityId}" is not declarative`);
        }
        const resultCheck = evaluateDeclarativeSchema(resultSchema, rawResult);
        if (!resultCheck.valid) {
            await this.engine.markInvocationReconciliation(invocationId, {
                state: "pending",
                outcome: "unknown",
                deliveryState: "uncertain",
                status: InvocationStatus.BLOCKED,
                nextAction: `malformed reconciliation result: ${resultCheck.errors.join("; ")}`,
                lastCheckedAt: this.isoNow(),
            });
            throw new ConnectorResultSchemaError(invocation.capabilityId, resultCheck.errors);
        }
        let result = rawResult as CapabilityResult;
        const evidenceProblem = this.guardEvidenceItems(result.evidence);
        if (evidenceProblem) {
            await this.engine.markInvocationReconciliation(invocationId, {
                state: "pending",
                outcome: "unknown",
                deliveryState: "uncertain",
                status: InvocationStatus.BLOCKED,
                nextAction: `malformed reconciliation evidence: ${evidenceProblem}`,
                lastCheckedAt: this.isoNow(),
            });
            throw new DispatchSeamError(`reconciliation evidence violates the EvidenceReference contract: ${evidenceProblem}`);
        }
        if (result.requestId !== invocation.requestId) {
            await this.engine.markInvocationReconciliation(invocationId, {
                state: "pending",
                outcome: "unknown",
                deliveryState: "uncertain",
                status: InvocationStatus.BLOCKED,
                nextAction: "reconciliation returned an unattributable request identity",
                lastCheckedAt: this.isoNow(),
            });
            throw new DispatchSeamError(
                `reconciliation requestId mismatch: expected "${invocation.requestId}", got "${result.requestId}"`,
            );
        }
        if (result.ownerVerification !== undefined) {
            const verificationProblem = this.guardOwnerVerificationOutcome(result.ownerVerification);
            if (verificationProblem) {
                if (descriptor.requiresOwnerVerification) {
                    await this.engine.markInvocationReconciliation(invocationId, {
                        state: "pending",
                        outcome: "unknown",
                        deliveryState: "uncertain",
                        status: InvocationStatus.BLOCKED,
                        nextAction: `malformed owner verification: ${verificationProblem}`,
                        lastCheckedAt: this.isoNow(),
                    });
                    throw new DispatchSeamError(`reconciliation owner verification is malformed: ${verificationProblem}`);
                }
                result = { ...result, ownerVerification: undefined };
            }
        }
        if (
            descriptor.requiresOwnerVerification
            && (!result.ownerVerification || result.ownerVerification.verified === null)
        ) {
            await this.engine.markInvocationReconciliation(invocationId, {
                state: "pending",
                outcome: "unknown",
                deliveryState: "uncertain",
                status: InvocationStatus.BLOCKED,
                nextAction: "reconciliation returned no mandatory owner verification",
                lastCheckedAt: this.isoNow(),
            });
            const blocked = await this.engine.getInvocation(invocationId);
            if (!blocked) throw new DispatchSeamError(`invocation "${invocationId}" disappeared during reconciliation`);
            return { invocation: blocked, result, recordedStatus: blocked.status };
        }
        const mapped = invocationStatusFor(result);
        const ownerClaim = result.ownerVerification?.verified === true || result.ownerVerification?.verified === false
            ? this.ownerVerificationOf(invocation, result)
            : undefined;
        try {
            await this.engine.recordReconciledInvocationResult(
                invocationId,
                {
                    invocationId,
                    status: mapped,
                    summary: result.summary,
                    evidenceRefs: this.evidenceRefsOf(result),
                    completedAt: isTerminalInvocationStatus(mapped) ? this.isoNow() : undefined,
                },
                ownerClaim,
            );
        } catch (error) {
            await this.engine.markInvocationReconciliation(invocationId, {
                state: "pending",
                outcome: "unknown",
                deliveryState: "uncertain",
                status: InvocationStatus.BLOCKED,
                nextAction: `reconciliation result was not accepted: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
                lastCheckedAt: this.isoNow(),
            });
            throw error;
        }
        const updated = await this.engine.getInvocation(invocationId);
        if (!updated) throw new DispatchSeamError(`invocation "${invocationId}" disappeared after reconciliation`);
        return { invocation: updated, result, recordedStatus: updated.status };
    }

    /** Persist a conservative reconciliation observation without replay. */
    private async recordReconciliationProblem(
        invocation: CapabilityInvocation,
        reason: string,
    ): Promise<CapabilityInvocation> {
        const current = await this.engine.getInvocation(invocation.invocationId);
        if (!current) throw new DispatchSeamError(`invocation "${invocation.invocationId}" disappeared during reconciliation`);
        if (current.status === InvocationStatus.COMPLETED || current.status === InvocationStatus.CANCELLED) return current;
        const status = current.status === InvocationStatus.FAILED
            ? InvocationStatus.FAILED
            : current.status === InvocationStatus.BLOCKED
                ? InvocationStatus.BLOCKED
                : InvocationStatus.BLOCKED;
        try {
            return await this.engine.markInvocationReconciliation(current.invocationId, {
                state: "pending",
                outcome: "unknown",
                deliveryState: "uncertain",
                status,
                nextAction: sanitizeText(reason),
                lastCheckedAt: this.isoNow(),
            });
        } catch {
            return this.engine.getInvocation(current.invocationId).then((latest) => {
                if (!latest) throw new DispatchSeamError(`invocation "${current.invocationId}" disappeared during reconciliation`);
                return latest;
            });
        }
    }

    /**
     * Validate a result before any caller consumes its fields. This helper is
     * used by non-invoking lifecycle operations as well as completed-result
     * reacquisition, so malformed adapter values cannot escape as TypeErrors.
     */
    private validateConnectorResult(
        invocation: CapabilityInvocation,
        descriptor: CapabilityDescriptor,
        rawResult: unknown,
        options: { requireOwnerVerification?: boolean } = {},
    ): CapabilityResult {
        const resultSchema = descriptor.resultSchema;
        if (!isDeclarativeSchema(resultSchema)) {
            throw new DispatchSeamError(
                `descriptor resultSchema for "${invocation.capabilityId}" is not declarative; result cannot be consumed`,
            );
        }
        const resultCheck = evaluateDeclarativeSchema(resultSchema, rawResult);
        if (!resultCheck.valid) {
            throw new ConnectorResultSchemaError(invocation.capabilityId, resultCheck.errors);
        }
        let result = rawResult as CapabilityResult;
        const evidenceProblem = this.guardEvidenceItems(result.evidence);
        if (evidenceProblem) {
            throw new DispatchSeamError(`connector result evidence violates the EvidenceReference contract: ${evidenceProblem}`);
        }
        if (result.ownerVerification !== undefined) {
            const verificationProblem = this.guardOwnerVerificationOutcome(result.ownerVerification);
            if (verificationProblem) {
                if (descriptor.requiresOwnerVerification && options.requireOwnerVerification !== false) {
                    throw new DispatchSeamError(`connector owner verification is malformed: ${verificationProblem}`);
                }
                result = { ...result, ownerVerification: undefined };
            }
        }
        const requiresOwnerVerification = options.requireOwnerVerification ?? descriptor.requiresOwnerVerification;
        const persistedOwnerVerification = invocation.ownerVerification?.verified === true;
        if (
            requiresOwnerVerification
            && !persistedOwnerVerification
            && (result.ownerVerification === undefined || result.ownerVerification.verified === null)
        ) {
            throw new DispatchSeamError(
                `capability "${invocation.capabilityId}" returned no attested owner verification`,
            );
        }
        if (result.requestId !== invocation.requestId) {
            throw new DispatchSeamError(
                `connector result requestId mismatch: expected "${invocation.requestId}", got "${result.requestId}"`,
            );
        }
        return result;
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

    private async persistedInvocationForDispatch(
        invocationId: string,
        missionId: string,
        stepId: string,
        descriptor: CapabilityDescriptor,
    ) {
        const invocation = await this.engine.getInvocation(invocationId);
        if (!invocation || invocation.missionId !== missionId || invocation.stepId !== stepId) {
            throw new DispatchSeamError(
                `durable invocation "${invocationId}" does not belong to mission "${missionId}" step "${stepId}"; dispatch fails closed`,
            );
        }
        if (invocation.status === InvocationStatus.COMPLETED || invocation.status === InvocationStatus.CANCELLED) {
            throw new DispatchSeamError(
                `invocation "${invocationId}" is terminal; completed effects are never re-dispatched`,
            );
        }
        const mission = await this.engine.getMission(missionId);
        if (mission.state !== MissionState.READY && mission.state !== MissionState.EXECUTING) {
            throw new DispatchSeamError(
                `mission "${missionId}" is in state "${mission.state}"; persisted dispatch is paused or waiting and cannot cross the seam`,
            );
        }
        if (invocation.cancellation.requested) {
            throw new DispatchSeamError(
                `invocation "${invocationId}" has a persisted cancellation request; dispatch is forbidden`,
            );
        }
        if (invocation.delivery.state !== "not_submitted") {
            throw new DispatchSeamError(
                `invocation "${invocationId}" has delivery state "${invocation.delivery.state}"; reconcile before dispatch`,
            );
        }
        if (invocation.status !== InvocationStatus.PENDING && invocation.status !== InvocationStatus.DISPATCHED) {
            throw new DispatchSeamError(
                `invocation "${invocationId}" is in status "${invocation.status}"; only prepared work may cross the seam`,
            );
        }
        if (!isInvocationDue(invocation, this.isoNow())) {
            throw new DispatchSeamError(
                `invocation "${invocationId}" is not yet eligible for dispatch at its persisted nextEligibleAt`,
            );
        }
        if (
            invocation.contractVersion !== descriptor.contractVersion
            || invocation.moduleOwner !== descriptor.moduleOwner
            || invocation.idempotency.mode !== descriptor.idempotency.mode
            || invocation.retry.maxAttempts !== descriptor.retry.maxAttempts
            || invocation.retry.backoff !== descriptor.retry.backoff
            || invocation.reconciliation.support !== descriptor.reconciliationSupport
            || invocation.cancellation.support !== descriptor.cancellationSupport
        ) {
            const mismatches = [
                invocation.contractVersion !== descriptor.contractVersion ? "contractVersion" : undefined,
                invocation.moduleOwner !== descriptor.moduleOwner ? "moduleOwner" : undefined,
                invocation.idempotency.mode !== descriptor.idempotency.mode ? "idempotency.mode" : undefined,
                invocation.retry.maxAttempts !== descriptor.retry.maxAttempts ? "retry.maxAttempts" : undefined,
                invocation.retry.backoff !== descriptor.retry.backoff ? "retry.backoff" : undefined,
                invocation.reconciliation.support !== descriptor.reconciliationSupport ? "reconciliationSupport" : undefined,
                invocation.cancellation.support !== descriptor.cancellationSupport ? "cancellationSupport" : undefined,
            ].filter((field): field is string => field !== undefined);
            throw new DispatchSeamError(
                `invocation "${invocationId}" contract semantics no longer match the registered capability (${mismatches.join(", ")}); dispatch fails closed`,
            );
        }
        if (invocation.planRevisionId) {
            const revision = await this.engine.getPlanRevision(invocation.planRevisionId);
            const step = revision?.steps.find((candidate) => candidate.stepId === invocation.stepId);
            if (!revision || revision.missionId !== missionId || !step || step.capabilityRequirement !== invocation.capabilityId) {
                throw new DispatchSeamError(
                    `invocation "${invocationId}" cannot be rebound to its persisted plan revision; dispatch fails closed`,
                );
            }
        }
        return invocation;
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
        const { step } = await this.revisionForInvocation(invocation);
        return [...step.inputRefs];
    }

    /** Declarative desired outcome from the accepted plan revision. */
    private async stepDesiredOutcome(invocation: CapabilityInvocationRef): Promise<string> {
        const { step } = await this.revisionForInvocation(invocation);
        return step.desiredOutcome;
    }

    /**
     * New invocations use the current accepted revision. A persisted retry or
     * continuation uses the revision that authorized that invocation, so a
     * later planner revision cannot silently rewrite an already-authorized
     * request's input identity or desired outcome.
     */
    private async revisionForInvocation(invocation: CapabilityInvocationRef) {
        const planRevisionId = (invocation as Partial<CapabilityInvocation>).planRevisionId;
        if (planRevisionId) {
            const revision = await this.engine.getPlanRevision(planRevisionId);
            const step = revision?.steps.find((candidate) => candidate.stepId === invocation.stepId);
            if (!revision || revision.missionId !== invocation.missionId || !step) {
                throw new DispatchSeamError(
                    `invocation "${invocation.invocationId}" cannot read its persisted plan revision; dispatch fails closed`,
                );
            }
            return { revision, step };
        }
        return this.currentRevisionFor(invocation.missionId, invocation.stepId);
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
