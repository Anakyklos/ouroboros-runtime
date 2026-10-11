import { describe, expect, it } from "bun:test";
import { deepStrictEqual } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CapabilityResultStatus } from "../capabilities/connector.js";
import {
    makeContextConnector,
    makeContextDescriptor,
    makeContextRequest,
    fixedClock,
    journalRows,
} from "./fixtures.js";
import { ContextCompiler } from "./compiler.js";
import { createSeamHarness } from "./seam-harness.js";
import { SeamBoundContextReader } from "./sources.js";
import { ContextCompilerError, EpistemicClass, SourceStatus } from "./contracts.js";
import { ProgressiveContextPackRuntime } from "./progressive.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import { makeContextMission } from "./fixtures.js";
import {
    EffectClass,
    InvocationStatus,
    MissionState,
    type CapabilityInvocation,
    type MissionContextAccounting,
} from "../mission/contracts.js";
import {
    CapabilityAvailability,
    CancellationSupport,
    IdempotencyMode,
    ReconciliationSupport,
    RetryBackoff,
} from "../capabilities/contracts.js";

function makeAccountingInvocation(
    missionId: string,
    invocationId: string,
    stepId: string,
    attemptCount: number,
): CapabilityInvocation {
    const now = "2026-08-30T12:00:00.000Z";
    return {
        invocationId,
        missionId,
        stepId,
        capabilityId: "context:lifeos",
        planRevisionId: "historical-context-plan",
        contractVersion: 1,
        moduleOwner: "lifeos",
        effectClass: EffectClass.READ,
        status: InvocationStatus.PENDING,
        requestId: `request-${invocationId}`,
        effectFingerprint: `fingerprint-${invocationId}`,
        inputRefs: ["refs/lifeos/journal/week"],
        idempotency: { mode: IdempotencyMode.IDEMPOTENT, key: invocationId },
        retry: {
            maxAttempts: Math.max(1, attemptCount),
            attempt: attemptCount,
            backoff: RetryBackoff.NONE,
            backoffMs: 0,
            nextEligibleAt: null,
        },
        attempts: Array.from({ length: attemptCount }, (_, index) => ({
            attempt: index + 1,
            correlationId: `correlation-${invocationId}-${index + 1}`,
            state: "acknowledged" as const,
            startedAt: now,
            finishedAt: now,
        })),
        delivery: { state: "acknowledged", acknowledgedAt: now },
        cancellation: {
            support: CancellationSupport.UNSUPPORTED,
            requested: false,
            state: "not_requested",
        },
        reconciliation: {
            support: ReconciliationSupport.NONE,
            state: "not_required",
        },
        ownerVerificationState: "pending",
        createdAt: now,
        updatedAt: now,
        resultRefs: [],
    };
}

describe("ProgressiveContextPackRuntime", () => {
    it("builds a small initial pack without consulting an external owner", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission } = await harness.acceptContextPlan(descriptor, "refs/lifeos/journal/week");
        let calls = 0;
        harness.seam.registerConnector(descriptor.capabilityId, {
            ...makeContextConnector(descriptor, { rows: journalRows() }),
            invoke: async (request) => {
                calls++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId: request.requestId,
                    summary: "context fetched",
                    contextRows: journalRows(),
                    evidence: [],
                };
            },
        });
        const runtime = new ProgressiveContextPackRuntime({
            store: harness.store,
            reader: new SeamBoundContextReader(harness.engine, harness.seam, harness.registry),
            compiler: new ContextCompiler({ clock: fixedClock() }),
            clock: fixedClock(),
        });

        const initialRequest = makeContextRequest({
            missionId: mission.missionId,
            ownerHint: undefined,
            stepId: undefined,
            maxAgeMs: undefined,
            requestedClasses: undefined,
        });
        const pack = await runtime.compileInitial(mission.missionId, initialRequest);

        expect(pack.missionId).toBe(mission.missionId);
        expect(pack.initialPackageId).toMatch(/^pkg-/);
        expect(pack.mission.objective).toBe(mission.sanitizedOriginalIntent);
        expect(calls).toBe(0);
        expect(pack.accounting.expansions).toBe(0);
        expect(Object.isFrozen(pack)).toBe(true);
        const roundTripped = JSON.parse(JSON.stringify(pack));
        expect(roundTripped).toEqual(pack);
        deepStrictEqual(roundTripped, pack);
        expect(Object.hasOwn(pack, "requesterInvocationId")).toBe(false);
        expect(Object.hasOwn(pack.package, "stepId")).toBe(false);
        expect(Object.hasOwn(pack.package.request, "stepId")).toBe(false);
        expect(Object.hasOwn(pack.package.request, "ownerHint")).toBe(false);
        expect(pack.budget.observed.totalChars).toBeLessThanOrEqual(pack.budget.limits.maxTotalChars);
        await harness.close();
    });

    it("counts tracked Invocation attempts without hydrating unrelated history for accounting", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const directory = mkdtempSync(join(tmpdir(), "ouroboros-context-attempt-accounting-"));
        const dbPath = join(directory, "missions.sqlite");
        let currentHarness = await createSeamHarness({
            descriptors: [descriptor],
            store: new SqliteMissionStore(dbPath),
        });
        try {
            const harness = currentHarness;
            const { mission, stepId } = await harness.acceptContextPlan(descriptor, "refs/lifeos/journal/week");
            const priorAccounting: MissionContextAccounting = {
                contractVersion: 1,
                missionId: mission.missionId,
                initial: { bytes: 20, chars: 20, items: 1 },
                aggregate: { bytes: 20, chars: 20, items: 1 },
                contextRequests: 2,
                expansions: 2,
                omissions: 0,
                unresolvedSources: 0,
                invocationIds: ["tracked-a", "tracked-a", "missing-invocation", "tracked-b", "zero-attempts"],
                requestIds: [],
                tokenUsage: { value: 5, provenance: "estimated", method: "chars_div_4" },
                attempts: 99,
                outcome: { state: mission.state, verified: false, ownerBlocked: false, verifiedCriteria: 0 },
                updatedAt: "2026-08-30T12:00:00.000Z",
            };
            await harness.updateMission(mission.missionId, { contextAccounting: priorAccounting });
            await harness.store.saveInvocation(makeAccountingInvocation(mission.missionId, "tracked-a", "old-read-a", 2));
            await harness.store.saveInvocation(makeAccountingInvocation(mission.missionId, "tracked-b", "old-read-b", 3));
            await harness.store.saveInvocation(makeAccountingInvocation(mission.missionId, "zero-attempts", "old-read-zero", 0));
            for (let index = 0; index < 128; index++) {
                await harness.store.saveInvocation(makeAccountingInvocation(
                    mission.missionId,
                    `unrelated-${index}`,
                    `unrelated-step-${index}`,
                    5,
                ));
            }

            let invokes = 0;
            harness.seam.registerConnector(descriptor.capabilityId, {
                ...makeContextConnector(descriptor, { rows: journalRows() }),
                invoke: async (request) => {
                    invokes++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "context fetched",
                        contextRows: journalRows(),
                        evidence: [],
                    };
                },
                reconcile: async (requestId) => ({
                    status: CapabilityResultStatus.COMPLETED,
                    requestId,
                    summary: "context read reconciled",
                    contextRows: journalRows(),
                    evidence: [],
                }),
            });

            let fullHistoryReads = 0;
            let fullHistoryEntitiesMaterialized = 0;
            const targetedReadIds: string[] = [];
            const tracedStore = new Proxy(harness.store, {
                get(target, property) {
                    if (property === "listInvocations") {
                        return async (missionId: string) => {
                            fullHistoryReads++;
                            const invocations = await target.listInvocations(missionId);
                            fullHistoryEntitiesMaterialized += invocations.length;
                            return invocations;
                        };
                    }
                    if (property === "getInvocation") {
                        return async (invocationId: string) => {
                            targetedReadIds.push(invocationId);
                            return target.getInvocation(invocationId);
                        };
                    }
                    const value = Reflect.get(target, property, target) as unknown;
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            const runtime = new ProgressiveContextPackRuntime({
                store: tracedStore,
                reader: new SeamBoundContextReader(harness.engine, harness.seam, harness.registry),
                compiler: new ContextCompiler({ clock: fixedClock() }),
                clock: fixedClock(),
            });
            const initial = await runtime.compileInitial(mission.missionId, makeContextRequest({ missionId: mission.missionId }));
            const request = makeContextRequest({ missionId: mission.missionId, ownerHint: "lifeos", stepId });
            const expanded = await runtime.expand(initial, { correlationId: "tracked-accounting", request });

            expect(expanded.accounting.invocationIds).toHaveLength(5);
            expect(expanded.accounting.attempts).toBe(6);
            expect(invokes).toBe(1);
            expect(fullHistoryEntitiesMaterialized).toBe(0);
            expect(fullHistoryReads).toBe(0);
            expect(targetedReadIds).toEqual(expect.arrayContaining([
                "tracked-a",
                "tracked-b",
                "zero-attempts",
                "missing-invocation",
                ...expanded.accounting.invocationIds.filter((id) => !priorAccounting.invocationIds.includes(id)),
            ]));
            expect(targetedReadIds).toHaveLength(5);
            expect(targetedReadIds.some((id) => id.startsWith("unrelated-"))).toBe(false);

            const repeated = await runtime.expand(expanded, { correlationId: "tracked-accounting", request });
            expect(repeated.accounting.attempts).toBe(6);
            expect(repeated.accounting.invocationIds).toHaveLength(5);
            expect(invokes).toBe(1);
            expect(fullHistoryReads).toBe(0);
            expect(fullHistoryEntitiesMaterialized).toBe(0);

            await harness.close();
            currentHarness = await createSeamHarness({
                descriptors: [descriptor],
                store: new SqliteMissionStore(dbPath),
            });
            let restartInvokes = 0;
            currentHarness.seam.registerConnector(descriptor.capabilityId, {
                ...makeContextConnector(descriptor, { rows: journalRows() }),
                invoke: async (request) => {
                    restartInvokes++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "context fetched",
                        contextRows: journalRows(),
                        evidence: [],
                    };
                },
                reconcile: async (requestId) => {
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId,
                        summary: "context read reconciled",
                        contextRows: journalRows(),
                        evidence: [],
                    };
                },
            });
            const restartedStore = new Proxy(currentHarness.store, {
                get(target, property) {
                    if (property === "listInvocations") {
                        return async (missionId: string) => {
                            fullHistoryReads++;
                            const invocations = await target.listInvocations(missionId);
                            fullHistoryEntitiesMaterialized += invocations.length;
                            return invocations;
                        };
                    }
                    if (property === "getInvocation") {
                        return async (invocationId: string) => {
                            targetedReadIds.push(invocationId);
                            return target.getInvocation(invocationId);
                        };
                    }
                    const value = Reflect.get(target, property, target) as unknown;
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            const restartedRuntime = new ProgressiveContextPackRuntime({
                store: restartedStore,
                reader: new SeamBoundContextReader(currentHarness.engine, currentHarness.seam, currentHarness.registry),
                compiler: new ContextCompiler({ clock: fixedClock() }),
                clock: fixedClock(),
            });
            const resumed = await restartedRuntime.compileInitial(mission.missionId, makeContextRequest({ missionId: mission.missionId }));
            expect(resumed.accounting.attempts).toBe(6);
            expect(resumed.accounting.invocationIds).toHaveLength(5);
            const resumedExpansion = await restartedRuntime.expand(resumed, {
                correlationId: "tracked-accounting",
                request,
            });
            expect(resumedExpansion.accounting.attempts).toBe(6);
            expect(resumedExpansion.accounting.invocationIds).toHaveLength(5);
            expect(restartInvokes).toBe(0);
            expect(fullHistoryReads).toBe(0);
            expect(fullHistoryEntitiesMaterialized).toBe(0);
        } finally {
            await currentHarness.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("deduplicates persisted accounting IDs when SQLite expansion is refused before dispatch", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const directory = mkdtempSync(join(tmpdir(), "ouroboros-context-refused-accounting-"));
        const dbPath = join(directory, "missions.sqlite");
        let harness = await createSeamHarness({
            descriptors: [descriptor],
            store: new SqliteMissionStore(dbPath),
        });
        try {
            const { mission, stepId } = await harness.acceptContextPlan(descriptor, "refs/lifeos/journal/week");
            await harness.store.saveInvocation(makeAccountingInvocation(mission.missionId, "tracked-a", "old-read-a", 2));
            await harness.store.saveInvocation(makeAccountingInvocation(mission.missionId, "tracked-b", "old-read-b", 3));
            const foreignMissionId = "mission-context-accounting-foreign";
            await harness.store.createMission(makeContextMission({ missionId: foreignMissionId }));
            await harness.store.saveInvocation(makeAccountingInvocation(foreignMissionId, "foreign-invocation", "foreign-read", 4));
            const priorAccounting: MissionContextAccounting = {
                contractVersion: 1,
                missionId: mission.missionId,
                initial: { bytes: 20, chars: 20, items: 1 },
                aggregate: { bytes: 20, chars: 20, items: 1 },
                contextRequests: 1,
                expansions: 1,
                omissions: 0,
                unresolvedSources: 0,
                invocationIds: ["tracked-a", "tracked-a", "foreign-invocation", "tracked-b", "tracked-b"],
                requestIds: [],
                tokenUsage: { value: 5, provenance: "estimated", method: "chars_div_4" },
                attempts: 5,
                outcome: { state: mission.state, verified: false, ownerBlocked: false, verifiedCriteria: 0 },
                updatedAt: "2026-08-30T12:00:00.000Z",
            };
            await harness.updateMission(mission.missionId, { contextAccounting: priorAccounting });
            await harness.close();

            harness = await createSeamHarness({
                descriptors: [descriptor],
                store: new SqliteMissionStore(dbPath),
            });
            let invokeCalls = 0;
            harness.seam.registerConnector(descriptor.capabilityId, {
                ...makeContextConnector(descriptor, { rows: journalRows() }),
                invoke: async (request) => {
                    invokeCalls++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "context fetched",
                        contextRows: journalRows(),
                        evidence: [],
                    };
                },
            });
            harness.registry.setAvailability(descriptor.capabilityId, CapabilityAvailability.UNAVAILABLE);

            const targetedReadIds: string[] = [];
            const tracedStore = new Proxy(harness.store, {
                get(target, property) {
                    if (property === "getInvocation") {
                        return async (invocationId: string) => {
                            targetedReadIds.push(invocationId);
                            return target.getInvocation(invocationId);
                        };
                    }
                    const value = Reflect.get(target, property, target) as unknown;
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            const runtime = new ProgressiveContextPackRuntime({
                store: tracedStore,
                reader: new SeamBoundContextReader(harness.engine, harness.seam, harness.registry),
                compiler: new ContextCompiler({ clock: fixedClock() }),
                clock: fixedClock(),
            });
            const initial = await runtime.compileInitial(mission.missionId, makeContextRequest({ missionId: mission.missionId }));
            const expanded = await runtime.expand(initial, {
                correlationId: "unavailable-accounting",
                request: makeContextRequest({ missionId: mission.missionId, ownerHint: "lifeos", stepId }),
            });

            expect(expanded.package.unresolved.map((source) => source.status)).toContain(SourceStatus.UNAVAILABLE);
            expect(expanded.accounting.attempts).toBe(5);
            expect(expanded.accounting.invocationIds).toEqual(["tracked-a", "foreign-invocation", "tracked-b"]);
            expect(targetedReadIds).toEqual(["tracked-a", "foreign-invocation", "tracked-b"]);
            expect(invokeCalls).toBe(0);
            expect(await harness.store.listInvocations(mission.missionId)).toHaveLength(2);
        } finally {
            await harness.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("performs one explicit bounded expansion and rejects a scope escalation before dispatch", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission, stepId } = await harness.acceptContextPlan(descriptor, "refs/lifeos/journal/week");
        let calls = 0;
        harness.seam.registerConnector(descriptor.capabilityId, {
            ...makeContextConnector(descriptor, { rows: journalRows() }),
            invoke: async (request) => {
                calls++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId: request.requestId,
                    summary: "context fetched",
                    contextRows: journalRows(),
                    evidence: [],
                };
            },
        });
        const runtime = new ProgressiveContextPackRuntime({
            store: harness.store,
            reader: new SeamBoundContextReader(harness.engine, harness.seam, harness.registry),
            compiler: new ContextCompiler({ clock: fixedClock() }),
            clock: fixedClock(),
        });
        const initial = await runtime.compileInitial(mission.missionId, makeContextRequest({
            missionId: mission.missionId,
        }));
        await expect(runtime.expand(initial, {
            correlationId: "invalid-budget",
            request: makeContextRequest({
                missionId: mission.missionId,
                ownerHint: "lifeos",
                stepId,
                budget: { maxItems: Number.NaN, maxTotalChars: 1000, maxEstimatedTokens: 250 },
            }),
        })).rejects.toThrow(ContextCompilerError);
        expect(calls).toBe(0);
        const expansion = await runtime.expand(initial, {
            correlationId: "need-journal-week",
            request: makeContextRequest({
                missionId: mission.missionId,
                ownerHint: "lifeos",
                stepId,
                subject: "refs/lifeos/journal/week",
                budget: { maxItems: 3, maxTotalChars: 1500, maxEstimatedTokens: 400 },
            }),
        });

        expect(calls).toBe(1);
        expect(expansion.package.items.length).toBeGreaterThan(0);
        expect(expansion.accounting.expansions).toBe(1);
        expect(expansion.accounting.contextRequests).toBe(1);
        deepStrictEqual(JSON.parse(JSON.stringify(expansion)), expansion);

        const escalated = await runtime.expand(expansion, {
            correlationId: "outside-scope",
            request: makeContextRequest({
                missionId: mission.missionId,
                ownerHint: "lifeos",
                stepId,
                subject: "refs/lifeos/private/other",
            }),
        });
        expect(calls).toBe(1);
        expect(escalated.package.unresolved.at(-1)?.status).toBe(SourceStatus.UNSUPPORTED);
        await expect(runtime.expand(escalated, {
            correlationId: "secret-ref-check",
            request: makeContextRequest({
                missionId: mission.missionId,
                ownerHint: "lifeos",
                stepId: "step-context-read-2",
                subject: "refs/lifeos/api_key=not-a-real-key",
            }),
        })).rejects.toThrow(/must not contain secrets/i);
        expect(calls).toBe(1);
        await harness.close();
    });

    it("fails closed when an expansion asks for more aggregate budget than the initial pack", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission } = await harness.acceptContextPlan(descriptor, "refs/lifeos/journal/week");
        const runtime = new ProgressiveContextPackRuntime({
            store: harness.store,
            reader: new SeamBoundContextReader(harness.engine, harness.seam, harness.registry),
            compiler: new ContextCompiler({ clock: fixedClock() }),
            clock: fixedClock(),
        });
        const initial = await runtime.compileInitial(mission.missionId, makeContextRequest({
            missionId: mission.missionId,
            budget: { maxItems: 8, maxTotalChars: 1000, maxEstimatedTokens: 250 },
        }));
        await expect(runtime.expand(initial, {
            correlationId: "too-large",
            request: makeContextRequest({
                missionId: mission.missionId,
                ownerHint: "lifeos",
                stepId: "step-unavailable",
                budget: { maxItems: 99, maxTotalChars: 99999, maxEstimatedTokens: 99999 },
            }),
        })).rejects.toThrow(ContextCompilerError);
        await harness.close();
    });

    it("preserves mandatory Mission fields and records omitted optional rows when the budget is exhausted", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission, stepId } = await harness.acceptContextPlan(descriptor, "refs/lifeos/journal/week");
        harness.seam.registerConnector(descriptor.capabilityId, makeContextConnector(descriptor, {
            rows: [{
                sourceRef: "refs/lifeos/journal/week",
                content: "optional-entry-".repeat(100),
                fetchedAt: "2026-08-30T11:30:00.000Z",
                epistemicClass: EpistemicClass.FACT,
            }],
            withOwnerVerification: true,
        }));
        const runtime = new ProgressiveContextPackRuntime({
            store: harness.store,
            reader: new SeamBoundContextReader(harness.engine, harness.seam, harness.registry),
            compiler: new ContextCompiler({ clock: fixedClock() }),
            clock: fixedClock(),
        });
        const initial = await runtime.compileInitial(mission.missionId, makeContextRequest({
            missionId: mission.missionId,
            budget: { maxItems: 4, maxTotalChars: 1000, maxEstimatedTokens: 250 },
        }));
        const expanded = await runtime.expand(initial, {
            correlationId: "optional-context",
            request: makeContextRequest({
                missionId: mission.missionId,
                ownerHint: "lifeos",
                stepId,
                budget: { maxItems: 4, maxTotalChars: 1000, maxEstimatedTokens: 250 },
            }),
        });

        expect(expanded.mission.constraints).toEqual(mission.constraints);
        expect(expanded.mission.acceptanceCriteria).toEqual(mission.acceptanceCriteria);
        expect(expanded.package.items).toHaveLength(0);
        expect(expanded.package.budgetReport.excluded.some((item) => item.reason === "scope_exceeded")).toBe(true);
        expect(expanded.budget.observed.totalChars).toBeLessThanOrEqual(expanded.budget.limits.maxTotalChars);
        await harness.close();
    });

    it("reacquires a repeated request after freshness expires and removes the old source version", async () => {
        const descriptor = makeContextDescriptor("lifeos", { reconciliationSupport: "full_replay" });
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission, stepId } = await harness.acceptContextPlan(descriptor, "refs/lifeos/journal/week");
        let now = "2026-08-30T12:00:00.000Z";
        let invokes = 0;
        let reconciles = 0;
        const firstRow = {
            sourceRef: "refs/lifeos/journal/week",
            content: "A".repeat(450),
            fetchedAt: "2026-08-30T11:30:00.000Z",
            epistemicClass: EpistemicClass.FACT,
        };
        const secondRow = {
            sourceRef: "refs/lifeos/journal/week",
            content: "B".repeat(450),
            fetchedAt: "2026-08-30T14:30:00.000Z",
            epistemicClass: EpistemicClass.FACT,
        };
        harness.seam.registerConnector(descriptor.capabilityId, {
            connectorContractVersion: 1,
            capabilityId: descriptor.capabilityId,
            describe: () => descriptor,
            invoke: async (request) => {
                invokes++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId: request.requestId,
                    summary: "initial context read",
                    evidence: [],
                    contextRows: [firstRow],
                };
            },
            reconcile: async (requestId) => {
                reconciles++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId,
                    summary: "reacquired context read",
                    evidence: [],
                    contextRows: [secondRow],
                };
            },
        });
        const runtime = new ProgressiveContextPackRuntime({
            store: harness.store,
            reader: new SeamBoundContextReader(harness.engine, harness.seam, harness.registry),
            compiler: new ContextCompiler({ clock: () => new Date(now) }),
            clock: () => new Date(now),
        });
        const initial = await runtime.compileInitial(mission.missionId, makeContextRequest({
            missionId: mission.missionId,
            budget: { maxItems: 4, maxTotalChars: 800, maxEstimatedTokens: 200 },
        }));
        const request = makeContextRequest({
            missionId: mission.missionId,
            ownerHint: "lifeos",
            stepId,
            maxAgeMs: 60 * 60 * 1000,
            budget: { maxItems: 4, maxTotalChars: 800, maxEstimatedTokens: 200 },
        });
        const requestSnapshot = JSON.stringify(request);
        const first = await runtime.expand(initial, { correlationId: "same-query", request });
        expect(first.package.items.map((item) => item.content)).toContain("A".repeat(450));
        now = "2026-08-30T15:00:00.000Z";
        const second = await runtime.expand(first, { correlationId: "same-query", request });

        expect(invokes).toBe(1);
        expect(reconciles).toBe(1);
        expect(second.accounting.invocationIds).toHaveLength(1);
        expect(Object.hasOwn(second.accounting, "calls")).toBe(false);
        expect(second.accounting.attempts).toBe(1);
        expect(second.package.items.map((item) => item.content)).toContain("B".repeat(450));
        expect(second.package.items.map((item) => item.content)).not.toContain("A".repeat(450));
        expect(second.package.unresolved.some((item) => item.status === SourceStatus.STALE)).toBe(false);
        const repeatedFresh = await runtime.expand(second, { correlationId: "same-query", request });
        expect(JSON.stringify(request)).toBe(requestSnapshot);
        expect(invokes).toBe(1);
        expect(reconciles).toBe(2);
        expect(repeatedFresh.accounting.requestIds).toEqual(second.accounting.requestIds);
        expect(repeatedFresh.expansionIds).toEqual(second.expansionIds);
        expect(repeatedFresh.package.items.map((item) => item.content)).toEqual([
            "B".repeat(450),
        ]);
        expect(repeatedFresh.package.unresolved.some((item) => item.status === SourceStatus.STALE)).toBe(false);
        await harness.close();
    });

    it("records an unavailable owner as unresolved data without inventing context", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission, stepId } = await harness.acceptContextPlan(descriptor, "refs/lifeos/journal/week");
        harness.seam.registerConnector(descriptor.capabilityId, makeContextConnector(descriptor, {
            rows: journalRows(),
            status: CapabilityResultStatus.FAILED,
            withOwnerVerification: true,
        }));
        const runtime = new ProgressiveContextPackRuntime({
            store: harness.store,
            reader: new SeamBoundContextReader(harness.engine, harness.seam, harness.registry),
            compiler: new ContextCompiler({ clock: fixedClock() }),
            clock: fixedClock(),
        });
        const initial = await runtime.compileInitial(mission.missionId, makeContextRequest({ missionId: mission.missionId }));
        const expanded = await runtime.expand(initial, {
            correlationId: "unavailable-owner",
            request: makeContextRequest({ missionId: mission.missionId, ownerHint: "lifeos", stepId }),
        });

        expect(expanded.package.items).toHaveLength(0);
        expect(expanded.package.unresolved).toHaveLength(1);
        expect(expanded.package.unresolved[0]?.status).toBe(SourceStatus.UNAVAILABLE);
        expect(expanded.accounting.unresolvedSources).toBe(1);
        await harness.close();
    });

    it("recomposes after a runtime restart from durable Mission state and persists only scalar telemetry", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission, stepId } = await harness.acceptContextPlan(descriptor, "refs/lifeos/journal/week");
        harness.seam.registerConnector(descriptor.capabilityId, makeContextConnector(descriptor, {
            rows: [{
                sourceRef: "refs/lifeos/journal/week",
                content: "api_key=never-persist-this-row",
                fetchedAt: "2026-08-30T11:30:00.000Z",
                epistemicClass: EpistemicClass.FACT,
            }],
            withOwnerVerification: true,
        }));
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const runtime1 = new ProgressiveContextPackRuntime({
            store: harness.store, reader, compiler: new ContextCompiler({ clock: fixedClock() }), clock: fixedClock(),
        });
        const initial1 = await runtime1.compileInitial(mission.missionId, makeContextRequest({ missionId: mission.missionId }));
        const expanded = await runtime1.expand(initial1, {
            correlationId: "durable-accounting",
            request: makeContextRequest({ missionId: mission.missionId, ownerHint: "lifeos", stepId }),
        });
        const stored = await harness.store.getMission(mission.missionId);
        const telemetry = JSON.stringify(stored?.contextAccounting);
        expect(telemetry).toContain('"provenance":"estimated"');
        expect(telemetry).toContain('"bytes":');
        expect(telemetry).not.toContain("never-persist-this-row");
        expect(expanded.package.items.every((item) => !item.content.includes("never-persist-this-row"))).toBe(true);

        const runtime2 = new ProgressiveContextPackRuntime({
            store: harness.store, reader, compiler: new ContextCompiler({ clock: fixedClock() }), clock: fixedClock(),
        });
        const restarted = await runtime2.compileInitial(mission.missionId, makeContextRequest({ missionId: mission.missionId }));
        expect(restarted.package.items.some((item) => item.content.includes("never-persist-this-row"))).toBe(false);
        expect(restarted.accounting.contextRequests).toBe(expanded.accounting.contextRequests);
        expect(restarted.accounting.expansions).toBe(expanded.accounting.expansions);
        expect(restarted.accounting.invocationIds).toEqual(expanded.accounting.invocationIds);
        await expect(runtime2.expand(expanded, {
            correlationId: "old-pack-after-restart",
            request: makeContextRequest({ missionId: mission.missionId, ownerHint: "lifeos", stepId }),
        })).rejects.toThrow(/recompile after restart/i);

        harness.registerCriterionAttestation(mission.missionId, mission.acceptanceCriteria[0]!, "lifeos");
        await harness.engine.recordCriterionVerification(
            mission.missionId,
            mission.acceptanceCriteria[0]!,
            true,
            "lifeos",
        );
        await harness.engine.completeMission(mission.missionId);
        const completed = await harness.store.getMission(mission.missionId);
        expect(completed?.contextAccounting?.outcome.state).toBe("completed");
        expect(completed?.contextAccounting?.outcome.verified).toBe(true);
        await harness.close();
    });

    it("persists Context accounting through the existing Mission SQLite store restart", async () => {
        const directory = mkdtempSync(join(tmpdir(), "ouroboros-context-accounting-"));
        const dbPath = join(directory, "missions.sqlite");
        const mission = makeContextMission({
            contextAccounting: {
                contractVersion: 1,
                missionId: "mission-ctx-1",
                initial: { bytes: 50, chars: 45, items: 1 },
                aggregate: { bytes: 80, chars: 72, items: 2 },
                contextRequests: 1,
                expansions: 1,
                omissions: 0,
                unresolvedSources: 0,
                invocationIds: ["invocation-ctx-1"],
                requestIds: ["a".repeat(64)],
                tokenUsage: { value: 18, provenance: "estimated", method: "chars_div_4" },
                attempts: 1,
                outcome: { state: MissionState.EXECUTING, verified: false, ownerBlocked: false, verifiedCriteria: 0 },
                updatedAt: "2026-08-30T12:00:00.000Z",
            },
        });
        const oldMissionSnapshot = {
            ...mission,
            contextAccounting: { ...mission.contextAccounting!, calls: 1 },
        } as unknown as typeof mission;
        const firstStore = new SqliteMissionStore(dbPath);
        try {
            await firstStore.initialize();
            await firstStore.createMission(oldMissionSnapshot);
            await firstStore.close();
            const restartedStore = new SqliteMissionStore(dbPath);
            await restartedStore.initialize();
            const recovered = await restartedStore.getMission(mission.missionId);
            expect(recovered?.contextAccounting).toEqual(mission.contextAccounting);
            expect(Object.hasOwn(recovered?.contextAccounting ?? {}, "calls")).toBe(false);
            await restartedStore.close();
        } finally {
            await firstStore.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    for (const terminalState of [
        MissionState.COMPLETED,
        MissionState.CANCELLED,
        MissionState.FAILED_TERMINAL,
    ]) {
        it(`rejects initial compilation and expansion for terminal Mission ${terminalState}`, async () => {
            const descriptor = makeContextDescriptor("lifeos");
            const harness = await createSeamHarness({ descriptors: [descriptor] });
            const { mission, stepId } = await harness.acceptContextPlan(descriptor, "refs/lifeos/journal/week");
            let connectorCalls = 0;
            harness.seam.registerConnector(descriptor.capabilityId, {
                ...makeContextConnector(descriptor, { rows: journalRows() }),
                invoke: async (request) => {
                    connectorCalls++;
                    return {
                        status: CapabilityResultStatus.COMPLETED,
                        requestId: request.requestId,
                        summary: "context fetched",
                        contextRows: journalRows(),
                        evidence: [],
                    };
                },
            });
            const runtime = new ProgressiveContextPackRuntime({
                store: harness.store,
                reader: new SeamBoundContextReader(harness.engine, harness.seam, harness.registry),
                compiler: new ContextCompiler({ clock: fixedClock() }),
                clock: fixedClock(),
            });
            const pack = await runtime.compileInitial(mission.missionId, makeContextRequest({ missionId: mission.missionId }));

            if (terminalState === MissionState.COMPLETED) {
                await harness.updateMission(mission.missionId, {
                    state: MissionState.COMPLETED,
                    contextAccounting: {
                        ...pack.accounting,
                        outcome: {
                            state: MissionState.COMPLETED,
                            verified: true,
                            ownerBlocked: false,
                            verifiedCriteria: mission.acceptanceCriteria.length,
                        },
                    },
                    updatedAt: "2026-08-30T12:01:00.000Z",
                });
            } else if (terminalState === MissionState.CANCELLED) {
                await harness.engine.cancelMission(mission.missionId, "operator cancelled");
            } else {
                await harness.engine.failMission(mission.missionId, "fatal error");
            }

            const before = await harness.store.getMission(mission.missionId);
            const invocationsBefore = await harness.store.listInvocations(mission.missionId);
            expect(before?.state).toBe(terminalState);
            await expect(runtime.compileInitial(mission.missionId, makeContextRequest({
                missionId: mission.missionId,
            }))).rejects.toThrow(/terminal/i);
            await expect(runtime.expand(pack, {
                correlationId: `terminal-${terminalState}`,
                request: makeContextRequest({
                    missionId: mission.missionId,
                    ownerHint: "lifeos",
                    stepId,
                }),
            })).rejects.toThrow(/terminal/i);
            expect(await harness.store.updateContextAccountingIfNonTerminal(
                mission.missionId,
                before!.contextAccounting!,
            )).toBe(false);

            const after = await harness.store.getMission(mission.missionId);
            expect(connectorCalls).toBe(0);
            expect(await harness.store.listInvocations(mission.missionId)).toEqual(invocationsBefore);
            expect(after?.contextAccounting).toEqual(before?.contextAccounting);
            expect(after?.updatedAt).toBe(before?.updatedAt);
            expect(after?.state).toBe(before?.state);
            await harness.close();
        });
    }
});
