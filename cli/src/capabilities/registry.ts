/**
 * 🗂️ Capability Registry (Issue #63)
 *
 * Deterministic, provider-independent registry of versioned capability
 * descriptors. Satisfies the #62 `CapabilityResolver` interface so the
 * existing deterministic policy consumes it unchanged.
 *
 * Responsibilities (ONLY these):
 *  - register/replace/resolve versioned descriptors;
 *  - expose availability without altering authorization-relevant identity;
 *  - bind connectors to descriptors (version-checked);
 *  - expose a sanitized, secret-free view for discovery/diagnostics.
 *
 * NOT a responsibility of the registry:
 *  - authorization (that is `PlanPolicyValidator`);
 *  - dispatch/scheduling (that is #50);
 *  - dynamic code/plugin installation (never supported).
 *
 * Duplicate/conflicting registration is an explicit, tested contract:
 * `DuplicateCapabilityError` (no silent overwrite, no best-effort fallback).
 */

import { CONNECTOR_CONTRACT_VERSION, validateCapabilityDescriptor } from "./contracts.js";
import type { CapabilityDescriptor } from "./contracts.js";
import { containsRawSecret } from "../mission/sanitize.js";
import type { CapabilityContract } from "../mission/contracts.js";
import type { CapabilityResolver } from "../mission/ports.js";

/** A capability id was registered twice with conflicting definitions. */
export class DuplicateCapabilityError extends Error {
    constructor(capabilityId: string) {
        super(`Capability "${capabilityId}" is already registered with a conflicting definition`);
        this.name = "DuplicateCapabilityError";
    }
}

/** A connector was bound to an unknown capability. */
export class UnknownCapabilityError extends Error {
    constructor(capabilityId: string) {
        super(`Capability "${capabilityId}" is not registered`);
        this.name = "UnknownCapabilityError";
    }
}

/** A connector was bound with a mismatched connector contract version. */
export class ConnectorContractVersionError extends Error {
    constructor(capabilityId: string, declared: number, expected: number) {
        super(
            `Connector for "${capabilityId}" declares contract version ${declared}; expected ${expected}`,
        );
        this.name = "ConnectorContractVersionError";
    }
}

/** A registered connector does not match the registered descriptor. */
export class CapabilityContractConflictError extends Error {
    constructor(capabilityId: string, detail: string) {
        super(`Capability "${capabilityId}" has a conflicting contract: ${detail}`);
        this.name = "CapabilityContractConflictError";
    }
}

/**
 * Registry surface for descriptors. Deliberately does NOT extend the
 * resolver interface (which returns authorization-shaped contracts) to
 * avoid confusion between discovery and authorization.
 */
export interface CapabilityRegistryApi {
    register(descriptor: CapabilityDescriptor): void;
    replace(descriptor: CapabilityDescriptor): void;
    requireDescriptor(capabilityId: string): CapabilityDescriptor;
    listDescriptors(): CapabilityDescriptor[];
    setAvailability(capabilityId: string, availability: CapabilityDescriptor["availability"], detail?: string): void;
}

/**
 * Deterministic Capability Registry.
 * Same registration input always yields the same resolution output.
 */
export class CapabilityRegistry implements CapabilityResolver, CapabilityRegistryApi {
    private readonly descriptors = new Map<string, CapabilityDescriptor>();

    /**
     * Defensive deep copy. Descriptors carry authorize-relevant nested
     * structures (`allowedInputRefPrefixes`, retry/idempotency policy) that
     * the #62 policy consumes; a shallow spread would share those objects
     * with every caller of `register`/`resolve`/`requireDescriptor`/
     * `listDescriptors`, letting discovery-side mutation silently change
     * authorization inputs. Functions (the schema `validate` predicates)
     * are copied by reference: they are inert deterministic checks with no
     * observable state, so sharing them cannot leak mutation.
     */
    private cloneDescriptor(descriptor: CapabilityDescriptor): CapabilityDescriptor {
        const clone = (value: unknown): unknown => {
            if (typeof value === "function" || value === null || typeof value !== "object") {
                return value;
            }
            if (Array.isArray(value)) {
                return value.map(clone);
            }
            const out: Record<string, unknown> = {};
            for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
                out[key] = clone(member);
            }
            return out;
        };
        return clone(descriptor) as CapabilityDescriptor;
    }

    /** Authorization-shaped projection consumed by the #62 policy. */
    private toContract(descriptor: CapabilityDescriptor): CapabilityContract {
        return {
            capabilityId: descriptor.capabilityId,
            moduleOwner: descriptor.moduleOwner,
            effectClass: descriptor.effectClass,
            requiresApproval: descriptor.requiresApproval,
            requiresOwnerVerification: descriptor.requiresOwnerVerification,
            allowedInputRefPrefixes: [...descriptor.allowedInputRefPrefixes],
            ownsStorage: descriptor.ownsStorage,
        };
    }

    /** Validate + register. Throws `DuplicateCapabilityError` on conflicts. */
    register(descriptor: CapabilityDescriptor): void {
        this.validateAndCheck(descriptor);
        this.descriptors.set(descriptor.capabilityId, this.cloneDescriptor(descriptor));
    }

    /**
     * Explicit replacement of an already-registered descriptor. The new
     * definition must itself be valid and, unlike `register`, is allowed to
     * supersede the existing definition (tested contract).
     */
    replace(descriptor: CapabilityDescriptor): void {
        if (!this.descriptors.has(descriptor.capabilityId)) {
            throw new UnknownCapabilityError(descriptor.capabilityId);
        }
        const validation = validateCapabilityDescriptor(descriptor);
        if (!validation.valid) {
            throw new Error(
                `Invalid capability descriptor for "${descriptor.capabilityId}": ${validation.errors.join("; ")}`,
            );
        }
        this.validateDescriptorOrFailClosed(descriptor);
        this.descriptors.set(descriptor.capabilityId, this.cloneDescriptor(descriptor));
    }

    /** Fail-closed lookup used by dispatch-time gates. */
    requireDescriptor(capabilityId: string): CapabilityDescriptor {
        const descriptor = this.descriptors.get(capabilityId);
        if (!descriptor) {
            throw new UnknownCapabilityError(capabilityId);
        }
        return this.cloneDescriptor(descriptor);
    }

    /** #62 resolver API: null when unknown (discovery != authorization). */
    async resolve(capabilityId: string): Promise<CapabilityContract | null> {
        const descriptor = this.descriptors.get(capabilityId);
        return descriptor ? this.toContract(descriptor) : null;
    }

    /** #62 resolver API: list registered capability ids (sorted, deterministic). */
    async listRegistered(): Promise<string[]> {
        return [...this.descriptors.keys()].sort();
    }

    /** List full descriptors (discovery surface). */
    listDescriptors(): CapabilityDescriptor[] {
        return [...this.descriptors.values()]
            .map((d) => this.cloneDescriptor(d))
            .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
    }

    /**
     * Update availability. Availability is discovery state: it never
     * mutates authorization-relevant identity fields (owner, effect class,
     * ref prefixes, approval requirements).
     */
    setAvailability(
        capabilityId: string,
        availability: CapabilityDescriptor["availability"],
        detail?: string,
    ): void {
        const current = this.requireDescriptor(capabilityId);
        if (detail !== undefined && containsRawSecret(detail)) {
            throw new Error(`availability detail for "${capabilityId}" must not contain a raw secret`);
        }
        this.descriptors.set(capabilityId, { ...current, availability, availabilityDetail: detail });
    }

    /** Sanitized view for diagnostics — secret-free by construction. */
    describeForDiagnostics(capabilityId: string): {
        capabilityId: string;
        moduleOwner: string;
        contractVersion: number;
        availability: CapabilityDescriptor["availability"];
        effectClass: CapabilityDescriptor["effectClass"];
    } {
        const d = this.requireDescriptor(capabilityId);
        return {
            capabilityId: d.capabilityId,
            moduleOwner: d.moduleOwner,
            contractVersion: d.contractVersion,
            availability: d.availability,
            effectClass: d.effectClass,
        };
    }

    private validateDescriptorOrFailClosed(descriptor: CapabilityDescriptor): void {
        const validation = validateCapabilityDescriptor(descriptor);
        if (!validation.valid) {
            throw new Error(`Invalid capability descriptor: ${validation.errors.join("; ")}`);
        }
    }

    private validateAndCheck(descriptor: CapabilityDescriptor): void {
        this.validateDescriptorOrFailClosed(descriptor);
        if (this.descriptors.has(descriptor.capabilityId)) {
            throw new DuplicateCapabilityError(descriptor.capabilityId);
        }
    }
}

/** Thin, deterministic function registry for connector binding checks. */
interface ConnectorBinding {
    connectorContractVersion: number;
    describe(): CapabilityDescriptor;
}

/**
 * Connector binding helper used by registration-time gates. Accepts a
 * `CapabilityConnector` (or any binding exposing `connectorContractVersion`
 * + `describe()`). Version is checked BEFORE any `describe()` call, so a
 * mismatched connector never reaches descriptor processing.
 *
 * With two arguments, the connector's `describe()` output must also match
 * the registered descriptor exactly (deep equality) — discovery never
 * silently diverges from what was registered.
 */
export function assertConnectorMatchesDescriptor(
    connector: ConnectorBinding,
    expectedDescriptor?: CapabilityDescriptor,
    expectedVersion: number = CONNECTOR_CONTRACT_VERSION,
): void {
    const version =
        typeof connector?.connectorContractVersion === "number"
            ? connector.connectorContractVersion
            : Number.NaN;
    if (version !== expectedVersion) {
        throw new ConnectorContractVersionError(
            typeof connector?.describe === "function"
                ? connector.describe().capabilityId
                : "<unavailable: version mismatch>",
            version,
            expectedVersion,
        );
    }
    if (typeof connector.describe !== "function") {
        throw new CapabilityContractConflictError(
            "<unnamed connector>",
            "connector must implement describe()",
        );
    }
    const described = connector.describe();
    const validation = validateCapabilityDescriptor(described);
    if (!validation.valid) {
        throw new CapabilityContractConflictError(
            described.capabilityId,
            validation.errors.join("; "),
        );
    }
    if (expectedDescriptor !== undefined && JSON.stringify(described) !== JSON.stringify(expectedDescriptor)) {
        throw new CapabilityContractConflictError(
            described.capabilityId,
            "connector describe() output does not match the registered descriptor",
        );
    }
}
