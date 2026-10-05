/** Operational progressive Context Packs over the #64 compiler (#78). */

import { createHash } from "node:crypto";
import type { Mission, MissionContextAccounting } from "../mission/contracts.js";
import { TERMINAL_STATES } from "../mission/contracts.js";
import type { MissionStore } from "../mission/ports.js";
import { containsRawSecret, sanitizeText } from "../mission/sanitize.js";
import {
    BoundedContextPackage,
    clampBudget,
    ContextBudget,
    ContextCompilerError,
    ContextRequest,
    DEFAULT_REQUEST_BUDGET_POLICY,
    EpistemicClass,
    estimateTokens,
    deepFreeze,
} from "./contracts.js";
import { ContextCompiler } from "./compiler.js";
import { SeamBoundContextReader } from "./sources.js";

export interface MissionContextProjection {
    sanitizedIntent: string;
    objective: string;
    constraints: string[];
    acceptanceCriteria: string[];
    evidenceRefs: Array<{ refId: string; owner: string; externalRef: string; label: string }>;
}

export interface ProgressiveContextPack {
    contractVersion: 1;
    packId: string;
    missionId: string;
    requesterInvocationId?: string;
    initialPackageId: string;
    mission: MissionContextProjection;
    /** Current cumulative #64 package; expansions replace stale layers. */
    package: BoundedContextPackage;
    expansionIds: string[];
    budget: {
        limits: ContextBudget;
        observed: { items: number; totalChars: number; estimatedTokens: number; bytes: number };
        remaining: ContextBudget;
    };
    accounting: MissionContextAccounting;
}

export interface ContextExpansionRequest {
    /** Opaque caller-supplied correlation identity; never used as authority. */
    correlationId: string;
    requesterInvocationId?: string;
    request: ContextRequest;
}

interface RuntimeState {
    limits: ContextBudget;
    requestIds: string[];
    invocationIds: string[];
    initial: { bytes: number; chars: number; items: number };
}

export interface ProgressiveContextRuntimeOptions {
    store: MissionStore;
    reader: SeamBoundContextReader;
    compiler?: ContextCompiler;
    clock?: () => Date;
}

/** A Mission-local, bounded, explicit context composition path. */
export class ProgressiveContextPackRuntime {
    private readonly states = new WeakMap<ProgressiveContextPack, RuntimeState>();
    private readonly compiler: ContextCompiler;
    private readonly clock: () => Date;

    constructor(private readonly options: ProgressiveContextRuntimeOptions) {
        this.compiler = options.compiler ?? new ContextCompiler({ clock: options.clock });
        this.clock = options.clock ?? (() => new Date());
    }

    /** Compile the mission-only working set; this path never reads an owner. */
    async compileInitial(missionId: string, request: ContextRequest): Promise<ProgressiveContextPack> {
        if (!request || typeof request !== "object"
            || typeof request.missionId !== "string"
            || typeof request.subject !== "string"
            || typeof request.purpose !== "string"
            || !request.budget || typeof request.budget !== "object") {
            throw new ContextCompilerError("initial ContextRequest is malformed or unbounded");
        }
        if (request.missionId !== missionId || request.ownerHint !== undefined || request.stepId !== undefined) {
            throw new ContextCompilerError("initial Context Pack must be mission-only and mission-bound");
        }
        const mission = await this.options.store.getMission(missionId);
        if (!mission) throw new ContextCompilerError("Mission does not exist in durable state");
        assertMissionNonTerminal(mission);
        const projection = projectMission(mission);
        const core = JSON.stringify(projection);
        const coreChars = core.length;
        const limits = clampBudget(request.budget, DEFAULT_REQUEST_BUDGET_POLICY);
        const remaining = {
            maxItems: limits.maxItems - 1,
            maxTotalChars: limits.maxTotalChars - coreChars,
            maxEstimatedTokens: limits.maxEstimatedTokens - estimateTokens(coreChars),
        };
        if (Object.values(remaining).some((value) => value <= 0)) {
            throw new ContextCompilerError("mandatory Mission projection exceeds the bounded initial pack budget");
        }
        const boundedRequest = { ...request, budget: remaining };
        const compiled = this.compiler.compile(mission, boundedRequest, []);
        const observed = measure(projection, compiled);
        const priorAccounting = mission.contextAccounting;
        const pack = this.makePack({
            mission,
            projection,
            compiled,
            initialPackageId: compiled.packageId,
            expansionIds: [],
            limits,
            observed,
            requesterInvocationId: undefined,
            accounting: this.accounting(mission, observed, observed, compiled, priorAccounting),
        });
        this.states.set(pack, {
            limits,
            requestIds: [...(priorAccounting?.requestIds ?? [])],
            invocationIds: [...(priorAccounting?.invocationIds ?? [])],
            initial: { bytes: observed.bytes, chars: observed.totalChars, items: observed.items },
        });
        await this.persistAccounting(missionId, pack.accounting);
        return pack;
    }

    /** Resolve one explicitly requested, authorized expansion through the #63 seam. */
    async expand(
        pack: ProgressiveContextPack,
        expansion: ContextExpansionRequest,
    ): Promise<ProgressiveContextPack> {
        const state = this.states.get(pack);
        if (!state) throw new ContextCompilerError("Context Pack session is not current; recompile after restart");
        if (!expansion || typeof expansion !== "object"
            || typeof expansion.correlationId !== "string"
            || !expansion.request || typeof expansion.request !== "object"
            || typeof expansion.request.subject !== "string"
            || typeof expansion.request.purpose !== "string"
            || typeof expansion.request.missionId !== "string"
            || !expansion.request.budget || typeof expansion.request.budget !== "object") {
            throw new ContextCompilerError("ContextExpansionRequest is malformed");
        }
        const request: ContextRequest = {
            ...expansion.request,
            purpose: sanitizeText(expansion.request.purpose),
        };
        if (request.missionId !== pack.missionId || !request.ownerHint || !request.stepId) {
            throw new ContextCompilerError("expansion requires an owner hint and accepted Mission step scope");
        }
        if ([request.subject, request.ownerHint, request.stepId].some((value) => value && containsRawSecret(value))) {
            throw new ContextCompilerError("expansion identity fields must not contain secrets");
        }
        validateExpansionRequest(request);
        if (!expansion.correlationId.trim() || containsRawSecret(expansion.correlationId)) {
            throw new ContextCompilerError("expansion correlationId must be non-empty and contain no secret");
        }
        if (expansion.requesterInvocationId !== undefined) {
            if (!expansion.requesterInvocationId.trim()
                || containsRawSecret(expansion.requesterInvocationId)) {
                throw new ContextCompilerError("requesterInvocationId must be a non-secret Invocation identity");
            }
            const requester = await this.options.store.getInvocation(expansion.requesterInvocationId);
            if (!requester || requester.missionId !== pack.missionId) {
                throw new ContextCompilerError("requesting Invocation is not part of this Mission");
            }
        }
        assertRequestDoesNotWiden(pack.package.request, request, state.limits);
        const mission = await this.options.store.getMission(pack.missionId);
        if (!mission) throw new ContextCompilerError("Mission no longer exists in durable state");
        assertMissionNonTerminal(mission);

        // Existing context content is rechecked by the compiler during merge;
        // a stale layer is removed before it reaches the new returned pack.
        const currentProjection = projectMission(mission);
        const freshBase = this.compiler.refreshFreshness(pack.package);
        const observedBefore = measure(currentProjection, freshBase);
        const remaining = {
            maxItems: state.limits.maxItems - observedBefore.items,
            maxTotalChars: state.limits.maxTotalChars - observedBefore.totalChars,
            maxEstimatedTokens: state.limits.maxEstimatedTokens - observedBefore.estimatedTokens,
        };
        if (Object.values(remaining).some((value) => value <= 0)) {
            throw new ContextCompilerError("Context Pack has no remaining expansion budget");
        }
        const boundedRequest: ContextRequest = {
            ...request,
            budget: {
                maxItems: Math.min(request.budget.maxItems, remaining.maxItems),
                maxTotalChars: Math.min(request.budget.maxTotalChars, remaining.maxTotalChars),
                maxEstimatedTokens: Math.min(request.budget.maxEstimatedTokens, remaining.maxEstimatedTokens),
            },
        };
        const resolution = await this.options.reader.read(mission, boundedRequest, {
            dispatchStepId: request.stepId,
        });
        const missionAfterRead = await this.options.store.getMission(pack.missionId);
        if (!missionAfterRead) throw new ContextCompilerError("Mission no longer exists in durable state");
        assertMissionNonTerminal(missionAfterRead);
        const expansionPackage = this.compiler.compile(mission, boundedRequest, resolution ? [resolution] : []);
        const combined = this.compiler.mergeExpansion(freshBase, expansionPackage);
        const observed = measure(currentProjection, combined);
        if (observed.totalChars > state.limits.maxTotalChars
            || observed.items > state.limits.maxItems
            || observed.estimatedTokens > state.limits.maxEstimatedTokens) {
            throw new ContextCompilerError("expanded Context Pack exceeds its initial aggregate budget");
        }

        const requestIdentity = hash({
            missionId: pack.missionId,
            requesterInvocationId: expansion.requesterInvocationId ?? "",
            stepId: request.stepId,
            correlationId: expansion.correlationId,
            ownerHint: request.ownerHint,
            subject: request.subject,
            purpose: request.purpose,
            requestedClasses: request.requestedClasses ? [...request.requestedClasses].sort() : null,
            maxAgeMs: request.maxAgeMs ?? null,
        });
        const sourceItems = [
            ...expansionPackage.items,
            ...combined.items.filter((item) => item.provenance.stepId === request.stepId),
        ];
        const sourceAnchors = [...new Map(sourceItems.map((item) => {
            const anchor = {
                owner: item.provenance.owner,
                sourceRef: item.provenance.sourceRef,
                sourceVersion: item.provenance.sourceVersion ?? null,
                fetchedAt: item.provenance.fetchedAt,
                expiresAt: item.provenance.expiresAt ?? null,
            };
            return [JSON.stringify(anchor), anchor] as const;
        }))].map(([, anchor]) => anchor)
            .sort((a, b) => {
                const left = JSON.stringify(a);
                const right = JSON.stringify(b);
                return left < right ? -1 : left > right ? 1 : 0;
            });
        const expansionId = hash({
            requestIdentity,
            sourceAnchors,
            unresolved: expansionPackage.unresolved.map((entry) => ({
                requestedRef: entry.requestedRef,
                owner: entry.owner,
                status: entry.status,
            })),
        });
        const ids = [...new Set([...state.requestIds, requestIdentity])];
        const latestMission = missionAfterRead;
        assertMissionNonTerminal(latestMission);
        const invocation = latestMission.invocationRefs.find((entry) => entry.stepId === request.stepId);
        const invocationIds = invocation
            ? [...new Set([...state.invocationIds, invocation.invocationId])]
            : state.invocationIds;
        const fullInvocations = await this.options.store.listInvocations(pack.missionId);
        const attempts = fullInvocations
            .filter((entry) => invocationIds.includes(entry.invocationId))
            .reduce((count, entry) => count + entry.attempts.length, 0);
        const unresolved = combined.unresolved.length;
        const omissions = combined.budgetReport.excluded.length;
        const accounting: MissionContextAccounting = {
            contractVersion: 1,
            missionId: pack.missionId,
            initial: state.initial,
            aggregate: { bytes: observed.bytes, chars: observed.totalChars, items: observed.items },
            contextRequests: pack.accounting.contextRequests + 1,
            expansions: pack.accounting.expansions + 1,
            omissions,
            unresolvedSources: unresolved,
            invocationIds,
            requestIds: ids,
            tokenUsage: { value: observed.estimatedTokens, provenance: "estimated", method: "chars_div_4" },
            attempts,
            outcome: missionOutcome(latestMission),
            updatedAt: this.clock().toISOString(),
        };
        const updated = this.makePack({
            mission: latestMission,
            projection: currentProjection,
            compiled: combined,
            initialPackageId: pack.initialPackageId,
            expansionIds: [...new Set([...pack.expansionIds, expansionId])],
            limits: state.limits,
            observed,
            requesterInvocationId: expansion.requesterInvocationId,
            accounting,
        });
        this.states.set(updated, {
            ...state,
            requestIds: ids,
            invocationIds,
        });
        this.states.delete(pack);
        await this.persistAccounting(pack.missionId, accounting);
        return updated;
    }

    private async persistAccounting(missionId: string, accounting: MissionContextAccounting): Promise<void> {
        if (await this.options.store.updateContextAccountingIfNonTerminal(missionId, accounting)) return;
        const current = await this.options.store.getMission(missionId);
        if (current) assertMissionNonTerminal(current);
        throw new ContextCompilerError("Mission no longer exists in durable state");
    }

    private accounting(
        mission: Mission,
        initial: ReturnType<typeof measure>,
        aggregate: ReturnType<typeof measure>,
        pkg: BoundedContextPackage,
        previous?: MissionContextAccounting,
    ): MissionContextAccounting {
        const invocationIds = [...(previous?.invocationIds ?? [])];
        return {
            contractVersion: 1,
            missionId: mission.missionId,
            initial: { bytes: initial.bytes, chars: initial.totalChars, items: initial.items },
            aggregate: { bytes: aggregate.bytes, chars: aggregate.totalChars, items: aggregate.items },
            contextRequests: previous?.contextRequests ?? 0,
            expansions: previous?.expansions ?? 0,
            omissions: pkg.budgetReport.excluded.length,
            unresolvedSources: pkg.unresolved.length,
            invocationIds,
            requestIds: [...(previous?.requestIds ?? [])],
            tokenUsage: { value: aggregate.estimatedTokens, provenance: "estimated", method: "chars_div_4" },
            attempts: previous?.attempts ?? 0,
            outcome: missionOutcome(mission),
            updatedAt: this.clock().toISOString(),
        };
    }

    private makePack(input: {
        mission: Mission;
        projection: MissionContextProjection;
        compiled: BoundedContextPackage;
        initialPackageId: string;
        expansionIds: string[];
        limits: ContextBudget;
        observed: ReturnType<typeof measure>;
        requesterInvocationId?: string;
        accounting: MissionContextAccounting;
    }): ProgressiveContextPack {
        const remaining = {
            maxItems: Math.max(0, input.limits.maxItems - input.observed.items),
            maxTotalChars: Math.max(0, input.limits.maxTotalChars - input.observed.totalChars),
            maxEstimatedTokens: Math.max(0, input.limits.maxEstimatedTokens - input.observed.estimatedTokens),
        };
        const payload = {
            contractVersion: 1 as const,
            missionId: input.mission.missionId,
            ...(input.requesterInvocationId === undefined
                ? {}
                : { requesterInvocationId: input.requesterInvocationId }),
            initialPackageId: input.initialPackageId,
            mission: input.projection,
            package: input.compiled,
            expansionIds: input.expansionIds,
            budget: { limits: input.limits, observed: input.observed, remaining },
            accounting: input.accounting,
        };
        return deepFreeze({
            ...payload,
            packId: `pack-${hash(payload).slice(0, 24)}`,
        }) as ProgressiveContextPack;
    }
}

function assertMissionNonTerminal(mission: Mission): void {
    if (TERMINAL_STATES.has(mission.state)) {
        throw new ContextCompilerError(`Mission is terminal (${mission.state}); Context Pack operations are refused`);
    }
}

function projectMission(mission: Mission): MissionContextProjection {
    return {
        sanitizedIntent: sanitizeText(mission.sanitizedOriginalIntent),
        objective: sanitizeText(mission.interpretedObjective),
        constraints: mission.constraints.map(sanitizeText),
        acceptanceCriteria: mission.acceptanceCriteria.map(sanitizeText),
        evidenceRefs: mission.evidenceRefs.map((ref) => ({
            refId: ref.refId,
            owner: ref.owner,
            externalRef: ref.externalRef,
            label: sanitizeText(ref.label),
        })),
    };
}

function measure(projection: MissionContextProjection, pkg: BoundedContextPackage) {
    const serialized = JSON.stringify(projection);
    const chars = serialized.length + pkg.items.reduce((sum, item) => sum + item.content.length, 0);
    const bytes = Buffer.byteLength(serialized, "utf8")
        + pkg.items.reduce((sum, item) => sum + Buffer.byteLength(item.content, "utf8"), 0);
    const items = 1 + pkg.items.length;
    return { bytes, totalChars: chars, items, estimatedTokens: estimateTokens(chars) };
}

function missionOutcome(mission: Mission): MissionContextAccounting["outcome"] {
    const ownerBlocked = mission.invocationRefs.some((invocation) => invocation.ownerVerification?.verified === false);
    const verifiedCriteria = mission.criterionVerifications.filter((criterion) => criterion.satisfied).length;
    return {
        state: mission.state,
        verified: mission.state === "completed" && !ownerBlocked
            && verifiedCriteria >= mission.acceptanceCriteria.length,
        ownerBlocked,
        verifiedCriteria,
    };
}

function assertRequestDoesNotWiden(
    initial: ContextRequest,
    expansion: ContextRequest,
    limits: ContextBudget,
): void {
    for (const key of ["maxItems", "maxTotalChars", "maxEstimatedTokens"] as const) {
        if (!Number.isFinite(expansion.budget[key]) || expansion.budget[key] <= 0) {
            throw new ContextCompilerError(`expansion ${key} must be a finite positive number`);
        }
        if (expansion.budget[key] > limits[key]) {
            throw new ContextCompilerError(`expansion ${key} exceeds the initial Mission budget`);
        }
    }
    if (initial.requestedClasses && (!expansion.requestedClasses
        || expansion.requestedClasses.some((item) => !initial.requestedClasses!.includes(item)))) {
        throw new ContextCompilerError("expansion cannot widen the initially requested epistemic classes");
    }
    if (initial.maxAgeMs !== undefined && (expansion.maxAgeMs === undefined || expansion.maxAgeMs > initial.maxAgeMs)) {
        throw new ContextCompilerError("expansion cannot weaken the initial freshness requirement");
    }
}

function validateExpansionRequest(request: ContextRequest): void {
    if (typeof request.ownerHint !== "string" || typeof request.stepId !== "string"
        || !request.subject.trim() || !request.purpose.trim()
        || !request.ownerHint.trim() || !request.stepId.trim()) {
        throw new ContextCompilerError("expansion requires non-empty subject, purpose, owner and step identity");
    }
    if (request.maxAgeMs !== undefined && (!Number.isFinite(request.maxAgeMs) || request.maxAgeMs < 0)) {
        throw new ContextCompilerError("expansion maxAgeMs must be a finite non-negative number");
    }
    if (request.requestedClasses !== undefined) {
        const known = new Set(Object.values(EpistemicClass));
        if (!Array.isArray(request.requestedClasses)
            || request.requestedClasses.some((value) => !known.has(value))) {
            throw new ContextCompilerError("expansion requestedClasses contains an unsupported class");
        }
    }
}

function hash(value: unknown): string {
    const stable = (item: unknown): unknown => {
        if (Array.isArray(item)) return item.map(stable);
        if (item !== null && typeof item === "object") {
            const record = item as Record<string, unknown>;
            return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
        }
        return item;
    };
    return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
