/**
 * 🧩 Context Compiler (Issue #64)
 *
 * Deterministic, offline, provider-independent compilation of a Bounded
 * Context Package for a Mission.
 *
 * Structural authority rules enforced HERE (not by prompts):
 *  1. Mission-owned refs are compiled ONLY from the requesting Mission's
 *     own contextRefs — cross-mission references are refused.
 *  2. External content reaches the package ONLY as pre-authorized
 *     `ContextReadOutcome`s produced by the RegistryBoundContextReader
 *     (sources.ts), which enforces the #62 deterministic policy scope and
 *     the #63 descriptor contract BEFORE any owner adapter runs. The
 *     compiler itself holds no registry and no policy: it cannot widen
 *     what the reader already authorized.
 *  3. Discovery does not concede authorization: the reader's gate order is
 *     fail-closed and availability is reported honestly (never hidden as
 *     an empty success).
 *  4. External content is DATA: rows are sanitized and never interpreted
 *     as instructions. The returned package is deeply frozen — structurally
 *     unable to mutate intent/constraints/etc.
 *  5. Budgets are deterministic and enforced BEFORE inclusion; provenance
 *     survives every reduction; exclusions are recorded, never silent.
 *  6. Honest degradation: one owner's failure never destroys items
 *     already compiled from other owners; failures become typed records.
 *  7. Restart recomposition: compilation is a pure function of (durable
 *     Mission state, refs, pre-authorized reads, clock) — no prompt/output
 *     cache, no model calls, no network.
 *  8. No secrets/Authorization/CoT/raw provider responses are persisted:
 *     every string passes the shared sanitizers; unredactable secrets are
 *     refused with an honest exclusion record — never a silent leak.
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
    EpistemicClass,
    estimateTokens,
    ItemProvenance,
    SensitivityClass,
    SourceStatus,
    UnresolvedSource,
} from "./contracts.js";
import { containsRawSecret, sanitizeText } from "../mission/sanitize.js";

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
 * One outcome of the RegistryBoundContextReader (sources.ts): either a
 * successful pre-authorized read carrying the authorized descriptor
 * (provenance is computed by the compiler, never forged by adapters) or an
 * honest unresolved record. The compiler consumes this union verbatim.
 */
export type ContextReadOutcome = CompiledSourceRead | UnresolvedSource;

/**
 * 🧩 Context Compiler — the ONE entry point that turns (durable Mission
 * state, authorized refs, pre-authorized reads) into a bounded,
 * provenance-carrying, deeply frozen context package.
 */
export class ContextCompiler {
    private readonly clock: () => Date;

    constructor(options: { clock?: () => Date } = {}) {
        this.clock = options.clock ?? (() => new Date());
    }

    private isoNow(): string {
        return this.clock().toISOString();
    }

    /**
     * Compile the package. Deterministic and PURE with respect to its
     * inputs (mission, request, pre-authorized reads, clock): the same
     * durable Mission state + refs + reads always recompose the same
     * package. No caches, no model calls, no network.
     */
    compile(
        mission: Mission,
        request: ContextRequest,
        reads: ContextReadOutcome[],
    ): BoundedContextPackage {
        // Gate 0 — declarative request sanity.
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

        const now = this.isoNow();
        const items: ContextItem[] = [];
        const unresolved: UnresolvedSource[] = [];
        const excluded: BudgetExclusion[] = [];

        // ── Phase A: mission-owned references (durable, authorized) ───
        for (const owned of mission.contextRefs) {
            const content = sanitizeText(owned.label);
            items.push({
                itemId: computeItemId({
                    owner: owned.owner,
                    sourceRef: owned.externalRef,
                    epistemicClass: EpistemicClass.FACT,
                    content,
                    missionId: mission.missionId,
                }),
                epistemicClass: EpistemicClass.FACT,
                content,
                provenance: {
                    owner: owned.owner,
                    sourceRef: owned.externalRef,
                    fetchedAt: now,
                    authorization: `authorized by ${sanitizeText(owned.authorizedBy)} via MissionIntent.contextRefs`,
                    missionId: mission.missionId,
                    purpose: sanitizeText(request.purpose),
                    sensitivity: SensitivityClass.NORMAL,
                    origin: "mission_owned",
                },
            });
        }

        // ── Phase B: pre-authorized external reads (#63 boundary) ─────
        // `reads` are produced ONLY by the RegistryBoundContextReader
        // (sources.ts), which enforces the #62 policy + #63 descriptor
        // gates BEFORE any adapter call and returns honest per-source
        // `UnresolvedSource` records for everything it refused.
        for (const outcome of reads) {
            if (!("rows" in outcome)) {
                unresolved.push(outcome);
                continue;
            }
            for (const row of outcome.rows) {
                // Sanitize BEFORE classification. Unredactable secret-like
                // content is EXCLUDED with an honest record — never a
                // silent carry, never a silent drop.
                const rawContent = row.content;
                const content = sanitizeText(rawContent);
                if (content !== rawContent || containsRawSecret(content)) {
                    excluded.push({
                        itemId: `secret:${sha256Json({ ref: row.sourceRef, content }).slice(0, 24)}`,
                        reason: "secret_refused",
                    });
                    continue;
                }

                const sensitivity = row.sensitivity ?? SensitivityClass.NORMAL;
                if (sensitivity === SensitivityClass.RESTRICTED) {
                    // Owner-declared restricted: reference-only, no content.
                    items.push({
                        itemId: computeItemId({
                            owner: outcome.descriptor.moduleOwner,
                            sourceRef: row.sourceRef,
                            epistemicClass: EpistemicClass.FACT,
                            content: "(restricted)",
                            missionId: mission.missionId,
                        }),
                        epistemicClass: EpistemicClass.FACT,
                        content: `(restricted: reference-only ${row.sourceRef})`,
                        provenance: this.externalProvenance(
                            outcome.descriptor,
                            row,
                            request,
                            now,
                            sensitivity,
                            undefined,
                        ),
                    });
                    continue;
                }

                // Freshness: fail-closed. A freshness requirement with a
                // source that cannot prove its age is STALE, not fresh.
                let expiresAt: string | undefined;
                if (request.maxAgeMs !== undefined) {
                    const nowMs = Date.parse(now);
                    const fetchedMs =
                        row.fetchedAt !== undefined ? Date.parse(row.fetchedAt) : Number.NaN;
                    const age = Number.isNaN(fetchedMs) ? Number.NaN : nowMs - fetchedMs;
                    if (Number.isNaN(age) || age > request.maxAgeMs) {
                        unresolved.push({
                            requestedRef: sanitizeText(row.sourceRef),
                            owner: outcome.descriptor.moduleOwner,
                            status: SourceStatus.STALE,
                            detail: Number.isNaN(age)
                                ? "freshness required but the source carried no valid timestamp"
                                : "row age exceeds the request's maxAgeMs",
                        });
                        continue;
                    }
                    expiresAt = new Date(nowMs + request.maxAgeMs).toISOString();
                }

                items.push({
                    itemId: computeItemId({
                        owner: outcome.descriptor.moduleOwner,
                        sourceRef: row.sourceRef,
                        epistemicClass: EpistemicClass.FACT,
                        content,
                        missionId: mission.missionId,
                    }),
                    epistemicClass: EpistemicClass.FACT,
                    content,
                    provenance: this.externalProvenance(
                        outcome.descriptor,
                        row,
                        request,
                        now,
                        sensitivity,
                        expiresAt,
                    ),
                });
            }
        }

        // ── Phase C: minimal disclosure + dedup + deterministic budget ─
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
            const key = sha256Json({
                owner: item.provenance.owner,
                epistemicClass: item.epistemicClass,
                content: item.content,
            });
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
            if (capped.length >= request.budget.maxItems) {
                excluded.push({ itemId: item.itemId, reason: "scope_exceeded" });
                continue;
            }
            const nextTotal = totalChars + item.content.length;
            if (nextTotal > request.budget.maxTotalChars) {
                excluded.push({ itemId: item.itemId, reason: "scope_exceeded" });
                continue;
            }
            if (estimateTokens(nextTotal) > request.budget.maxEstimatedTokens) {
                excluded.push({ itemId: item.itemId, reason: "scope_exceeded" });
                continue;
            }
            capped.push(item);
            totalChars = nextTotal;
        }

        // packageId is the deterministic hash of the full package content;
        // it is set BEFORE deep-freeze (frozen objects reject assignment).
        const unfrozen: BoundedContextPackage = {
            packageId: "",
            contractVersion: CONTEXT_COMPILER_CONTRACT_VERSION,
            missionId: mission.missionId,
            stepId: request.stepId,
            compiledAt: now,
            request: JSON.parse(JSON.stringify(request)) as ContextRequest,
            items: capped,
            unresolved,
            budgetReport: {
                limits: {
                    maxItems: request.budget.maxItems,
                    maxTotalChars: request.budget.maxTotalChars,
                    maxEstimatedTokens: request.budget.maxEstimatedTokens,
                },
                observed: {
                    items: capped.length,
                    totalChars,
                    estimatedTokens: estimateTokens(totalChars),
                },
                excluded,
            },
        };
        (unfrozen as { packageId: string }).packageId = `pkg-${
            sha256Json({ ...unfrozen, packageId: "" }).slice(0, 24)
        }`;
        return deepFreeze(unfrozen);
    }

    /**
     * Derive a bounded summary over EXPLICITLY selected source items. The
     * summary is a NEW item of class derived_summary that KEEPS the source
     * item ids — reduction never destroys the reconstructible relation to
     * facts. Deriving FROM an inference is refused: inferences may not
     * masquerade as summaries-of-facts.
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
        const content = sanitizeText(joined);
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
                sensitivity: SensitivityClass.NORMAL,
                origin: "mission_owned",
            },
            derivedFrom: ordered.map((s) => s.itemId),
            derivationOp: `first:${ordered.length}`,
        };
        const next: BoundedContextPackage = {
            ...pkg,
            items: [...pkg.items, summaryItem],
        };
        (next as { packageId: string }).packageId = `pkg-${
            sha256Json({ ...next, packageId: "" }).slice(0, 24)
        }`;
        return { ok: true, item: summaryItem, package: deepFreeze(next) };
    }

    /**
     * Add an EXPLICIT, provenance-carrying inference submitted by the
     * requester side (e.g. planner). Compiled as INFERENCE — never
     * promoted to fact, never silently blended into derived summaries.
     */
    addInference(
        pkg: BoundedContextPackage,
        spec: { content: string; refId: string },
    ):
        | { ok: true; item: ContextItem; package: BoundedContextPackage }
        | { ok: false; reason: string } {
        const content = sanitizeText(spec.content);
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
                sensitivity: SensitivityClass.NORMAL,
                origin: "external_owner",
            },
        };
        const next: BoundedContextPackage = {
            ...pkg,
            items: [...pkg.items, item],
        };
        (next as { packageId: string }).packageId = `pkg-${
            sha256Json({ ...next, packageId: "" }).slice(0, 24)
        }`;
        return { ok: true, item, package: deepFreeze(next) };
    }

    /** Compiler-computed provenance for an external row (adapter-proof). */
    private externalProvenance(
        descriptor: CompiledSourceReadDescriptor,
        row: { sourceRef: string; fetchedAt?: string; evidenceRefId?: string },
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
 * Restart recomposition entry point. Recompiles the package from durable
 * Mission state + pre-authorized reads — no prompt/output cache, no replay
 * of model output. Pure: same inputs → same package (deterministic ids).
 */
export function recompileAfterRestart(
    mission: Mission,
    request: ContextRequest,
    reads: ContextReadOutcome[],
    options: { clock?: () => Date } = {},
): BoundedContextPackage {
    return new ContextCompiler(options).compile(mission, request, reads);
}
