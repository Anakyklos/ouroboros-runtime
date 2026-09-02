/**
 * 🧩 Context Compiler (Issue #64)
 *
 * Deterministic, offline, provider-independent compilation of a Bounded
 * Context Package for a Mission.
 *
 * Structural authority rules enforced HERE (not by prompts):
 *  1. Mission-owned refs are compiled ONLY from the requesting Mission's
 *     own contextRefs — cross-mission references are refused.
 *  2. External content reaches the package ONLY through a non-forgeable
 *     `SeamContextResolution` (a sealed batch of `SeamAuthorizedRead`s +
 *     honest refusals) OWNED by the reader module (sources.ts), whose
 *     construction token is module-private and never exported. EVERY seal
 *     and refusal carries an immutable `SeamAuthorizationEnvelope`
 *     (missionId, actual dispatched stepId, capability that ran, subject
 *     scope); the compiler re-verifies the envelope against the mission
 *     and request it is compiling (round-3 blocker): cross-mission reuse
 *     and step reassignment fail closed. The compiler imports the classes
 *     only for identity checks — it holds NO seal, NO token and NO
 *     minting function, so it cannot widen what the boundary already
 *     authorized. A plain `{descriptor, rows}` object, a forged
 *     `CompiledSourceRead` or a caller-forged `UnresolvedSource` is
 *     structurally refused. There is NO caller-provided outcome path (no
 *     `alreadyAuthorized`): the engine exposes no API that proves
 *     invocation/result identity for a dispatch that happened elsewhere,
 *     so caller-supplied shapes are never authority — reads must flow
 *     through the reader, which dispatches and seals them in the same
 *     call.
 *  3. Budgets are NEVER taken from the requester as authority (review
 *     blocker 3): the proposed `ContextRequest.budget` is deterministically
 *     clamped to the runtime-owned `RequestBudgetPolicy` ceiling before
 *     use, and EVERY mutation of a package (compile, deriveSummary,
 *     addInference) re-runs the same class/dedup/budget pipeline and
 *     updates the honest budgetReport. A package can never exceed its
 *     effective budget — including after additions — and mutations are
 *     MONOTONICALLY NON-EXPANDING (review blocker, round 2): the
 *     package's recorded `budgetReport.limits` are the authorized ceiling;
 *     a mutating compiler can only keep or TIGHTEN them (the strictest
 *     across all compilers that touched the package), never widen them.
 *     The report additionally asserts observed ≤ limits; an over-budget
 *     package refuses to grow at all.
 *  4. External content is DATA and stays epistemically honest (review
 *     blocker 5): rows carry their source epistemic class; the compiler
 *     never defaults external content to FACT. A row without a declared
 *     class is refused (UNSUPPORTED) unless the capability contract
 *     explicitly guarantees fact-only rows.
 *  5. Freshness is honest (review blocker 4): with maxAgeMs, expiry is
 *     anchored to the SOURCE's own fetchedAt (fetchedAt + maxAgeMs), never
 *     to compilation time — recompiling does not renew validity. A source
 *     that cannot prove its age is STALE, never silently fresh.
 *  6. The package is deeply frozen inert data; provenance is
 *     compiler-computed (forge-proof); exclusions are recorded, never
 *     silent; one owner's failure never destroys other owners' items.
 *  7. Restart recomposition: compilation is a pure function of (durable
 *     Mission state, refs, seam-authorized reads, clock) — no prompt/output
 *     cache, no model calls, no network.
 *  8. No secrets/Authorization/CoT/raw provider responses are persisted:
 *     every string passes the shared sanitizers; unredactable secrets are
 *     refused with an honest exclusion record — never a silent leak.
 *  9. Sensitivity accompanies redaction (review blocker, round 2): a
 *     string that had to be sanitized can never carry NORMAL sensitivity.
 *     Whenever the sanitized content differs from its source, the item's
 *     provenance is marked REDACTED (and the source row is recorded as an
 *     honest exclusion); RESTRICTED rows remain reference-only. This one
 *     rule applies uniformly to mission-owned contextRefs, external rows,
 *     inferences and derived summaries.
 * 10. Restart is recomposition, not replay (review blocker, round 2):
 *     `recompileAfterRestart` accepts only the durable Mission, the
 *     request, the SAME seam-bound reader and a live compiler. External
 *     content is re-acquired through the #63 seam after restart; a
 *     package compiled before the restart is data, never authority, and
 *     blind redispatch of an already-dispatched step is refused by the
 *     engine (InvocationConflictError).
 * 11. Reader failures are never dropped (round-3 blocker): resolution
 *     batches carry honest `UnresolvedSource` records that the compiler
 *     incorporates into `package.unresolved`, so the planner can
distinguish
 *     "no external context needed" from "needed context failed honestly".
 * 12. Identity fields never carry raw secrets (round-3 blocker):
 *     `sourceRef`/`evidenceRefId`/`subject`/`ownerHint`/`stepId` fail
 *     closed on a raw secret pattern (refs are never redacted in place —
 *     that would change identity); free-form text (`purpose`) is
 *     sanitized once and stored sanitized only.
 */

import { createHash } from "node:crypto";

import type { Mission } from "../mission/contracts.js";
import {
    BoundedContextPackage,
    BudgetExclusion,
    CompiledSourceRead,
    CompiledSourceReadDescriptor,
    ContextCompilerError,
    ContextItem,
    ContextRequest,
    CONTEXT_COMPILER_CONTRACT_VERSION,
    DEFAULT_REQUEST_BUDGET_POLICY,
    deepFreeze,
    EpistemicClass,
    estimateTokens,
    ItemProvenance,
    RequestBudgetPolicy,
    SensitivityClass,
    SourceStatus,
    UnresolvedSource,
    clampBudget,
    type ContextRow,
} from "./contracts.js";
import { containsRawSecret, sanitizeText } from "../mission/sanitize.js";
import { SeamAuthorizedRead, SeamContextResolution } from "./sources.js";



/** Structural check: only genuinely sealed instances are authority. */
function isSeamAuthorizedRead(value: unknown): value is SeamAuthorizedRead {
    return SeamAuthorizedRead.isSealed(value);
}

/** Deterministic sha256 (hex) of a canonical JSON payload. */
function sha256Json(value: unknown): string {
    const stable = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(stable);
        if (v !== null && typeof v === "object") {
            const rec = v as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(rec).sort()) out[key] = stable(rec[key]);
            return out;
        }
        return v;
    };
    return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

/**
 * Deterministic item id: hash of provenance identity + content. The same
 * inputs always produce the same id (restart recomposition).
 */
function computeItemId(input: {
    owner: string;
    sourceRef: string;
    epistemicClass: EpistemicClass;
    content: string;
    missionId: string;
}): string {
    return `ctx-${sha256Json({
        owner: input.owner,
        sourceRef: input.sourceRef,
        epistemicClass: input.epistemicClass,
        content: input.content,
        missionId: input.missionId,
    }).slice(0, 24)}`;
}


/**
 * Deterministic package identity: hash of the FULL package content,
 * including the honest budgetReport — a package whose accounting was
 * tampered with is a different package.
 */
function computePackageId(pkg: Omit<BoundedContextPackage, "packageId">): string {
    return `pkg-${sha256Json(pkg).slice(0, 24)}`;
}

/** Dedup identity of an item (owner + class + content). */
function dedupKey(item: ContextItem): string {
    return sha256Json({
        owner: item.provenance.owner,
        epistemicClass: item.epistemicClass,
        content: item.content,
    });
}

/**
 * Sensitivity accompanies redaction (review blocker, round 2) — the ONE
 * consistent rule (Option A) for every sanitizeText inclusion: when the
 * compiled content differs from its raw source OR carries a [REDACTED]
 * marker (also covers pre-redacted durable state, e.g. engine-sanitized
 * contextRef labels), the item's provenance is REDACTED — never NORMAL
 * next to redaction markers.
 */
function redactionSensitivity(raw: string, content: string): SensitivityClass {
    return content !== raw || content.includes("[REDACTED]")
        ? SensitivityClass.REDACTED
        : SensitivityClass.NORMAL;
}

/**
 * 🧩 Context Compiler — the ONE entry point that turns (durable Mission
 * state, authorized refs, seam-authorized reads) into a bounded,
 * provenance-carrying, deeply frozen context package.
 */
export class ContextCompiler {
    private readonly clock: () => Date;
    private readonly budgetPolicy: RequestBudgetPolicy;

    constructor(
        options: { clock?: () => Date; budgetPolicy?: RequestBudgetPolicy } = {},
    ) {
        this.clock = options.clock ?? (() => new Date());
        this.budgetPolicy = options.budgetPolicy ?? DEFAULT_REQUEST_BUDGET_POLICY;
    }

    private isoNow(): string {
        return this.clock().toISOString();
    }

    /**
     * Effective (clamped) budget for a request — deterministic. A missing
     * budget is INVALID (fail-closed): the compiler refuses to guess.
     */
    private effectiveBudget(request: ContextRequest): {
        effective: ReturnType<typeof clampBudget>;
        clamped: boolean;
        budget: {
            maxItems: number;
            maxTotalChars: number;
            maxEstimatedTokens: number;
        };
    } {
        if (
            request.budget === undefined ||
            request.budget === null ||
            typeof request.budget !== "object"
        ) {
            throw new ContextCompilerError(
                "ContextRequest.budget is missing — the compiler never compiles unbounded (fail-closed)",
            );
        }
        const b = request.budget as {
            maxItems?: unknown;
            maxTotalChars?: unknown;
            maxEstimatedTokens?: unknown;
        };
        for (const key of ["maxItems", "maxTotalChars", "maxEstimatedTokens"] as const) {
            if (typeof b[key] !== "number" || !Number.isFinite(b[key] as number)) {
                throw new ContextCompilerError(
                    `ContextRequest.budget.${key} is missing or not a finite number (fail-closed)`,
                );
            }
        }
        const budget = request.budget as {
            maxItems: number;
            maxTotalChars: number;
            maxEstimatedTokens: number;
        };
        const effective = clampBudget(budget, this.budgetPolicy);
        const clamped =
            effective.maxItems !== budget.maxItems ||
            effective.maxTotalChars !== budget.maxTotalChars ||
            effective.maxEstimatedTokens !== budget.maxEstimatedTokens;
        return { effective, clamped, budget };
    }

    /**
     * Compile the package. Deterministic and PURE with respect to its
     * inputs (mission, request, SEALED seam-authorized reads, clock): the
     * same durable Mission state + refs + reads always recompose the same
     * package. No caches, no model calls, no network.
     *
     * Structural closure (review blocker, round 2): external content is
     * accepted ONLY as non-forgeable `SeamAuthorizedRead`s produced by the
     * SeamBoundContextReader. A raw `{descriptor, rows}` or a forged
     * `CompiledSourceRead` is refused BEFORE any item is produced — the
     * whole compilation fails closed.
     */
    compile(
        mission: Mission,
        request: ContextRequest,
        resolutions: SeamContextResolution[],
    ): BoundedContextPackage {
        // Gate 0 — declarative request sanity (fail-closed budgets: a
        // missing/invalid budget never compiles an unbounded package).
        if (!request.subject.trim() || !request.purpose.trim()) {
            throw new ContextCompilerError(
                "ContextRequest must declare a non-empty subject and purpose",
            );
        }
        // Gate 1 — the request must belong to THIS mission (fail-closed:
        // a package compiled for another mission is never produced).
        if (request.missionId !== mission.missionId) {
            throw new ContextCompilerError(
                `ContextRequest targets mission "${request.missionId}" but compilation was requested for "${mission.missionId}"`,
            );
        }
        // ONE normalization pass over the request (round-3 blocker):
        // identity/ref fields (subject/ownerHint/stepId) fail closed on a
        // raw secret pattern — refs are never redacted in place, that
        // would change identity; free-form purpose is sanitized ONCE and
        // ONLY the sanitized form is stored (package.request snapshot AND
        // every provenance field), so no raw/sanitized split can leak.
        const normalized = normalizeRequest(request);
        const { effective, clamped, budget } = this.effectiveBudget(normalized);
        if (
            effective.maxItems <= 0 ||
            effective.maxTotalChars <= 0 ||
            effective.maxEstimatedTokens <= 0
        ) {
            throw new ContextCompilerError(
                "ContextRequest.budget is invalid or clamps to an empty budget (fail-closed)",
            );
        }
        // Gate 1b — structural closure on external input: every entry must
        // be a genuinely sealed SeamContextResolution. Plain objects,
        // forged resolutions and caller-forged UnresolvedSources are
        // refused, never silently coerced into authority.
        for (const resolution of resolutions) {
            if (!SeamContextResolution.isSealed(resolution)) {
                throw new ContextCompilerError(
                    "external content must arrive as SeamContextResolution values produced by the SeamBoundContextReader; raw descriptor/rows objects or forged unresolved records are not authority (fail-closed)",
                );
            }
        }
        // Gate 1c — authorization envelope re-binding (round-3 blocker):
        // every sealed batch must belong to THIS mission/request. A seal
        // authorized for Mission A can never be reattributed to Mission B;
        // a seal from step A can never be compiled under step B; the
        // subject scope and capability must match the request/mission.
        for (const resolution of resolutions) {
            this.assertResolutionBound(resolution, mission, normalized);
        }

        const now = this.isoNow();
        const items: ContextItem[] = [];
        const unresolved: UnresolvedSource[] = [];
        const excluded: BudgetExclusion[] = [];

        // ── Phase A: mission-owned references (durable, authorized) ───
        // A request WITHOUT an ownerHint is mission-only: contextRefs are
        // compiled WITHOUT any seam read (blocker 1 test contract).
        // Sensitivity accompanies redaction (review blocker, round 2): a
        // label that had to be sanitized is compiled as REDACTED, never
        // as NORMAL. Identity fields fail closed on raw secrets (round-3
        // blocker): a contextRef whose externalRef smuggles a secret is
        // excluded with an honest record — refs are never redacted in
        // place.
        for (const owned of mission.contextRefs) {
            if (containsRawSecret(owned.externalRef)) {
                excluded.push({
                    itemId: `secret:${sha256Json({ ref: owned.externalRef }).slice(0, 24)}`,
                    reason: "secret_in_identity",
                });
                continue;
            }
            const rawLabel = owned.label;
            const ownedContent = sanitizeText(rawLabel);
            const ownedRedacted = redactionSensitivity(rawLabel, ownedContent);
            items.push({
                itemId: computeItemId({
                    owner: owned.owner,
                    sourceRef: owned.externalRef,
                    epistemicClass: EpistemicClass.FACT,
                    content: ownedContent,
                    missionId: mission.missionId,
                }),
                epistemicClass: EpistemicClass.FACT,
                content: ownedContent,
                provenance: {
                    owner: owned.owner,
                    sourceRef: owned.externalRef,
                    fetchedAt: now,
                    authorization: `authorized by ${sanitizeText(owned.authorizedBy)} via MissionIntent.contextRefs`,
                    missionId: mission.missionId,
                    purpose: sanitizeText(normalized.purpose),
                    sensitivity: ownedRedacted,
                    origin: "mission_owned",
                },
            });
        }

        // ── Phase B: seam-authorized external reads (#63 boundary) ────
        // `resolutions` are sealed SeamContextResolution batches produced
        // ONLY by the SeamBoundContextReader from ConnectorDispatchSeam-
        // authorized results; reader failures (unavailable/revoked/
        // unsupported) are carried inside and recorded in unresolved —
        // never dropped (round-3 blocker). The compiler never defaults
        // external content to FACT (blocker 5).
        for (const resolution of resolutions) {
            for (const refusal of resolution.unresolved) {
                unresolved.push(refusal);
            }
            for (const outcome of resolution.reads) {
                const envelope = outcome.authorization;
                const outcomeRead = outcome.read;
                if (outcomeRead.skippedInvalidRows !== undefined && outcomeRead.skippedInvalidRows > 0) {
                    unresolved.push({
                        requestedRef: sanitizeText(outcomeRead.descriptor.capabilityId),
                        owner: outcomeRead.descriptor.moduleOwner,
                        status: SourceStatus.UNSUPPORTED,
                        detail: `${outcomeRead.skippedInvalidRows} malformed row(s) skipped by structural validation`,
                    });
                }
                for (const row of outcomeRead.rows) {
                    // Identity secret gate FIRST (round-3 blocker): a row
                    // whose sourceRef/evidenceRefId carries a raw secret
                    // is excluded with an honest record — silently
                    // redacting a ref would change its identity, so refs
                    // fail closed (they never reach provenance.sourceRef,
                    // item id sources, restricted reference-only text,
                    // evidenceRefId or unresolved records).
                    if (
                        containsRawSecret(row.sourceRef) ||
                        (row.evidenceRefId !== undefined && containsRawSecret(row.evidenceRefId))
                    ) {
                        excluded.push({
                            itemId: `secret:${sha256Json({
                                ref: row.sourceRef,
                                evidenceRefId: row.evidenceRefId,
                            }).slice(0, 24)}`,
                            reason: "secret_in_identity",
                        });
                        continue;
                    }
                    // Sanitize BEFORE classification. Unredactable secret-like
                    // content is EXCLUDED with an honest record — never a
                    // silent carry, never a silent drop.
                    const rawContent = row.content;
                    const content = sanitizeText(rawContent);
                    // Sensitivity accompanies redaction (review blocker,
                    // round 2): content that NEEDED sanitizing — or arrived
                    // pre-redacted — is carried with REDACTED sensitivity,
                    // never NORMAL next to redaction markers. An unredactable
                    // secret-like string is refused outright below.
                    const rowRedacted = redactionSensitivity(rawContent, content);
                    if (containsRawSecret(content)) {
                        excluded.push({
                            itemId: `secret:${sha256Json({ ref: row.sourceRef, content }).slice(0, 24)}`,
                            reason: "secret_refused",
                        });
                        continue;
                    }

                    // Epistemic class: the SOURCE declares it (blocker 5).
                    // No silent promotion to FACT, ever. A row without a class
                    // is refused unless the descriptor contract explicitly
                    // guarantees fact-only rows for this capability.
                    const itemClass = rowClassOf(row, outcomeRead.descriptor);
                    if (itemClass === undefined) {
                        unresolved.push({
                            requestedRef: sanitizeText(row.sourceRef),
                            owner: outcomeRead.descriptor.moduleOwner,
                            status: SourceStatus.UNSUPPORTED,
                            detail:
                                "row carried no epistemic classification and the capability does not declare fact-only rows",
                        });
                        continue;
                    }

                    // RESTRICTED stays RESTRICTED (the stricter class wins);
                    // redaction only ever upgrades NORMAL to REDACTED.
                    const declaredSensitivity = row.sensitivity ?? SensitivityClass.NORMAL;
                    const sensitivity =
                        declaredSensitivity === SensitivityClass.RESTRICTED
                            ? SensitivityClass.RESTRICTED
                            : rowRedacted === SensitivityClass.REDACTED
                              ? SensitivityClass.REDACTED
                              : declaredSensitivity;
                    if (sensitivity === SensitivityClass.RESTRICTED) {
                        // Owner-declared restricted: reference-only, no content.
                        items.push({
                            itemId: computeItemId({
                                owner: outcomeRead.descriptor.moduleOwner,
                                sourceRef: row.sourceRef,
                                epistemicClass: itemClass,
                                content: "(restricted)",
                                missionId: mission.missionId,
                            }),
                            epistemicClass: itemClass,
                            content: `(restricted: reference-only ${row.sourceRef})`,
                            provenance: this.externalProvenance(
                                outcomeRead.descriptor,
                                row,
                                normalized,
                                now,
                                sensitivity,
                                expiryFor(row, normalized, now),
                                envelope.stepId,
                            ),
                        });
                        continue;
                    }

                    // Freshness: fail-closed. A freshness requirement with a
                    // source that cannot prove its age is STALE, not fresh.
                    // Expiry anchors to the SOURCE's fetchedAt (blocker 4):
                    // recompiling later never renews validity.
                    if (normalized.maxAgeMs !== undefined) {
                        const nowMs = Date.parse(now);
                        const fetchedMs =
                            row.fetchedAt !== undefined ? Date.parse(row.fetchedAt) : Number.NaN;
                        const age = Number.isNaN(fetchedMs) ? Number.NaN : nowMs - fetchedMs;
                        if (Number.isNaN(age) || age > normalized.maxAgeMs) {
                            unresolved.push({
                                requestedRef: sanitizeText(row.sourceRef),
                                owner: outcomeRead.descriptor.moduleOwner,
                                status: SourceStatus.STALE,
                                detail: Number.isNaN(age)
                                    ? "freshness required but the source carried no valid timestamp"
                                    : "row age exceeds the request's maxAgeMs",
                            });
                            continue;
                        }
                    }

                    items.push({
                        itemId: computeItemId({
                            owner: outcomeRead.descriptor.moduleOwner,
                            sourceRef: row.sourceRef,
                            epistemicClass: itemClass,
                            content,
                            missionId: mission.missionId,
                        }),
                        epistemicClass: itemClass,
                        content,
                        provenance: this.externalProvenance(
                            outcomeRead.descriptor,
                            row,
                            normalized,
                            now,
                            sensitivity,
                            expiryFor(row, normalized, now),
                            envelope.stepId,
                        ),
                    });
                }
            }
        }

        // ── Phase C: minimal disclosure + dedup + deterministic budget ─
        const capped = this.capPipeline(items, normalized, effective, excluded);

        const budgetReport = {
            limits: {
                maxItems: effective.maxItems,
                maxTotalChars: effective.maxTotalChars,
                maxEstimatedTokens: effective.maxEstimatedTokens,
            },
            proposed: {
                maxItems: budget.maxItems,
                maxTotalChars: budget.maxTotalChars,
                maxEstimatedTokens: budget.maxEstimatedTokens,
            },
            clamped,
            observed: {
                items: capped.length,
                totalChars: capped.reduce((sum, i) => sum + i.content.length, 0),
                estimatedTokens: estimateTokens(
                    capped.reduce((sum, i) => sum + i.content.length, 0),
                ),
            },
            excluded,
        };

        // packageId is the deterministic hash of the full package content
        // (including the honest report); it is set BEFORE deep-freeze
        // (frozen objects reject assignment).
        const unfrozen: Omit<BoundedContextPackage, "packageId"> & { packageId: string } = {
            packageId: "",
            contractVersion: CONTEXT_COMPILER_CONTRACT_VERSION,
            missionId: mission.missionId,
            stepId: normalized.stepId,
            compiledAt: now,
            request: JSON.parse(JSON.stringify(normalized)) as ContextRequest,
            items: capped,
            unresolved,
            budgetReport,
        };
        unfrozen.packageId = computePackageId(unfrozen);
        return deepFreeze(unfrozen) as BoundedContextPackage;
    }

    /**
     * Round-3 blocker: re-bind every sealed resolution to THIS mission and
     * request. The seal proves "this payload crossed the seam FOR this
     * mission, under this step, this capability, this subject scope" —
     * the compiler refuses anything else: cross-mission reuse, step
     * reassignment, subject divergence and capability drift all fail
     * closed. Refused-only resolutions (honest reader failures) must still
     * bind to the mission/request; sealed reads additionally must belong
     * to a capability the mission actually authorizes.
     */
    private assertResolutionBound(
        resolution: SeamContextResolution,
        mission: Mission,
        request: ContextRequest,
    ): void {
        const auth = resolution.authorization;
        if (auth.missionId !== mission.missionId) {
            throw new ContextCompilerError(
                `sealed resolution is bound to mission "${auth.missionId}" but compilation is for "${mission.missionId}" (cross-mission reuse refused)`,
            );
        }
        if (request.stepId !== undefined && auth.stepId !== request.stepId) {
            throw new ContextCompilerError(
                `sealed resolution dispatched step "${auth.stepId}" but the request declares step "${request.stepId}" (step reassignment refused)`,
            );
        }
        if (auth.subject !== request.subject) {
            throw new ContextCompilerError(
                `sealed resolution subject "${auth.subject}" diverges from request subject "${request.subject}" (scope divergence refused)`,
            );
        }
        for (const read of resolution.reads) {
            if (!SeamAuthorizedRead.isSealed(read)) {
                throw new ContextCompilerError(
                    "resolution wraps a non-sealed read (fail-closed)",
                );
            }
            const readAuth = read.authorization;
            if (
                readAuth.missionId !== auth.missionId ||
                readAuth.stepId !== auth.stepId ||
                readAuth.capabilityId !== auth.capabilityId ||
                readAuth.subject !== auth.subject
            ) {
                throw new ContextCompilerError(
                    "sealed read envelope drifts from its resolution (fail-closed)",
                );
            }
            if (read.read.descriptor.capabilityId !== auth.capabilityId) {
                throw new ContextCompilerError(
                    `sealed read descriptor capability "${read.read.descriptor.capabilityId}" drifts from envelope capability "${auth.capabilityId}" (fail-closed)`,
                );
            }
            if (!mission.allowedCapabilityScope.capabilityIds.includes(auth.capabilityId)) {
                throw new ContextCompilerError(
                    `sealed read capability "${auth.capabilityId}" is not authorized for mission "${mission.missionId}" (fail-closed)`,
                );
            }
        }
    }

    /**
     * Derive a bounded summary over EXPLICITLY selected source items. The
     * summary is a NEW item of class derived_summary that KEEPS the source
     * item ids — reduction never destroys the reconstructible relation to
     * facts. Deriving FROM an inference is refused (inferences may not
     * masquerade as summaries-of-facts) and deriving FROM restricted
     * (reference-only) sources is refused. The addition passes the SAME
     * class/dedup/budget pipeline as compilation (blocker 3).
     */
    deriveSummary(
        pkg: BoundedContextPackage,
        spec: { sourceItemIds: string[]; maxChars: number },
    ):
        | { ok: true; item: ContextItem; package: BoundedContextPackage }
        | { ok: false; reason: string } {
        const ids = new Set(spec.sourceItemIds);
        const sources = pkg.items.filter((i) => ids.has(i.itemId));
        if (sources.length !== spec.sourceItemIds.length) {
            return { ok: false, reason: "one or more source item ids are not in the package" };
        }
        if (sources.some((s) => s.epistemicClass === EpistemicClass.INFERENCE)) {
            return {
                ok: false,
                reason: "cannot derive from an inference item (only facts/summaries)",
            };
        }
        if (
            sources.some((s) => s.provenance.sensitivity === SensitivityClass.RESTRICTED)
        ) {
            return {
                ok: false,
                reason: "cannot derive from restricted (reference-only) sources",
            };
        }
        if (sources.length === 0) {
            return { ok: false, reason: "no source items selected" };
        }
        const sourcesById = new Map(pkg.items.map((i) => [i.itemId, i]));
        const ordered = spec.sourceItemIds
            .map((id) => sourcesById.get(id))
            .filter((s): s is ContextItem => s !== undefined);
        const joined = ordered
            .map((s) => s.content)
            .join(" | ")
            .slice(0, Math.max(1, spec.maxChars));
        const rawJoined = joined;
        const content = sanitizeText(rawJoined);
        const summaryRedacted = redactionSensitivity(rawJoined, content);
        if (containsRawSecret(content)) {
            return {
                ok: false,
                reason: "derived summary would carry an unredactable secret (refused)",
            };
        }
        const summaryItem: ContextItem = {
            itemId: computeItemId({
                owner: "ouroboros.compiler",
                sourceRef: `derived:first:${ordered.length}`,
                epistemicClass: EpistemicClass.DERIVED_SUMMARY,
                content,
                missionId: pkg.missionId,
            }),
            epistemicClass: EpistemicClass.DERIVED_SUMMARY,
            content,
            provenance: {
                owner: "ouroboros.compiler",
                sourceRef: `derived:first:${ordered.length}`,
                sourceVersion: CONTEXT_COMPILER_CONTRACT_VERSION,
                fetchedAt: this.isoNow(),
                authorization: `derived from ${ordered.length} compiled item(s) by deterministic reduction "first:${ordered.length}"; sources remain reconstructible`,
                missionId: pkg.missionId,
                purpose: sanitizeText(pkg.request.purpose),
                sensitivity: summaryRedacted,
                origin: "mission_owned",
            },
            derivedFrom: ordered.map((s) => s.itemId),
            derivationOp: `first:${ordered.length}`,
        };
        return this.appendItems(pkg, [summaryItem]);
    }

    /**
     * Add an EXPLICIT, provenance-carrying inference submitted by the
     * requester side (e.g. planner). Compiled as INFERENCE — never
     * promoted to fact, never silently blended into derived summaries.
     * The addition passes the SAME class/dedup/budget pipeline as
     * compilation (blocker 3): a FACT-only request refuses it, a full
     * package refuses it, and the report stays honest.
     */
    addInference(
        pkg: BoundedContextPackage,
        spec: { content: string; refId: string },
    ):
        | { ok: true; item: ContextItem; package: BoundedContextPackage }
        | { ok: false; reason: string } {
        const rawContent = spec.content;
        const content = sanitizeText(rawContent);
        const inferenceRedacted = redactionSensitivity(rawContent, content);
        if (containsRawSecret(content)) {
            return { ok: false, reason: "inference carries an unredactable secret (refused)" };
        }
        const item: ContextItem = {
            itemId: computeItemId({
                owner: "planner",
                sourceRef: `inference:${spec.refId}`,
                epistemicClass: EpistemicClass.INFERENCE,
                content,
                missionId: pkg.missionId,
            }),
            epistemicClass: EpistemicClass.INFERENCE,
            content,
            provenance: {
                owner: "planner",
                sourceRef: `inference:${sanitizeText(spec.refId)}`,
                fetchedAt: this.isoNow(),
                authorization:
                    "declared by the requester as an inference; NOT a fact and never promoted",
                missionId: pkg.missionId,
                purpose: sanitizeText(pkg.request.purpose),
                sensitivity: inferenceRedacted,
                origin: "external_owner",
            },
        };
        return this.appendItems(pkg, [item]);
    }

    /**
     * The ONE mutation pipeline (blocker 3): every package addition —
     * compile, deriveSummary, addInference — passes the same gates in the
     * same deterministic order: requestedClasses → dedup → budget. The
     * budgetReport is recomputed honestly and the package identity is
     * recomputed over the full content. A refusal is typed, never silent.
     */
    private appendItems(
        pkg: BoundedContextPackage,
        additions: ContextItem[],
    ):
        | { ok: true; item: ContextItem; package: BoundedContextPackage }
        | { ok: false; reason: string } {
        const item = additions[0];
        const excluded: BudgetExclusion[] = [];

        // Gate 0 — MONOTONIC NON-EXPANSION (review blocker, round 2): the
        // package's recorded limits are the AUTHORIZED ceiling. The
        // mutating instance's own policy can keep or TIGHTEN them (the
        // strictest across all compilers that touched the package) — it can
        // never widen them, so a loose compiler cannot expand a package
        // compiled under a stricter policy.
        const own = this.effectiveBudget(pkg.request).effective;
        const inherited = pkg.budgetReport.limits;
        const effective = {
            maxItems: Math.min(own.maxItems, inherited.maxItems),
            maxTotalChars: Math.min(own.maxTotalChars, inherited.maxTotalChars),
            maxEstimatedTokens: Math.min(own.maxEstimatedTokens, inherited.maxEstimatedTokens),
        };
        // Over-budget honesty: if observed ever exceeds the inherited
        // ceiling (e.g. hand-built input), the package refuses to grow at
        // all — never launder an over-budget state.
        const observedNow = {
            items: pkg.items.length,
            totalChars: pkg.items.reduce((sum, i) => sum + i.content.length, 0),
            estimatedTokens: estimateTokens(
                pkg.items.reduce((sum, i) => sum + i.content.length, 0),
            ),
        };
        const alreadyOverBudget =
            observedNow.items > inherited.maxItems ||
            observedNow.totalChars > inherited.maxTotalChars ||
            observedNow.estimatedTokens > inherited.maxEstimatedTokens;
        if (alreadyOverBudget) {
            return {
                ok: false,
                reason: "package already exceeds its recorded budget limits (refusing to grow an over-budget package)",
            };
        }

        // Gate 1 — minimal disclosure (requestedClasses still authority).
        const requested = pkg.request.requestedClasses;
        if (requested && !requested.includes(item.epistemicClass)) {
            return {
                ok: false,
                reason: `epistemic class "${item.epistemicClass}" is not requested by the original request (minimal disclosure)`,
            };
        }

        // Gate 2 — dedup (identical owner+class+content already present).
        const key = dedupKey(item);
        if (pkg.items.some((existing) => dedupKey(existing) === key)) {
            excluded.push({ itemId: item.itemId, reason: "duplicate" });
            return { ok: false, reason: "identical item already in the package (duplicate)" };
        }

        const totalChars = pkg.items.reduce((sum, i) => sum + i.content.length, 0);
        const nextChars = totalChars + item.content.length;
        if (pkg.items.length + 1 > effective.maxItems) {
            return { ok: false, reason: "package is at its maxItems budget (scope_exceeded)" };
        }
        if (nextChars > effective.maxTotalChars) {
            return { ok: false, reason: "addition exceeds maxTotalChars budget (scope_exceeded)" };
        }
        if (estimateTokens(nextChars) > effective.maxEstimatedTokens) {
            return {
                ok: false,
                reason: "addition exceeds maxEstimatedTokens budget (scope_exceeded)",
            };
        }

        // Honest accounting: the new package's report reflects the addition.
        const items = [...pkg.items, item];
        const budgetReport = {
            limits: { ...effective },
            proposed: { ...pkg.budgetReport.proposed },
            clamped: pkg.budgetReport.clamped || this.budgetPolicy !== DEFAULT_REQUEST_BUDGET_POLICY,
            observed: {
                items: items.length,
                totalChars: nextChars,
                estimatedTokens: estimateTokens(nextChars),
            },
            excluded: [...pkg.budgetReport.excluded, ...excluded],
        };
        const unfrozen: Omit<BoundedContextPackage, "packageId"> & { packageId: string } = {
            packageId: "",
            contractVersion: pkg.contractVersion,
            missionId: pkg.missionId,
            stepId: pkg.stepId,
            compiledAt: pkg.compiledAt,
            request: JSON.parse(JSON.stringify(pkg.request)) as ContextRequest,
            items,
            unresolved: [...pkg.unresolved],
            budgetReport,
        };
        unfrozen.packageId = computePackageId(unfrozen);
        return { ok: true, item, package: deepFreeze(unfrozen) as BoundedContextPackage };
    }

    /**
     * Shared Phase-C reduction: class filter, dedup, deterministic order,
     * budget caps — every exclusion recorded, never silent.
     */
    private capPipeline(
        items: ContextItem[],
        request: ContextRequest,
        effective: ReturnType<typeof clampBudget>,
        excluded: BudgetExclusion[],
    ): ContextItem[] {
        let candidates = items;
        if (request.requestedClasses) {
            const allowed = new Set(request.requestedClasses);
            candidates = items.filter((item) => {
                if (allowed.has(item.epistemicClass)) return true;
                excluded.push({ itemId: item.itemId, reason: "class_not_requested" });
                return false;
            });
        }

        const unique = new Map<string, ContextItem>();
        for (const item of candidates) {
            const key = dedupKey(item);
            if (unique.has(key)) {
                excluded.push({ itemId: item.itemId, reason: "duplicate" });
                continue;
            }
            unique.set(key, item);
        }

        const sorted = [...unique.values()].sort(
            (a, b) =>
                a.epistemicClass.localeCompare(b.epistemicClass) ||
                a.provenance.owner.localeCompare(b.provenance.owner) ||
                a.provenance.sourceRef.localeCompare(b.provenance.sourceRef) ||
                a.itemId.localeCompare(b.itemId),
        );

        const capped: ContextItem[] = [];
        let totalChars = 0;
        for (const item of sorted) {
            if (capped.length >= effective.maxItems) {
                excluded.push({ itemId: item.itemId, reason: "scope_exceeded" });
                continue;
            }
            const nextTotal = totalChars + item.content.length;
            if (nextTotal > effective.maxTotalChars) {
                excluded.push({ itemId: item.itemId, reason: "scope_exceeded" });
                continue;
            }
            if (estimateTokens(nextTotal) > effective.maxEstimatedTokens) {
                excluded.push({ itemId: item.itemId, reason: "scope_exceeded" });
                continue;
            }
            capped.push(item);
            totalChars = nextTotal;
        }
        return capped;
    }

    /** Compiler-computed provenance for an external row (connector-proof). */
    private externalProvenance(
        descriptor: CompiledSourceReadDescriptor,
        row: Pick<ContextRow, "sourceRef" | "fetchedAt" | "evidenceRefId">,
        request: ContextRequest,
        now: string,
        sensitivity: SensitivityClass,
        expiresAt: string | undefined,
        stepId: string,
    ): ItemProvenance {
        return {
            owner: descriptor.moduleOwner,
            sourceRef: row.sourceRef,
            sourceVersion: descriptor.contractVersion,
            fetchedAt: row.fetchedAt ?? now,
            authorization: `capability:${descriptor.capabilityId}`,
            missionId: request.missionId,
            stepId,
            purpose: sanitizeText(request.purpose),
            expiresAt,
            sensitivity,
            origin: "external_owner",
            evidenceRefId: row.evidenceRefId,
        };
    }
}

/**
 * Resolve a row's epistemic class. Returns undefined when the row carries
 * no class and the capability does NOT declare fact-only rows — the caller
 * must refuse it (never default to FACT).
 */
function rowClassOf(
    row: Pick<ContextRow, "epistemicClass">,
    descriptor: CompiledSourceReadDescriptor,
): EpistemicClass | undefined {
    if (row.epistemicClass !== undefined) return row.epistemicClass;
    if (descriptor.factRowsOnly === true) return EpistemicClass.FACT;
    return undefined;
}

/**
 * Honest expiry (blocker 4): anchored to the SOURCE's own fetchedAt —
 * fetchedAt + maxAgeMs — so recompiling never renews validity. When the
 * request declares maxAgeMs but the row carries no usable timestamp the
 * row is STALE (handled by the caller); expiry is simply undefined here.
 */
function expiryFor(
    row: Pick<ContextRow, "fetchedAt">,
    request: ContextRequest,
    _now: string,
): string | undefined {
    if (request.maxAgeMs === undefined) return undefined;
    const fetchedMs = row.fetchedAt !== undefined ? Date.parse(row.fetchedAt) : Number.NaN;
    if (Number.isNaN(fetchedMs)) return undefined;
    return new Date(fetchedMs + request.maxAgeMs).toISOString();
}

/**
 * ONE normalization pass over the request (round-3 blocker): identity/ref
 * fields (subject, ownerHint, stepId) FAIL CLOSED when they carry a raw
 * secret pattern — silently redacting a ref would change its identity, so
 * refs are never redacted in place. Free-form `purpose` is sanitized
 * deterministically ONCE; the returned request (and ONLY it) is what the
 * package snapshot and every provenance field use, so no raw/sanitized
 * split can exist between package.request and provenance.
 */
function normalizeRequest(request: ContextRequest): ContextRequest {
    const identityFields: Array<[string, string | undefined]> = [
        ["subject", request.subject],
        ["ownerHint", request.ownerHint],
        ["stepId", request.stepId],
    ];
    for (const [field, value] of identityFields) {
        if (value !== undefined && containsRawSecret(value)) {
            throw new ContextCompilerError(
                `ContextRequest.${field} carries a raw secret pattern; identity/ref fields are never silently redacted (fail-closed)`,
            );
        }
    }
    return { ...request, purpose: sanitizeText(request.purpose) };
}

/**
 * Restart recomposition entry point (review blocker, round 2). Recompiles
 * the package from the DURABLE Mission state and the SAME request —
 * mission-owned contextRefs flow from durable storage; external content is
 * NEVER carried across the restart: it must be RE-ACQUIRED through the
 * #63 seam (SeamBoundContextReader) and handed to the compiler as sealed
 * reads. Previous results are data, never authority; a step that already
 * dispatched cannot be blindly replayed (the engine refuses with
 * InvocationConflictError; reconciliation is #50 territory). Pure with
 * respect to its inputs: same Mission + request + clock → same package.
 */
export function recompileAfterRestart(
    mission: Mission,
    request: ContextRequest,
    options: { clock?: () => Date; budgetPolicy?: RequestBudgetPolicy } = {},
): BoundedContextPackage {
    return new ContextCompiler(options).compile(mission, request, []);
}
