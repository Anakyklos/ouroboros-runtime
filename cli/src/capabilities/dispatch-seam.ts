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
 *     8. requestId echo must match (reconciliation key) — otherwise the
 *        invocation is UNCERTAIN, never "failed";
 *     9. CapabilityResult is validated against resultSchema — a malformed
 *        result is never consumed nor recorded as completed;
 *    10. ownerVerification verdicts are propagated to the engine's
 *        VerificationAuthority; verified:false never coexists with a
 *        successful invocation; missing mandatory verification blocks;
 *    11. recordInvocationResult() — the engine's single atomic write path,
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
        let result: CapabilityResult;
        try {
            result = await connector.invoke(request);
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

        // (8) requestId echo: the reconciliation key. A connector that
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

        // (9) Result schema enforcement BEFORE consuming/recording.
        const resultSchema = descriptor.resultSchema;
        if (!isDeclarativeSchema(resultSchema)) {
            await this.recordUncertain(invocation, "descriptor resultSchema is not declarative; result not consumed");
            throw new DispatchSeamError(
                `descriptor resultSchema for "${capabilityId}" is not a declarative schema; dispatch fails closed`,
            );
        }
        const resultCheck = evaluateDeclarativeSchema(resultSchema, result);
        if (!resultCheck.valid) {
            // Effect already happened; a malformed result must never be
            // recorded as completed. Uncertain, reconciliation territory.
            await this.recordUncertain(
                invocation,
                `CapabilityResult violates the capability resultSchema (effect outcome uncertain): ${resultCheck.errors.join("; ")}`,
            );
            throw new ConnectorResultSchemaError(capabilityId, resultCheck.errors);
        }

        // (10) Owner verification verdicts are evidence, not decoration.
        if (result.ownerVerification && result.ownerVerification.verified === false) {
            // Evidence-backed negative verdict: the owner examined the
            // outcome and rejected it. This is the one post-effect state
            // with a definitive, evidenced answer: FAILED (never success).
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

        // (11) Engine-owned result recording (status + evidence, atomic).
        // OwnerVerification (when present, verified/unknown) is attested by
        // the engine's VerificationAuthority — the fail-closed default
        // authority rejects it, in which case the invocation is still
        // recorded with the honest status but WITHOUT an attested verdict
        // (completion gates elsewhere never accept unattested verdicts).
        const mapped = invocationStatusFor(result);
        const ownerVerification = result.ownerVerification
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
                ownerVerification,
            );
        } catch (error) {
            if (ownerVerification) {
                // Authority refused to attest (fail-closed default or
                // provenance mismatch). Record WITHOUT the verdict; the
                // verdict is never silently self-attested.
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
        "allowedInputRefPrefixes",
    ] as const) {
        if (JSON.stringify(recordA[field]) !== JSON.stringify(recordB[field])) {
            differences.push(field);
        }
    }
    return differences;
}

