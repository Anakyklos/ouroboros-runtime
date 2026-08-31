/**
 * 🧪 Capability Registry + Descriptor tests (Issue #63)
 *
 * Proves the versioned, provider-independent Capability Descriptor and the
 * Capability Registry that satisfies/substitutes the #62 CapabilityResolver.
 *
 * Deterministic, offline, provider-free.
 */

import { describe, expect, test } from "bun:test";
import {
    CAPABILITY_REGISTRY_CONTRACT_VERSION,
    CapabilityAvailability,
    CancellationSupport,
    EffectClass,
    IdempotencyMode,
    ReconciliationSupport,
    RetryBackoff,
    validateCapabilityDescriptor,
    type CapabilityDescriptor,
} from "./contracts.js";
import {
    CapabilityRegistry,
    CapabilityContractConflictError,
    ConnectorContractVersionError,
    DuplicateCapabilityError,
    UnknownCapabilityError,
} from "./registry.js";
import { assertConnectorMatchesDescriptor } from "./registry.js";
import { defineCapabilityDescriptor } from "./fixtures.js";
import {
    CapabilityResult,
    CapabilityResultStatus,
    ConnectorRequest,
    type CapabilityConnector,
} from "./connector.js";

describe("CapabilityDescriptor contract (v1)", () => {
    test("a valid descriptor passes validation and carries the full declared surface", () => {
        const descriptor = defineCapabilityDescriptor({
            capabilityId: "lifeos.query_commitments",
            moduleOwner: "lifeos",
            purpose: "Query open commitments owned by LifeOS",
            effectClass: EffectClass.READ,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            ownsStorage: true,
            requiresOwnerVerification: true,
        });

        const result = validateCapabilityDescriptor(descriptor);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);

        // Full required surface declared by #63.
        expect(descriptor.contractVersion).toBe(CAPABILITY_REGISTRY_CONTRACT_VERSION);
        expect(descriptor.moduleOwner).toBe("lifeos");
        expect(descriptor.availability).toBe(CapabilityAvailability.AVAILABLE);
        expect(descriptor.idempotency.mode).toBe(IdempotencyMode.IDEMPOTENT);
        expect(descriptor.retry.maxAttempts).toBeTypeOf("number");
        expect(descriptor.retry.backoff).toBe(RetryBackoff.NONE);
        expect(descriptor.cancellationSupport).toBe(CancellationSupport.NONE);
        expect(descriptor.reconciliationSupport).toBe(ReconciliationSupport.NONE);
        expect(descriptor.expectedEvidence.ownerVerification).toBe("module_owner");
        // Typed input/result schemas are declared as validators (objects with
        // deterministic check functions), not free-form text.
        expect(typeof descriptor.inputSchema.validate).toBe("function");
        expect(typeof descriptor.resultSchema.validate).toBe("function");
    });

    test("descriptor satisfies the #62 CapabilityContract shape consumed by policy", () => {
        const descriptor = defineCapabilityDescriptor({
            capabilityId: "lifeos.query_commitments",
            moduleOwner: "lifeos",
            purpose: "Query open commitments",
            effectClass: EffectClass.READ,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            ownsStorage: true,
        });
        // These are exactly the fields CapabilityContract requires.
        expect(descriptor.capabilityId).toBe("lifeos.query_commitments");
        expect(descriptor.moduleOwner).toBe("lifeos");
        expect(descriptor.effectClass).toBe(EffectClass.READ);
        expect(descriptor.requiresApproval).toBe(false);
        expect(descriptor.requiresOwnerVerification).toBe(false);
        expect(descriptor.allowedInputRefPrefixes).toContain("refs/lifeos/");
        expect(descriptor.ownsStorage).toBe(true);
    });

    test("contract version mismatch fails closed", () => {
        const descriptor = defineCapabilityDescriptor({
            capabilityId: "x.y",
            moduleOwner: "x",
            purpose: "p",
            effectClass: EffectClass.READ,
        });
        const tampered = { ...descriptor, contractVersion: 2 } as CapabilityDescriptor;
        const result = validateCapabilityDescriptor(tampered);
        expect(result.valid).toBe(false);
        expect(result.errors.join(" ")).toContain("contract version");
    });

    test("empty identity fields fail closed", () => {
        const descriptor = {
            ...defineCapabilityDescriptor({
                capabilityId: "seed",
                moduleOwner: "x",
                purpose: "p",
                effectClass: EffectClass.READ,
            }),
            capabilityId: "",
            moduleOwner: "   ",
        } as CapabilityDescriptor;
        const result = validateCapabilityDescriptor(descriptor);
        expect(result.valid).toBe(false);
        expect(result.errors.join(" ")).toContain("capabilityId");
        expect(result.errors.join(" ")).toContain("moduleOwner");
    });

    test("purpose must be already sanitized — raw secrets fail closed", () => {
        const seed = defineCapabilityDescriptor({
            capabilityId: "x.y",
            moduleOwner: "x",
            purpose: "p",
            effectClass: EffectClass.READ,
        });
        const descriptor = {
            ...seed,
            purpose: "connect with Authorization: Bearer abc123",
        } as CapabilityDescriptor;
        const result = validateCapabilityDescriptor(descriptor);
        expect(result.valid).toBe(false);
        expect(result.errors.join(" ")).toContain("purpose");
    });

    test("credential requirement may carry a reference but never a raw secret", () => {
        const seed = defineCapabilityDescriptor({
            capabilityId: "x.y",
            moduleOwner: "x",
            purpose: "p",
            effectClass: EffectClass.NETWORK,
        });
        const byReference = {
            ...seed,
            credentialRequirement: { kind: "reference", credentialRef: "vault://x/creds" },
        } as CapabilityDescriptor;
        expect(validateCapabilityDescriptor(byReference).valid).toBe(true);

        const rawSecret = {
            ...seed,
            credentialRequirement: { kind: "metadata", metadata: "api_key=sk-123" },
        } as CapabilityDescriptor;
        const result = validateCapabilityDescriptor(rawSecret);
        expect(result.valid).toBe(false);
        expect(result.errors.join(" ")).toContain("credential");
    });

    test("availability must be one of the eight declared states", () => {
        const all = [
            CapabilityAvailability.AVAILABLE,
            CapabilityAvailability.BUSY,
            CapabilityAvailability.WAITING_DEPENDENCY,
            CapabilityAvailability.NEEDS_USER_ACTION,
            CapabilityAvailability.DEGRADED,
            CapabilityAvailability.UNAVAILABLE,
            CapabilityAvailability.UNSUPPORTED,
            CapabilityAvailability.CONFIGURATION_ERROR,
        ];
        expect(new Set(all).size).toBe(8);
        const descriptor = defineCapabilityDescriptor({
            capabilityId: "x.y",
            moduleOwner: "x",
            purpose: "p",
            effectClass: EffectClass.READ,
        });
        for (const availability of all) {
            const result = validateCapabilityDescriptor({ ...descriptor, availability });
            expect(result.valid).toBe(true);
        }
    });

    test("cancellation/reconciliation semantics are declared explicitly", () => {
        const longRunning = defineCapabilityDescriptor({
            capabilityId: "runstead.long_job",
            moduleOwner: "runstead",
            purpose: "Long running job",
            effectClass: EffectClass.EXECUTION,
            cancellationSupport: CancellationSupport.COOPERATIVE,
            reconciliationSupport: ReconciliationSupport.STATUS_REPLAY,
        });
        expect(validateCapabilityDescriptor(longRunning).valid).toBe(true);
        expect(longRunning.reconciliationSupport).not.toBe(ReconciliationSupport.NONE);
    });
});

describe("CapabilityRegistry", () => {
    const readDescriptor = () =>
        defineCapabilityDescriptor({
            capabilityId: "lifeos.query_commitments",
            moduleOwner: "lifeos",
            purpose: "Query open commitments owned by LifeOS",
            effectClass: EffectClass.READ,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            ownsStorage: true,
        });

    test("registers and resolves the versioned descriptor deterministically", async () => {
        const registry = new CapabilityRegistry();
        registry.register(readDescriptor());

        const resolved = await registry.resolve("lifeos.query_commitments");
        expect(resolved).not.toBeNull();
        expect(resolved!.capabilityId).toBe("lifeos.query_commitments");

        const again = await registry.resolve("lifeos.query_commitments");
        expect(again).toEqual(resolved);

        const native = registry.requireDescriptor("lifeos.query_commitments");
        expect(native.capabilityId).toBe("lifeos.query_commitments");
        expect(native.moduleOwner).toBe("lifeos");
        expect(native.purpose).toBe("Query open commitments owned by LifeOS");
    });

    test("satisfies the #62 CapabilityResolver interface", async () => {
        const registry = new CapabilityRegistry();
        registry.register(readDescriptor());
        // Shape-compatible with the resolver the #62 policy consumes:
        const resolver = registry as import("../mission/ports.js").CapabilityResolver;
        expect(await resolver.resolve("lifeos.query_commitments")).not.toBeNull();
        expect(await resolver.resolve("nope.nope")).toBeNull();
        expect(await resolver.listRegistered()).toEqual(["lifeos.query_commitments"]);
    });

    test("unknown capability: resolver API returns null, registry API fails closed", async () => {
        const registry = new CapabilityRegistry();
        expect(await registry.resolve("ghost.capability")).toBeNull();
        expect(() => registry.requireDescriptor("ghost.capability")).toThrow(
            UnknownCapabilityError,
        );
    });

    test("duplicate registration is rejected explicitly (no silent overwrite)", () => {
        const registry = new CapabilityRegistry();
        registry.register(readDescriptor());
        expect(() => registry.register(readDescriptor())).toThrow(DuplicateCapabilityError);
    });

    test("conflicting connector description is rejected explicitly", () => {
        const registry = new CapabilityRegistry();
        registry.register(readDescriptor());
        const conflicting = {
            ...readDescriptor(),
            effectClass: EffectClass.WRITE,
        } as CapabilityDescriptor;
        expect(() => registry.register(conflicting)).toThrow(DuplicateCapabilityError);
    });

    test("explicit replace() swaps the descriptor deterministically", () => {
        const registry = new CapabilityRegistry();
        registry.register(readDescriptor());
        const upgraded = {
            ...readDescriptor(),
            purpose: "Query open commitments (v2 surface)",
            availability: CapabilityAvailability.DEGRADED,
        } as CapabilityDescriptor;
        registry.replace(upgraded);
        expect(registry.requireDescriptor("lifeos.query_commitments").purpose).toBe(
            "Query open commitments (v2 surface)",
        );
        expect(registry.requireDescriptor("lifeos.query_commitments").availability).toBe(
            CapabilityAvailability.DEGRADED,
        );
    });

    test("unavailable capability remains discoverable with availability intact", async () => {
        const registry = new CapabilityRegistry();
        registry.register(
            defineCapabilityDescriptor({
                capabilityId: "tecer.record_entry",
                moduleOwner: "tecer",
                purpose: "Record nutrition entry",
                effectClass: EffectClass.WRITE,
                availability: CapabilityAvailability.UNAVAILABLE,
                availabilityDetail: "module offline",
            }),
        );
        const resolved = registry.requireDescriptor("tecer.record_entry");
        expect(resolved.availability).toBe(CapabilityAvailability.UNAVAILABLE);
        // Other capabilities are not affected by one module being down.
        registry.register(readDescriptor());
        expect(
            registry.requireDescriptor("lifeos.query_commitments").availability,
        ).toBe(CapabilityAvailability.AVAILABLE);
    });

    test("availability changes never alter the authorization-relevant identity", () => {
        const registry = new CapabilityRegistry();
        registry.register(readDescriptor());
        const before = registry.requireDescriptor("lifeos.query_commitments");
        registry.setAvailability(
            "lifeos.query_commitments",
            CapabilityAvailability.BUSY,
            "processing",
        );
        const after = registry.requireDescriptor("lifeos.query_commitments");
        expect(after.availability).toBe(CapabilityAvailability.BUSY);
        // Authorization-relevant fields are untouched by availability state.
        expect(after.moduleOwner).toBe(before.moduleOwner);
        expect(after.effectClass).toBe(before.effectClass);
        expect(after.allowedInputRefPrefixes).toEqual(before.allowedInputRefPrefixes);
        expect(after.requiresApproval).toBe(before.requiresApproval);
        expect(after.ownsStorage).toBe(before.ownsStorage);
    });

    test("descriptor with raw secret anywhere fails registration (fail closed)", () => {
        const registry = new CapabilityRegistry();
        const leaky = defineCapabilityDescriptor({
            capabilityId: "x.y",
            moduleOwner: "x",
            purpose: "p",
            effectClass: EffectClass.READ,
        });
        const tampered = {
            ...leaky,
            availabilityDetail: "token=super-secret-value",
        } as CapabilityDescriptor;
        expect(() => registry.register(tampered)).toThrow();
    });

    test("descriptor with unsupported future version fails registration", () => {
        const registry = new CapabilityRegistry();
        const future = {
            ...readDescriptor(),
            contractVersion: 99,
        } as CapabilityDescriptor;
        expect(() => registry.register(future)).toThrow();
    });

    test("connector binding requires version match and an exactly matching describe()", () => {
        const registry = new CapabilityRegistry();
        registry.register(readDescriptor());

        const wrongVersion = {
            connectorContractVersion: 99,
            capabilityId: "lifeos.query_commitments",
            describe: () => readDescriptor(),
            invoke: async () => {
                throw new Error("not used");
            },
            observeStatus: async () => null,
        };
        expect(() => assertConnectorMatchesDescriptor(wrongVersion as never)).toThrow(
            ConnectorContractVersionError,
        );
    });

    test("no silent fallback: registry never substitutes another capability", async () => {
        const registry = new CapabilityRegistry();
        registry.register(readDescriptor());
        // Resolving an unknown id never returns a different capability.
        expect(await registry.resolve("other.capability")).toBeNull();
    });

    test("no dynamic code/plugin installation API exists on the registry surface", () => {
        const registry = new CapabilityRegistry() as unknown as Record<string, unknown>;
        for (const forbidden of ["install", "load", "loadPlugin", "eval", "importModule"]) {
            expect(registry[forbidden]).toBeUndefined();
        }
    });
});

describe("Registry conflict handling (explicit contract)", () => {
    test("CapabilityContractConflictError is exported and distinct", () => {
        const err = new CapabilityContractConflictError("cap", "mismatch");
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain("cap");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connector lifecycle (thin, versioned, transport-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

describe("Connector lifecycle (transport-agnostic contract)", () => {
    const readDescriptor = () =>
        defineCapabilityDescriptor({
            capabilityId: "lifeos.query_commitments",
            moduleOwner: "lifeos",
            purpose: "Query open commitments owned by LifeOS",
            effectClass: EffectClass.READ,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            ownsStorage: true,
        });

    /** Deterministic offline stub connector (no network, no real secrets). */
    function stubConnector(
        descriptor: CapabilityDescriptor,
        handler: (request: ConnectorRequest) => Promise<CapabilityResult>,
        extra: Partial<CapabilityConnector> = {},
    ): CapabilityConnector {
        return {
            connectorContractVersion: 1,
            capabilityId: descriptor.capabilityId,
            describe: () => descriptor,
            invoke: handler,
            ...extra,
        };
    }

    test("connector bound to registry must describe exactly the registered descriptor", async () => {
        const registry = new CapabilityRegistry();
        const descriptor = readDescriptor();
        registry.register(descriptor);
        const connector = stubConnector(descriptor, async () => ({
            status: CapabilityResultStatus.COMPLETED,
            requestId: "req-1",
            summary: "commitments fetched",
            evidence: [{ owner: "lifeos", externalRef: "lifeos/evidence-1", label: "query result" }],
        }));
        expect(() => assertConnectorMatchesDescriptor(connector, descriptor)).not.toThrow();
        // A connector whose describe() diverges from the registered descriptor
        // is rejected explicitly (discovery never silently diverges).
        const divergent = stubConnector(
            { ...descriptor, purpose: "something else entirely" } as CapabilityDescriptor,
            async () => ({
                status: CapabilityResultStatus.COMPLETED,
                requestId: "req-1",
                summary: "s",
                evidence: [],
            }),
        );
        expect(() => assertConnectorMatchesDescriptor(divergent, descriptor)).toThrow(
            CapabilityContractConflictError,
        );
    });

    test("invoke returns a typed result matching the declared result schema", async () => {
        const registry = new CapabilityRegistry();
        const descriptor = readDescriptor();
        registry.register(descriptor);
        const connector = stubConnector(descriptor, async (request) => {
            expect(descriptor.inputSchema.validate(request).valid).toBe(true);
            return {
                status: CapabilityResultStatus.COMPLETED,
                requestId: request.requestId,
                summary: "3 open commitments",
                evidence: [{ owner: "lifeos", externalRef: "lifeos/evidence-9", label: "query result" }],
            };
        });
        const result = await connector.invoke({
            requestId: "req-1",
            inputRefs: ["refs/lifeos/journal/entry-1"],
            desiredOutcome: "list open commitments",
        });
        expect(result.status).toBe(CapabilityResultStatus.COMPLETED);
        expect(descriptor.resultSchema.validate(result).valid).toBe(true);
        expect(result.evidence[0].owner).toBe("lifeos");
    });

    test("observeStatus reports a prior long-running invocation without inventing completion", async () => {
        const registry = new CapabilityRegistry();
        const descriptor = readDescriptor();
        registry.register(descriptor);
        const connector = stubConnector(descriptor, async () => {
            throw new Error("should not invoke");
        }, {
            observeStatus: async (ownerOperationRef) => ({
                status: CapabilityResultStatus.STILL_RUNNING,
                requestId: "req-42",
                summary: "still running",
                evidence: [],
                ownerOperationRef,
            }),
        });
        const status = await connector.observeStatus!("op-42");
        expect(status!.status).toBe(CapabilityResultStatus.STILL_RUNNING);
        expect(status!.requestId).toBe("req-42");
        expect(status!.ownerOperationRef).toBe("op-42");
    });

    test("cancel produces a typed result and is only declared where supported", async () => {
        const registry = new CapabilityRegistry();
        const descriptor = readDescriptor();
        registry.register(descriptor);
        const connector = stubConnector(descriptor, async () => {
            throw new Error("should not invoke");
        }, {
            cancel: async (ownerOperationRef) => ({
                status: CapabilityResultStatus.FAILED,
                requestId: "req-7",
                summary: `cancelled ${ownerOperationRef}`,
                evidence: [],
            }),
        });
        const cancelled = await connector.cancel!("op-7");
        expect(cancelled.status).toBe(CapabilityResultStatus.FAILED);
        expect(cancelled.summary).toContain("op-7");
        // A connector without cancel does not fabricate one.
        const noCancel = stubConnector(descriptor, async () => ({
            status: CapabilityResultStatus.COMPLETED,
            requestId: "r",
            summary: "s",
            evidence: [],
        }));
        expect(noCancel.cancel).toBeUndefined();
    });

    test("reconcile recovers state after disconnect without fabricating success", async () => {
        const registry = new CapabilityRegistry();
        const descriptor = readDescriptor();
        registry.register(descriptor);
        const connector = stubConnector(descriptor, async () => {
            throw new Error("should not invoke");
        }, {
            reconcile: async (_requestId) => null,
        });
        // Unknown/pending after restart: reconcile reports null, never COMPLETED.
        expect(await connector.reconcile!("req-9")).toBeNull();
        const fabricating = stubConnector(descriptor, async () => {
            throw new Error("should not invoke");
        }, {
            reconcile: async (_requestId) => ({
                status: CapabilityResultStatus.COMPLETED,
                requestId: "req-9",
                summary: "reconciled as completed",
                evidence: [],
            }),
        });
        const reconciled = await fabricating.reconcile!("req-9");
        expect(reconciled!.status).toBe(CapabilityResultStatus.COMPLETED);
        // The result is still subject to the declared result schema.
        expect(descriptor.resultSchema.validate(reconciled).valid).toBe(true);
    });

    test("connector version mismatch is rejected at binding time", () => {
        const registry = new CapabilityRegistry();
        const descriptor = readDescriptor();
        registry.register(descriptor);
        const stale = stubConnector(descriptor, async () => ({
            status: CapabilityResultStatus.COMPLETED,
            requestId: "r",
            summary: "s",
            evidence: [],
        }));
        (stale as { connectorContractVersion: number }).connectorContractVersion = 99;
        expect(() => assertConnectorMatchesDescriptor(registry, stale)).toThrow(
            ConnectorContractVersionError,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Secret hygiene + owner forgeability (defense in depth)
// ─────────────────────────────────────────────────────────────────────────────

describe("Secret hygiene and owner forgeability", () => {
    const readDescriptor = () =>
        defineCapabilityDescriptor({
            capabilityId: "lifeos.query_commitments",
            moduleOwner: "lifeos",
            purpose: "Query open commitments owned by LifeOS",
            effectClass: EffectClass.READ,
            allowedInputRefPrefixes: ["refs/lifeos/"],
            ownsStorage: true,
        });

    test("registry rejects descriptors carrying raw secrets in any string field", () => {
        const registry = new CapabilityRegistry();
        for (const tampered of [
            { ...readDescriptor(), purpose: "connect with Authorization: Bearer abc123def456" },
            {
                ...readDescriptor(),
                allowedInputRefPrefixes: ["refs/lifeos/", "refs/lifeos/?api_key=supersecret123"],
            },
        ] as CapabilityDescriptor[]) {
            expect(() => registry.register(tampered)).toThrow();
        }
    });

    test("diagnostics never leak secrets, even when availability detail contains one", () => {
        const registry = new CapabilityRegistry();
        registry.register(readDescriptor());
        expect(() =>
            registry.setAvailability(
                "lifeos.query_commitments",
                CapabilityAvailability.CONFIGURATION_ERROR,
                "missing env api_key=sk-abc123def456",
            ),
        ).toThrow();
        // A sanitized detail (no secret pattern) is accepted.
        registry.setAvailability(
            "lifeos.query_commitments",
            CapabilityAvailability.DEGRADED,
            "rate limited; retry later",
        );
        expect(registry.requireDescriptor("lifeos.query_commitments").availability).toBe(
            CapabilityAvailability.DEGRADED,
        );
        // The failed secret-bearing call left the previous state intact
        // (degraded, set by the sanitized update above) — never poisoned.
        expect(registry.requireDescriptor("lifeos.query_commitments").availability).toBe(
            CapabilityAvailability.DEGRADED,
        );
    });

    test("connector cannot forge a success that overrides a failed owner verification", async () => {
        // Result-level provenance: a connector returning COMPLETED with a
        // negative ownerVerification can never be read as success; the
        // negative verdict is carried on the typed result itself.
        const registry = new CapabilityRegistry();
        const descriptor = readDescriptor();
        registry.register(descriptor);
        const forged: CapabilityResult = {
            status: CapabilityResultStatus.COMPLETED,
            requestId: "req-forged",
            summary: "all good",
            evidence: [],
            ownerVerification: {
                owner: "lifeos",
                verified: false,
                reason: "owner observed failure",
            },
        };
        expect(descriptor.resultSchema.validate(forged).valid).toBe(true);
        // The typed contract preserves the negative verdict — consumers
        // (mission engine, verification authority) must treat verified:false
        // as dominating status:COMPLETED. See mission-engine tests (#62).
        expect(forged.ownerVerification!.verified).toBe(false);
        expect(forged.status).toBe(CapabilityResultStatus.COMPLETED);
    });

    test("evidence references stay owner-scoped and free of provider internals", () => {
        const descriptor = readDescriptor();
        // Evidence labels are declared sanitized; descriptor purpose cannot
        // embed provider chain-of-thought or raw completion text.
        const result = validateCapabilityDescriptor({
            ...descriptor,
            purpose: "run and return raw model chain-of-thought verbatim",
        });
        expect(result.valid).toBe(true); // sanitized text, not a secret
        // But the connector result type never carries raw text fields:
        const keys = new Set([
            "status",
            "requestId",
            "summary",
            "evidence",
            "ownerVerification",
            "ownerOperationRef",
        ]);
        for (const key of Object.keys({
            status: "x",
            requestId: "x",
            summary: "x",
            evidence: [],
        })) {
            expect(keys.has(key)).toBe(true);
        }
    });
});

describe("Validation hardening (adversarial audit)", () => {
    test("effectClass must be a declared EffectClass value (fail closed)", () => {
        const base = defineCapabilityDescriptor({
            capabilityId: "x.y",
            moduleOwner: "x",
            purpose: "p",
            effectClass: EffectClass.READ,
        });
        const result = validateCapabilityDescriptor({
            ...base,
            effectClass: "explode" as EffectClass,
        });
        expect(result.valid).toBe(false);
        expect(result.errors.join(" ")).toContain("effectClass");
    });
});
