import { describe, expect, it } from "bun:test";
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
import { MissionState } from "../mission/contracts.js";

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

        const pack = await runtime.compileInitial(mission.missionId, makeContextRequest({
            missionId: mission.missionId,
        }));

        expect(pack.missionId).toBe(mission.missionId);
        expect(pack.initialPackageId).toMatch(/^pkg-/);
        expect(pack.mission.objective).toBe(mission.sanitizedOriginalIntent);
        expect(calls).toBe(0);
        expect(pack.accounting.expansions).toBe(0);
        expect(Object.isFrozen(pack)).toBe(true);
        expect(JSON.parse(JSON.stringify(pack))).toEqual(pack);
        expect(pack.budget.observed.totalChars).toBeLessThanOrEqual(pack.budget.limits.maxTotalChars);
        await harness.close();
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
        expect(second.accounting.calls).toBe(1);
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
                calls: 1,
                attempts: 1,
                outcome: { state: MissionState.EXECUTING, verified: false, ownerBlocked: false, verifiedCriteria: 0 },
                updatedAt: "2026-08-30T12:00:00.000Z",
            },
        });
        const firstStore = new SqliteMissionStore(dbPath);
        try {
            await firstStore.initialize();
            await firstStore.createMission(mission);
            await firstStore.close();
            const restartedStore = new SqliteMissionStore(dbPath);
            await restartedStore.initialize();
            const recovered = await restartedStore.getMission(mission.missionId);
            expect(recovered?.contextAccounting).toEqual(mission.contextAccounting);
            await restartedStore.close();
        } finally {
            await firstStore.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
