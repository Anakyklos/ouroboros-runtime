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
import type { CapabilityConnector } from "./connector.js";
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
 * replace() attempted to change contract/owner identity. Registration
 * identity is immutable for the registration lifetime: there is NO consent
 * path, no boolean-and-reason escape hatch. Owner/effect/schema migration
 * requires a NEW versioned registration plus explicit policy work.
 */
export class DescriptorReplacementError extends Error {
    constructor(capabilityId: string, contractChanges: string[]) {
        super(
            `replace() for "${capabilityId}" attempted to change contract/owner fields ` +
                `(${contractChanges.join(", ")}); registration identity is immutable for the ` +
                `registration lifetime — owner/effect/schema migration requires a NEW ` +
                `versioned registration plus explicit policy, never an in-place retarget`,
        );
        this.name = "DescriptorReplacementError";
    }
}

/**
 * Canonical JSON: object keys recursively sorted, stable across processes.
 * Deterministic equality/comparison for data-only descriptors (blocker 4).
 */
export function canonicalJson(value: unknown): string {
    if (value === undefined) return "undefined";
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "undefined";
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Structural difference report between two descriptors (blockers 4 + 5):
 * canonical, key-order-insensitive comparison yielding the differing paths.
 */
export function describeDescriptorDifferences(
    a: CapabilityDescriptor,
    b: CapabilityDescriptor,
): string[] {
    const diffs: string[] = [];
    const walk = (x: unknown, y: unknown, path: string): void => {
        if (canonicalJson(x) === canonicalJson(y)) return;
        if (
            typeof x === "object" &&
            x !== null &&
            !Array.isArray(x) &&
            typeof y === "object" &&
            y !== null &&
            !Array.isArray(y)
        ) {
            const keys = new Set([
                ...Object.keys(x as Record<string, unknown>),
                ...Object.keys(y as Record<string, unknown>),
            ]);
            for (const key of [...keys].sort()) {
                walk(
                    (x as Record<string, unknown>)[key],
                    (y as Record<string, unknown>)[key],
                    path === "" ? key : `${path}.${key}`,
                );
            }
            return;
        }
        diffs.push(path === "" ? "<root>" : path);
    };
    walk(a, b, "");
    return diffs;
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
     * authorization inputs. Descriptors are data-only (blocker 3), so this
     * is a pure structural copy with no code objects to preserve.
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
     * Explicit replacement of an already-registered descriptor.
     *
     * Classification is absolute — there is NO consent escape hatch:
     *  - availability / availabilityDetail are discovery/runtime state and
     *    replace freely (zero authority impact);
     *  - contract/owner identity (moduleOwner, effectClass, approval,
     *    verification, ref prefixes, storage, idempotency/retry policy,
     *    schemas, credentials, characteristics, degradation, purpose,
     *    contractVersion) is IMMUTABLE within a registration lifetime.
     *    Any identity change throws `DescriptorReplacementError`. A local
     *    boolean + free-text reason is not authority: owner/effect/schema/
     *    approval migration requires a NEW identity (versioned
     *    registration) plus explicit policy work in a future issue —
     *    never an in-place retarget of the id everyone authorizes against.
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
        const current = this.descriptors.get(descriptor.capabilityId)!;
        const contractChanges = contractFieldDifferences(current, descriptor);
        if (contractChanges.length > 0) {
            // Fail closed, categorically. No caller-supplied consent can
            // retarget contract/owner identity in place.
            throw new DescriptorReplacementError(descriptor.capabilityId, contractChanges);
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

/**
 * Fields that define WHAT a capability is (contract/owner identity). A
 * `replace()` that changes any of these is a re-registration decision, not a
 * metadata refresh — it must be explicit (blocker 5).
 */
const CONTRACT_IDENTITY_FIELDS: ReadonlyArray<string> = [
    "purpose",
    "contractVersion",
    "moduleOwner",
    "effectClass",
    "requiresApproval",
    "requiresOwnerVerification",
    "allowedInputRefPrefixes",
    "ownsStorage",
    "idempotency",
    "retry",
    "cancellationSupport",
    "reconciliationSupport",
    "expectedEvidence",
    "inputSchema",
    "resultSchema",
    "inputSchemaDescription",
    "resultSchemaDescription",
    "credentialRequirement",
    "characteristics",
    "degradation",
] as const;

/**
 * Canonical, order-insensitive comparison of the contract/owner identity
 * fields between the registered descriptor and a replacement candidate.
 * Returns the differing field paths (empty = no identity change).
 */
function contractFieldDifferences(
    current: CapabilityDescriptor,
    candidate: CapabilityDescriptor,
): string[] {
    const changes: string[] = [];
    for (const field of CONTRACT_IDENTITY_FIELDS) {
        if (canonicalJson((current as unknown as Record<string, unknown>)[field]) !==
            canonicalJson((candidate as unknown as Record<string, unknown>)[field])) {
            changes.push(field);
        }
    }
    return changes;
}

/**
 * Authorization-relevant projection of a descriptor — EXACTLY the shape
 * the #62 policy consumes (same mapping the registry uses for its own
 * resolver surface). Exported so the dispatch seam can prove the policy
 * resolver's contract and the descriptor selecting the connector agree
 * (split-brain guard): one authority source, two convergent views.
 */
export function authorizationProjection(descriptor: CapabilityDescriptor): CapabilityContract {
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

/** Thin, deterministic function registry for connector binding checks. */
interface ConnectorBinding {
    connectorContractVersion: number;
    describe(): CapabilityDescriptor;
}

/**
 * Connector binding gate used at registration/dispatch time (blocker 4).
 *
 * Fail-closed version check FIRST, against the CONNECTOR's own version
 * declaration, and with ZERO calls into connector methods before the check
 * completes: no `describe()`, no `invoke()`, nothing. A hostile or stale
 * connector therefore cannot influence any registry processing, and cannot
 * exfiltrate inputs, before the version gate passes.
 *
 * Only after the version gate passes may `describe()` be called; its output
 * must match the registered descriptor exactly (canonical compare,
 * key-order-insensitive, deep) — discovery never silently diverges from what
 * was registered.
 */
export function assertConnectorMatchesDescriptor(
    connector: CapabilityConnector | ConnectorBinding,
    expectedDescriptor?: CapabilityDescriptor,
    expectedVersion: number = CONNECTOR_CONTRACT_VERSION,
): void {
    // ── Version gate: zero connector method calls happen before this. ──
    // Note the version is read from the connector's own declared property —
    // a plain data read on the adapter handle, not a method invocation.
    const declaredVersion =
        typeof connector?.connectorContractVersion === "number"
            ? connector.connectorContractVersion
            : Number.NaN;
    if (declaredVersion !== expectedVersion) {
        // Deliberately NO describe() call here — capabilityId is unknown and
        // must stay unknown until the connector proves its contract version.
        throw new ConnectorContractVersionError(
            "<withheld until version gate passes>",
            declaredVersion,
            expectedVersion,
        );
    }

    // ── Post-gate: the connector has proven its version; now describe. ──
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
    if (
        expectedDescriptor !== undefined &&
        canonicalJson(described) !== canonicalJson(expectedDescriptor)
    ) {
        throw new CapabilityContractConflictError(
            described.capabilityId,
            `connector describe() output does not match the registered descriptor ` +
                `(differences: ${describeDescriptorDifferences(described, expectedDescriptor).join(", ") || "<root>"})`,
        );
    }
}
