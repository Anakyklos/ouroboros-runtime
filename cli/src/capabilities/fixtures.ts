/**
 * 🧩 Synthetic Capability Fixtures (Issue #63)
 *
 * Deterministic, offline, provider-free descriptors + connectors used to
 * prove the #63 contracts without Runstead/LifeOS/Tecer/Mouse Hub or any
 * external service. These are contract fixtures — NOT production modules.
 *
 * Fixtures (per #63):
 *  1. read-only domain capability;
 *  2. write capability requiring approval;
 *  3. long-running capability with status + reconnect/reconcile;
 *  4. unavailable capability;
 *  5. capability whose owner verification FAILS (never fabricated success).
 */

import {
    CapabilityAvailability,
    CancellationSupport,
    EffectClass,
    IdempotencyMode,
    ReconciliationSupport,
    RetryBackoff,
    validateCapabilityDescriptor,
    type CapabilityDescriptor,
} from "./contracts.js";
import type { ConnectorContractVersion } from "./connector.js";

/** Deterministic descriptor factory with full declared semantics. */
export function defineCapabilityDescriptor(input: {
    capabilityId: string;
    moduleOwner: string;
    purpose: string;
    effectClass: EffectClass;
    availability?: CapabilityAvailability;
    availabilityDetail?: string;
    requiresApproval?: boolean;
    requiresOwnerVerification?: boolean;
    allowedInputRefPrefixes?: string[];
    ownsStorage?: boolean;
    idempotency?: CapabilityDescriptor["idempotency"];
    retry?: CapabilityDescriptor["retry"];
    cancellationSupport?: CancellationSupport;
    reconciliationSupport?: ReconciliationSupport;
    credentialRequirement?: CapabilityDescriptor["credentialRequirement"];
    characteristics?: CapabilityDescriptor["characteristics"];
    degradation?: CapabilityDescriptor["degradation"];
    /** Deterministic input validator (defaults to accepting known refs shape). */
    inputSchema?: CapabilityDescriptor["inputSchema"];
    /** Deterministic result validator (defaults to accepting typed results). */
    resultSchema?: CapabilityDescriptor["resultSchema"];
}): CapabilityDescriptor {
    const descriptor: CapabilityDescriptor = {
        capabilityId: input.capabilityId,
        moduleOwner: input.moduleOwner,
        contractVersion: 1,
        purpose: input.purpose,
        effectClass: input.effectClass,
        requiresApproval: input.requiresApproval ?? false,
        requiresOwnerVerification: input.requiresOwnerVerification ?? false,
        allowedInputRefPrefixes: input.allowedInputRefPrefixes ?? [],
        ownsStorage: input.ownsStorage ?? false,
        availability: input.availability ?? CapabilityAvailability.AVAILABLE,
        idempotency: input.idempotency ?? {
            mode: IdempotencyMode.IDEMPOTENT,
            keyScope: "request",
        },
        retry: input.retry ?? { maxAttempts: 0, backoff: RetryBackoff.NONE },
        cancellationSupport: input.cancellationSupport ?? CancellationSupport.NONE,
        reconciliationSupport: input.reconciliationSupport ?? ReconciliationSupport.NONE,
        expectedEvidence: {
            ownerVerification: input.requiresOwnerVerification ? "module_owner" : "none",
        },
        inputSchema: input.inputSchema ?? {
            description: "ConnectorRequest: requestId + authorized inputRefs + declarative outcome",
            validate(value: unknown): { valid: boolean; errors: string[] } {
                const req = value as { requestId?: unknown; inputRefs?: unknown };
                const errors: string[] = [];
                if (typeof req.requestId !== "string" || req.requestId.trim() === "") {
                    errors.push("requestId is required");
                }
                if (!Array.isArray(req.inputRefs)) {
                    errors.push("inputRefs must be an array");
                }
                return { valid: errors.length === 0, errors };
            },
        },
        resultSchema: input.resultSchema ?? {
            description: "CapabilityResult: typed status + evidence refs, no raw provider text",
            validate(value: unknown): { valid: boolean; errors: string[] } {
                const res = value as { status?: unknown; evidence?: unknown };
                const errors: string[] = [];
                if (typeof res.status !== "string") {
                    errors.push("status is required");
                }
                if (!Array.isArray(res.evidence)) {
                    errors.push("evidence must be an array");
                }
                return { valid: errors.length === 0, errors };
            },
        },
        credentialRequirement: input.credentialRequirement,
        characteristics: input.characteristics,
        degradation: input.degradation,
    };
    const validation = validateCapabilityDescriptor(descriptor);
    if (!validation.valid) {
        throw new Error(`Invalid descriptor: ${validation.errors.join("; ")}`);
    }
    return descriptor;
}
