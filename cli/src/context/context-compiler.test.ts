/**
 * 🧩 Context Compiler Tests (Issue #64)
 *
 * Deterministic, offline suite proving the #64 boundary:
 *  - mission-owned refs compile as FACT with mission authorization;
 *  - external content ONLY via the RegistryBoundContextReader (#62 policy
 *    scope + #63 descriptor gates), with compiler-computed provenance;
 *  - epistemic classes stay distinct (fact / derived_summary / inference);
 *  - the package is inert frozen data (injection stays DATA);
 *  - budgets, dedup and minimal disclosure are deterministic;
 *  - secrets fail closed with honest exclusion records;
 *  - restart recomposition is pure (same inputs → same package).
 */

import { describe, expect, it } from "bun:test";

import { CapabilityRegistry } from "../capabilities/registry.js";
import { CapabilityAvailability } from "../capabilities/contracts.js";
import { EffectClass } from "../mission/contracts.js";
import type { Mission } from "../mission/contracts.js";
import { ContextCompiler, recompileAfterRestart } from "./compiler.js";
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
    makeContextDescriptor,
    makeContextMission,
    makeContextRequest,
    makeStaticAdapter,
    makeThrowingAdapter,
    THREE_HOURS_MS,
} from "./fixtures.js";
import { RegistryBoundContextReader } from "./sources.js";
import type { ContextRow } from "./contracts.js";

/** Build a reader with a lifeos descriptor (+ optional second owner). */
function makeReader(options: {
    mission: Mission;
    extraDescriptorOwner?: string;
    unavailable?: CapabilityAvailability;
    availabilityDetail?: string;
}): RegistryBoundContextReader {
    const registry = new CapabilityRegistry();
    registry.register(
        makeContextDescriptor("lifeos", {
            availability: options.unavailable,
            availabilityDetail: options.availabilityDetail,
        }),
    );
    if (options.extraDescriptorOwner) {
        registry.register(makeContextDescriptor(options.extraDescriptorOwner));
    }
    return new RegistryBoundContextReader({ registry });
}

/** Read through the registry boundary, then compile — the canonical flow. */
async function compileViaReader(
    mission: Mission,
    request: ContextRequest,
    setup: (reader: RegistryBoundContextReader) => void,
): Promise<BoundedContextPackage> {
    const reader = makeReader({ mission });
    setup(reader);
    const outcomes = await reader.read(mission, request);
    return new ContextCompiler({ clock: fixedClock() }).compile(mission, request, outcomes);
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
});

describe("ContextCompiler — provenance is compiler-computed (forge-proof)", () => {
    it("external rows carry provenance from the authorized descriptor, not the adapter", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest({ ownerHint: "lifeos" });
        const pkg = await compileViaReader(mission, request, (reader) => {
            reader.registerAdapter(makeStaticAdapter("context:lifeos", journalRows()));
        });

        expect(pkg.items.length).toBe(3);
        for (const item of pkg.items) {
            expect(item.provenance.owner).toBe("lifeos");
            expect(item.provenance.origin).toBe("external_owner");
            expect(item.provenance.authorization).toBe("capability:context:lifeos");
            expect(item.provenance.sourceVersion).toBe(1);
            expect(item.provenance.missionId).toBe("mission-ctx-1");
            expect(item.provenance.purpose).toBe("weekly review compilation");
        }
    });

    it("unresolved records from the reader are carried honestly into the package", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest({ ownerHint: "lifeos" });
        const reader = makeReader({ mission });
        // No adapter registered → honest gate-7 refusal.
        const outcomes = await reader.read(mission, request);
        expect(outcomes).toHaveLength(1);
        expect("rows" in outcomes[0]).toBe(false);

        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            request,
            outcomes as ContextReadOutcome[],
        );
        expect(pkg.items).toHaveLength(0);
        expect(pkg.unresolved).toHaveLength(1);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.UNSUPPORTED);
        expect(pkg.unresolved[0].detail).toContain("no context adapter registered");
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

describe("ContextCompiler — package is inert data (injection stays DATA)", () => {
    it("returns a deeply frozen package with no functions and untouched mission intent", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest({ ownerHint: "lifeos" });
        const pkg = await compileViaReader(mission, request, (reader) => {
            reader.registerAdapter(makeStaticAdapter("context:lifeos", journalRows()));
        });

        expect(Object.isFrozen(pkg)).toBe(true);
        expect(Object.isFrozen(pkg.items)).toBe(true);
        expect(Object.isFrozen(pkg.items[0])).toBe(true);
        expect(Object.isFrozen(pkg.items[0].provenance)).toBe(true);
        expect(Object.isFrozen(pkg.request)).toBe(true);

        const json = JSON.stringify(pkg);
        expect(json).not.toContain("() =>");
        expect(json).not.toContain("function");

        // The compiler holds no API into Mission authority fields.
        expect(mission.originalIntent).toBe("Prepare the weekly review from my journal summaries");
        expect(mission.constraints).toEqual(["No destructive effects"]);
        expect(mission.acceptanceCriteria).toEqual(["Review drafted from authorized sources"]);
        expect(mission.state).toBe("created");
    });
});

describe("RegistryBoundContextReader — registry boundary (fail-closed gates)", () => {
    it("refuses capabilities outside the mission scope as REVOKED", async () => {
        const mission = makeContextMission({
            allowedCapabilityScope: {
                capabilityIds: ["storage.read-local"],
                allowedEffectClasses: [EffectClass.READ],
                allowedRefPrefixes: ["refs/lifeos/", "refs/tecer/", "refs/ouroboros/"],
            },
        });
        const reader = makeReader({ mission });
        reader.registerAdapter(makeStaticAdapter("context:lifeos", journalRows()));
        const outcomes = await reader.read(mission, makeContextRequest({ ownerHint: "lifeos" }));
        expect(outcomes).toHaveLength(1);
        const unresolved = outcomes[0] as { status: SourceStatus; detail: string };
        expect(unresolved.status).toBe(SourceStatus.REVOKED);
        expect(unresolved.detail).toContain("not authorized for this mission");
    });

    it("refuses unknown owners as UNSUPPORTED (no such capability)", async () => {
        const mission = makeContextMission();
        const reader = makeReader({ mission }); // only context:lifeos registered
        const outcomes = await reader.read(mission, makeContextRequest({ ownerHint: "katherine" }));
        expect(outcomes).toHaveLength(1);
        const unresolved = outcomes[0] as { status: SourceStatus; detail: string };
        expect(unresolved.status).toBe(SourceStatus.UNSUPPORTED);
        expect(unresolved.detail).toContain("no such capability");
    });

    it("refuses non-read-only capabilities as UNSUPPORTED", async () => {
        const mission = makeContextMission();
        const registry = new CapabilityRegistry();
        registry.register(
            makeContextDescriptor("lifeos", { ownsStorage: true } as never),
        );
        const reader = new RegistryBoundContextReader({ registry });
        const outcomes = await reader.read(mission, makeContextRequest({ ownerHint: "lifeos" }));
        const unresolved = outcomes[0] as { status: SourceStatus; detail: string };
        expect(unresolved.status).toBe(SourceStatus.UNSUPPORTED);
        expect(unresolved.detail).toContain("read-only context source");
    });

    it("honors ref-prefix boundaries: outside mission prefixes REVOKED, outside descriptor prefixes UNSUPPORTED", async () => {
        const mission = makeContextMission();
        const reader = makeReader({ mission });
        reader.registerAdapter(makeStaticAdapter("context:lifeos", journalRows()));

        // Subject outside the MISSION prefixes → REVOKED.
        const outsideMission = await reader.read(
            mission,
            makeContextRequest({ ownerHint: "lifeos", subject: "refs/runstead/pr/7" }),
        );
        expect((outsideMission[0] as { status: SourceStatus }).status).toBe(SourceStatus.REVOKED);

        // Subject inside mission prefixes but outside the descriptor's
        // declared prefixes → UNSUPPORTED.
        const rogueRegistry = new CapabilityRegistry();
        rogueRegistry.register(
            makeContextDescriptor("lifeos", {
                allowedInputRefPrefixes: ["refs/other/"],
            }),
        );
        const rogueReader = new RegistryBoundContextReader({ registry: rogueRegistry });
        rogueReader.registerAdapter(makeStaticAdapter("context:lifeos", journalRows()));
        const outsideDescriptor = await rogueReader.read(
            mission,
            makeContextRequest({ ownerHint: "lifeos" }),
        );
        expect((outsideDescriptor[0] as { status: SourceStatus }).status).toBe(
            SourceStatus.UNSUPPORTED,
        );
        expect((outsideDescriptor[0] as { detail: string }).detail).toContain(
            "capability declared ref prefixes",
        );
    });

    it("maps discovery availability honestly (BUSY → UNAVAILABLE, NEEDS_USER_ACTION → CONFIGURATION_ERROR)", async () => {
        const mission = makeContextMission();

        const busyReader = makeReader({
            mission,
            unavailable: CapabilityAvailability.BUSY,
            availabilityDetail: "journal service is busy",
        });
        const busy = await busyReader.read(mission, makeContextRequest({ ownerHint: "lifeos" }));
        expect((busy[0] as { status: SourceStatus }).status).toBe(SourceStatus.UNAVAILABLE);
        expect((busy[0] as { detail: string }).detail).toContain("busy");

        const cfgReader = makeReader({
            mission,
            unavailable: CapabilityAvailability.NEEDS_USER_ACTION,
        });
        const cfg = await cfgReader.read(mission, makeContextRequest({ ownerHint: "lifeos" }));
        expect((cfg[0] as { status: SourceStatus }).status).toBe(SourceStatus.CONFIGURATION_ERROR);
    });

    it("returns no reads for mission-only requests (no ownerHint)", async () => {
        const mission = makeContextMission();
        const reader = makeReader({ mission });
        const outcomes = await reader.read(mission, makeContextRequest());
        expect(outcomes).toEqual([]);
    });
});

describe("ContextCompiler — honest degradation across owners", () => {
    it("a throwing adapter degrades honestly without poisoning other owners", async () => {
        const mission = makeContextMission();
        const registry = new CapabilityRegistry();
        registry.register(makeContextDescriptor("lifeos"));
        registry.register(makeContextDescriptor("tecer"));
        const reader = new RegistryBoundContextReader({ registry });
        reader.registerAdapter(makeThrowingAdapter("context:lifeos"));
        reader.registerAdapter(
            makeStaticAdapter("context:tecer", [
                {
                    sourceRef: "refs/tecer/loom/state",
                    content: "Loom state: three active threads.",
                    fetchedAt: "2026-08-30T10:00:00.000Z",
                },
            ]),
        );

        const outcomes: ContextReadOutcome[] = [];
        outcomes.push(
            ...(await reader.read(mission, makeContextRequest({ ownerHint: "lifeos" }))),
        );
        outcomes.push(
            ...(await reader.read(
                mission,
                makeContextRequest({ ownerHint: "tecer", subject: "refs/tecer/loom/state" }),
            )),
        );

        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(
            mission,
            makeContextRequest(),
            outcomes,
        );
        // LifeOS failed honestly…
        expect(pkg.unresolved).toHaveLength(1);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.UNAVAILABLE);
        expect(pkg.unresolved[0].detail).toContain("adapter threw");
        // …and Tecer's items survived (one owner's failure ≠ silent erasure).
        expect(pkg.items).toHaveLength(1);
        expect(pkg.items[0].provenance.owner).toBe("tecer");
    });

    it("skips malformed rows honestly and keeps valid siblings", async () => {
        const mission = makeContextMission();
        const rows: ContextRow[] = [
            { sourceRef: "", content: "broken row" },
            ...journalRows(),
        ];
        const pkg = await compileViaReader(makeContextMission(), makeContextRequest({ ownerHint: "lifeos" }), (reader) => {
            reader.registerAdapter(makeStaticAdapter("context:lifeos", rows));
        });
        expect(pkg.unresolved).toHaveLength(1);
        expect(pkg.unresolved[0].status).toBe(SourceStatus.UNSUPPORTED);
        expect(pkg.unresolved[0].detail).toContain("structural validation");
        expect(pkg.items).toHaveLength(3); // malformed row skipped, siblings kept
    });

    it("enforces freshness fail-closed: no timestamp or old rows are STALE", async () => {
        const mission = makeContextMission();
        const rows: ContextRow[] = [
            {
                sourceRef: "refs/lifeos/journal/no-ts",
                content: "Entry without a valid age proof.",
            },
            {
                sourceRef: "refs/lifeos/journal/aged",
                content: "Aged entry.",
                fetchedAt: "2026-08-30T08:00:00.000Z",
            },
            {
                sourceRef: "refs/lifeos/journal/fresh",
                content: "Fresh entry.",
                fetchedAt: "2026-08-30T09:00:00.000Z",
            },
        ];
        const request = makeContextRequest({ ownerHint: "lifeos", maxAgeMs: THREE_HOURS_MS });
        const pkg = await compileViaReader(mission, request, (reader) => {
            reader.registerAdapter(makeStaticAdapter("context:lifeos", rows));
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
        expect(pkg.items[0].provenance.expiresAt).toBe("2026-08-30T15:00:00.000Z");
    });
});

describe("ContextCompiler — budgets, dedup and deterministic selection", () => {
    it("caps items and chars with recorded exclusions, deterministic order", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest({
            ownerHint: "lifeos",
            budget: { maxItems: 2, maxTotalChars: 10000, maxEstimatedTokens: 5000 },
        });
        const pkg = await compileViaReader(mission, request, (reader) => {
            reader.registerAdapter(makeStaticAdapter("context:lifeos", journalRows()));
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
    });

    it("deduplicates identical content from repeated reads (recorded, not silent)", async () => {
        const mission = makeContextMission();
        const rows = journalRows();
        const reader = makeReader({ mission });
        reader.registerAdapter(makeStaticAdapter("context:lifeos", rows));
        const request = makeContextRequest({ ownerHint: "lifeos" });
        const outcomes = [
            ...(await reader.read(mission, request)),
            ...(await reader.read(mission, request)),
        ];
        const pkg = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, outcomes);
        expect(pkg.items).toHaveLength(3);
        expect(pkg.budgetReport.excluded.filter((e) => e.reason === "duplicate")).toHaveLength(3);
    });

    it("is order-independent: shuffled read order yields the same package", async () => {
        const mission = makeContextMission();
        const rows = journalRows();
        const request = makeContextRequest({ ownerHint: "lifeos" });
        const reader = makeReader({ mission });
        reader.registerAdapter(makeStaticAdapter("context:lifeos", rows));
        const forward = await reader.read(mission, request);
        const backward = [...(await reader.read(mission, request))].reverse();
        const a = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, forward);
        const b = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, backward);
        expect(a.packageId).toBe(b.packageId);
        expect(a.items.map((i) => i.itemId)).toEqual(b.items.map((i) => i.itemId));
    });

    it("enforces the token-like budget via the documented 4-chars-per-token heuristic", async () => {
        const mission = makeContextMission();
        const longContent = "x".repeat(400);
        const request = makeContextRequest({
            ownerHint: "lifeos",
            budget: { maxItems: 12, maxTotalChars: 100000, maxEstimatedTokens: 50 },
        });
        const pkg = await compileViaReader(mission, request, (reader) => {
            reader.registerAdapter(
                makeStaticAdapter("context:lifeos", [
                    { sourceRef: "refs/lifeos/big", content: longContent },
                ]),
            );
        });
        // 400 chars ≈ 100 estimated tokens > 50 → excluded, honest record.
        expect(pkg.items).toHaveLength(0);
        expect(pkg.budgetReport.excluded).toHaveLength(1);
        expect(pkg.budgetReport.excluded[0].reason).toBe("scope_exceeded");
    });
});

describe("ContextCompiler — secrets fail closed", () => {
    it("refuses secret-bearing rows with honest exclusion records (no leak)", async () => {
        const mission = makeContextMission();
        const rows: ContextRow[] = [
            {
                sourceRef: "refs/lifeos/journal/leaky",
                content: "my api_key=sk-proj-abcdef123456 and password=hunter2",
            },
            ...journalRows(),
        ];
        const pkg = await compileViaReader(
            makeContextMission(),
            makeContextRequest({ ownerHint: "lifeos" }),
            (reader) => {
                reader.registerAdapter(makeStaticAdapter("context:lifeos", rows));
            },
        );

        expect(pkg.items).toHaveLength(3); // only the clean rows survive
        expect(pkg.budgetReport.excluded.some((e) => e.reason === "secret_refused")).toBe(true);
        const json = JSON.stringify(pkg);
        expect(json).not.toContain("sk-proj-");
        expect(json).not.toContain("hunter2");
        expect(json).not.toContain("api_key=sk");
    });

    it("carries owner-declared RESTRICTED rows as reference-only", async () => {
        const mission = makeContextMission();
        const rows: ContextRow[] = [
            {
                sourceRef: "refs/lifeos/journal/private",
                content: "SHOULD NEVER APPEAR",
                sensitivity: SensitivityClass.RESTRICTED,
            },
        ];
        const pkg = await compileViaReader(
            makeContextMission(),
            makeContextRequest({ ownerHint: "lifeos" }),
            (reader) => {
                reader.registerAdapter(makeStaticAdapter("context:lifeos", rows));
            },
        );
        expect(pkg.items).toHaveLength(1);
        expect(pkg.items[0].content).toBe(
            "(restricted: reference-only refs/lifeos/journal/private)",
        );
        expect(pkg.items[0].provenance.sensitivity).toBe(SensitivityClass.RESTRICTED);
        expect(JSON.stringify(pkg)).not.toContain("SHOULD NEVER APPEAR");
    });
});

describe("ContextCompiler — restart recomposition", () => {
    it("recompiles the same package from durable state after restart (pure, no cache)", async () => {
        const mission = makeContextMission();
        const request = makeContextRequest({ ownerHint: "lifeos" });
        const reader = makeReader({ mission });
        reader.registerAdapter(makeStaticAdapter("context:lifeos", journalRows()));
        const outcomes = await reader.read(mission, request);

        const first = new ContextCompiler({ clock: fixedClock() }).compile(mission, request, outcomes);
        const restarted = recompileAfterRestart(mission, request, outcomes, {
            clock: fixedClock(),
        });
        expect(restarted.packageId).toBe(first.packageId);
        expect(restarted).toEqual(first);
    });
});
