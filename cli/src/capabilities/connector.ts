/**
 * 🔌 Connector Contract (Issue #63)
 *
 * Small, versioned lifecycle the Ouroboros side may exercise against a
 * capability owner, via an adapter. Transport (HTTP/MCP/IPC/subprocess/
 * local process) is a detail of the adapter — this contract never forces
 * one. MCP, when used, is an optional transport behind this contract.
 *
 * Lifecycle (per capability, as declared by its descriptor):
 *  - describe()        → the current CapabilityDescriptor
 *  - invoke(request)   → typed CapabilityResult (never raw provider text)
 *  - observeStatus()   → current owner status (when supported)
 *  - cancel(requestId) → when cancellationSupport != NONE/UNSUPPORTED
 *  - reconcile(requestId) → after disconnect/restart, when supported
 *
 * The connector NEVER receives Mission authority. It is only reachable
 * after `PlanPolicyValidator` authorization (thin dispatch seam).
 */

import type { CapabilityDescriptor } from "./contracts.js";
import { CONNECTOR_CONTRACT_VERSION } from "./contracts.js";

/** Typed, sanitized input passed to an authorized connector invocation. */
export interface ConnectorRequest {
    /** Stable request identity (idempotency key scope from the descriptor). */
    requestId: string;
    /** Authorized input references (e.g. "refs/lifeos/journal/entry-1"). */
    inputRefs: string[];
    /** Declarative, sanitized outcome the invocation should realize. */
    desiredOutcome: string;
}

/** How the owner reports completion of an invocation. */
export enum CapabilityResultStatus {
    COMPLETED = "completed",
    FAILED = "failed",
    STILL_RUNNING = "still_running",
    UNKNOWN = "unknown",
}

/** Owner verification verdict attached to a typed result. */
export interface OwnerVerificationOutcome {
    owner: string;
    verified: boolean | null;
    /** Sanitized, event/evidence-based reason (never CoT). */
    reason: string;
}

/** Evidence/result reference produced by the owner (opaque, sanitized). */
export interface EvidenceReference {
    owner: string;
    externalRef: string;
    label: string;
}

/**
 * Typed result of a connector invocation. Raw provider responses, secrets,
 * prompts and chain-of-thought never appear here.
 */
export interface CapabilityResult {
    status: CapabilityResultStatus;
    /** Stable id of the executed request (echoed for reconciliation). */
    requestId: string;
    /** Sanitized, declarative summary (no raw provider text). */
    summary: string;
    /** Typed evidence/result references owned by the module. */
    evidence: EvidenceReference[];
    /** Owner/domain verification outcome (may be unknown/pending). */
    ownerVerification?: OwnerVerificationOutcome;
    /** For long-running capabilities: opaque owner handle for status. */
    ownerOperationRef?: string;
}

/** Versioned connector lifecycle. */
export interface CapabilityConnector {
    /** Connector contract version implemented by this adapter. */
    readonly connectorContractVersion: number;
    /** The capability this connector serves (must match registration). */
    readonly capabilityId: string;
    /** Describe/discover: the current descriptor. */
    describe(): CapabilityDescriptor;
    /** Authorized invocation — reachable only via the dispatch seam. */
    invoke(request: ConnectorRequest): Promise<CapabilityResult>;
    /** Observe/status of a prior invocation (long-running). */
    observeStatus?(ownerOperationRef: string): Promise<CapabilityResult | null>;
    /** Cancel a running invocation (when declared supported). */
    cancel?(ownerOperationRef: string): Promise<CapabilityResult>;
    /** Reconcile after disconnect/restart (when declared supported). */
    reconcile?(requestId: string): Promise<CapabilityResult | null>;
}

/** Re-export for convenience of adapter authors. */
export { CONNECTOR_CONTRACT_VERSION as CONNECTOR_CONTRACT_VERSION_1 };
export type { CapabilityDescriptor };
