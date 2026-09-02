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
 *     `SeamAuthorizedRead`: a nominal class whose construction is private
 *     to this module (the compiler), produced ONLY by the
 *     SeamBoundContextReader (sources.ts) from results that ALREADY passed
 *     the #63 `ConnectorDispatchSeam` gates. A plain `{descriptor, rows}`
 *     object is structurally refused, and a forged `CompiledSourceRead`
 *     can never be sealed. The compiler itself holds no registry, no seam
 *     and no policy: it cannot widen what the boundary already authorized.
 *     There is NO caller-provided outcome path (no `alreadyAuthorized`):
 *     the engine exposes no API that proves invocation/result identity for
 *     a dispatch that happened elsewhere, so caller-supplied shapes are
 *     never authority — reads must flow through the reader, which
 *     dispatches and seals them in the same call.
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
 */

import { createHash } from "node:crypto";

import type { Mission } from "../mission/contracts.js";
import {
    BoundedContextPackage,
    BudgetExclusion,
    CompiledSourceRead,
    CompiledSourceReadDescriptor,
    ContextItem,
    ContextRequest,
    CONTEXT_COMPILER_CONTRACT_VERSION,
    DEFAULT_REQUEST_BUDGET_POLICY,
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

/**
 * 🔒 SeamAuthorizedRead — non-forgeable proof that a read crossed the
 * #63 `ConnectorDispatchSeam` boundary (review blocker, round 2). This is
 * a NOMINAL class with a PRIVATE constructor: a plain `{descriptor, rows}`
 * object, a hand-built look-alike, or a forged `CompiledSourceRead` can
 * never satisfy the compiler's input check — only the module-internal
 * seal, obtained by the SeamBoundContextReader (sources.ts) through
 * `getSeamSeal()`, carries the module-private construction token. A
 * constructor call without it (including through `as any`) throws at
 * RUNTIME, not merely at type-check time. The wrapped read is deep-frozen
 * at sealing: a sealed read cannot be mutated into a different
 * authorization.
 */
export class SeamAuthorizedRead {
    readonly read: CompiledSourceRead;

    constructor(read: CompiledSourceRead, sealToken: symbol) {
        if (sealToken !== SEAM_SEAL_TOKEN) {
            throw new ContextCompilerError(
                "SeamAuthorizedRead cannot be constructed directly: reads are sealed only through the SeamBoundContextReader",
            );
        }
        this.read = deepFreeze(read) as CompiledSourceRead;
        Object.freeze(this);
    }
}

/** Module-private construction token: even a forced constructor call
 * without it fails closed at runtime (not merely at type-check time). */
const SEAM_SEAL_TOKEN = Symbol("context.compiler.seamSeal");

/**
 * The ONE module-internal sealing authority. Never exported as a value;
 * the reader borrows it (coordination only — every legit production read
 * still flows through seam dispatch inside sources.ts).
 */
const seamSeal = (read: CompiledSourceRead): SeamAuthorizedRead =>
    new SeamAuthorizedRead(read, SEAM_SEAL_TOKEN);

/** The reader's only way to seal a seam-authorized read. */
export function getSeamSeal(): (read: CompiledSourceRead) => SeamAuthorizedRead {
    return seamSeal;
}

/** Structural check: only genuinely sealed instances are authority. */
function isSeamAuthorizedRead(value: unknown): value is SeamAuthorizedRead {
    return value instanceof SeamAuthorizedRead;
}

/** Typed, fail-closed error for the Context Compiler boundary. */
export class ContextCompilerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ContextCompilerError";
    }
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

/** Deep-freeze a pure-data structure so returned packages are immutable. */
function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value as Record<string, unknown>)) {
            deepFreeze((value as Record<string, unknown>)[key]);
        }
        Object.freeze(value);
    }
    return value;
}

/**
 * What the SeamBoundContextReader reports for ONE requested source
 * (sources.ts): either a successful read SEALED as a non-forgeable
 * `SeamAuthorizedRead` (the ONLY form the compiler accepts), or an honest
 * refusal record. Honest refusals are surface data for the caller, never
 * compiler authority — a refused source can never contribute content.
 */
export type ContextReadResult =
    | { ok: true; read: SeamAuthorizedRead }
    | { ok: false; unresolved: UnresolvedSource };

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
        reads: SeamAuthorizedRead[],
    ): BoundedContextPackage {
        // Gate 0 — declarative request sanity (fail-closed budgets: a
        // missing/invalid budget never compiles an unbounded package).
        if (!request.subject.trim() || !request.purpose.trim()) {
            throw new ContextCompilerError(
                "ContextRequest must declare a non-empty subject and purpose",
            );
        }
        const { effective, clamped, budget } = this.effectiveBudget(request);
        if (
            effective.maxItems <= 0 ||
            effective.maxTotalChars <= 0 ||
            effective.maxEstimatedTokens <= 0
        ) {
            throw new ContextCompilerError(
                "ContextRequest.budget is invalid or clamps to an empty budget (fail-closed)",
            );
        }
        // Gate 1 — the request must belong to THIS mission (fail-closed:
        // a package compiled for another mission is never produced).
        if (request.missionId !== mission.missionId) {
            throw new ContextCompilerError(
                `ContextRequest targets mission "${request.missionId}" but compilation was requested for "${mission.missionId}"`,
            );
        }
        // Gate 1b — structural closure on external reads: every entry must
        // be a genuinely sealed SeamAuthorizedRead. Plain objects are
        // refused, never silently coerced into authority.
        for (const r of reads) {
            if (!isSeamAuthorizedRead(r)) {
                throw new ContextCompilerError(
                    "external reads must be SeamAuthorizedRead values produced by the SeamBoundContextReader; raw descriptor/rows objects are not authority (fail-closed)",
                );
            }
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
        // as NORMAL.
        for (const owned of mission.contextRefs) {
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
                    purpose: sanitizeText(request.purpose),
                    sensitivity: ownedRedacted,
                    origin: "mission_owned",
                },
            });
        }

        // ── Phase B: seam-authorized external reads (#63 boundary) ────
        // `reads` are non-forgeable SeamAuthorizedReads produced ONLY by
        // the SeamBoundContextReader from ConnectorDispatchSeam-authorized
        // results. The compiler never defaults external content to FACT
        // (blocker 5).
        for (const outcome of reads) {
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
                            request,
                            now,
                            sensitivity,
                            expiryFor(row, request, now),
                        ),
                    });
                    continue;
                }

                // Freshness: fail-closed. A freshness requirement with a
                // source that cannot prove its age is STALE, not fresh.
                // Expiry anchors to the SOURCE's fetchedAt (blocker 4):
                // recompiling later never renews validity.
                if (request.maxAgeMs !== undefined) {
                    const nowMs = Date.parse(now);
                    const fetchedMs =
                        row.fetchedAt !== undefined ? Date.parse(row.fetchedAt) : Number.NaN;
                    const age = Number.isNaN(fetchedMs) ? Number.NaN : nowMs - fetchedMs;
                    if (Number.isNaN(age) || age > request.maxAgeMs) {
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
                        request,
                        now,
                        sensitivity,
                        expiryFor(row, request, now),
                    ),
                });
            }
        }

        // ── Phase C: minimal disclosure + dedup + deterministic budget ─
        const capped = this.capPipeline(items, request, effective, excluded);

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
            stepId: request.stepId,
            compiledAt: now,
            request: JSON.parse(JSON.stringify(request)) as ContextRequest,
            items: capped,
            unresolved,
            budgetReport,
        };
        unfrozen.packageId = computePackageId(unfrozen);
        return deepFreeze(unfrozen) as BoundedContextPackage;
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
    ): ItemProvenance {
        return {
            owner: descriptor.moduleOwner,
            sourceRef: row.sourceRef,
            sourceVersion: descriptor.contractVersion,
            fetchedAt: row.fetchedAt ?? now,
            authorization: `capability:${descriptor.capabilityId}`,
            missionId: request.missionId,
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
