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
    /** Sanitized input shape description. */
    inputSchemaDescription?: string;
    /** Sanitized result shape description. */
    resultSchemaDescription?: string;
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
        availabilityDetail: input.availabilityDetail,
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
        inputSchemaDescription:
            input.inputSchemaDescription ??
            "ConnectorRequest: requestId + authorized inputRefs + declarative outcome",
        resultSchemaDescription:
            input.resultSchemaDescription ??
            "CapabilityResult: typed status + evidence refs, no raw provider text",
        inputSchema: input.inputSchema ?? {
            kind: "declarative",
            fields: [
                { path: "requestId", types: ["string"], minLength: 1 },
                { path: "inputRefs", types: ["array"] },
            ],
        },
        resultSchema: input.resultSchema ?? {
            kind: "declarative",
            fields: [
                // Everything the seam consumes after invoke() is required by
                // the default schema: a result missing any of these is
                // rejected BEFORE the seam touches it (hostile adapter:
                // null/primitive/missing requestId — round 3, blocker 1;
                // malformed EVIDENCE ITEMS — round 4, blocker 1).
                { path: "status", types: ["string"] },
                { path: "requestId", types: ["string"], minLength: 1 },
                { path: "summary", types: ["string"] },
                {
                    path: "evidence",
                    types: ["array"],
                    items: [
                        // Each evidence item must carry every field the seam
                        // dereferences in evidenceRefsOf() — a shape-less
                        // `[null]`/`[42]`/partial-item array is rejected at
                        // the gate, never post-handoff (round 4, blocker 1).
                        { path: "owner", types: ["string"], minLength: 1 },
                        { path: "externalRef", types: ["string"], minLength: 1 },
                        { path: "label", types: ["string"] },
                    ],
                },
                {
                    // ownerVerification is OPTIONAL (a result may carry no
                    // verdict), but when PRESENT it must be structurally
                    // valid before the seam consumes any field of it —
                    // verified must be exactly boolean|null, owner a
                    // non-empty string, reason a string (round 5).
                    path: "ownerVerification",
                    types: ["object"],
                    optional: true,
                    items: [
                        { path: "owner", types: ["string"], minLength: 1 },
                        { path: "verified", types: ["boolean", "null"] },
                        { path: "reason", types: ["string"] },
                    ],
                },
            ],
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
