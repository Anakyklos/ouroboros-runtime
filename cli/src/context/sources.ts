/**
 * 🔗 Registry-Bound Context Sources (Issue #64)
 *
 * Produces pre-authorized `CompiledSourceRead`s for the Context Compiler
 * through the #63 Capability Registry boundary.
 *
 * Authority rules encoded HERE:
 *   - Discovery never concedes authorization: availability is honest
 *     discovery state, but every read is gated by the Mission's #62
 *     deterministic policy scope (capability allowlist, effect classes,
 *     ref prefixes) AND the #63 descriptor contract (allowedInputRefPrefixes,
 *     ownsStorage=false, read effect class).
 *   - Revocation/deauthorization is honored: a capability removed from the
 *     Mission scope (or unavailable) degrades honestly — never a fake
 *     success.
 *   - No DB paths, no SQL, no private schemas cross this boundary: only
 *     opaque source refs returned by owner-side adapters.
 *   - One owner's failure never destroys other owners' reads.
 */

import type { CapabilityDescriptor } from "../capabilities/contracts.js";
import { CapabilityAvailability } from "../capabilities/contracts.js";
import { EffectClass } from "../mission/contracts.js";
import type { Mission } from "../mission/contracts.js";
import type { CapabilityRegistryApi } from "../capabilities/registry.js";
import type {
    CompiledSourceRead,
    ContextRequest,
    SensitivityClass,
    UnresolvedSource,
} from "./contracts.js";
import { SourceStatus } from "./contracts.js";
import type { ContextReadOutcome } from "./compiler.js";

/** Explicit convention: context capabilities are named `context:<owner>`. */
export function contextCapabilityIdForOwner(owner: string): string {
    return `context:${owner}`;
}

/** A row an owner-side context adapter may return (opaque, sanitized). */
export interface ContextRow {
    sourceRef: string;
    content: string;
    fetchedAt?: string;
    evidenceRefId?: string;
    sensitivity?: SensitivityClass;
}

/** Owner-side adapter serving an authorized context read (offline in tests). */
export interface ContextCapabilityAdapter {
    capabilityId: string;
    serve(
        request: ContextRequest,
        maxItems: number,
    ):
        | Promise<{ ok: true; rows: ContextRow[] } | { ok: false; status: SourceStatus; detail: string }>
        | { ok: true; rows: ContextRow[] }
        | { ok: false; status: SourceStatus; detail: string };
}

/** ------------------------------------------------------------------ */
/**  Registry-bound reader                                             */
/** ------------------------------------------------------------------ */

/**
 * Deterministic gate order (fail-closed, all BEFORE any adapter call):
 *   1. explicit owner hint present
 *   2. descriptor exists in the #63 registry
 *   3. read-only discipline: ownsStorage=false + EffectClass.READ
 *   4. Mission #62 scope: capability allowlist + READ effect class
 *      (authorization — discovery never concedes it)
 *   5. subject within Mission allowedRefPrefixes AND descriptor prefixes
 *   6. honest availability (unavailable / config error / unsupported)
 *   7. an adapter is registered for the capability
 */
export class RegistryBoundContextReader {
    private readonly registry: CapabilityRegistryApi;
    private readonly adapters = new Map<string, ContextCapabilityAdapter>();

    constructor(deps: { registry: CapabilityRegistryApi }) {
        this.registry = deps.registry;
    }

    /** Register the owner-side adapter behind a context capability. */
    registerAdapter(adapter: ContextCapabilityAdapter): void {
        this.adapters.set(adapter.capabilityId, adapter);
    }

    /**
     * Read all authorized sources implied by the request. Returns a mix
     * of successful `CompiledSourceRead`s and honest `UnresolvedSource`s;
     * one source's failure never affects the others.
     */
    async read(mission: Mission, request: ContextRequest): Promise<ContextReadOutcome[]> {
        const outcomes: ContextReadOutcome[] = [];
        if (!request.ownerHint) {
            return outcomes; // mission-only compilation: no external reads
        }
        const capabilityId = contextCapabilityIdForOwner(request.ownerHint);
        const refusal = this.refusalReason(mission, request, capabilityId);
        if (refusal !== null) {
            outcomes.push(refusal);
            return outcomes;
        }
        const adapter = this.adapters.get(capabilityId)!;
        const descriptor = this.registry.requireDescriptor(capabilityId);
        let result;
        try {
            result = await adapter.serve(request, request.budget.maxItems);
        } catch (error) {
            outcomes.push({
                requestedRef: request.subject,
                owner: descriptor.moduleOwner,
                status: SourceStatus.UNAVAILABLE,
                detail: `adapter threw: ${(error as Error).name}`,
            });
            return outcomes;
        }
        if (!result.ok) {
            outcomes.push({
                requestedRef: request.subject,
                owner: descriptor.moduleOwner,
                status: result.status,
                detail: result.detail,
            });
            return outcomes;
        }
        // Row-level structural validation: a malformed row is skipped
        // honestly, valid sibling rows are kept.
        const rows: CompiledSourceRead["rows"] = [];
        for (const row of result.rows) {
            if (
                typeof row?.sourceRef !== "string" ||
                row.sourceRef.length === 0 ||
                typeof row?.content !== "string"
            ) {
                outcomes.push({
                    requestedRef: String(row?.sourceRef ?? "(missing)"),
                    owner: descriptor.moduleOwner,
                    status: SourceStatus.UNSUPPORTED,
                    detail: "row failed structural validation",
                });
                continue;
            }
            rows.push({
                sourceRef: row.sourceRef,
                content: row.content,
                fetchedAt: row.fetchedAt,
                evidenceRefId: row.evidenceRefId,
                sensitivity: row.sensitivity,
            });
        }
        if (rows.length > 0) {
            outcomes.push({ descriptor, rows });
        }
        return outcomes;
    }

    /** Deterministic refusal mapping; null = the read may proceed. */
    private refusalReason(
        mission: Mission,
        request: ContextRequest,
        capabilityId: string,
    ): UnresolvedSource | null {
        const requestedRef = request.subject;

        // 2. Descriptor exists (fail-closed on unknown capability).
        let descriptor: CapabilityDescriptor;
        try {
            descriptor = this.registry.requireDescriptor(capabilityId);
        } catch {
            return {
                requestedRef,
                owner: request.ownerHint ?? "(unknown)",
                status: SourceStatus.UNSUPPORTED,
                detail: "no such capability in the registry",
            };
        }

        // 3. Read-only context discipline.
        if (descriptor.ownsStorage !== false || descriptor.effectClass !== EffectClass.READ) {
            return {
                requestedRef,
                owner: descriptor.moduleOwner,
                status: SourceStatus.UNSUPPORTED,
                detail: "capability is not a read-only context source",
            };
        }

        // 4. Mission policy scope = authorization (never discovery).
        const scope = mission.allowedCapabilityScope;
        if (!scope.capabilityIds.includes(capabilityId)) {
            return {
                requestedRef,
                owner: descriptor.moduleOwner,
                status: SourceStatus.REVOKED,
                detail: "capability not authorized for this mission",
            };
        }
        if (!scope.allowedEffectClasses.includes(EffectClass.READ)) {
            return {
                requestedRef,
                owner: descriptor.moduleOwner,
                status: SourceStatus.REVOKED,
                detail: "read effect class not authorized for this mission",
            };
        }

        // 5. Ref prefixes (mission scope AND descriptor contract).
        const inMissionScope = scope.allowedRefPrefixes.some((p) => request.subject.startsWith(p));
        const inDescriptorScope = descriptor.allowedInputRefPrefixes.some((p) =>
            request.subject.startsWith(p),
        );
        if (!inMissionScope) {
            return {
                requestedRef,
                owner: descriptor.moduleOwner,
                status: SourceStatus.REVOKED,
                detail: "subject outside mission allowed ref prefixes",
            };
        }
        if (!inDescriptorScope) {
            return {
                requestedRef,
                owner: descriptor.moduleOwner,
                status: SourceStatus.UNSUPPORTED,
                detail: "subject outside capability declared ref prefixes",
            };
        }

        // 6. Honest availability (discovery state, never fake success).
        switch (descriptor.availability) {
            case CapabilityAvailability.UNAVAILABLE:
            case CapabilityAvailability.BUSY:
            case CapabilityAvailability.WAITING_DEPENDENCY:
            case CapabilityAvailability.DEGRADED:
                return {
                    requestedRef,
                    owner: descriptor.moduleOwner,
                    status: SourceStatus.UNAVAILABLE,
                    detail: descriptor.availabilityDetail ?? "capability unavailable",
                };
            case CapabilityAvailability.NEEDS_USER_ACTION:
            case CapabilityAvailability.CONFIGURATION_ERROR:
                return {
                    requestedRef,
                    owner: descriptor.moduleOwner,
                    status: SourceStatus.CONFIGURATION_ERROR,
                    detail: descriptor.availabilityDetail ?? "capability needs configuration",
                };
            case CapabilityAvailability.UNSUPPORTED:
                return {
                    requestedRef,
                    owner: descriptor.moduleOwner,
                    status: SourceStatus.UNSUPPORTED,
                    detail: descriptor.availabilityDetail ?? "capability unsupported",
                };
            case CapabilityAvailability.AVAILABLE:
                break;
        }

        // 7. An adapter must be registered for this capability.
        if (!this.adapters.has(capabilityId)) {
            return {
                requestedRef,
                owner: descriptor.moduleOwner,
                status: SourceStatus.UNSUPPORTED,
                detail: "no context adapter registered for capability",
            };
        }

        return null;
    }
}
