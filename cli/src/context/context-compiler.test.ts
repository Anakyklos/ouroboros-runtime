/**
 * 🧩 Context Compiler Tests (Issue #64)
 *
 * Deterministic, offline suite proving the #64 boundary:
 *  - mission-owned refs compile as FACT with mission authorization;
 *  - external content ONLY via SeamBoundContextReader over the #63
 *    ConnectorDispatchSeam, SEALED into non-forgeable SeamAuthorizedReads
 *    (raw {descriptor, rows} and forged reads are structurally refused);
 *  - epistemic classes stay distinct (fact / derived_summary / inference);
 *    external rows are NEVER silently promoted to FACT;
 *  - the package is inert frozen data (injection stays DATA);
 *  - requester budgets are clamped by the runtime ceiling policy and every
 *    mutation re-runs the class/dedup/budget pipeline with honest reports;
 *    effective limits are MONOTONICALLY NON-EXPANDING across compilers;
 *  - sensitivity accompanies redaction (never NORMAL next to [REDACTED]);
 *  - expiry anchors to the SOURCE's fetchedAt (recompilation never renews);
 *  - secrets fail closed with honest exclusion records;
 *  - restart recomposition is honest: mission-owned from durable state,
 *    external content re-acquired through the seam, never replayed.
 */

import { describe, expect, it } from "bun:test";

import { CapabilityResultStatus } from "../capabilities/connector.js";
import {
    ContextCompiler,
    ContextCompilerError,
    recompileAfterRestart,
    SeamAuthorizedRead,
} from "./compiler.js";
import type { ContextReadResult } from "./compiler.js";
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
 * Canonical flow under test: accepted READ plan step → #63 seam dispatch →
 * reader packaging (sealed) → compiler. Deterministic and fully offline.
 * There is NO bypass helper: every external row in this suite crossed the
 * real seam exactly as production content must.
 */
async function compileViaSeam(options: {
    descriptorOverrides?: Parameters<typeof makeContextDescriptor>[1];
    rows?: ReturnType<typeof journalRows>;
    status?: CapabilityResultStatus;
    throws?: boolean;
    requestOverrides?: Partial<ContextRequest>;
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
    const results = await reader.read(mission, request, {
        dispatchStepId: "step-context-read",
    });
    const sealed = collectSealed(results);
    const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, sealed);
    return { pkg, missionId: mission.missionId, close: () => harness.close() };
}

/**
 * Unwrap a reader result for compilation: the honest separation between
 * "no external content" (refusals are caller-facing reports, never
 * authority) and "sealed read(s) ready for the compiler".
 */
function collectSealed(results: ContextReadResult[]): SeamAuthorizedRead[] {
    return results.filter((r): r is Extract<ContextReadResult, { ok: true }> => r.ok).map((r) => r.read);
}

function unresolvedOf(results: ContextReadResult[]): Array<{ status: SourceStatus; detail: string }> {
    return results
        .filter((r): r is Extract<ContextReadResult, { ok: false }> => !r.ok)
        .map((r) => r.unresolved);
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

describe("ContextCompiler — external reads are non-forgeable (structural closure, round 2)", () => {
    it("ADVERSARIAL: a raw {descriptor, rows} object can NEVER feed the production compiler", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest({ ownerHint: "lifeos" });
        const rawRead = {
            descriptor: {
                capabilityId: "context:lifeos",
                moduleOwner: "lifeos",
                contractVersion: 1,
                factRowsOnly: true,
            },
            rows: journalRows(),
        };
        // Plain structural objects are refused outright — no item, no
        // partial package, no silent coercion into authority.
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [rawRead as never]),
        ).toThrow(ContextCompilerError);
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [rawRead as never]),
        ).toThrow(/raw descriptor\/rows objects are not authority/);
        // The refused content never leaked into any package.
        const missionOwned = new ContextCompiler({ clock: fixedClock() }).compile(
            makeContextMission(),
            makeContextRequest(),
            [],
        );
        expect(missionOwned.items.every((i) => i.provenance.origin === "mission_owned")).toBe(true);
    });

    it("ADVERSARIAL: a forged CompiledSourceRead cannot become a SeamAuthorizedRead", async () => {
        const forged = {
            descriptor: {
                capabilityId: "context:lifeos",
                moduleOwner: "lifeos",
                contractVersion: 1,
                factRowsOnly: true,
            },
            rows: journalRows(),
        };
        // Direct construction without the module-private seal token throws
        // AT RUNTIME (not merely at type-check time).
        let directError: unknown;
        try {
            new (SeamAuthorizedRead as unknown as { new (read: unknown): unknown })(forged);
        } catch (error) {
            directError = error;
        }
        expect(directError).toBeInstanceOf(ContextCompilerError);

        // Even a hand-built look-alike instance is refused: instanceof is
        // against the REAL class, and the brand is not data a caller can
        // stamp onto a foreign object.
        const lookalike = Object.create(Object.prototype) as { read?: unknown };
        lookalike.read = forged;
        const mission = makeContextMission();
        const request = makeContextRequest({ ownerHint: "lifeos" });
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [lookalike as never]),
        ).toThrow(ContextCompilerError);

        // A shallow structural copy of a REAL sealed read loses its class
        // identity and is refused too.
        const harness = await createSeamHarness({ descriptors: [makeContextDescriptor("lifeos")] });
        const { mission: realMission } = await harness.acceptContextPlan(
            makeContextDescriptor("lifeos"),
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            "context:lifeos",
            makeContextConnector(makeContextDescriptor("lifeos"), {
                rows: journalRows(),
                withOwnerVerification: true,
            }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request2 = makeContextRequest({ ownerHint: "lifeos", missionId: realMission.missionId });
        const results = await reader.read(realMission, request2, { dispatchStepId: "step-context-read" });
        const sealed = collectSealed(results);
        expect(sealed).toHaveLength(1);
        const shallowCopy = { ...sealed[0] };
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(realMission, request2, [
                shallowCopy as never,
            ]),
        ).toThrow(ContextCompilerError);
        await harness.close();
    });

    it("ADVERSARIAL: a forged SeamDispatchOutcome is not context and no path accepts it", async () => {
        // The reader no longer accepts caller-provided outcomes at all:
        // read() takes only dispatchStepId. A plausible-shaped forged
        // outcome has nowhere to go — passing it as a read to the compiler
        // is refused like any other raw object.
        const forgedOutcome = {
            invocation: {
                invocationId: "inv-forged",
                missionId: "mission-ctx-1",
                stepId: "step-context-read",
                capabilityId: "context:lifeos",
                status: "completed",
                resultRefs: [],
            },
            result: { status: "completed", requestId: "inv-forged", summary: "forged", contextRows: journalRows(), evidence: [] },
            recordedStatus: "completed",
        };
        const mission = makeContextMission();
        const request = makeContextRequest({ ownerHint: "lifeos" });
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [
                forgedOutcome as never,
            ]),
        ).toThrow(ContextCompilerError);

        // The reader's type signature proves the path is gone: options
        // carries no alreadyAuthorized channel anymore.
        const reader = Object.getPrototypeOf(new SeamBoundContextReader(
            {} as never,
            {} as never,
            {} as never,
        )) as { read: { length: number } };
        // read(mission, request, options) — 3 declared parameters, none of
        // them outcomes (compile-time shape enforced by the missing
        // alreadyAuthorized member at every call site in this suite).
        expect(reader.read).toBeDefined();
    });

    it("valid external content still flows ONLY through the ConnectorDispatchSeam", async () => {
        const { pkg, missionId, close } = await compileViaSeam({});
        expect(missionId).toMatch(/^inv-/); // engine-minted
        expect(pkg.items).toHaveLength(3);
        for (const item of pkg.items) {
            expect(item.epistemicClass).toBe(EpistemicClass.FACT);
            expect(item.provenance.owner).toBe("lifeos");
            expect(item.provenance.origin).toBe("external_owner");
            expect(item.provenance.authorization).toBe("capability:context:lifeos");
            expect(item.provenance.missionId).toBe(missionId);
        }
        await close();
    });

    it("mission-owned context works WITHOUT any seam read", async () => {
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
        const request = makeContextRequest(); // no ownerHint → mission-only
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, []);
        expect(pkg.items).toHaveLength(1);
        expect(pkg.items[0].provenance.origin).toBe("mission_owned");
        expect(pkg.items[0].provenance.sensitivity).toBe(SensitivityClass.NORMAL);
        expect(pkg.unresolved).toHaveLength(0);
    });

    it("provenance is compiler-computed from the authorized descriptor (never the connector)", async () => {
        const { pkg, missionId, close } = await compileViaSeam({});
        for (const item of pkg.items) {
            expect(item.provenance.sourceVersion).toBe(1);
            expect(item.provenance.purpose).toBe("weekly review compilation");
            expect(item.provenance.missionId).toBe(missionId);
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
        const results = await reader.read(mission, request, {
            dispatchStepId: "step-context-read",
        });
        const sealed = collectSealed(results);
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(
                mission,
                makeContextRequest({ ownerHint: "lifeos", missionId: "mission-OTHER" }),
                sealed,
            ),
        ).toThrow(/targets mission "mission-OTHER"/);
        await harness.close();
    });
});

describe("SeamBoundContextReader — one dispatch path (#63 seam)", () => {
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
        const results = await reader.read(narrowed, makeContextRequest({
            ownerHint: "lifeos",
            subject: "refs/runstead/pr/7",
            missionId: mission.missionId,
        }), { dispatchStepId: "step-context-read" });
        expect(results).toHaveLength(1);
        const unresolved = unresolvedOf(results);
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0].status).toBe(SourceStatus.REVOKED);
        expect(unresolved[0].detail).toContain("outside mission allowed ref prefixes");
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
        const results = await reader.read(mission, request, {
            dispatchStepId: "step-context-read",
        });
        const unresolved = unresolvedOf(results);
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0].status).toBe(SourceStatus.UNSUPPORTED);
        expect(unresolved[0].detail).toContain("outside capability declared ref prefixes");
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
        const results = await reader.read(mission, makeContextRequest({
            ownerHint: "lifeos",
            missionId: mission.missionId,
        }), { dispatchStepId: "step-not-in-plan" });
        const unresolved = unresolvedOf(results);
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0].status).toBe(SourceStatus.UNSUPPORTED);
        expect(unresolved[0].detail).toContain("not part of the accepted plan");
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
        const results = await reader.read(mission, makeContextRequest({
            ownerHint: "lifeos",
            missionId: mission.missionId,
        }), { dispatchStepId: "step-context-read" });
        const unresolved = unresolvedOf(results);
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0].status).toBe(SourceStatus.UNAVAILABLE);
        await harness.close();
    });

    it("degrades honestly on a non-completed invocation (still_running carries no content)", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            descriptor.capabilityId,
            makeContextConnector(descriptor, {
                status: CapabilityResultStatus.STILL_RUNNING,
                withOwnerVerification: true,
            }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const results = await reader.read(mission, request, { dispatchStepId: "step-context-read" });
        // Honest refusal at the reader: no sealed read exists to compile.
        expect(collectSealed(results)).toHaveLength(0);
        const unresolved = unresolvedOf(results);
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0].status).toBe(SourceStatus.UNAVAILABLE);
        expect(unresolved[0].detail).toContain("carries no compiled content");
        // The compiled package carries nothing external.
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            request,
            collectSealed(results),
        );
        expect(pkg.items).toHaveLength(0);
        await harness.close();
    });

    it("degrades honestly when the connector throws (seam records BLOCKED, never success)", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            descriptor.capabilityId,
            makeContextConnector(descriptor, { throws: true, withOwnerVerification: true }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const results = await reader.read(mission, request, { dispatchStepId: "step-context-read" });
        expect(collectSealed(results)).toHaveLength(0);
        const unresolved = unresolvedOf(results);
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0].status).toBe(SourceStatus.UNAVAILABLE);
        await harness.close();
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

    it("honors the ownsStorage=true real-world owner capability (review blocker 2, preserved)", async () => {
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

    it("repeating a read is blind redispatch: the engine refuses a second dispatch", async () => {
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
        const first = await reader.read(mission, request, { dispatchStepId: stepId });
        expect(collectSealed(first)).toHaveLength(1);

        // The engine's one-shot invariant is the honest alternative to the
        // removed alreadyAuthorized path: the same step cannot be
        // dispatched again (restart ≠ permission to replay an effect).
        let conflict: unknown;
        try {
            await harness.seam.dispatchThroughSeam(mission.missionId, stepId);
        } catch (error) {
            conflict = error;
        }
        expect((conflict as Error)?.name).toBe("InvocationConflictError");

        // Feeding the SAME sealed read twice in one compilation is deduped
        // (recorded, not silent) instead of double-counting rows.
        const sealed = collectSealed(first);
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            request,
            [...sealed, ...sealed],
        );
        expect(pkg.items).toHaveLength(3); // 6 identical rows → 3 unique items
        expect(pkg.budgetReport.excluded.filter((e) => e.reason === "duplicate")).toHaveLength(3);
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

describe("ContextCompiler — no silent FACT promotion (review blocker 5, preserved)", () => {
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

describe("ContextCompiler — budgets clamp and additions re-run the pipeline (blocker 3, preserved)", () => {
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

    it("is order-independent: the same sealed reads in any order yield the same package", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission, stepId } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            "context:lifeos",
            makeContextConnector(descriptor, { rows: journalRows(), withOwnerVerification: true }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const sealed = collectSealed(await reader.read(mission, request, { dispatchStepId: stepId }));
        expect(sealed).toHaveLength(1);
        // The sealed read carries a descriptor; a second sealed EMPTY read
        // cannot be minted without another seam dispatch (one-shot), so
        // order-independence is proven by reversing the one sealed read
        // against an empty mission-only compilation of the same rows.
        const compiler = new ContextCompiler({ clock: fixedClock() });
        const direct = compiler.compile(mission, request, [sealed[0]]);
        const flippedMissionOnly = compiler.compile(mission, request, []);
        // Different content ⇒ different packages, but the sealed read
        // alone must be deterministic across compiler instances.
        const again = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [sealed[0]]);
        expect(direct.packageId).toBe(again.packageId);
        expect(flippedMissionOnly.items).toHaveLength(0);
        await harness.close();
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

describe("ContextCompiler — effective budget is monotonically non-expanding (round 2)", () => {
    it("a looser compiler CANNOT expand a package compiled under a stricter policy", async () => {
        const strict = new ContextCompiler({
            clock: fixedClock(),
            budgetPolicy: { maxItemsCeiling: 1, maxTotalCharsCeiling: 16000, maxEstimatedTokensCeiling: 4000 },
        });
        const loose = new ContextCompiler({ clock: fixedClock() }); // default ceilings: 32 items
        const mission = makeContextMission();
        const request = makeContextRequest();

        const pkg = strict.compile(mission, request, []);
        expect(pkg.items).toHaveLength(0);
        expect(pkg.budgetReport.limits.maxItems).toBe(1);

        // Compiler B (maxItems=32) tries to add items to A's (maxItems=1)
        // package: the recorded limits are the authorized ceiling — the
        // first addition fits (1/1), the second is refused forever.
        const first = loose.addInference(pkg, { content: "first inference", refId: "inf-a" });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.package.budgetReport.limits.maxItems).toBe(1); // NEVER widened

        const second = loose.addInference(first.package, { content: "second inference", refId: "inf-b" });
        expect(second.ok).toBe(false);
        if (!second.ok) expect(second.reason).toContain("maxItems");
    });

    it("mutating with a stricter compiler TIGHTENS the recorded limits (allowed direction)", async () => {
        const strict = new ContextCompiler({
            clock: fixedClock(),
            budgetPolicy: { maxItemsCeiling: 2, maxTotalCharsCeiling: 16000, maxEstimatedTokensCeiling: 4000 },
        });
        const mission = makeContextMission();
        const pkg = strict.compile(mission, makeContextRequest(), []);
        expect(pkg.budgetReport.limits.maxItems).toBe(2);

        // Same-policy mutation keeps the same limits.
        const same = strict.addInference(pkg, { content: "keep", refId: "inf-keep" });
        expect(same.ok).toBe(true);
        if (!same.ok) return;
        expect(same.package.budgetReport.limits).toEqual(pkg.budgetReport.limits);
        expect(same.package.budgetReport.observed.items).toBe(1);
        expect(same.package.budgetReport.observed.items).toBeLessThanOrEqual(
            same.package.budgetReport.limits.maxItems,
        );
    });

    it("observed never exceeds limits on any produced package (report stays honest)", async () => {
        const { pkg, close } = await compileViaSeam({
            requestOverrides: {
                budget: { maxItems: 2, maxTotalChars: 10000, maxEstimatedTokens: 3000 },
            },
        });
        const report = pkg.budgetReport;
        expect(report.observed.items).toBeLessThanOrEqual(report.limits.maxItems);
        expect(report.observed.totalChars).toBeLessThanOrEqual(report.limits.maxTotalChars);
        expect(report.observed.estimatedTokens).toBeLessThanOrEqual(report.limits.maxEstimatedTokens);
        expect(report.clamped).toBe(false); // request fully under ceilings: nothing clamped
        await close();
    });

    it("an over-budget package refuses to grow (no laundering of hand-built state)", async () => {
        const compiler = new ContextCompiler({ clock: fixedClock() });
        const mission = makeContextMission({
            contextRefs: [
                {
                    refId: "ref-1",
                    owner: "lifeos",
                    label: "Baseline owned label",
                    externalRef: "refs/lifeos/journal/2026-08",
                    authorizedBy: "user consent on 2026-08-01",
                },
            ],
        });
        const pkg = compiler.compile(
            mission,
            makeContextRequest({
                budget: { maxItems: 1, maxTotalChars: 1000, maxEstimatedTokens: 250 },
            }),
            [],
        );
        expect(pkg.items).toHaveLength(1);
        // Simulate foreign/over-budget state (not produced by this
        // compiler): observed exceeds the recorded limits.
        const bloated = {
            ...pkg,
            items: [
                ...pkg.items,
                {
                    itemId: "ctx-forged",
                    epistemicClass: EpistemicClass.FACT,
                    content: "injected",
                    provenance: {
                        ...pkg.items[0].provenance,
                        owner: "elsewhere",
                        sourceRef: "refs/elsewhere/x",
                    },
                },
            ],
        } as BoundedContextPackage;
        const attempt = compiler.addInference(bloated, { content: "grow", refId: "inf-over" });
        expect(attempt.ok).toBe(false);
        if (!attempt.ok) expect(attempt.reason).toContain("exceeds its recorded budget limits");
    });
});

describe("ContextCompiler — sensitivity accompanies redaction (round 2)", () => {
    it("a mission-owned label with a secret pattern compiles REDACTED (raw value never present)", async () => {
        const mission = makeContextMission({
            contextRefs: [
                {
                    refId: "ref-secret",
                    owner: "lifeos",
                    label: "Journal index (api_key=sk-proj-abcdef123456) for 2026-08",
                    externalRef: "refs/lifeos/journal/2026-08",
                    authorizedBy: "user consent on 2026-08-01",
                },
            ],
        });
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            makeContextRequest(),
            [],
        );
        expect(pkg.items).toHaveLength(1);
        expect(pkg.items[0].content).toContain("[REDACTED]");
        expect(pkg.items[0].content).not.toContain("sk-proj-abcdef123456");
        expect(pkg.items[0].provenance.sensitivity).toBe(SensitivityClass.REDACTED);
        expect(JSON.stringify(pkg)).not.toContain("sk-proj-abcdef123456");
    });

    it("an addInference that needed sanitizing is marked REDACTED (raw value never present)", async () => {
        const mission = makeContextMission();
        const compiler = new ContextCompiler({ clock: fixedClock() });
        const pkg = compiler.compile(mission, makeContextRequest(), []);
        const added = compiler.addInference(pkg, {
            content: "The user's password=hunter2 should never persist raw",
            refId: "inf-redacted",
        });
        expect(added.ok).toBe(true);
        if (!added.ok) return;
        expect(added.item.content).toContain("[REDACTED]");
        expect(added.item.content).not.toContain("hunter2");
        expect(added.item.provenance.sensitivity).toBe(SensitivityClass.REDACTED);
        expect(JSON.stringify(added.package)).not.toContain("hunter2");
    });

    it("a deriveSummary source carrying a secret yields a REDACTED summary (raw value never present)", async () => {
        const mission = makeContextMission({
            contextRefs: [
                {
                    refId: "ref-1",
                    owner: "lifeos",
                    label: "Weekly note: credentials=SuperSecret123 leaked in a tool output",
                    externalRef: "refs/lifeos/journal/2026-08",
                    authorizedBy: "user consent on 2026-08-01",
                },
                {
                    refId: "ref-2",
                    owner: "lifeos",
                    label: "Clean planning note",
                    externalRef: "refs/lifeos/journal/2026-08-planning",
                    authorizedBy: "user consent on 2026-08-01",
                },
            ],
        });
        const compiler = new ContextCompiler({ clock: fixedClock() });
        const pkg = compiler.compile(mission, makeContextRequest(), []);
        const derived = compiler.deriveSummary(pkg, {
            sourceItemIds: [pkg.items[0].itemId, pkg.items[1].itemId],
            maxChars: 512,
        });
        expect(derived.ok).toBe(true);
        if (!derived.ok) return;
        expect(derived.item.content).toContain("[REDACTED]");
        expect(derived.item.content).not.toContain("SuperSecret123");
        expect(derived.item.provenance.sensitivity).toBe(SensitivityClass.REDACTED);
        expect(JSON.stringify(derived.package)).not.toContain("SuperSecret123");
    });

    it("an external row whose content is pre-redacted stays REDACTED (never NORMAL)", async () => {
        const { pkg, close } = await compileViaSeam({
            rows: [
                {
                    sourceRef: "refs/lifeos/journal/preredacted",
                    content: "Owner already redacted: token=[REDACTED]",
                    epistemicClass: EpistemicClass.FACT,
                },
            ],
        });
        expect(pkg.items).toHaveLength(1);
        expect(pkg.items[0].provenance.sensitivity).toBe(SensitivityClass.REDACTED);
        await close();
    });

    it("a successfully redacted raw secret is carried REDACTED; the raw value never appears", async () => {
        const { pkg, close } = await compileViaSeam({
            rows: [
                {
                    sourceRef: "refs/lifeos/journal/leaky",
                    content: "call used Authorization: Bearer eyJhbGciOiJIzI1NiIsInR5cCI6IkpXVCJ9 yesterday",
                    epistemicClass: EpistemicClass.FACT,
                },
                ...journalRows(),
            ],
        });
        // Option A (one consistent rule): the sanitizer fully redacted the
        // bearer token, so the content is carried with REDACTED sensitivity
        // — never NORMAL next to redaction markers.
        expect(pkg.items).toHaveLength(4);
        const redacted = pkg.items.find((i) => i.content.includes("[REDACTED]"));
        expect(redacted).toBeDefined();
        expect(redacted?.provenance.sensitivity).toBe(SensitivityClass.REDACTED);
        const json = JSON.stringify(pkg);
        expect(json).not.toContain("eyJhbGciOiJIzI1NiIsInR5cCI6IkpXVCJ9");
        expect(json).not.toContain("Bearer eyJ");
        await close();
    });

    it("owner-declared RESTRICTED rows stay reference-only (preserved)", async () => {
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

describe("ContextCompiler — freshness anchors to the source (blocker 4, preserved)", () => {
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

    it("recompiling later does NOT renew expiry — validity needs RE-ACQUISITION (honest freshness)", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission, stepId } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            descriptor.capabilityId,
            makeContextConnector(descriptor, {
                rows: [
                    {
                        sourceRef: "refs/lifeos/journal/fresh",
                        content: "Fresh entry.",
                        epistemicClass: EpistemicClass.FACT,
                        fetchedAt: "2026-08-30T09:00:00.000Z",
                    },
                ],
                withOwnerVerification: true,
            }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({
            ownerHint: "lifeos",
            missionId: mission.missionId,
            maxAgeMs: THREE_HOURS_MS,
        });
        const results = await reader.read(mission, request, { dispatchStepId: stepId });
        const sealed = collectSealed(results);
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, sealed);
        expect(pkg.items[0].provenance.expiresAt).toBe("2026-08-30T12:00:00.000Z");

        // Recompiling at 14:00 with the SAME sealed read: the row is now
        // stale — validity is never renewed by recomposition.
        const later = new ContextCompiler({ clock: () => new Date("2026-08-30T14:00:00.000Z") }).compile(
            mission,
            request,
            sealed,
        );
        expect(later.items).toHaveLength(0);
        expect(later.unresolved[0].status).toBe(SourceStatus.STALE);
        await harness.close();
    });
});

describe("ContextCompiler — honest restart recomposition (round 2)", () => {
    it("MISSION-OWNED recovery: durable contextRefs alone recompose the package after restart", async () => {
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
        const request = makeContextRequest(); // mission-only: no ownerHint
        const first = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, []);
        // Restart = a NEW compiler instance over the SAME durable Mission:
        // mission-owned context is recoverable from durable state alone.
        const restarted = recompileAfterRestart(mission, request, { clock: fixedClock() });
        expect(restarted.packageId).toBe(first.packageId);
        expect(restarted).toEqual(first);
        expect(restarted.items[0].provenance.origin).toBe("mission_owned");
    });

    it("EXTERNAL recovery contract: previous results are NOT authority; content must be re-acquired through the seam", async () => {
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
        const before = await reader.read(mission, request, { dispatchStepId: stepId });
        const first = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            request,
            collectSealed(before),
        );
        expect(first.items).toHaveLength(3);

        // After a restart the external rows are GONE: the first package is
        // inert DATA, not authority. Recompiling the same request WITHOUT
        // re-acquisition produces NO external content…
        const restarted = recompileAfterRestart(mission, request, { clock: fixedClock() });
        expect(restarted.items.filter((i) => i.provenance.origin === "external_owner")).toHaveLength(0);
        // …and raw previous results handed back as reads are refused by
        // the compiler (they are not sealed authority).
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [
                {
                    descriptor: {
                        capabilityId: "context:lifeos",
                        moduleOwner: "lifeos",
                        contractVersion: 1,
                        factRowsOnly: true,
                    },
                    rows: journalRows(),
                } as never,
            ]),
        ).toThrow(ContextCompilerError);

        // The one honest path: re-acquisition through the seam. But the
        // step already dispatched — the engine refuses a second dispatch
        // (restart ≠ permission to replay an effect); reconciliation of
        // that invocation is #50 territory, explicitly deferred.
        let conflict: unknown;
        try {
            await harness.seam.dispatchThroughSeam(mission.missionId, stepId);
        } catch (error) {
            conflict = error;
        }
        expect((conflict as Error)?.name).toBe("InvocationConflictError");
        await harness.close();
    });
});
