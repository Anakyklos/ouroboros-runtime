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
 * SEALED into a non-forgeable `SeamAuthorizedRead` owned by THIS module — the
 * ONLY form the compiler accepts — so external content cannot enter
 * compilation without having crossed the seam HERE. Caller-provided
 * `SeamDispatchOutcome` objects are NOT accepted: a plausible-shaped object
 * is not proof of authorization, and the engine exposes no API today to
 * prove invocation/result identity for outcomes dispatched elsewhere (that
 * proof needs #50-grade reconciliation records). If a read matters,
 * dispatch it through this reader.
 *
 * Authorization binding (round-3 review blocker): every seal and every
 * refusal batch carries an immutable `SeamAuthorizationEnvelope`
 * (missionId, the ACTUAL dispatched stepId, the capability that ran, the
 * subject scope that was validated). The compiler re-verifies that the
 * envelope belongs to the mission/request it is compiling — a payload
 * authorized for Mission A can never be reattributed to Mission B, and a
 * `request.stepId` that diverges from the really dispatched step fails
 * closed. Reader failures are NOT dropped: they are carried inside the
 * same sealed `SeamContextResolution` so the compiled package records
 * honest `unresolved` entries (unavailable/revoked/unsupported are data,
 * never silent).
 */

import type { CapabilityRegistryApi } from "../capabilities/registry.js";
import type { CapabilityDescriptor } from "../capabilities/contracts.js";
import type { SeamDispatchOutcome } from "../capabilities/dispatch-seam.js";
import { CapabilityUnavailableError, DispatchSeamError } from "../capabilities/dispatch-seam.js";
import type { MissionEngine } from "../mission/mission-engine.js";
import type { Mission } from "../mission/contracts.js";
import { EffectClass } from "../mission/contracts.js";
import { containsRawSecret } from "../mission/sanitize.js";
import type {
    CompiledSourceRead,
    ContextRequest,
    UnresolvedSource,
} from "./contracts.js";
import {
    ContextCompilerError,
    deepFreeze,
    EpistemicClass,
    SensitivityClass,
    SourceStatus,
} from "./contracts.js";

/** Immutable authorization envelope bound to a sealed resolution. The
 * compiler accepts a resolution ONLY when this envelope matches the
 * mission/request it is compiling (fail-closed re-binding). */
export interface SeamAuthorizationEnvelope {
    /** Mission that authorized the read(s) in this resolution. */
    missionId: string;
    /** The ACTUAL step dispatched through the seam ("" = pre-step refusal). */
    stepId: string;
    /** The capability that ran (or was attempted); "" = pre-step refusal. */
    capabilityId: string;
    /** The subject/inputRef scope validated against CURRENT mission state. */
    subject: string;
}

/** Compare two envelopes field-by-field (deterministic identity). */
function sameEnvelope(a: SeamAuthorizationEnvelope, b: SeamAuthorizationEnvelope): boolean {
    return (
        a.missionId === b.missionId &&
        a.stepId === b.stepId &&
        a.capabilityId === b.capabilityId &&
        a.subject === b.subject
    );
}

/**
 * 🔒 SeamAuthorizedRead — non-forgeable proof that a read crossed the
 * #63 `ConnectorDispatchSeam` boundary (review blockers, rounds 2+3). This
 * class lives HERE — in the reader module — so that the construction
 * token is module-private: this file exports the CLASS (for the
 * compiler's identity check) but NEVER the token or any seal factory.
 * Minting a sealed read is therefore structurally impossible outside
 * this module: no import of compiler.js, sources.js or anything else
 * can construct one (the constructor throws without the token, and the
 * private-field brand cannot be installed from outside). "Only the
 * reader can seal" is enforced by module visibility, not convention.
 * The wrapped payload is deep-frozen at sealing, and the seal carries
 * the immutable `SeamAuthorizationEnvelope` (mission/step/capability/
 * subject) that the compiler re-verifies: a payload authorized for
 * Mission A can never be reattributed to Mission B. The compiler's
 * input gate checks the class's PRIVATE brand (`#sealed in value`), not
 * merely `instanceof`, so prototype-chain forgeries are structurally
 * refused.
 */
export class SeamAuthorizedRead {
    readonly authorization: SeamAuthorizationEnvelope;
    readonly read: CompiledSourceRead;
    /** Brand (unforgeable): only the constructor after the token gate can
     * install this private field, and prototype manipulation cannot.
     * `Object.create(SeamAuthorizedRead.prototype)` with a forged `.read`
     * PASSES `instanceof` — the gate therefore checks the private brand,
     * never the prototype chain. */
    #sealed = true;

    constructor(
        authorization: SeamAuthorizationEnvelope,
        read: CompiledSourceRead,
        sealToken: symbol,
    ) {
        if (sealToken !== SEAM_SEAL_TOKEN) {
            throw new ContextCompilerError(
                "SeamAuthorizedRead cannot be constructed directly: reads are sealed only inside the SeamBoundContextReader (sources.ts)",
            );
        }
        this.authorization = deepFreeze({ ...authorization });
        this.read = deepFreeze(read) as CompiledSourceRead;
        Object.freeze(this);
    }

    /** Structural check: only genuinely sealed instances are authority.
     * Uses the private brand (`#sealed in value`), so a prototype-chain
     * forgery (Object.create of the class prototype) is refused — it has
     * no private field and cannot install one. Non-objects are refused
     * outright so every non-sealed input degrades to the same
     * ContextCompilerError (never a TypeError). */
    static isSealed(value: unknown): value is SeamAuthorizedRead {
        if (typeof value !== "object" || value === null) return false;
        return #sealed in value;
    }
}

/**
 * 🔒 SeamContextResolution — the opaque, scope-bound batch produced by the
 * reader for ONE dispatched step: the authorization envelope, the sealed
 * successful read(s), and the honest refusal record(s). Reader failures
 * (UNAVAILABLE/REVOKED/UNSUPPORTED) are carried INSIDE this sealed batch,
 * never dropped: the compiler incorporates them into the package's
 * `unresolved` so the planner can distinguish "there was no external
 * context" from "there was needed context but the source failed". Like
 * seals, resolutions are brand-checked and mintable only here; a
 * caller-forged `UnresolvedSource` can never enter the compiler.
 */
export class SeamContextResolution {
    readonly authorization: SeamAuthorizationEnvelope;
    readonly reads: SeamAuthorizedRead[];
    readonly unresolved: UnresolvedSource[];
    #sealed = true;

    constructor(
        authorization: SeamAuthorizationEnvelope,
        reads: SeamAuthorizedRead[],
        unresolved: UnresolvedSource[],
        sealToken: symbol,
    ) {
        if (sealToken !== SEAM_SEAL_TOKEN) {
            throw new ContextCompilerError(
                "SeamContextResolution cannot be constructed directly: resolutions are sealed only inside the SeamBoundContextReader (sources.ts)",
            );
        }
        // Mint-time consistency: every sealed read inside must carry the
        // SAME envelope — no read can drift from the resolution scope.
        for (const read of reads) {
            if (!sameEnvelope(read.authorization, authorization)) {
                throw new ContextCompilerError(
                    "resolution envelope must match every sealed read it wraps (drift refused at mint time)",
                );
            }
        }
        this.authorization = deepFreeze({ ...authorization });
        this.reads = deepFreeze([...reads]);
        this.unresolved = deepFreeze([...unresolved]);
        Object.freeze(this);
    }

    /** Structural check: only genuinely sealed resolutions are authority. */
    static isSealed(value: unknown): value is SeamContextResolution {
        if (typeof value !== "object" || value === null) return false;
        return #sealed in value;
    }
}

/** Module-private construction token. NOT exported — this file exports
 * the classes only. No other module can mint a seal or a resolution. */
const SEAM_SEAL_TOKEN = Symbol("context.compiler.seamSeal");

/** The ONE sealing authority, module-private: every legit production
 * read still flows through seam dispatch inside this reader (the call
 * sites sit in dispatchAndPackage/packageOutcome, after ALL gates). */
function sealRead(
    authorization: SeamAuthorizationEnvelope,
    read: CompiledSourceRead,
): SeamAuthorizedRead {
    return new SeamAuthorizedRead(authorization, read, SEAM_SEAL_TOKEN);
}

/** The ONE resolution mint, module-private: aggregates one step's result. */
function sealResolution(
    authorization: SeamAuthorizationEnvelope,
    reads: SeamAuthorizedRead[],
    unresolved: UnresolvedSource[],
): SeamContextResolution {
    return new SeamContextResolution(authorization, reads, unresolved, SEAM_SEAL_TOKEN);
}

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
 * are kept. Only opaque source refs and sanitized text cross this boundary;
 * rows whose IDENTITY fields (sourceRef/evidenceRefId) carry a raw secret
 * pattern are skipped — refs are never silently redacted (identity
 * changes), they fail closed.
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
        // Identity fields never carry raw secrets (round-3 blocker):
        // silently redacting a ref would change its identity, so rows that
        // smuggle a secret in sourceRef/evidenceRefId fail closed here.
        if (containsRawSecret(sourceRef) || (evidenceRefId !== undefined && containsRawSecret(evidenceRefId))) {
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

/** Refusal records never carry a raw secret: identity fields that failed
 * the secret gate are replaced by a placeholder (never redacted in place
 * — redaction would change the identity the record is about). */
function safeRequestedRef(ref: string): string {
    return containsRawSecret(ref) ? "[ref withheld: raw secret pattern detected]" : ref;
}

/**
 * 🔗 SeamBoundContextReader — produces sealed `SeamContextResolution`s for
 * the compiler by dispatching accepted plan steps through the #63 seam. The
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
     * Resolve ONE step's context into a sealed, scope-bound resolution.
     * A request WITHOUT ownerHint is mission-only (no external read, no
     * dispatch) and yields null. The request's stepId and the actual
     * dispatch step must AGREE: when `request.stepId` is present it IS the
     * dispatch step; an explicit conflicting `dispatchStepId` fails closed
     * (throw, no dispatch, no result). Reader failures are never dropped:
     * they come back inside the resolution's `unresolved`.
     */
    async read(
        mission: Mission,
        request: ContextRequest,
        options: { dispatchStepId?: string } = {},
    ): Promise<SeamContextResolution | null> {
        if (!request.ownerHint) return null; // mission-only compilation
        let dispatchStepId = options.dispatchStepId;
        if (request.stepId !== undefined) {
            if (dispatchStepId !== undefined && dispatchStepId !== request.stepId) {
                throw new ContextCompilerError(
                    `request.stepId ("${request.stepId}") conflicts with dispatchStepId ("${dispatchStepId}"): refusing to dispatch a different step than the request declares (fail-closed)`,
                );
            }
            dispatchStepId = request.stepId;
        }
        const envelope: SeamAuthorizationEnvelope = {
            missionId: mission.missionId,
            stepId: dispatchStepId ?? "",
            capabilityId: "",
            subject: request.subject,
        };
        // Identity fields never carry raw secrets (round-3 blocker): a
        // subject that smuggles a secret is refused BEFORE any dispatch —
        // no invocation is minted, and the refusal record carries a
        // placeholder, never the raw ref (refs are never redacted in
        // place; that would change the identity the record is about).
        if (containsRawSecret(request.subject)) {
            // The envelope's subject is the identity being refused: it
            // must never carry the raw secret either — use the same
            // placeholder the refusal record uses.
            const refusalEnvelope: SeamAuthorizationEnvelope = {
                ...envelope,
                subject: safeRequestedRef(request.subject),
            };
            return sealResolution(
                refusalEnvelope,
                [],
                [
                    unresolvedRecord(
                        safeRequestedRef(request.subject),
                        request.ownerHint,
                        SourceStatus.UNSUPPORTED,
                        "subject carries a raw secret pattern; identity/ref fields are never redacted (fail-closed, no dispatch)",
                    ),
                ],
            );
        }
        if (dispatchStepId === undefined) {
            // Honest refusal: external content was wanted but no step was
            // identified; NOT a silent empty success.
            return sealResolution(
                envelope,
                [],
                [
                    unresolvedRecord(
                        safeRequestedRef(request.subject),
                        request.ownerHint,
                        SourceStatus.UNSUPPORTED,
                        "external read requested but no dispatch step was identified (no stepId)",
                    ),
                ],
            );
        }
        const piece = await this.dispatchAndPackage(mission, request, dispatchStepId);
        if (piece.kind === "ok") {
            return sealResolution(
                piece.envelope,
                [sealRead(piece.envelope, piece.read)],
                [],
            );
        }
        return sealResolution(piece.envelope, [], [piece.unresolved]);
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
    ): Promise<
        | { kind: "ok"; envelope: SeamAuthorizationEnvelope; read: CompiledSourceRead }
        | { kind: "refused"; envelope: SeamAuthorizationEnvelope; unresolved: UnresolvedSource }
    > {
        const requestedRef = safeRequestedRef(request.subject);
        const label = request.ownerHint ?? "(unknown)";
        const refuse = (unresolved: UnresolvedSource) => ({
            kind: "refused" as const,
            envelope: {
                missionId: mission.missionId,
                stepId,
                capabilityId: "",
                subject: request.subject,
            },
            unresolved,
        });
        // Fresh authoritative mission state (never the caller's snapshot).
        const current = await this.engine.getMission(mission.missionId);

        // Current mission must still have an accepted plan (revocation-safe).
        if (!current.currentPlanRevisionId) {
            return refuse(
                unresolvedRecord(
                    requestedRef,
                    label,
                    SourceStatus.UNSUPPORTED,
                    "no accepted plan revision for this mission",
                ),
            );
        }
        const revision = await this.engine.getPlanRevision(current.currentPlanRevisionId);
        if (!revision || revision.missionId !== mission.missionId) {
            return refuse(
                unresolvedRecord(
                    requestedRef,
                    label,
                    SourceStatus.UNSUPPORTED,
                    "current plan revision is not readable for this mission",
                ),
            );
        }
        const step = revision.steps.find((s) => s.stepId === stepId);
        if (!step) {
            return refuse(
                unresolvedRecord(
                    requestedRef,
                    label,
                    SourceStatus.UNSUPPORTED,
                    `step "${stepId}" is not part of the accepted plan`,
                ),
            );
        }
        const stepEnvelope = (capabilityId: string): SeamAuthorizationEnvelope => ({
            missionId: mission.missionId,
            stepId,
            capabilityId,
            subject: request.subject,
        });
        // Read-only discipline: context compilation consumes READ steps.
        if (step.effectClass !== EffectClass.READ) {
            return refuse(
                unresolvedRecord(
                    requestedRef,
                    contextOwnerFromStep(step),
                    SourceStatus.UNSUPPORTED,
                    "accepted plan step is not a read",
                ),
            );
        }
        // Defense in depth against CURRENT state (policy gates re-run at
        // dispatch; these typed refusals precede any seam call).
        const revoked = scopeRefusal(current, step.capabilityRequirement, request.subject);
        if (revoked) {
            return {
                kind: "refused",
                envelope: stepEnvelope(step.capabilityRequirement),
                unresolved: unresolvedRecord(
                    requestedRef,
                    contextOwnerFromStep(step),
                    revoked.status,
                    revoked.detail,
                ),
            };
        }

        // Dispatch through the ONE seam. Refusals BEFORE invoke leave no
        // invocation minted; uncertainty AFTER invoke is preserved by the
        // seam itself (BLOCKED, never rewritten into success).
        let outcome: SeamDispatchOutcome;
        try {
            outcome = await this.seam.dispatchThroughSeam(mission.missionId, stepId);
        } catch (error) {
            if (error instanceof CapabilityUnavailableError) {
                return {
                    kind: "refused",
                    envelope: stepEnvelope(step.capabilityRequirement),
                    unresolved: unresolvedRecord(
                        requestedRef,
                        contextOwnerFromStep(step),
                        SourceStatus.UNAVAILABLE,
                        sanitizeDetail(error.detail ?? "capability unavailable"),
                    ),
                };
            }
            if (error instanceof DispatchSeamError) {
                // The seam already recorded the honest invocation state
                // (e.g. BLOCKED/uncertain after a connector throw): the
                // capability could not be consumed now — UNAVAILABLE with
                // the sanitized reason; reconciliation is engine territory.
                return {
                    kind: "refused",
                    envelope: stepEnvelope(step.capabilityRequirement),
                    unresolved: unresolvedRecord(
                        requestedRef,
                        contextOwnerFromStep(step),
                        SourceStatus.UNAVAILABLE,
                        sanitizeDetail(error instanceof Error ? error.message : String(error)),
                    ),
                };
            }
            return {
                kind: "refused",
                envelope: stepEnvelope(step.capabilityRequirement),
                unresolved: unresolvedRecord(
                    requestedRef,
                    contextOwnerFromStep(step),
                    SourceStatus.UNSUPPORTED,
                    sanitizeDetail(error instanceof Error ? error.message : String(error)),
                ),
            };
        }
        return this.packageOutcome(mission, request, step, outcome);
    }

    /** Package a seam outcome: honest status first, then validated rows. */
    private packageOutcome(
        mission: Mission,
        request: ContextRequest,
        step: { stepId: string; capabilityRequirement: string },
        outcome: SeamDispatchOutcome,
    ):
        | { kind: "ok"; envelope: SeamAuthorizationEnvelope; read: CompiledSourceRead }
        | { kind: "refused"; envelope: SeamAuthorizationEnvelope; unresolved: UnresolvedSource } {
        const requestedRef = safeRequestedRef(request.subject);
        const owner = contextOwnerFromCapabilityId(outcome.invocation.capabilityId);
        const envelope: SeamAuthorizationEnvelope = {
            missionId: mission.missionId,
            stepId: step.stepId,
            capabilityId: outcome.invocation.capabilityId,
            subject: request.subject,
        };
        const refuse = (unresolved: UnresolvedSource) => ({ kind: "refused" as const, envelope, unresolved });

        // Honest status: only COMPLETED invocations contribute content.
        // BLOCKED/pending/failed statuses degrade honestly — reconciliation
        // territory, never a silent fake success, never a blind replay.
        if (outcome.recordedStatus !== "completed") {
            return refuse(
                unresolvedRecord(
                    requestedRef,
                    owner,
                    SourceStatus.UNAVAILABLE,
                    sanitizeDetail(
                        `invocation status "${outcome.recordedStatus}" carries no compiled content (honest degradation; reconcile, never replay blindly)`,
                    ),
                ),
            );
        }
        // Plan/invocation drift is FAIL-CLOSED: the capability that ran
        // must be exactly the capability the dispatch step required.
        if (outcome.invocation.capabilityId !== step.capabilityRequirement) {
            return refuse(
                unresolvedRecord(
                    requestedRef,
                    owner,
                    SourceStatus.UNSUPPORTED,
                    "capability drift between accepted plan step and dispatched invocation",
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
            return {
                kind: "refused",
                envelope,
                unresolved: unresolvedRecord(
                    requestedRef,
                    owner,
                    SourceStatus.UNSUPPORTED,
                    "capability descriptor no longer present in the registry",
                ),
            };
        }

        const { rows, skipped } = rowsFromResult(outcome.result);
        for (const row of rows) {
            // Row-level prefix checks (descriptor contract + mission scope).
            if (!descriptor.allowedInputRefPrefixes.some((p) => row.sourceRef.startsWith(p))) {
                return {
                    kind: "refused",
                    envelope,
                    unresolved: unresolvedRecord(
                        safeRequestedRef(row.sourceRef),
                        owner,
                        SourceStatus.UNSUPPORTED,
                        "row sourceRef outside capability declared ref prefixes",
                    ),
                };
            }
            if (
                !mission.allowedCapabilityScope.allowedRefPrefixes.some((p) =>
                    row.sourceRef.startsWith(p),
                )
            ) {
                return {
                    kind: "refused",
                    envelope,
                    unresolved: unresolvedRecord(
                        safeRequestedRef(row.sourceRef),
                        owner,
                        SourceStatus.REVOKED,
                        "row sourceRef outside mission allowed ref prefixes",
                    ),
                };
            }
        }
        if (rows.length === 0) {
            return {
                kind: "refused",
                envelope,
                unresolved: unresolvedRecord(
                    requestedRef,
                    owner,
                    SourceStatus.UNSUPPORTED,
                    skipped > 0
                        ? "connector returned no structurally valid context rows"
                        : "connector returned no context rows",
                ),
            };
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
        return { kind: "ok", envelope, read };
    }
}

/** Honest refusal record (typed, sanitized — never compiler authority). */
function unresolvedRecord(
    requestedRef: string,
    owner: string,
    status: SourceStatus,
    detail: string,
): UnresolvedSource {
    return { requestedRef, owner, status, detail };
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