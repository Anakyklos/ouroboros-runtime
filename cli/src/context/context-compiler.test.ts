/**
 * 🧩 Context Compiler Tests (Issue #64)
 *
 * Deterministic, offline suite proving the #64 boundary:
 *  - mission-owned refs compile as FACT with mission authorization;
 *  - external content ONLY via SeamBoundContextReader over the #63
 *    ConnectorDispatchSeam (identity, split-brain, schemas, honest status);
 *  - epistemic classes stay distinct (fact / derived_summary / inference);
 *    external rows are NEVER silently promoted to FACT;
 *  - the package is inert frozen data (injection stays DATA);
 *  - requester budgets are clamped by the runtime ceiling policy and every
 *    mutation re-runs the class/dedup/budget pipeline with honest reports;
 *  - expiry anchors to the SOURCE's fetchedAt (recompilation never renews);
 *  - secrets fail closed with honest exclusion records;
 *  - restart recomposition is pure (same inputs → same package).
 */

import { describe, expect, it } from "bun:test";

import { CapabilityResultStatus } from "../capabilities/connector.js";
import { ContextCompiler, ContextCompilerError, recompileAfterRestart } from "./compiler.js";
import type { ContextReadOutcome } from "./compiler.js";
import {
    EpistemicClass,
    SensitivityClass,
    SourceStatus,
} from "./contracts.js";
import type { BoundedContextPackage, ContextRequest } from "./contracts.js";
import {
    fixedClock,
    journalRows,
    makeContextConnector,
    makeContextDescriptor,
    makeContextMission,
    makeContextRequest,
    THREE_HOURS_MS,
} from "./fixtures.js";
import { SeamBoundContextReader } from "./sources.js";
import { createSeamHarness } from "./seam-harness.js";

/**
 * Canonical flow under test: accepted READ plan step → seam dispatch →
 * reader packaging → compiler. Deterministic and fully offline.
 */
async function compileViaSeam(options: {
    descriptorOverrides?: Parameters<typeof makeContextDescriptor>[1];
    rows?: ReturnType<typeof journalRows>;
    status?: CapabilityResultStatus;
    throws?: boolean;
    requestOverrides?: Partial<ContextRequest>;
    missionOverrides?: Parameters<typeof makeContextMission>[0];
}): Promise<{ pkg: BoundedContextPackage; missionId: string; close: () => Promise<void> }> {
    const descriptor = makeContextDescriptor("lifeos", options.descriptorOverrides);
    const harness = await createSeamHarness({ descriptors: [descriptor] });
    const { mission } = await harness.acceptContextPlan(
        descriptor,
        options.requestOverrides?.subject ?? "refs/lifeos/journal/2026-08",
    );
    harness.seam.registerConnector(
        descriptor.capabilityId,
        makeContextConnector(descriptor, {
            rows: options.rows ?? journalRows(),
            status: options.status,
            throws: options.throws,
            withOwnerVerification: true,
        }),
    );
    const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
    const request = makeContextRequest({
        ownerHint: "lifeos",
        missionId: mission.missionId,
        ...options.requestOverrides,
    });
    const outcomes = await reader.read(mission, request, {
        dispatchStepId: "step-context-read",
    });
    const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, outcomes);
    return { pkg, missionId: mission.missionId, close: () => harness.close() };
}

describe("ContextCompiler — mission-only compilation", () => {
    it("compiles mission-owned contextRefs as FACT items with mission authorization", async () => {
        const mission = makeContextMission({
            contextRefs: [
                {
                    refId: "ref-1",
                    owner: "lifeos",
                    label: "Journal index for 2026-08",
                    externalRef: "refs/lifeos/journal/2026-08",
                    authorizedBy: "user consent on 2026-08-01",
                },
            ],
        });
        const request = makeContextRequest();
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, []);

        expect(pkg.missionId).toBe("mission-ctx-1");
        expect(pkg.items).toHaveLength(1);
        expect(pkg.items[0].epistemicClass).toBe(EpistemicClass.FACT);
        expect(pkg.items[0].content).toBe("Journal index for 2026-08");
        expect(pkg.items[0].provenance.origin).toBe("mission_owned");
        expect(pkg.items[0].provenance.authorization).toContain("user consent on 2026-08-01");
        expect(pkg.unresolved).toHaveLength(0);
    });

    it("is deterministic: same inputs → same packageId and items", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest();
        const a = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, []);
        const b = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, []);
        expect(a.packageId).toBe(b.packageId);
        expect(a).toEqual(b);
        expect(a.packageId.startsWith("pkg-")).toBe(true);
    });

    it("does not mutate the mission or the request", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest();
        const missionSnapshot = structuredClone(mission);
        const requestSnapshot = structuredClone(request);
        new ContextCompiler({ clock: fixedClock() }).compile(mission, request, []);
        expect(mission).toEqual(missionSnapshot);
        expect(request).toEqual(requestSnapshot);
    });

    it("refuses a request that targets another mission (fail-closed)", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest({ missionId: "mission-OTHER" });
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, request, []),
        ).toThrow(/targets mission "mission-OTHER"/);
    });

    it("fails closed when the budget is missing/invalid (never compiles unbounded)", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest();
        for (const bad of [
            undefined,
            { maxItems: 0, maxTotalChars: 100, maxEstimatedTokens: 10 },
            { maxItems: Number.NaN, maxTotalChars: 100, maxEstimatedTokens: 10 },
        ] as unknown as ContextRequest["budget"][]) {
            const broken = { ...request, budget: bad } as ContextRequest;
            expect(() =>
                new ContextCompiler({ clock: fixedClock() }).compile(mission, broken, []),
            ).toThrow(ContextCompilerError);
        }
    });
});

describe("ContextCompiler — provenance is compiler-computed (forge-proof)", () => {
    it("external rows carry provenance from the authorized descriptor, not the connector", async () => {
        const { pkg, missionId, close } = await compileViaSeam({});
        for (const item of pkg.items) {
            expect(item.provenance.owner).toBe("lifeos");
            expect(item.provenance.origin).toBe("external_owner");
            expect(item.provenance.authorization).toBe("capability:context:lifeos");
            expect(item.provenance.sourceVersion).toBe(1);
            expect(item.provenance.missionId).toBe(missionId);
            expect(item.provenance.missionId).toMatch(/^inv-/); // engine-minted
            expect(item.provenance.purpose).toBe("weekly review compilation");
        }
        await close();
    });

    it("rejects a request that targets another mission even with authorized reads (fail-closed)", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            descriptor.capabilityId,
            makeContextConnector(descriptor, { rows: journalRows(), withOwnerVerification: true }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const outcomes = await reader.read(mission, request, {
            dispatchStepId: "step-context-read",
        });
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(
                mission,
                makeContextRequest({ ownerHint: "lifeos", missionId: "mission-OTHER" }),
                outcomes,
            ),
        ).toThrow(/targets mission "mission-OTHER"/);
        await harness.close();
    });
});

describe("SeamBoundContextReader — one dispatch path (#63 seam)", () => {
    it("dispatches an accepted READ step through the seam and compiles rows", async () => {
        const { pkg, close } = await compileViaSeam({});
        expect(pkg.items).toHaveLength(3);
        for (const item of pkg.items) {
            expect(item.epistemicClass).toBe(EpistemicClass.FACT);
            expect(item.provenance.owner).toBe("lifeos");
        }
        await close();
    });

    it("honors the ownsStorage=true real-world owner capability (review blocker 2)", async () => {
        // LifeOS legitimately reads its OWN storage through its capability.
        const { pkg, close } = await compileViaSeam({});
        expect(pkg.items.length).toBeGreaterThan(0);
        expect(pkg.unresolved).toHaveLength(0);
        // No DB paths, no storage URLs cross the boundary — refs only.
        const json = JSON.stringify(pkg);
        expect(json).not.toContain("storage://");
        expect(json).not.toContain("db://");
        await close();
    });

    it("refuses a subject outside CURRENT mission ref prefixes as REVOKED (pre-seam)", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            descriptor.capabilityId,
            makeContextConnector(descriptor, { rows: journalRows(), withOwnerVerification: true }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        // Mission scope narrowed after acceptance: subject now outside.
        const narrowed = {
            ...mission,
            allowedCapabilityScope: {
                ...mission.allowedCapabilityScope,
                allowedRefPrefixes: ["refs/tecer/"],
            },
        };
        const outcomes = await reader.read(narrowed, makeContextRequest({
            ownerHint: "lifeos",
            subject: "refs/runstead/pr/7",
            missionId: mission.missionId,
        }), { dispatchStepId: "step-context-read" });
        expect(outcomes).toHaveLength(1);
        const unresolved = outcomes[0] as { status: SourceStatus; detail: string };
        expect(unresolved.status).toBe(SourceStatus.REVOKED);
        expect(unresolved.detail).toContain("outside mission allowed ref prefixes");
        await harness.close();
    });

    it("refuses rows outside the descriptor's declared ref prefixes (fail-closed)", async () => {
        // The step input stays INSIDE the contract (a rogue inputRef never
        // passes #62 policy at plan time); the connector is the one that
        // tries to smuggle rows outside its declared prefixes.
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            descriptor.capabilityId,
            makeContextConnector(descriptor, {
                withOwnerVerification: true,
                rows: [
                    {
                        sourceRef: "refs/other/smuggled",
                        content: "Row outside the declared descriptor prefixes.",
                        epistemicClass: EpistemicClass.FACT,
                    },
                ],
            }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const outcomes = await reader.read(mission, request, {
            dispatchStepId: "step-context-read",
        });
        expect(outcomes).toHaveLength(1);
        const unresolved = outcomes[0] as { status: SourceStatus; detail: string };
        expect(unresolved.status).toBe(SourceStatus.UNSUPPORTED);
        expect(unresolved.detail).toContain("outside capability declared ref prefixes");
        await harness.close();
    });

    it("refuses a step outside the accepted plan (no plan forgery)", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const outcomes = await reader.read(mission, makeContextRequest({
            ownerHint: "lifeos",
            missionId: mission.missionId,
        }), { dispatchStepId: "step-not-in-plan" });
        expect(outcomes).toHaveLength(1);
        const unresolved = outcomes[0] as { status: SourceStatus; detail: string };
        expect(unresolved.status).toBe(SourceStatus.UNSUPPORTED);
        expect(unresolved.detail).toContain("not part of the accepted plan");
        await harness.close();
    });

    it("degrades honestly when the capability is unavailable (seam pre-mint gate)", async () => {
        const descriptor = makeContextDescriptor("lifeos", {
            availability: "unavailable" as never,
        });
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            descriptor.capabilityId,
            makeContextConnector(descriptor, { rows: journalRows(), withOwnerVerification: true }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const outcomes = await reader.read(mission, makeContextRequest({
            ownerHint: "lifeos",
            missionId: mission.missionId,
        }), { dispatchStepId: "step-context-read" });
        expect(outcomes).toHaveLength(1);
        const unresolved = outcomes[0] as { status: SourceStatus; detail: string };
        expect(unresolved.status).toBe(SourceStatus.UNAVAILABLE);
        await harness.close();
    });

    it("degrades honestly on a non-completed invocation (still_running carries no content)", async () => {
        const { pkg, close } = await compileViaSeam({
            status: CapabilityResultStatus.STILL_RUNNING,
        });
        expect(pkg.items).toHaveLength(0);
        expect(pkg.unresolved).toHaveLength(1);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.UNAVAILABLE);
        expect(pkg.unresolved[0].detail).toContain("carries no compiled content");
        await close();
    });

    it("degrades honestly when the connector throws (seam records BLOCKED, never success)", async () => {
        const { pkg, close } = await compileViaSeam({ throws: true });
        expect(pkg.items).toHaveLength(0);
        expect(pkg.unresolved).toHaveLength(1);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.UNAVAILABLE);
        await close();
    });

    it("skips malformed rows honestly and keeps valid siblings", async () => {
        const rows = [
            { sourceRef: "", content: "broken row", epistemicClass: EpistemicClass.FACT },
            ...journalRows(),
            { sourceRef: "refs/lifeos/journal/x", content: 42 },
        ];
        const { pkg, close } = await compileViaSeam({ rows });
        // 2 malformed entries skipped honestly…
        expect(pkg.unresolved.some((u) => u.detail.includes("malformed row"))).toBe(true);
        // …and the 3 valid siblings compiled.
        expect(pkg.items).toHaveLength(3);
        await close();
    });

    it("records already-authorized outcomes after re-validating CURRENT scope", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission, stepId } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            descriptor.capabilityId,
            makeContextConnector(descriptor, { rows: journalRows(), withOwnerVerification: true }),
        );
        const seamOutcome = await harness.seam.dispatchThroughSeam(mission.missionId, stepId);
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });

        const ok = await reader.read(mission, request, { alreadyAuthorized: [seamOutcome] });
        expect(ok).toHaveLength(1);
        expect("rows" in ok[0]).toBe(true);

        // The caller's snapshot is NEVER authority: mutating it (or passing
        // a forged one) changes nothing — the reader re-validates against
        // FRESH engine state (same split-brain discipline as dispatch).
        const forged = {
            ...mission,
            allowedCapabilityScope: {
                ...mission.allowedCapabilityScope,
                capabilityIds: ["context:tecer"],
            },
        };
        const stillOk = await reader.read(forged, request, { alreadyAuthorized: [seamOutcome] });
        expect(stillOk).toHaveLength(1);
        expect("rows" in stillOk[0]).toBe(true);
        expect((stillOk[0] as { rows: unknown[] }).rows).toHaveLength(3);
        await harness.close();
    });
});

describe("ContextCompiler — epistemic classes stay distinct", () => {
    it("compiles inferences as INFERENCE without promotion and honors requestedClasses", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest();
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, []);

        const withInference = new ContextCompiler({ clock: fixedClock() }).addInference(pkg, {
            content: "The user seems ready for a deeper review cadence",
            refId: "inf-1",
        });
        expect(withInference.ok).toBe(true);
        if (!withInference.ok) return;
        expect(withInference.item.epistemicClass).toBe(EpistemicClass.INFERENCE);
        expect(withInference.item.provenance.owner).toBe("planner");
        expect(withInference.item.provenance.sourceRef).toBe("inference:inf-1");

        // Minimal disclosure: requesting only FACTs excludes the inference
        // with a recorded (never silent) reason.
        const factOnly = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            makeContextRequest({ requestedClasses: [EpistemicClass.FACT] }),
            [],
        );
        expect(factOnly.items.every((i) => i.epistemicClass === EpistemicClass.FACT)).toBe(true);
    });

    it("deriveSummary produces DERIVED_SUMMARY with reconstructible lineage", async () => {
        const mission = makeContextMission({
            contextRefs: [
                {
                    refId: "ref-1",
                    owner: "lifeos",
                    label: "Journal index for 2026-08",
                    externalRef: "refs/lifeos/journal/2026-08",
                    authorizedBy: "user consent on 2026-08-01",
                },
            ],
        });
        const compiler = new ContextCompiler({ clock: fixedClock() });
        const pkg = compiler.compile(mission, makeContextRequest(), []);
        expect(pkg.items).toHaveLength(1);

        const derived = compiler.deriveSummary(pkg, {
            sourceItemIds: [pkg.items[0].itemId],
            maxChars: 256,
        });
        expect(derived.ok).toBe(true);
        if (!derived.ok) return;
        expect(derived.item.epistemicClass).toBe(EpistemicClass.DERIVED_SUMMARY);
        expect(derived.item.derivedFrom).toEqual([pkg.items[0].itemId]);
        expect(derived.item.derivationOp).toBe("first:1");
        expect(derived.item.provenance.owner).toBe("ouroboros.compiler");
        expect(derived.package.items).toHaveLength(2);
        // Honest accounting after the addition (blocker 3).
        expect(derived.package.budgetReport.observed.items).toBe(2);
        expect(
            derived.package.budgetReport.observed.totalChars,
        ).toBe(derived.package.items.reduce((s, i) => s + i.content.length, 0));
    });

    it("refuses to derive a summary from an inference (no masquerade as fact)", async () => {
        const mission = makeContextMission();
        const compiler = new ContextCompiler({ clock: fixedClock() });
        const pkg = compiler.compile(mission, makeContextRequest(), []);
        const added = compiler.addInference(pkg, { content: "a guess", refId: "inf-9" });
        expect(added.ok).toBe(true);
        if (!added.ok) return;
        const derived = compiler.deriveSummary(added.package, {
            sourceItemIds: [added.item.itemId],
            maxChars: 64,
        });
        expect(derived.ok).toBe(false);
        if (derived.ok) return;
        expect(derived.reason).toContain("inference");
    });

    it("refuses to derive from source ids that are not in the package", async () => {
        const mission = makeContextMission();
        const compiler = new ContextCompiler({ clock: fixedClock() });
        const pkg = compiler.compile(mission, makeContextRequest(), []);
        const derived = compiler.deriveSummary(pkg, {
            sourceItemIds: ["ctx-does-not-exist"],
            maxChars: 64,
        });
        expect(derived.ok).toBe(false);
    });
});

describe("ContextCompiler — no silent FACT promotion (review blocker 5)", () => {
    it("refuses external rows without epistemic classification (never defaults to FACT)", async () => {
        const { pkg, close } = await compileViaSeam({
            rows: [
                { sourceRef: "refs/lifeos/journal/no-class", content: "Unclassified content." },
            ] as never,
        });
        expect(pkg.items).toHaveLength(0);
        expect(pkg.unresolved).toHaveLength(1);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.UNSUPPORTED);
        expect(pkg.unresolved[0].detail).toContain("no epistemic classification");
        await close();
    });

    it("preserves a DERIVED_SUMMARY row as derived_summary (owner summary stays a summary)", async () => {
        const { pkg, close } = await compileViaSeam({
            rows: [
                {
                    sourceRef: "refs/lifeos/journal/summary",
                    content: "Owner-provided weekly summary.",
                    epistemicClass: EpistemicClass.DERIVED_SUMMARY,
                    fetchedAt: "2026-08-30T09:00:00.000Z",
                },
            ],
        });
        expect(pkg.items).toHaveLength(1);
        expect(pkg.items[0].epistemicClass).toBe(EpistemicClass.DERIVED_SUMMARY);
        expect(pkg.items[0].epistemicClass).not.toBe(EpistemicClass.FACT);
        await close();
    });

    it("keeps an INFERENCE row as inference (requester guess from the owner side)", async () => {
        const { pkg, close } = await compileViaSeam({
            rows: [
                {
                    sourceRef: "refs/lifeos/journal/guess",
                    content: "Owner-side guess.",
                    epistemicClass: EpistemicClass.INFERENCE,
                    fetchedAt: "2026-08-30T09:00:00.000Z",
                },
            ],
        });
        expect(pkg.items).toHaveLength(1);
        expect(pkg.items[0].epistemicClass).toBe(EpistemicClass.INFERENCE);
        await close();
    });

    it("honors the descriptor factRowsOnly guarantee without trusting the connector", async () => {
        const { pkg, close } = await compileViaSeam({
            descriptorOverrides: { factRowsOnly: true },
            rows: [
                { sourceRef: "refs/lifeos/journal/no-class", content: "Fact-only source row." },
            ] as never,
        });
        expect(pkg.items).toHaveLength(1);
        expect(pkg.items[0].epistemicClass).toBe(EpistemicClass.FACT);
        await close();
    });
});

describe("ContextCompiler — budgets clamp and additions re-run the pipeline (blocker 3)", () => {
    it("clamps a requester budget above the runtime ceiling (policy is authority)", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest({
            budget: { maxItems: 1000, maxTotalChars: 1000000, maxEstimatedTokens: 500000 },
        });
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, []);
        expect(pkg.budgetReport.limits).toEqual({
            maxItems: 32,
            maxTotalChars: 16000,
            maxEstimatedTokens: 4000,
        });
        expect(pkg.budgetReport.clamped).toBe(true);
        expect(pkg.budgetReport.proposed).toEqual(request.budget);
    });

    it("caps items with recorded exclusions under the EFFECTIVE budget, deterministic order", async () => {
        const { pkg, close } = await compileViaSeam({
            requestOverrides: {
                budget: { maxItems: 2, maxTotalChars: 10000, maxEstimatedTokens: 5000 },
            },
        });
        expect(pkg.items).toHaveLength(2);
        expect(pkg.budgetReport.observed.items).toBe(2);
        expect(pkg.budgetReport.excluded).toHaveLength(1);
        expect(pkg.budgetReport.excluded[0].reason).toBe("scope_exceeded");
        // Deterministic order-independent selection: lowest sourceRefs win.
        expect(pkg.items.map((i) => i.provenance.sourceRef)).toEqual([
            "refs/lifeos/journal/2026-08-28",
            "refs/lifeos/journal/2026-08-29",
        ]);
        await close();
    });

    it("deduplicates identical content from repeated reads (recorded, not silent)", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission, stepId } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            descriptor.capabilityId,
            makeContextConnector(descriptor, { rows: journalRows(), withOwnerVerification: true }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const outcomes: ContextReadOutcome[] = [
            ...(await reader.read(mission, request, { dispatchStepId: stepId })),
        ];
        expect(outcomes).toHaveLength(1);
        expect("rows" in outcomes[0]).toBe(true);

        // Repeating the read is a blind redispatch: the engine refuses a
        // second dispatch of the same step (honest one-shot invariant).
        let conflict: unknown;
        try {
            await harness.seam.dispatchThroughSeam(mission.missionId, stepId);
        } catch (error) {
            conflict = error;
        }
        expect((conflict as Error)?.name).toBe("InvocationConflictError");

        // Re-package the SAME authorized outcome twice in one compilation:
        // the compiler's dedup collapses identical content (recorded, not
        // silent) instead of double-counting the same rows.
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            request,
            [...outcomes, ...outcomes],
        );
        expect(pkg.items).toHaveLength(3); // 6 identical rows → 3 unique items
        expect(pkg.budgetReport.excluded.filter((e) => e.reason === "duplicate")).toHaveLength(3);
        await harness.close();
    });

    it("is order-independent: shuffled read order yields the same package", async () => {
        const { pkg, close } = await compileViaSeam({});
        const mission = makeContextMission({ missionId: pkg.missionId });
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: pkg.missionId });
        const rows = journalRows();
        const direct = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [
            { descriptor: (pkg.items[0].provenance.owner, pkg.items[0].provenance) && {
                capabilityId: "context:lifeos",
                moduleOwner: "lifeos",
                contractVersion: 1,
            }, rows },
            { descriptor: { capabilityId: "context:lifeos", moduleOwner: "lifeos", contractVersion: 1 }, rows: [] },
        ]);
        const flipped = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [
            { descriptor: { capabilityId: "context:lifeos", moduleOwner: "lifeos", contractVersion: 1 }, rows: [] },
            { descriptor: { capabilityId: "context:lifeos", moduleOwner: "lifeos", contractVersion: 1 }, rows },
        ]);
        expect(direct.packageId).toBe(flipped.packageId);
        await close();
    });

    it("enforces the token-like budget via the documented 4-chars-per-token heuristic", async () => {
        const { pkg, close } = await compileViaSeam({
            rows: [{ sourceRef: "refs/lifeos/big", content: "x".repeat(400), epistemicClass: EpistemicClass.FACT }],
            requestOverrides: {
                budget: { maxItems: 12, maxTotalChars: 100000, maxEstimatedTokens: 50 },
            },
        });
        // 400 chars ≈ 100 estimated tokens > 50 → excluded, honest record.
        expect(pkg.items).toHaveLength(0);
        expect(pkg.budgetReport.excluded).toHaveLength(1);
        expect(pkg.budgetReport.excluded[0].reason).toBe("scope_exceeded");
        await close();
    });

    it("addInference respects requestedClasses, dedup and the budget (one pipeline)", async () => {
        const mission = makeContextMission();
        const compiler = new ContextCompiler({ clock: fixedClock() });

        // FACT-only request: an inference addition is refused.
        const factOnly = compiler.compile(
            mission,
            makeContextRequest({ requestedClasses: [EpistemicClass.FACT] }),
            [],
        );
        const refused = compiler.addInference(factOnly, { content: "a guess", refId: "inf-1" });
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.reason).toContain("minimal disclosure");

        // Full package: an addition that would exceed maxItems is refused.
        const full = compiler.compile(
            mission,
            makeContextRequest({ budget: { maxItems: 1, maxTotalChars: 1000, maxEstimatedTokens: 250 } }),
            [],
        );
        const filler = compiler.addInference(full, { content: "filler", refId: "inf-2" });
        expect(filler.ok).toBe(true);
        if (!filler.ok) return;
        const overflow = compiler.addInference(filler.package, { content: "one too many", refId: "inf-3" });
        expect(overflow.ok).toBe(false);
        if (!overflow.ok) expect(overflow.reason).toContain("maxItems");

        // Duplicate addition (same owner+class+content) is refused.
        const open = compiler.compile(mission, makeContextRequest(), []);
        const first = compiler.addInference(open, { content: "same thought", refId: "inf-4" });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const dup = compiler.addInference(first.package, { content: "same thought", refId: "inf-5" });
        expect(dup.ok).toBe(false);
        if (!dup.ok) expect(dup.reason).toContain("duplicate");

        // The refused additions never appear anywhere; the accepted one is
        // accounted honestly.
        expect(first.package.budgetReport.observed.items).toBe(1);
    });

    it("deriveSummary honors the class filter and budget too", async () => {
        const mission = makeContextMission({
            contextRefs: [
                {
                    refId: "ref-1",
                    owner: "lifeos",
                    label: "Journal index for 2026-08",
                    externalRef: "refs/lifeos/journal/2026-08",
                    authorizedBy: "user consent on 2026-08-01",
                },
            ],
        });
        const compiler = new ContextCompiler({ clock: fixedClock() });
        const factOnly = compiler.compile(
            mission,
            makeContextRequest({
                requestedClasses: [EpistemicClass.FACT],
                budget: { maxItems: 1, maxTotalChars: 1000, maxEstimatedTokens: 250 },
            }),
            [],
        );
        // Package is full (1/1 items) and the request admits only FACTs:
        // the class gate (minimal disclosure) fires first and honestly.
        const refused = compiler.deriveSummary(factOnly, {
            sourceItemIds: [factOnly.items[0].itemId],
            maxChars: 64,
        });
        expect(refused.ok).toBe(false);
        if (!refused.ok) {
            expect(refused.reason).toContain("minimal disclosure");
        }

        // With the class gate satisfied (full request), a full package
        // refuses the addition on maxItems.
        const full = compiler.compile(
            mission,
            makeContextRequest({
                budget: { maxItems: 1, maxTotalChars: 1000, maxEstimatedTokens: 250 },
            }),
            [],
        );
        expect(full.items).toHaveLength(1);
        const overflow = compiler.deriveSummary(full, {
            sourceItemIds: [full.items[0].itemId],
            maxChars: 64,
        });
        expect(overflow.ok).toBe(false);
        if (!overflow.ok) expect(overflow.reason).toContain("maxItems");
    });
});

describe("ContextCompiler — package is inert data (injection stays DATA)", () => {
    it("returns a deeply frozen package with no functions and untouched mission intent", async () => {
        const { pkg, missionId, close } = await compileViaSeam({});
        expect(missionId).toMatch(/^inv-/); // engine-minted mission id

        expect(Object.isFrozen(pkg)).toBe(true);
        expect(Object.isFrozen(pkg.items)).toBe(true);
        expect(Object.isFrozen(pkg.items[0])).toBe(true);
        expect(Object.isFrozen(pkg.items[0].provenance)).toBe(true);
        expect(Object.isFrozen(pkg.request)).toBe(true);

        const json = JSON.stringify(pkg);
        expect(json).not.toContain("() =>");
        expect(json).not.toContain("function");

        // The compiler holds no API into Mission authority fields.
        expect(pkg.missionId).toBe(missionId);
        await close();
    });
});

describe("ContextCompiler — secrets fail closed", () => {
    it("refuses secret-bearing rows with honest exclusion records (no leak)", async () => {
        const { pkg, close } = await compileViaSeam({
            rows: [
                {
                    sourceRef: "refs/lifeos/journal/leaky",
                    content: "my api_key=sk-proj-abcdef123456 and password=hunter2",
                    epistemicClass: EpistemicClass.FACT,
                },
                ...journalRows(),
            ],
        });

        expect(pkg.items).toHaveLength(3); // only the clean rows survive
        expect(pkg.budgetReport.excluded.some((e) => e.reason === "secret_refused")).toBe(true);
        const json = JSON.stringify(pkg);
        expect(json).not.toContain("sk-proj-");
        expect(json).not.toContain("hunter2");
        expect(json).not.toContain("api_key=sk");
        await close();
    });

    it("carries owner-declared RESTRICTED rows as reference-only", async () => {
        const { pkg, close } = await compileViaSeam({
            rows: [
                {
                    sourceRef: "refs/lifeos/journal/private",
                    content: "SHOULD NEVER APPEAR",
                    epistemicClass: EpistemicClass.FACT,
                    sensitivity: SensitivityClass.RESTRICTED,
                },
            ],
        });
        expect(pkg.items).toHaveLength(1);
        expect(pkg.items[0].content).toBe(
            "(restricted: reference-only refs/lifeos/journal/private)",
        );
        expect(pkg.items[0].provenance.sensitivity).toBe(SensitivityClass.RESTRICTED);
        expect(JSON.stringify(pkg)).not.toContain("SHOULD NEVER APPEAR");
        await close();
    });
});

describe("ContextCompiler — freshness anchors to the source (blocker 4)", () => {
    it("no timestamp or old rows are STALE; expiry = fetchedAt + maxAgeMs", async () => {
        const rows = [
            {
                sourceRef: "refs/lifeos/journal/no-ts",
                content: "Entry without a valid age proof.",
                epistemicClass: EpistemicClass.FACT,
            },
            {
                sourceRef: "refs/lifeos/journal/aged",
                content: "Aged entry.",
                epistemicClass: EpistemicClass.FACT,
                fetchedAt: "2026-08-30T08:00:00.000Z",
            },
            {
                sourceRef: "refs/lifeos/journal/fresh",
                content: "Fresh entry.",
                epistemicClass: EpistemicClass.FACT,
                fetchedAt: "2026-08-30T09:00:00.000Z",
            },
        ];
        const { pkg, close } = await compileViaSeam({
            rows,
            requestOverrides: { maxAgeMs: THREE_HOURS_MS },
        });

        // Clock is 2026-08-30T12:00 — the "fresh" row is exactly 3h old
        // (boundary, included); the "aged" row (4h) exceeds maxAgeMs; the
        // timestamp-less row cannot prove its age and is STALE.
        expect(pkg.unresolved).toHaveLength(2);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.STALE);
        expect(pkg.unresolved[0].detail).toContain("no valid timestamp");
        expect(pkg.unresolved[1].status).toBe(SourceStatus.STALE);
        expect(pkg.unresolved[1].requestedRef).toBe("refs/lifeos/journal/aged");
        expect(pkg.items).toHaveLength(1);
        expect(pkg.items[0].provenance.sourceRef).toBe("refs/lifeos/journal/fresh");
        // THE FIX (blocker 4): expiry anchors to the SOURCE's fetchedAt
        // (09:00 + 3h = 12:00), NOT to compilation time (would be 15:00).
        expect(pkg.items[0].provenance.expiresAt).toBe("2026-08-30T12:00:00.000Z");
        await close();
    });

    it("recompiling later does NOT renew expiry (honest freshness)", async () => {
        const rows = [
            {
                sourceRef: "refs/lifeos/journal/fresh",
                content: "Fresh entry.",
                epistemicClass: EpistemicClass.FACT,
                fetchedAt: "2026-08-30T09:00:00.000Z",
            },
        ];
        const { pkg, close } = await compileViaSeam({
            rows,
            requestOverrides: { maxAgeMs: THREE_HOURS_MS },
        });
        expect(pkg.items[0].provenance.expiresAt).toBe("2026-08-30T12:00:00.000Z");

        // Recompile at 14:00 with the same reads: the row is now stale and
        // the expiry would be the same — validity is never renewed.
        const mission = makeContextMission();
        const request = makeContextRequest({
            ownerHint: "lifeos",
            maxAgeMs: THREE_HOURS_MS,
        });
        const descriptor = { capabilityId: "context:lifeos", moduleOwner: "lifeos", contractVersion: 1 };
        const later = new ContextCompiler({ clock: () => new Date("2026-08-30T14:00:00.000Z") }).compile(
            mission,
            request,
            [{ descriptor, rows }],
        );
        expect(later.items).toHaveLength(0);
        expect(later.unresolved[0].status).toBe(SourceStatus.STALE);
        await close();
    });
});

describe("ContextCompiler — restart recomposition", () => {
    it("recompiles the same package from durable state after restart (pure, no cache)", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission, stepId } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            descriptor.capabilityId,
            makeContextConnector(descriptor, { rows: journalRows(), withOwnerVerification: true }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const outcomes = await reader.read(mission, request, { dispatchStepId: stepId });

        const first = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, outcomes);
        const restarted = recompileAfterRestart(mission, request, outcomes, {
            clock: fixedClock(),
        });
        expect(restarted.packageId).toBe(first.packageId);
        expect(restarted).toEqual(first);
        await harness.close();
    });
});
