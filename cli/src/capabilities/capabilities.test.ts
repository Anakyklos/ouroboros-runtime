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
