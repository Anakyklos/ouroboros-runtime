/**
 * 📦 Capability Contracts (Issue #63)
 *
 * Versioned, provider-independent descriptor + connector contracts for
 * sovereign Anakyklos modules. Evolves (does not replace) the #62 Mission
 * foundation: a `CapabilityDescriptor` is a strict superset of the
 * `CapabilityContract` the #62 deterministic policy consumes.
 *
 * Core rule (unchanged from #62): **discovery does not concede
 * authorization.** The registry describes/resolves; `PlanPolicyValidator`
 * authorizes; only authorized dispatch reaches a connector.
 *
 * NEVER exposed on this surface: internal tables, private DB paths/schemas,
 * prompt templates, credentials/Authorization (by value), raw provider
 * responses, chain-of-thought, module implementation details.
 */

import type { CapabilityContract } from "../mission/contracts.js";
import { EffectClass } from "../mission/contracts.js";
import { containsRawSecret } from "../mission/sanitize.js";

/** EffectClass re-export: #63 never forks the #62 enum into a parallel one. */
export { EffectClass };

/** Version of the capability descriptor/registry contract. */
export const CAPABILITY_REGISTRY_CONTRACT_VERSION = 1 as const;

/** Version of the connector lifecycle contract. */
export const CONNECTOR_CONTRACT_VERSION = 1 as const;

/** Availability states for a discovered capability (#63 requirement). */
export enum CapabilityAvailability {
    AVAILABLE = "available",
    BUSY = "busy",
    WAITING_DEPENDENCY = "waiting_dependency",
    NEEDS_USER_ACTION = "needs_user_action",
    DEGRADED = "degraded",
    UNAVAILABLE = "unavailable",
    UNSUPPORTED = "unsupported",
    CONFIGURATION_ERROR = "configuration_error",
}

/** Declared idempotency semantics. */
export enum IdempotencyMode {
    /** Re-invoking the same request identity is safe and yields the same effect once. */
    IDEMPOTENT = "idempotent",
    /** Not safe to re-invoke; callers must never replay without explicit reconciliation. */
    NON_IDEMPOTENT = "non_idempotent",
    /** Semantics unknown: treated as non-idempotent by any deterministic policy. */
    UNKNOWN = "unknown",
}

/** Declared retry backoff policy (executed by #50 scheduler, not here). */
export enum RetryBackoff {
    NONE = "none",
    FIXED = "fixed",
    EXPONENTIAL = "exponential",
}

/** Cancellation semantics declared by the capability. */
export enum CancellationSupport {
    /** No cancellation once dispatched. */
    NONE = "none",
    /** The owner accepts a cancel call and confirms asynchronously. */
    COOPERATIVE = "cooperative",
    /** Cancellation is guaranteed before the effect commits. */
    HARD = "hard",
    /** Cancellation is not supported by this capability/version. */
    UNSUPPORTED = "unsupported",
}

/** Reconciliation semantics after disconnect/restart. */
export enum ReconciliationSupport {
    /** The owner cannot be queried about past invocations. */
    NONE = "none",
    /** The owner returns authoritative status for a request id. */
    STATUS_REPLAY = "status_replay",
    /** The owner replays status plus result/evidence references. */
    FULL_REPLAY = "full_replay",
}

/** How the owner's verification verdict reaches the Mission boundary. */
export type OwnerVerificationMode = "module_owner" | "none";

/**
 * Typed schema/validator declaration. Deterministic validation functions,
 * never free-form text and never implementation internals.
 */
export interface TypedSchema<T = unknown> {
    /** Deterministic validator: returns typed errors (empty when valid). */
    validate(value: unknown): { valid: boolean; errors: string[] };
    /** Sanitized, human-readable description of the expected shape. */
    description: string;
    /** Phantom marker so different schemas stay structurally distinct. */
    readonly __type?: T;
}

/** Credential/auth requirement: by reference or metadata — never a raw secret. */
export interface CredentialRequirement {
    kind: "reference" | "metadata";
    /** Opaque pointer to credentials held by the owner or a secret store. */
    credentialRef?: string;
    /** Sanitized, non-secret metadata (e.g. "auth: oauth2", "scope: repo"). */
    metadata?: string;
}

/**
 * Versioned Capability Descriptor — the public declaration of a sovereign
 * module capability. Superset of the #62 `CapabilityContract` (which the
 * policy consumes); the extra fields are never read by authorization.
 */
export interface CapabilityDescriptor extends CapabilityContract {
    capabilityId: string;
    moduleOwner: string;
    /** Contract version of this descriptor schema. */
    contractVersion: number;
    /** Sanitized, human-readable purpose. */
    purpose: string;
    effectClass: EffectClass;
    requiresApproval: boolean;
    requiresOwnerVerification: boolean;
    allowedInputRefPrefixes: string[];
    ownsStorage: boolean;

    /** Current availability of the capability (discovery-only state). */
    availability: CapabilityAvailability;
    /** Optional sanitized detail (e.g. "module offline"). */
    availabilityDetail?: string;

    /** Declared idempotency/retry/cancellation/reconciliation semantics. */
    idempotency: { mode: IdempotencyMode; keyScope: "request" | "effect" | "none" };
    retry: { maxAttempts: number; backoff: RetryBackoff };
    cancellationSupport: CancellationSupport;
    reconciliationSupport: ReconciliationSupport;

    /** How owner verification verdicts are produced for this capability. */
    expectedEvidence: { ownerVerification: OwnerVerificationMode };

    /** Typed input validator declared by the owner. */
    inputSchema: TypedSchema;
    /** Typed result validator declared by the owner. */
    resultSchema: TypedSchema;

    /** Credential/auth requirement (reference/metadata only). */
    credentialRequirement?: CredentialRequirement;

    /**
     * Resource/network characteristics, only when material to authorization
     * or scheduling decisions. Free of secrets; sanitized at registration.
     */
    characteristics?: {
        network?: boolean;
        longRunning?: boolean;
        estimatedDurationMs?: number;
        resourceIntensity?: "low" | "medium" | "high";
    };

    /** Degradation/unsupported semantics (sanitized, declarative). */
    degradation?: {
        /** What happens when the capability is degraded (declared, not free-form). */
        behavior: "reject" | "queue" | "degraded_result";
        /** Sanitized note about unsupported semantics. */
        unsupportedSemantics?: string;
    };
}

/** Deterministic validation result for descriptors. */
export interface DescriptorValidation {
    valid: boolean;
    errors: string[];
}

/**
 * Validate a `CapabilityDescriptor` fail-closed:
 * version, identity, sanitized purpose, secret-free strings and declared
 * semantics are all checked. Registry rejects invalid descriptors.
 */
export function validateCapabilityDescriptor(
    descriptor: CapabilityDescriptor,
): DescriptorValidation {
    const errors: string[] = [];

    if (descriptor.contractVersion !== CAPABILITY_REGISTRY_CONTRACT_VERSION) {
        errors.push(
            `unsupported contract version ${descriptor.contractVersion} (expected ${CAPABILITY_REGISTRY_CONTRACT_VERSION})`,
        );
    }
    if (typeof descriptor.capabilityId !== "string" || descriptor.capabilityId.trim() === "") {
        errors.push("capabilityId is required");
    }
    if (typeof descriptor.moduleOwner !== "string" || descriptor.moduleOwner.trim() === "") {
        errors.push("moduleOwner is required");
    }
    if (typeof descriptor.purpose !== "string" || descriptor.purpose.trim() === "") {
        errors.push("purpose is required");
    }
    if (!Array.isArray(descriptor.allowedInputRefPrefixes)) {
        errors.push("allowedInputRefPrefixes must be an array");
    }
    if (
        !descriptor.availability ||
        !Object.values(CapabilityAvailability).includes(descriptor.availability)
    ) {
        errors.push(`availability "${String(descriptor.availability)}" is not a declared state`);
    }
    if (
        !descriptor.idempotency ||
        !Object.values(IdempotencyMode).includes(descriptor.idempotency.mode)
    ) {
        errors.push("idempotency.mode must be a declared IdempotencyMode");
    }
    if (
        !descriptor.retry ||
        !Number.isInteger(descriptor.retry.maxAttempts) ||
        descriptor.retry.maxAttempts < 0
    ) {
        errors.push("retry.maxAttempts must be a non-negative integer");
    }
    if (!descriptor.retry || !Object.values(RetryBackoff).includes(descriptor.retry.backoff)) {
        errors.push("retry.backoff must be a declared RetryBackoff");
    }
    if (!Object.values(CancellationSupport).includes(descriptor.cancellationSupport)) {
        errors.push("cancellationSupport must be a declared CancellationSupport");
    }
    if (!Object.values(ReconciliationSupport).includes(descriptor.reconciliationSupport)) {
        errors.push("reconciliationSupport must be a declared ReconciliationSupport");
    }
    if (
        descriptor.expectedEvidence?.ownerVerification !== "module_owner" &&
        descriptor.expectedEvidence?.ownerVerification !== "none"
    ) {
        errors.push("expectedEvidence.ownerVerification must be 'module_owner' or 'none'");
    }
    if (
        !descriptor.inputSchema ||
        typeof descriptor.inputSchema.validate !== "function"
    ) {
        errors.push("inputSchema must declare a typed validator");
    }
    if (
        !descriptor.resultSchema ||
        typeof descriptor.resultSchema.validate !== "function"
    ) {
        errors.push("resultSchema must declare a typed validator");
    }

    // Secret hygiene: any declared string field carrying a raw secret fails
    // closed. Uses the same deterministic detectors as the Mission sanitizer.
    const stringFields: Array<[string, string | undefined]> = [
        ["purpose", descriptor.purpose],
        ["availabilityDetail", descriptor.availabilityDetail],
        [
            "credentialRequirement.credentialRef",
            descriptor.credentialRequirement?.credentialRef,
        ],
        ["credentialRequirement.metadata", descriptor.credentialRequirement?.metadata],
        ["degradation.unsupportedSemantics", descriptor.degradation?.unsupportedSemantics],
    ];
    for (const [field, value] of stringFields) {
        if (value !== undefined && containsRawSecret(value)) {
            errors.push(`${field} must not contain a raw secret`);
        }
    }

    return { valid: errors.length === 0, errors };
}
