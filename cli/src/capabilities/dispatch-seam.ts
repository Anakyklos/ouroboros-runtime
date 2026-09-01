/**
 * 🎯🔌 THE ONE SEAM (PR #73 review blockers 1 + 2)
 *
 * Deterministic dispatch: an authorized invocation goes to the CONNECTOR
 * REGISTERED for the capability — never to a look-alike, never to a
 * re-implemented copy, never to whatever happens to answer first.
 *
 * Design constraints (all fail-closed):
 * - capabilityId is the SINGLE identity key. If the connector's declared
 *   capabilityId differs from the capability being dispatched, the
 *   dispatch is rejected — name similarity is not identity.
 * - The seam itself never fabricates success. If the connector is not
 *   registered, not the right one, or the capability is not available,
 *   dispatch fails loudly; callers decide what to do next.
 * - Discovery does not concede authorization: listing connectors never
 *   yields an invocation path; only engine.dispatchStep() mints
 *   invocations, and only after PlanPolicyValidator authorization.
 * - The seam never fabricates evidence. Connector output flows through
 *   recordInvocationResult (single write path, atomic evidence tx).
 * - No scheduler, no retries, no fan-out, no telemetry here — #50 owns
 *   those. This file is the narrow, testable contract #50 routes through.
 */

import { MissionEngine } from "../mission/mission-engine.js";
import {
    InvocationStatus,
    type CapabilityInvocationRef,
} from "../mission/contracts.js";
import type { CapabilityAvailability } from "./contracts.js";
import { CapabilityResultStatus } from "./connector.js";
import {
    assertConnectorMatchesDescriptor,
    type CapabilityRegistry,
} from "./registry.js";
import type {
    CapabilityConnector,
    CapabilityResult,
    ConnectorRequest,
} from "./connector.js";
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
 * (availability != AVAILABLE, blocker 2). Carries the state so callers can
 * decide to wait (busy/waiting_dependency) or fail fast
 * (unavailable/configuration_error) without string parsing.
 */
export class CapabilityUnavailableError extends DispatchSeamError {
    readonly capabilityId: string;
    readonly availability: CapabilityAvailability;
    readonly detail?: string;
    constructor(capabilityId: string, availability: CapabilityAvailability, detail?: string) {
        super(
            `Capability "${capabilityId}" is not dispatchable: availability is "${availability}"` +
                (detail ? ` (${detail})` : "") +
                `; no connector was invoked`,
        );
        this.name = "CapabilityUnavailableError";
        this.capabilityId = capabilityId;
        this.availability = availability;
        this.detail = detail;
    }
}

/** Result of a successful seam dispatch. */
export interface SeamDispatchOutcome {
    /** The invocation the engine minted (engine is the only id authority). */
    invocation: CapabilityInvocationRef;
    /** The typed result the ONE authorized connector produced. */
    result: CapabilityResult;
}

/**
 * The narrow, deterministic dispatch seam.
 *
 * Gating order in dispatchThroughSeam():
 *  1. engine.dispatchStep() — authorization, plan revalidation, approval,
 *     replay protection, and invocation minting (engine-only authority);
 *  2. connector presence + identity from its own declaration
 *     (zero connector method calls needed to notice a mismatch);
 *  3. availability gate (blocker 2) read from the REGISTRY's descriptor —
 *     discovery data, not connector testimony: an unavailable capability
 *     never reaches invoke() and siblings are untouched;
 *  4. version gate (blocker 4) BEFORE describe()/invoke();
 *  5. describe() must conform to the registered descriptor;
 *  6. invoke() — the only connector call that can produce effects;
 *  7. recordInvocationResult() — the engine's single atomic write path.
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
     * connector swaps. Descriptor changes go through the registry's
     * classified replace() instead.
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
     * identity-verified, version-gated connector is invoked, or nothing is.
     */
    async dispatchThroughSeam(missionId: string, stepId: string): Promise<SeamDispatchOutcome> {
        // (1) Authorization + state gates + invocation minting, engine-owned.
        const invocation = await this.engine.dispatchStep(missionId, stepId);
        const capabilityId = invocation.capabilityId;

        // (2) Connector presence + identity, from declarations only.
        const connector = this.connectors.get(capabilityId);
        if (!connector) {
            await this.recordFailure(invocation, "no connector registered for capability");
            throw new ConnectorNotRegisteredError(capabilityId);
        }
        if (connector.capabilityId !== capabilityId) {
            await this.recordFailure(invocation, "connector identity mismatch");
            throw new ConnectorIdentityMismatchError(capabilityId, connector.capabilityId);
        }

        // (3) Availability gate (blocker 2): registry data, not testimony.
        try {
            this.assertDispatchable(invocation);
        } catch (error) {
            await this.recordFailure(
                invocation,
                `capability not dispatchable: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            throw error;
        }

        // (4)+(5) Version gate + descriptor conformance (blocker 4).
        try {
            assertConnectorMatchesDescriptor(connector, this.registry.requireDescriptor(capabilityId));
        } catch (error) {
            await this.recordFailure(
                invocation,
                `connector contract gate failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            throw error;
        }

        // (6) The authorized handoff — the ONLY effectful connector call.
        const request: ConnectorRequest = {
            requestId: invocation.invocationId,
            inputRefs: await this.stepInputRefs(invocation),
            desiredOutcome: await this.stepDesiredOutcome(invocation),
        };
        let result;
        try {
            result = await connector.invoke(request);
        } catch (error) {
            const raw = error instanceof Error ? error.message : String(error);
            await this.recordFailure(invocation, `connector invoke failed: ${raw}`);
            throw new DispatchSeamError(
                `invoke() of capability "${capabilityId}" failed: ${sanitizeText(raw)}`,
            );
        }

        // The requestId is the reconciliation key; a connector that does
        // not echo it back has violated the contract. Fail loudly, record
        // FAILED, never fabricate a key on the connector's behalf.
        if (result.requestId !== invocation.invocationId) {
            await this.engine.recordInvocationResult(invocation.invocationId, {
                invocationId: invocation.invocationId,
                status: InvocationStatus.FAILED,
                summary: `connector returned result for requestId "${result.requestId}" while dispatching invocation "${invocation.invocationId}"`,
                evidenceRefs: [],
                completedAt: this.isoNow(),
            });
            throw new DispatchSeamError(
                `connector requestId echo mismatch: expected "${invocation.invocationId}", got "${result.requestId}"`,
            );
        }

        // (7) Engine-owned result recording (status + evidence, atomic).
        await this.engine.recordInvocationResult(invocation.invocationId, {
            invocationId: invocation.invocationId,
            status: result.status === CapabilityResultStatus.FAILED
                ? InvocationStatus.FAILED
                : InvocationStatus.COMPLETED,
            summary: result.summary,
            evidenceRefs: result.evidence.map((ref, index) => ({
                refId: `${result.requestId}:${index}`,
                owner: ref.owner,
                externalRef: ref.externalRef,
                label: ref.label,
            })),
            completedAt: this.isoNow(),
        });

        return {
            invocation: {
                ...invocation,
                status: result.status === CapabilityResultStatus.FAILED
                    ? InvocationStatus.FAILED
                    : InvocationStatus.COMPLETED,
            },
            result,
        };
    }

    /**
     * Availability gate (blocker 2). Reads availability from the registry
     * descriptor — discovery data owned by the runtime, never connector
     * testimony. Only AVAILABLE dispatches; everything else throws
     * explicitly BEFORE any connector call, and no sibling step is
     * consulted or touched (each dispatch is one step, independently).
     */
    private assertDispatchable(invocation: CapabilityInvocationRef): void {
        const descriptor = this.registry.requireDescriptor(invocation.capabilityId);
        if (descriptor.availability !== "available") {
            throw new CapabilityUnavailableError(
                invocation.capabilityId,
                descriptor.availability,
                descriptor.availabilityDetail,
            );
        }
    }

    /**
     * Step inputRefs come from the accepted plan revision the invocation
     * was dispatched from (deterministic data, no planner re-consultation).
     */
    private async stepInputRefs(invocation: CapabilityInvocationRef): Promise<string[]> {
        const revision = await this.currentRevision(invocation);
        const step = revision.steps.find((s) => s.stepId === invocation.stepId);
        if (!step) {
            throw new DispatchSeamError(
                `step "${invocation.stepId}" vanished from the accepted plan revision; refusing to synthesize connector input`,
            );
        }
        return [...step.inputRefs];
    }

    /** Declarative desired outcome from the accepted plan revision. */
    private async stepDesiredOutcome(invocation: CapabilityInvocationRef): Promise<string> {
        const revision = await this.currentRevision(invocation);
        const step = revision.steps.find((s) => s.stepId === invocation.stepId);
        if (!step) {
            throw new DispatchSeamError(
                `step "${invocation.stepId}" vanished from the accepted plan revision; refusing to synthesize connector input`,
            );
        }
        return step.desiredOutcome;
    }

    private async currentRevision(invocation: CapabilityInvocationRef) {
        const mission = await this.engine.getMission(invocation.missionId);
        if (!mission.currentPlanRevisionId) {
            throw new DispatchSeamError(
                `mission ${invocation.missionId} has no accepted plan revision; refusing to synthesize connector input`,
            );
        }
        const revision = await this.engine.getPlanRevision(mission.currentPlanRevisionId);
        if (!revision) {
            throw new DispatchSeamError(
                `plan revision ${mission.currentPlanRevisionId} not found; refusing to synthesize connector input`,
            );
        }
        return revision;
    }

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
}
