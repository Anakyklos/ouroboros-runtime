/**
 * 🔗 Seam-Bound Context Sources (Issue #64)
 *
 * Bridge between the Context Compiler and the ONE deterministic dispatch
 * seam of #63 (`ConnectorDispatchSeam`). This module owns NO second adapter
 * path: the only way an owner's content reaches compilation is a
 * lifecycle `CapabilityConnector.invoke()` result that ALREADY passed the
 * seam's gates (registry identity, availability, split-brain authority,
 * declarative input/result schemas, engine minting, honest status mapping).
 *
 * Resolution discipline (blocker 1 of the #74 review):
 *  - `ownerHint` is a HINT, never authority. Resolution is: an ACCEPTED
 *    plan step whose `capabilityRequirement` is authorized by #62 policy
 *    and gated by the #63 registry + engine. A wrong hint changes nothing:
 *    provenance labels always come from the capability that actually ran.
 *  - Ref prefixes were checked by #62 policy at plan time; this bridge
 *    re-verifies them against CURRENT mission state (fail-closed defense
 *    in depth — authorization is never frozen at acceptance time).
 *  - Revocation/availability is honored: every refusal is a typed honest
 *    `UnresolvedSource`; one source's failure never poisons another read.
 *  - No DB paths, no SQL, no private schemas cross this boundary: only
 *    opaque source refs returned by owner-side connectors, structurally
 *    validated here and sanitized by the compiler downstream.
 *
 * Structural closure (round-2 review blocker): every successful read is
 * SEALED into a non-forgeable `SeamAuthorizedRead` (compiler module) — the
 * ONLY form the compiler accepts — so external content cannot enter
 * compilation without having crossed the seam HERE. Caller-provided
 * `SeamDispatchOutcome` objects are NOT accepted: a plausible-shaped object
 * is not proof of authorization, and the engine exposes no API today to
 * prove invocation/result identity for outcomes dispatched elsewhere (that
 * proof needs #50-grade reconciliation records). If a read matters,
 * dispatch it through this reader.
 */

import type { CapabilityRegistryApi } from "../capabilities/registry.js";
import type { CapabilityDescriptor } from "../capabilities/contracts.js";
import type { SeamDispatchOutcome } from "../capabilities/dispatch-seam.js";
import { CapabilityUnavailableError, DispatchSeamError } from "../capabilities/dispatch-seam.js";
import type { MissionEngine } from "../mission/mission-engine.js";
import type { Mission } from "../mission/contracts.js";
import { EffectClass } from "../mission/contracts.js";
import type {
    CompiledSourceRead,
    ContextRequest,
    UnresolvedSource,
} from "./contracts.js";
import { EpistemicClass, SensitivityClass, SourceStatus } from "./contracts.js";
import { getSeamSeal } from "./compiler.js";
import type { ContextReadResult } from "./compiler.js";

/**
 * Canonical provenance label derived from a capability id — a LABEL only.
 * `context:lifeos` → `lifeos`; anything else keeps the full id. This is a
 * display/provenance convention, NEVER an authorization mechanism.
 */
export function contextOwnerFromCapabilityId(capabilityId: string): string {
    if (capabilityId.startsWith("context:")) return capabilityId.slice("context:".length);
    return capabilityId;
}

/**
 * Derive the context owner LABEL from a plan step. Pure labeling: the
 * step's authorized capability (not the hint) decides which connector runs.
 */
export function contextOwnerFromStep(step: {
    capabilityRequirement: string;
}): string {
    return contextOwnerFromCapabilityId(step.capabilityRequirement);
}

/**
 * Deterministic structural validation of connector-provided context rows.
 * A malformed entry is skipped honestly (typed record); valid sibling rows
 * are kept. Only opaque source refs and sanitized text cross this boundary.
 */
function validateContextRows(
    rows: unknown,
): { rows: CompiledSourceRead["rows"]; skipped: number } {
    if (!Array.isArray(rows)) return { rows: [], skipped: 1 };
    const valid: CompiledSourceRead["rows"] = [];
    let skipped = 0;
    const validSensitivity = new Set([
        SensitivityClass.NORMAL,
        SensitivityClass.REDACTED,
        SensitivityClass.RESTRICTED,
    ]);
    const validClass = new Set([
        EpistemicClass.FACT,
        EpistemicClass.DERIVED_SUMMARY,
        EpistemicClass.INFERENCE,
    ]);
    for (const candidate of rows) {
        const rec =
            candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
                ? (candidate as Record<string, unknown>)
                : undefined;
        const sourceRef = rec?.["sourceRef"];
        const content = rec?.["content"];
        const fetchedAt = rec?.["fetchedAt"];
        const evidenceRefId = rec?.["evidenceRefId"];
        const sensitivity = rec?.["sensitivity"];
        const epistemicClass = rec?.["epistemicClass"];
        if (
            typeof sourceRef !== "string" ||
            sourceRef.length === 0 ||
            typeof content !== "string" ||
            (fetchedAt !== undefined && typeof fetchedAt !== "string") ||
            (evidenceRefId !== undefined && typeof evidenceRefId !== "string") ||
            (sensitivity !== undefined &&
                (typeof sensitivity !== "string" ||
                    !validSensitivity.has(sensitivity as SensitivityClass))) ||
            (epistemicClass !== undefined &&
                (typeof epistemicClass !== "string" ||
                    !validClass.has(epistemicClass as EpistemicClass)))
        ) {
            skipped++;
            continue;
        }
        valid.push({
            sourceRef,
            content,
            fetchedAt: fetchedAt as string | undefined,
            evidenceRefId: evidenceRefId as string | undefined,
            sensitivity: sensitivity as SensitivityClass | undefined,
            epistemicClass: epistemicClass as EpistemicClass | undefined,
        });
    }
    return { rows: valid, skipped };
}

/**
 * Extract context rows from a seam-authorized result. The ONLY content
 * channel is the connector's typed optional `CapabilityResult.contextRows`
 * — structured data that crossed the seam's declarative result schema.
 * Summary/evidence strings are engine-level provenance, never row content.
 */
function rowsFromResult(result: { contextRows?: unknown }): {
    rows: CompiledSourceRead["rows"];
    skipped: number;
} {
    if (result.contextRows === undefined) return { rows: [], skipped: 0 };
    return validateContextRows(result.contextRows);
}

/**
 * 🔗 SeamBoundContextReader — produces `ContextReadResult`s for the
 * compiler by dispatching accepted plan steps through the #63 seam. The
 * registry handle here is DATA-ONLY (descriptor reads); no capability is
 * ever invoked except through the seam.
 */
export class SeamBoundContextReader {
    constructor(
        private readonly engine: MissionEngine,
        private readonly seam: import("../capabilities/dispatch-seam.js").ConnectorDispatchSeam,
        private readonly registry: CapabilityRegistryApi,
    ) {}

    /**
     * Compile-ready reads for a request. A request WITHOUT ownerHint is
     * mission-only (no external read, no dispatch). Otherwise the caller
     * names the accepted plan step that justifies the read; the step is
     * dispatched through the #63 seam and the authorized result (if any)
     * is sealed into a `SeamAuthorizedRead`.
     */
    async read(
        mission: Mission,
        request: ContextRequest,
        options: { dispatchStepId?: string } = {},
    ): Promise<ContextReadResult[]> {
        if (!request.ownerHint) return []; // mission-only compilation
        const outcomes: ContextReadResult[] = [];
        if (options.dispatchStepId !== undefined) {
            outcomes.push(await this.dispatchAndPackage(mission, request, options.dispatchStepId));
        }
        return outcomes;
    }

    /**
     * Dispatch ONE accepted plan step through the #63 seam and package the
     * authorized result for compilation. Pre-dispatch guards re-verify the
     * CURRENT mission state (fail-closed: revocation between plan
     * acceptance and compilation is honored — the seam and engine re-gate
     * everything again at dispatch time).
     */
    private async dispatchAndPackage(
        mission: Mission,
        request: ContextRequest,
        stepId: string,
    ): Promise<ContextReadResult> {
        const requestedRef = request.subject;
        // Fresh authoritative mission state (never the caller's snapshot).
        const current = await this.engine.getMission(mission.missionId);
        const label = request.ownerHint ?? "(unknown)";

        // Current mission must still have an accepted plan (revocation-safe).
        if (!current.currentPlanRevisionId) {
            return unresolved(
                requestedRef,
                label,
                SourceStatus.UNSUPPORTED,
                "no accepted plan revision for this mission",
            );
        }
        const revision = await this.engine.getPlanRevision(current.currentPlanRevisionId);
        if (!revision || revision.missionId !== mission.missionId) {
            return unresolved(
                requestedRef,
                label,
                SourceStatus.UNSUPPORTED,
                "current plan revision is not readable for this mission",
            );
        }
        const step = revision.steps.find((s) => s.stepId === stepId);
        if (!step) {
            return unresolved(
                requestedRef,
                label,
                SourceStatus.UNSUPPORTED,
                `step "${stepId}" is not part of the accepted plan`,
            );
        }
        // Read-only discipline: context compilation consumes READ steps.
        if (step.effectClass !== EffectClass.READ) {
            return unresolved(
                requestedRef,
                contextOwnerFromStep(step),
                SourceStatus.UNSUPPORTED,
                "accepted plan step is not a read",
            );
        }
        // Defense in depth against CURRENT state (policy gates re-run at
        // dispatch; these typed refusals precede any seam call).
        const revoked = scopeRefusal(current, step.capabilityRequirement, requestedRef);
        if (revoked) {
            return unresolved(
                requestedRef,
                contextOwnerFromStep(step),
                revoked.status,
                revoked.detail,
            );
        }

        // Dispatch through the ONE seam. Refusals BEFORE invoke leave no
        // invocation minted; uncertainty AFTER invoke is preserved by the
        // seam itself (BLOCKED, never rewritten into success).
        let outcome: SeamDispatchOutcome;
        try {
            outcome = await this.seam.dispatchThroughSeam(mission.missionId, stepId);
        } catch (error) {
            if (error instanceof CapabilityUnavailableError) {
                return unresolved(
                    requestedRef,
                    contextOwnerFromStep(step),
                    SourceStatus.UNAVAILABLE,
                    sanitizeDetail(error.detail ?? "capability unavailable"),
                );
            }
            if (error instanceof DispatchSeamError) {
                // The seam already recorded the honest invocation state
                // (e.g. BLOCKED/uncertain after a connector throw): the
                // capability could not be consumed now — UNAVAILABLE with
                // the sanitized reason; reconciliation is engine territory.
                return unresolved(
                    requestedRef,
                    contextOwnerFromStep(step),
                    SourceStatus.UNAVAILABLE,
                    sanitizeDetail(error instanceof Error ? error.message : String(error)),
                );
            }
            return unresolved(
                requestedRef,
                contextOwnerFromStep(step),
                SourceStatus.UNSUPPORTED,
                sanitizeDetail(error instanceof Error ? error.message : String(error)),
            );
        }
        return this.packageOutcome(current, request, outcome);
    }

    /** Package a seam outcome: honest status first, then validated rows. */
    private packageOutcome(
        mission: Mission,
        request: ContextRequest,
        outcome: SeamDispatchOutcome,
    ): ContextReadResult {
        const requestedRef = request.subject;
        const owner = contextOwnerFromCapabilityId(outcome.invocation.capabilityId);

        // Honest status: only COMPLETED invocations contribute content.
        // BLOCKED/pending/failed statuses degrade honestly — reconciliation
        // territory, never a silent fake success, never a blind replay.
        if (outcome.recordedStatus !== "completed") {
            return unresolved(
                requestedRef,
                owner,
                SourceStatus.UNAVAILABLE,
                sanitizeDetail(
                    `invocation status "${outcome.recordedStatus}" carries no compiled content (honest degradation; reconcile, never replay blindly)`,
                ),
            );
        }

        // Descriptor is read DATA-ONLY from the registry (the same source
        // the seam used); a vanished descriptor fails closed.
        let descriptor: CapabilityDescriptor | undefined;
        try {
            descriptor = this.registry.requireDescriptor(outcome.invocation.capabilityId);
        } catch {
            descriptor = undefined;
        }
        if (!descriptor) {
            return unresolved(
                requestedRef,
                owner,
                SourceStatus.UNSUPPORTED,
                "capability descriptor no longer present in the registry",
            );
        }

        const { rows, skipped } = rowsFromResult(outcome.result);
        for (const row of rows) {
            // Row-level prefix checks (descriptor contract + mission scope).
            if (!descriptor.allowedInputRefPrefixes.some((p) => row.sourceRef.startsWith(p))) {
                return unresolved(
                    sanitizeDetail(row.sourceRef),
                    owner,
                    SourceStatus.UNSUPPORTED,
                    "row sourceRef outside capability declared ref prefixes",
                );
            }
            if (
                !mission.allowedCapabilityScope.allowedRefPrefixes.some((p) =>
                    row.sourceRef.startsWith(p),
                )
            ) {
                return unresolved(
                    sanitizeDetail(row.sourceRef),
                    owner,
                    SourceStatus.REVOKED,
                    "row sourceRef outside mission allowed ref prefixes",
                );
            }
        }
        if (rows.length === 0) {
            return unresolved(
                requestedRef,
                owner,
                SourceStatus.UNSUPPORTED,
                skipped > 0
                    ? "connector returned no structurally valid context rows"
                    : "connector returned no context rows",
            );
        }
        const read: CompiledSourceRead = {
            descriptor: {
                capabilityId: descriptor.capabilityId,
                moduleOwner: descriptor.moduleOwner,
                contractVersion: descriptor.contractVersion,
                factRowsOnly: descriptor.factRowsOnly === true,
            },
            rows,
        };
        if (skipped > 0) {
            // Malformed sibling rows are recorded honestly on the read.
            read.skippedInvalidRows = skipped;
        }
        // The ONLY place a read is ever sealed: past every structural and
        // scope gate, straight from a seam-authorized result.
        return { ok: true, read: getSeamSeal()(read) };
    }
}

/** Honest refusal record (typed, sanitized — never compiler authority). */
function unresolved(
    requestedRef: string,
    owner: string,
    status: SourceStatus,
    detail: string,
): ContextReadResult {
    const record: UnresolvedSource = { requestedRef, owner, status, detail };
    return { ok: false, unresolved: record };
}

/**
 * Deterministic CURRENT-scope refusal (typed). Null = the read may proceed
 * to the seam. Mirrors the #62 policy vocabulary: capability allowlist,
 * READ effect class, mission ref prefixes.
 */
function scopeRefusal(
    mission: Mission,
    capabilityId: string,
    requestedRef: string,
): Omit<UnresolvedSource, "requestedRef" | "owner"> | null {
    const scope = mission.allowedCapabilityScope;
    if (!scope.capabilityIds.includes(capabilityId)) {
        return { status: SourceStatus.REVOKED, detail: "capability not authorized for this mission" };
    }
    if (!scope.allowedEffectClasses.includes(EffectClass.READ)) {
        return {
            status: SourceStatus.REVOKED,
            detail: "read effect class not authorized for this mission",
        };
    }
    if (!scope.allowedRefPrefixes.some((p) => requestedRef.startsWith(p))) {
        return {
            status: SourceStatus.REVOKED,
            detail: "subject outside mission allowed ref prefixes",
        };
    }
    return null;
}

/** Sanitize detail text (fail-closed against smuggling via error text). */
function sanitizeDetail(text: string): string {
    return text.replace(/[\r\n]+/g, " ").slice(0, 300);
}
