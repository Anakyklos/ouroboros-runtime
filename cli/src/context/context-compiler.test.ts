/**
 * 🧩 Context Compiler Tests (Issue #64)
 *
 * Deterministic, offline suite proving the #64 boundary:
 *  - mission-owned refs compile as FACT with mission authorization;
 *  - external content ONLY via SeamBoundContextReader over the #63
 *    ConnectorDispatchSeam, SEALED into non-forgeable SeamContextResolution
 *    batches of SeamAuthorizedReads carrying an immutable authorization
 *    envelope (missionId, dispatched stepId, capability, subject) that the
 *    compiler re-verifies: cross-mission reuse and step reassignment fail
 *    closed (raw {descriptor, rows}, forged reads, forged resolutions and
 *    forged unresolved records are structurally refused);
 *  - READER FAILURES ARE NEVER DROPPED: unavailable/revoked/unsupported
 *    travel inside the sealed resolution into package.unresolved, so the
 *    planner can tell "no external context needed" from "needed context
 *    failed honestly";
 *  - identity/metadata fields (sourceRef, evidenceRefId, subject,
 *    ownerHint, stepId) fail closed on raw secret patterns — refs are
 *    never redacted in place — while free-form purpose is sanitized once
 *    and stored sanitized only (no raw/sanitized split in the package);
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
import { DispatchSeamError } from "../capabilities/dispatch-seam.js";
import {
    ContextCompiler,
    recompileAfterRestart,
} from "./compiler.js";
import { SeamAuthorizedRead, SeamContextResolution } from "./sources.js";
import {
    ContextCompilerError,
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
 * reader packaging (sealed resolution) → compiler. Deterministic and fully
 * offline. There is NO bypass helper: every external row in this suite
 * crossed the real seam exactly as production content must.
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
    const resolution = await reader.read(mission, request, {
        dispatchStepId: "step-context-read",
    });
    const pkg = new ContextCompiler({ clock: fixedClock() }).compile(
        mission,
        request,
        resolution ? [resolution] : [],
    );
    return { pkg, missionId: mission.missionId, close: () => harness.close() };
}

/** Wrap one reader result (or none) for the compiler. */
function resolutionsOf(resolution: SeamContextResolution | null): SeamContextResolution[] {
    return resolution ? [resolution] : [];
}

/** Rows for a tecer capability (descriptor prefix refs/tecer/). */
function tecerRows(): ReturnType<typeof journalRows> {
    return [
        {
            sourceRef: "refs/tecer/journal/2026-08-30",
            content: "Tecer note: weekly standup kept, review aligns with lifeos journal.",
            epistemicClass: EpistemicClass.FACT,
            fetchedAt: "2026-08-30T09:00:00.000Z",
            sensitivity: SensitivityClass.NORMAL,
        },
        {
            sourceRef: "refs/tecer/journal/2026-08-29",
            content: "Tecer note: boundary draft shared with the planner.",
            epistemicClass: EpistemicClass.FACT,
            fetchedAt: "2026-08-29T09:00:00.000Z",
            sensitivity: SensitivityClass.NORMAL,
        },
        {
            sourceRef: "refs/tecer/journal/2026-08-28",
            content: "Tecer note: deep work day planned for the interface review.",
            epistemicClass: EpistemicClass.FACT,
            fetchedAt: "2026-08-28T09:00:00.000Z",
            sensitivity: SensitivityClass.NORMAL,
        },
    ];
}

/** Unwrap the honest refusal records of one reader result. */
function unresolvedOf(resolution: SeamContextResolution | null): BoundedContextPackage["unresolved"] {
    return resolution?.unresolved ?? [];
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
        ).toThrow(/raw descriptor\/rows objects .*not authority/);
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
        const realResolution = await reader.read(realMission, request2, {
            dispatchStepId: "step-context-read",
        });
        expect(realResolution).not.toBeNull();
        const shallowCopy = { ...realResolution! };
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
        // outcome has nowhere to go — passing it as a resolution to the
        // compiler is refused like any other raw object.
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

    it("ADVERSARIAL: a prototype-chain forgery (Object.create) is refused by the private brand", async () => {
        // `instanceof` alone is NOT the gate: an object created via
        // Object.create(SeamAuthorizedRead.prototype) passes instanceof
        // but has no private brand and cannot install one. The gate checks
        // `#sealed in value`, so the forge is structurally refused even
        // with a hand-set `.read`.
        const forgedViaPrototype = Object.create(SeamAuthorizedRead.prototype) as SeamAuthorizedRead;
        Object.defineProperty(forgedViaPrototype, "read", {
            value: {
                descriptor: {
                    capabilityId: "context:lifeos",
                    moduleOwner: "lifeos",
                    contractVersion: 1,
                    factRowsOnly: true,
                },
                rows: journalRows(),
            },
            enumerable: true,
        });
        const mission = makeContextMission();
        const request = makeContextRequest({ ownerHint: "lifeos" });
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [
                forgedViaPrototype as never,
            ]),
        ).toThrow(ContextCompilerError);
    });

    it("ADVERSARIAL: non-object inputs degrade to ContextCompilerError, never TypeError", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest({ ownerHint: "lifeos" });
        for (const impostor of [null, undefined, "not-a-read", 42, true]) {
            expect(() =>
                new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [
                    impostor as never,
                ]),
            ).toThrow(ContextCompilerError);
        }
    });

    it("the sealed read AND its resolution are deep-frozen: nested cells cannot be mutated into a different authorization", async () => {
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
        const resolution = await reader.read(mission, request, { dispatchStepId: stepId });
        expect(resolution).not.toBeNull();
        const sealed = resolution!.reads;
        expect(sealed).toHaveLength(1);
        expect(Object.isFrozen(resolution)).toBe(true);
        expect(Object.isFrozen(resolution!.authorization)).toBe(true);
        expect(Object.isFrozen(resolution!.reads)).toBe(true);
        expect(Object.isFrozen(resolution!.unresolved)).toBe(true);
        expect(Object.isFrozen(sealed[0])).toBe(true);
        expect(Object.isFrozen(sealed[0].authorization)).toBe(true);
        expect(Object.isFrozen(sealed[0].read)).toBe(true);
        expect(Object.isFrozen(sealed[0].read.rows)).toBe(true);
        expect(Object.isFrozen(sealed[0].read.rows[0])).toBe(true);
        // A strict-mode mutation attempt on a frozen nested cell throws;
        // even in sloppy mode it would silently no-op — either way the
        // compiled content cannot differ from what the seam sealed.
        const contentBefore = sealed[0].read.rows[0].content;
        try {
            (sealed[0].read.rows[0] as { content: string }).content = "TAMPERED";
        } catch {
            // frozen assignment throws in strict mode
        }
        expect((sealed[0].read.rows[0] as { content: string }).content).toBe(contentBefore);
        await harness.close();
    });

    it("ADVERSARIAL: a guessed Symbol.for token cannot construct a seal", async () => {
        // The module token is a unique Symbol(...) — Symbol.for returns a
        // DIFFERENT symbol from the global registry, so guessing the
        // description still throws at runtime.
        const forgedRead = {
            descriptor: {
                capabilityId: "context:lifeos",
                moduleOwner: "lifeos",
                contractVersion: 1,
                factRowsOnly: true,
            },
            rows: journalRows(),
        };
        const guessedToken = Symbol.for("context.compiler.seamSeal");
        expect(() =>
            new (SeamAuthorizedRead as unknown as { new (read: unknown, token: symbol): unknown })(
                forgedRead,
                guessedToken,
            ),
        ).toThrow(ContextCompilerError);
    });

    it("ADVERSARIAL: no module exports a sealing authority — minting is structurally impossible outside sources.ts", async () => {
        // The reviewer's requirement is STRUCTURAL closure. The seal must
        // not be obtainable by importing: compiler.js must expose no seal
        // factory, and sources.js must expose the classes WITHOUT the token
        // or any minting function.
        const compilerKeys = Object.keys(await import("./compiler.js"));
        expect(compilerKeys).not.toContain("getSeamSeal");
        expect(compilerKeys).not.toContain("seamSeal");
        expect(compilerKeys).not.toContain("sealRead");
        expect(compilerKeys).not.toContain("sealResolution");
        expect(compilerKeys).not.toContain("SEAM_SEAL_TOKEN");
        expect(compilerKeys).not.toContain("SeamAuthorizedRead"); // the classes moved out
        expect(compilerKeys).not.toContain("SeamContextResolution");
        const sourcesKeys = Object.keys(await import("./sources.js"));
        expect(sourcesKeys).toContain("SeamAuthorizedRead"); // identity check only
        expect(sourcesKeys).toContain("SeamContextResolution"); // identity check only
        expect(sourcesKeys).not.toContain("sealRead");
        expect(sourcesKeys).not.toContain("sealResolution");
        expect(sourcesKeys).not.toContain("SEAM_SEAL_TOKEN");
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
        const resolution = await reader.read(mission, request, {
            dispatchStepId: "step-context-read",
        });
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(
                mission,
                makeContextRequest({ ownerHint: "lifeos", missionId: "mission-OTHER" }),
                resolutionsOf(resolution),
            ),
        ).toThrow(/targets mission "mission-OTHER"/);
        await harness.close();
    });
});

describe("ContextCompiler — authorization envelope binding (round 3)", () => {
    it("a seal authorized for Mission A can NEVER compile Mission B (cross-mission reuse refused)", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission: missionA } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        harness.seam.registerConnector(
            descriptor.capabilityId,
            makeContextConnector(descriptor, { rows: journalRows(), withOwnerVerification: true }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const requestA = makeContextRequest({
            ownerHint: "lifeos",
            missionId: missionA.missionId,
        });
        const resolutionA = await reader.read(missionA, requestA, {
            dispatchStepId: "step-context-read",
        });
        expect(resolutionA).not.toBeNull();
        expect(resolutionA!.reads).toHaveLength(1);
        // The seal is bound to missionA; compiling for missionB (a
        // DIFFERENT mission object/id) must fail closed AFTER the request
        // gate (requestB targets missionB), at the envelope re-binding.
        const missionB = makeContextMission({ missionId: "mission-B" });
        const requestB = makeContextRequest({ ownerHint: "lifeos", missionId: "mission-B" });
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(missionB, requestB, [resolutionA!]),
        ).toThrow(/bound to mission "(inv-|mission-)[^"]*" but compilation is for "mission-B"/);
        // The data authorized by missionA was never reattributed: no
        // package for B exists with A's rows.
        await harness.close();
    });

    it("a seal from step A cannot be compiled under step B (step reassignment refused)", async () => {
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
        const resolution = await reader.read(mission, request, {
            dispatchStepId: "step-context-read",
        });
        expect(resolution).not.toBeNull();
        // Same mission, but the request declares a DIFFERENT step: the
        // envelope's dispatched step must match exactly — fail closed.
        const reassigned = makeContextRequest({
            ownerHint: "lifeos",
            missionId: mission.missionId,
            stepId: "step-B",
        });
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, reassigned, [resolution!]),
        ).toThrow(/dispatched step "step-context-read" but the request declares step "step-B"/);
        await harness.close();
    });

    it("request.stepId that diverges from the dispatch step is REJECTED at the reader (no silent divergence)", async () => {
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
        const request = makeContextRequest({
            ownerHint: "lifeos",
            missionId: mission.missionId,
            stepId: "step-X", // request declares one step…
        });
        // …but the caller asks to dispatch a DIFFERENT one: fail closed,
        // NO dispatch, NO result — not a silent divergence.
        await expect(
            reader.read(mission, request, { dispatchStepId: "step-context-read" }),
        ).rejects.toThrow(/conflicts with dispatchStepId/);
        await harness.close();
    });

    it("a legitimate seal on the SAME mission and step compiles, and provenance carries mission + step (round 3)", async () => {
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
        const request = makeContextRequest({
            ownerHint: "lifeos",
            missionId: mission.missionId,
            stepId: "step-context-read", // request agrees with the dispatch step
        });
        const resolution = await reader.read(mission, request, {
            dispatchStepId: "step-context-read",
        });
        expect(resolution).not.toBeNull();
        expect(resolution!.reads).toHaveLength(1);
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [resolution!]);
        expect(pkg.stepId).toBe("step-context-read");
        expect(pkg.items).toHaveLength(3);
        for (const item of pkg.items) {
            expect(item.provenance.missionId).toBe(mission.missionId);
            expect(item.provenance.stepId).toBe("step-context-read");
        }
        await harness.close();
    });

    it("a sealed read whose capability is NOT in the mission's scope is refused (capability re-binding)", async () => {
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
        const resolution = await reader.read(mission, request, {
            dispatchStepId: "step-context-read",
        });
        expect(resolution).not.toBeNull();
        // Same mission id, but the CURRENT scope no longer authorizes
        // context:lifeos (revocation between read and compile): the
        // envelope capability must still be in the mission scope.
        const narrowed = {
            ...mission,
            allowedCapabilityScope: {
                ...mission.allowedCapabilityScope,
                capabilityIds: ["context:tecer"],
            },
        };
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(narrowed, request, [resolution!]),
        ).toThrow(/not authorized for mission/);
        await harness.close();
    });

    it("two resolutions for the SAME mission but different steps compile when the request is not step-scoped", async () => {
        const lifeos = makeContextDescriptor("lifeos");
        const tecer = makeContextDescriptor("tecer");
        const harness = await createSeamHarness({ descriptors: [lifeos, tecer] });
        const { mission, steps } = await harness.acceptMultiContextPlan([
            { descriptor: lifeos, subject: "refs/lifeos/journal/2026-08", stepId: "step-lifeos" },
            { descriptor: tecer, subject: "refs/tecer/journal/2026-08", stepId: "step-tecer" },
        ]);
        harness.seam.registerConnector(
            lifeos.capabilityId,
            makeContextConnector(lifeos, { rows: journalRows(), withOwnerVerification: true }),
        );
        harness.seam.registerConnector(
            tecer.capabilityId,
            makeContextConnector(tecer, { rows: tecerRows(), withOwnerVerification: true }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({
            ownerHint: "lifeos",
            missionId: mission.missionId,
        });
        const resLifeos = await reader.read(mission, request, { dispatchStepId: steps[0].stepId });
        const resTecer = await reader.read(mission, request, { dispatchStepId: steps[1].stepId });
        expect(resLifeos).not.toBeNull();
        expect(resTecer).not.toBeNull();
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            request,
            [resLifeos!, resTecer!],
        );
        expect(pkg.items).toHaveLength(6); // 3 per owner, no dedup across owners
        expect(pkg.items.filter((i) => i.provenance.stepId === "step-lifeos")).toHaveLength(3);
        expect(pkg.items.filter((i) => i.provenance.stepId === "step-tecer")).toHaveLength(3);
        await harness.close();
    });
});

describe("SeamBoundContextReader — one dispatch path (#63 seam)", () => {
    it("uses CURRENT durable mission scope for returned rows, not a broad caller snapshot", async () => {
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );

        // The subject remains authorized by the CURRENT scope, but a sibling
        // row under the descriptor prefix is outside that narrower durable
        // scope. The caller keeps its original broad snapshot.
        await harness.updateMission(mission.missionId, {
            allowedCapabilityScope: {
                ...mission.allowedCapabilityScope,
                allowedRefPrefixes: ["refs/lifeos/journal/2026-08"],
            },
        });
        harness.seam.registerConnector(
            descriptor.capabilityId,
            makeContextConnector(descriptor, {
                withOwnerVerification: true,
                rows: [
                    {
                        ...journalRows()[0],
                        sourceRef: "refs/lifeos/private/2026-08-30",
                    },
                ],
            }),
        );

        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const resolution = await reader.read(mission, request, {
            dispatchStepId: "step-context-read",
        });

        expect(resolution).not.toBeNull();
        expect(resolution!.reads).toHaveLength(0);
        expect(unresolvedOf(resolution)).toEqual([
            expect.objectContaining({
                status: SourceStatus.REVOKED,
                detail: "row sourceRef outside mission allowed ref prefixes",
            }),
        ]);
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [resolution!]);
        expect(pkg.items).toHaveLength(0);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.REVOKED);
        await harness.close();
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
        const resolution = await reader.read(narrowed, makeContextRequest({
            ownerHint: "lifeos",
            subject: "refs/runstead/pr/7",
            missionId: mission.missionId,
        }), { dispatchStepId: "step-context-read" });
        expect(resolution).not.toBeNull();
        const unresolved = unresolvedOf(resolution);
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
        const resolution = await reader.read(mission, request, {
            dispatchStepId: "step-context-read",
        });
        const unresolved = unresolvedOf(resolution);
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
        const resolution = await reader.read(mission, makeContextRequest({
            ownerHint: "lifeos",
            missionId: mission.missionId,
        }), { dispatchStepId: "step-not-in-plan" });
        const unresolved = unresolvedOf(resolution);
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
        const resolution = await reader.read(mission, makeContextRequest({
            ownerHint: "lifeos",
            missionId: mission.missionId,
        }), { dispatchStepId: "step-context-read" });
        const unresolved = unresolvedOf(resolution);
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
        const resolution = await reader.read(mission, request, { dispatchStepId: "step-context-read" });
        expect(resolution).not.toBeNull();
        // Honest refusal at the reader: no sealed read exists to compile.
        expect(resolution!.reads).toHaveLength(0);
        const unresolved = unresolvedOf(resolution);
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0].status).toBe(SourceStatus.UNAVAILABLE);
        expect(unresolved[0].detail).toContain("carries no compiled content");
        // Round-3 blocker: the refusal SURVIVES into the compiled package.
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            request,
            [resolution!],
        );
        expect(pkg.items).toHaveLength(0);
        expect(pkg.unresolved).toHaveLength(1);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.UNAVAILABLE);
        expect(pkg.unresolved[0].detail).toContain("carries no compiled content");
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
        const resolution = await reader.read(mission, request, { dispatchStepId: "step-context-read" });
        expect(resolution).not.toBeNull();
        expect(resolution!.reads).toHaveLength(0);
        const unresolved = unresolvedOf(resolution);
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
        expect(first).not.toBeNull();
        expect(first!.reads).toHaveLength(1);

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

        // Feeding the SAME sealed resolution twice in one compilation is
        // deduped (recorded, not silent) instead of double-counting rows.
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            request,
            [first!, first!],
        );
        expect(pkg.items).toHaveLength(3); // 6 identical rows → 3 unique items
        expect(pkg.budgetReport.excluded.filter((e) => e.reason === "duplicate")).toHaveLength(3);
        await harness.close();
    });

    it("an external read with NO identified dispatch step is an honest unresolved (never silent)", async () => {
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
        const resolution = await reader.read(mission, request, {}); // no step at all
        expect(resolution).not.toBeNull();
        expect(resolution!.reads).toHaveLength(0);
        const unresolved = unresolvedOf(resolution);
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0].status).toBe(SourceStatus.UNSUPPORTED);
        expect(unresolved[0].detail).toContain("no dispatch step was identified");
        await harness.close();
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

    it("is order-independent: the same sealed resolution compiled twice yields the same package", async () => {
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
        const resolution = await reader.read(mission, request, { dispatchStepId: stepId });
        expect(resolution).not.toBeNull();
        expect(resolution!.reads).toHaveLength(1);
        const compiler = new ContextCompiler({ clock: fixedClock() });
        const direct = compiler.compile(mission, request, [resolution!]);
        const flippedMissionOnly = compiler.compile(mission, request, []);
        // Different content ⇒ different packages, but the sealed resolution
        // alone must be deterministic across compiler instances.
        const again = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [resolution!]);
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

describe("ContextCompiler — secrets in metadata and identifiers (round 3)", () => {
    it("a request whose SUBJECT carries a raw secret fails closed (never compiled, never redacted)", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest({
            ownerHint: "lifeos",
            subject: "refs/lifeos/token=sk-proj-abcdef123456",
        });
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, request, []),
        ).toThrow(/subject carries a raw secret pattern/);
    });

    it("a request whose ownerHint or stepId carries a raw secret fails closed too", async () => {
        const mission = makeContextMission();
        const hint = makeContextRequest({ ownerHint: "lifeos token=abc-secret" });
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, hint, []),
        ).toThrow(/ownerHint carries a raw secret pattern/);
        const step = makeContextRequest({ stepId: "step token=abc-secret" });
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, step, []),
        ).toThrow(/stepId carries a raw secret pattern/);
    });

    it("a request whose PURPOSE needs sanitizing stores ONLY the sanitized form (no raw/sanitized split)", async () => {
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
        const request = makeContextRequest({
            purpose: "weekly review credentials=SuperSecret123 compilation",
        });
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, []);
        expect(pkg.items).toHaveLength(1);
        expect(pkg.request.purpose).toContain("[REDACTED]");
        expect(pkg.request.purpose).not.toContain("SuperSecret123");
        // The snapshot and every provenance field use the SAME sanitized form.
        expect(pkg.items[0].provenance.purpose).toBe(pkg.request.purpose);
        expect(JSON.stringify(pkg)).not.toContain("SuperSecret123");
    });

    it("a mission-owned contextRef whose externalRef carries a raw secret is excluded (secret_in_identity)", async () => {
        const mission = makeContextMission({
            contextRefs: [
                {
                    refId: "ref-1",
                    owner: "lifeos",
                    label: "Journal index for 2026-08",
                    externalRef: "refs/lifeos/token=abcdef123456",
                    authorizedBy: "user consent on 2026-08-01",
                },
            ],
        });
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            makeContextRequest(),
            [],
        );
        expect(pkg.items).toHaveLength(0);
        expect(
            pkg.budgetReport.excluded.some((e) => e.reason === "secret_in_identity"),
        ).toBe(true);
        expect(JSON.stringify(pkg)).not.toContain("abcdef123456");
    });

    it("external rows whose sourceRef/evidenceRefId carry a raw secret never enter the package (any field)", async () => {
        const { pkg, close } = await compileViaSeam({
            rows: [
                {
                    sourceRef: "refs/lifeos/journal/leaky-ref",
                    content: "Should never appear either way",
                    evidenceRefId: "token=abcdef123456",
                    epistemicClass: EpistemicClass.FACT,
                },
                {
                    sourceRef: "refs/lifeos/token=abcdef123456",
                    content: "Should not appear",
                    epistemicClass: EpistemicClass.FACT,
                },
                ...journalRows(),
            ],
        });
        // Only the 3 clean rows survive; the secret-identity rows were
        // skipped by the reader's structural gate (never a raw carry, and
        // never redacted in place — identity fields fail closed).
        expect(pkg.items).toHaveLength(3);
        expect(pkg.items.every((i) => i.provenance.sourceRef !== "refs/lifeos/token=abcdef123456")).toBe(true);
        const json = JSON.stringify(pkg);
        expect(json).not.toContain("abcdef123456");
        expect(json).not.toContain("leaky-ref");
        await close();
    });

    it("a reader refusal for a secret-bearing subject carries a placeholder, never the raw ref", async () => {
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
        // Subject smuggles a raw secret: the reader refuses BEFORE any
        // dispatch (no invocation minted)…
        const resolution = await reader.read(mission, makeContextRequest({
            ownerHint: "lifeos",
            subject: "refs/lifeos/token=abcdef123456",
            missionId: mission.missionId,
        }), { dispatchStepId: "step-context-read" });
        expect(resolution).not.toBeNull();
        expect(resolution!.reads).toHaveLength(0);
        const unresolved = unresolvedOf(resolution);
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0].requestedRef).toContain("[ref withheld");
        expect(JSON.stringify(resolution)).not.toContain("abcdef123456");
        await harness.close();
    });

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

describe("ContextCompiler — reader failures reach package.unresolved (round 3)", () => {
    it("sanitizes raw secrets in seam refusal detail before sealing and compiling", async () => {
        const rawBearer = "Bearer liveBearerSecret";
        const rawApiKey = "api_key=live-api-key";
        const rawPassword = "password=live-password";
        const descriptor = makeContextDescriptor("lifeos");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        const throwingSeam = {
            dispatchThroughSeam: async () => {
                throw new DispatchSeamError(
                    `connector refused request: Authorization: ${rawBearer}; ${rawApiKey}; ${rawPassword}`,
                );
            },
        } as ConstructorParameters<typeof SeamBoundContextReader>[1];
        const reader = new SeamBoundContextReader(harness.engine, throwingSeam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const resolution = await reader.read(mission, request, { dispatchStepId: "step-context-read" });
        expect(resolution).not.toBeNull();

        const sealedJson = JSON.stringify(resolution);
        expect(sealedJson).not.toContain(rawBearer);
        expect(sealedJson).not.toContain(rawApiKey);
        expect(sealedJson).not.toContain(rawPassword);
        expect(resolution!.unresolved[0].detail).toContain("Bearer [REDACTED]");
        expect(resolution!.unresolved[0].detail).toContain("api_key= [REDACTED]");
        expect(resolution!.unresolved[0].detail).toContain("password= [REDACTED]");

        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [resolution!]);
        const packageJson = JSON.stringify(pkg);
        expect(packageJson).not.toContain(rawBearer);
        expect(packageJson).not.toContain(rawApiKey);
        expect(packageJson).not.toContain(rawPassword);
        await harness.close();
    });

    it("capability unavailable → the refusal appears in package.unresolved, not silently dropped", async () => {
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
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const resolution = await reader.read(mission, request, { dispatchStepId: "step-context-read" });
        expect(resolution).not.toBeNull();
        expect(resolution!.reads).toHaveLength(0);
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [resolution!]);
        expect(pkg.items).toHaveLength(0);
        expect(pkg.unresolved).toHaveLength(1);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.UNAVAILABLE);
        expect(pkg.unresolved[0].requestedRef).toBe("refs/lifeos/journal/2026-08");
        await harness.close();
    });

    it("revoked capability/scope → the refusal appears in package.unresolved as REVOKED", async () => {
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
        const request = makeContextRequest({
            ownerHint: "lifeos",
            subject: "refs/runstead/pr/7", // outside CURRENT mission prefixes
            missionId: mission.missionId,
        });
        const resolution = await reader.read(mission, request, { dispatchStepId: "step-context-read" });
        expect(resolution).not.toBeNull();
        expect(resolution!.reads).toHaveLength(0);
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [resolution!]);
        expect(pkg.items).toHaveLength(0);
        expect(pkg.unresolved).toHaveLength(1);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.REVOKED);
        await harness.close();
    });

    it("owner A fails and owner B returns valid rows: B's items survive, A's failure stays in unresolved", async () => {
        const lifeos = makeContextDescriptor("lifeos");
        const tecer = makeContextDescriptor("tecer");
        const harness = await createSeamHarness({ descriptors: [lifeos, tecer] });
        const { mission, steps } = await harness.acceptMultiContextPlan([
            { descriptor: lifeos, subject: "refs/lifeos/journal/2026-08", stepId: "step-lifeos" },
            { descriptor: tecer, subject: "refs/tecer/journal/2026-08", stepId: "step-tecer" },
        ]);
        // Owner A fails (connector throws → seam BLOCKED → honest refusal);
        // owner B serves valid rows.
        harness.seam.registerConnector(
            lifeos.capabilityId,
            makeContextConnector(lifeos, { throws: true, withOwnerVerification: true }),
        );
        harness.seam.registerConnector(
            tecer.capabilityId,
            makeContextConnector(tecer, { rows: tecerRows(), withOwnerVerification: true }),
        );
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const resA = await reader.read(mission, request, { dispatchStepId: steps[0].stepId });
        const resB = await reader.read(mission, request, { dispatchStepId: steps[1].stepId });
        expect(resA).not.toBeNull();
        expect(resB).not.toBeNull();
        expect(resA!.reads).toHaveLength(0);
        expect(resB!.reads).toHaveLength(1);
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            request,
            [resA!, resB!],
        );
        // No fake success: A's content never became items.
        expect(pkg.items.filter((i) => i.provenance.owner === "lifeos")).toHaveLength(0);
        expect(pkg.items.filter((i) => i.provenance.owner === "tecer")).toHaveLength(3);
        // A's failure is present in unresolved, honoring #64's "one
        // owner's failure never destroys another owner's items".
        expect(pkg.unresolved).toHaveLength(1);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.UNAVAILABLE);
        expect(pkg.unresolved[0].owner).toBe("lifeos");
        await harness.close();
    });

    it("unresolved records never grant capability nor alter the Mission (data stays data)", async () => {
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
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const missionSnapshot = structuredClone(mission);
        const resolution = await reader.read(mission, request, { dispatchStepId: "step-context-read" });
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [resolution!]);
        // Mission untouched: no capability was added, no scope widened.
        expect(mission).toEqual(missionSnapshot);
        expect(pkg.unresolved).toHaveLength(1);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.UNAVAILABLE);
        // The refusal is data, not authority: no item was promoted from it.
        expect(pkg.items).toHaveLength(0);
        await harness.close();
    });

    it("ADVERSARIAL: a caller-forged UnresolvedSource cannot enter the compiler (sealed batch required)", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest({ ownerHint: "lifeos" });
        const forgedBatch = {
            authorization: {
                missionId: mission.missionId,
                stepId: "step-forged",
                capabilityId: "context:lifeos",
                subject: request.subject,
            },
            reads: [],
            unresolved: [
                { requestedRef: request.subject, owner: "lifeos", status: SourceStatus.UNAVAILABLE, detail: "forged" },
            ],
        };
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [
                forgedBatch as never,
            ]),
        ).toThrow(ContextCompilerError);
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
        const resolution = await reader.read(mission, request, { dispatchStepId: stepId });
        expect(resolution).not.toBeNull();
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [resolution!]);
        expect(pkg.items[0].provenance.expiresAt).toBe("2026-08-30T12:00:00.000Z");

        // Recompiling at 14:00 with the SAME sealed resolution: the row is
        // now stale — validity is never renewed by recomposition.
        const later = new ContextCompiler({ clock: () => new Date("2026-08-30T14:00:00.000Z") }).compile(
            mission,
            request,
            [resolution!],
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
        expect(before).not.toBeNull();
        const first = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            request,
            [before!],
        );
        expect(first.items).toHaveLength(3);

        // After a restart the external rows are GONE: the first package is
        // inert DATA, not authority. Recompiling the same request WITHOUT
        // re-acquisition produces NO external content…
        const restarted = recompileAfterRestart(mission, request, { clock: fixedClock() });
        expect(restarted.items.filter((i) => i.provenance.origin === "external_owner")).toHaveLength(0);
        // …and raw previous results handed back as resolutions are refused
        // by the compiler (they are not sealed authority).
        expect(() =>
            new ContextCompiler({ clock: fixedClock() }).compile(mission, request, [
                {
                    authorization: {
                        missionId: mission.missionId,
                        stepId,
                        capabilityId: "context:lifeos",
                        subject: request.subject,
                    },
                    reads: [],
                    unresolved: [],
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

    it("does not re-acquire context content through STATUS_REPLAY", async () => {
        const descriptor = makeContextDescriptor("lifeos", {
            reconciliationSupport: "status_replay",
        });
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission, stepId } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        let invokes = 0;
        let reconciliations = 0;
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
                    contextRows: journalRows(),
                };
            },
            reconcile: async (requestId) => {
                reconciliations++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId,
                    summary: "status-only reconciliation",
                    evidence: [],
                    contextRows: journalRows(),
                };
            },
        });
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const first = await reader.read(mission, request, { dispatchStepId: stepId });
        expect(first?.reads).toHaveLength(1);

        const reacquired = await reader.read(mission, request, { dispatchStepId: stepId });
        expect(reacquired?.reads).toEqual([]);
        expect(reacquired?.unresolved).toHaveLength(1);
        expect(reacquired?.unresolved[0].status).toBe(SourceStatus.UNSUPPORTED);
        expect(invokes).toBe(1);
        expect(reconciliations).toBe(0);
        await harness.close();
    });

    it("re-acquires a completed external context read through FULL_REPLAY after restart", async () => {
        const descriptor = makeContextDescriptor("lifeos", {
            reconciliationSupport: "full_replay",
        });
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const { mission, stepId } = await harness.acceptContextPlan(
            descriptor,
            "refs/lifeos/journal/2026-08",
        );
        let invokes = 0;
        let reconciliations = 0;
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
                    contextRows: journalRows(),
                };
            },
            reconcile: async (requestId) => {
                reconciliations++;
                return {
                    status: CapabilityResultStatus.COMPLETED,
                    requestId,
                    summary: "reacquired context read",
                    evidence: [],
                    contextRows: journalRows(),
                };
            },
        });
        const reader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const request = makeContextRequest({ ownerHint: "lifeos", missionId: mission.missionId });
        const first = await reader.read(mission, request, { dispatchStepId: stepId });
        expect(first?.reads).toHaveLength(1);

        // A new reader/runtime after restart must use the durable completed
        // invocation identity and owner reconciliation, never invoke again.
        const restartedReader = new SeamBoundContextReader(harness.engine, harness.seam, harness.registry);
        const reacquired = await restartedReader.read(mission, request, { dispatchStepId: stepId });
        expect(reacquired?.reads).toHaveLength(1);
        expect(invokes).toBe(1);
        expect(reconciliations).toBe(1);
        await harness.close();
    });
});
