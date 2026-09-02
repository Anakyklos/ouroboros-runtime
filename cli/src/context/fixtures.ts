/**
 * 🧪 Deterministic Context Compiler Fixtures (Issue #64)
 *
 * Synthetic, offline, provider-free missions, descriptors and lifecycle
 * connectors used to prove the #64 contracts without LifeOS/Tecer/
 * Runstead/Katherine or any external service. Contract fixtures — NOT
 * production modules. All strings are benign by construction; secret-
 * pattern rows are explicit test inputs for the fail-closed path.
 *
 * Since the #74 review, external content flows ONLY through the #63
 * dispatch seam: fixtures provide full `CapabilityConnector` lifecycle
 * adapters (registered via `ConnectorDispatchSeam.registerConnector`),
 * never a parallel serve() path.
 */

import type { Mission } from "../mission/contracts.js";
import {
    EffectClass,
    MISSION_CONTRACT_VERSION,
    MissionState,
} from "../mission/contracts.js";
import type { CapabilityContract } from "../mission/contracts.js";
import {
    CapabilityAvailability,
    type CapabilityDescriptor,
} from "../capabilities/contracts.js";
import { EffectClass as CapabilityEffectClass } from "../capabilities/contracts.js";
import { defineCapabilityDescriptor } from "../capabilities/fixtures.js";
import type {
    CapabilityConnector,
    CapabilityResult,
    ConnectorRequest,
} from "../capabilities/connector.js";
import { CapabilityResultStatus } from "../capabilities/connector.js";
import type { ContextRequest } from "./contracts.js";
import { EpistemicClass, SensitivityClass, SourceStatus } from "./contracts.js";
import { CONTEXT_COMPILER_CONTRACT_VERSION } from "./contracts.js";
import type { ContextRow } from "./contracts.js";

/** Deterministic pinned instant for every fixture timeline. */
export const FIXTURE_NOW = "2026-08-30T12:00:00.000Z";

/** Deterministic mission factory (mirrors the #62 Mission contract). */
export function makeContextMission(overrides: Partial<Mission> = {}): Mission {
    const now = FIXTURE_NOW;
    return {
        missionId: "mission-ctx-1",
        schemaVersion: MISSION_CONTRACT_VERSION,
        source: "cli",
        originalIntent: "Prepare the weekly review from my journal summaries",
        sanitizedOriginalIntent: "Prepare the weekly review from my journal summaries",
        originalIntentRef: "0".repeat(64),
        interpretedObjective: "Prepare the weekly review from my journal summaries",
        constraints: ["No destructive effects"],
        acceptanceCriteria: ["Review drafted from authorized sources"],
        budgetPolicy: {},
        allowedCapabilityScope: {
            capabilityIds: [
                "context:lifeos",
                "context:tecer",
                "storage.read-local",
            ],
            allowedEffectClasses: [EffectClass.READ],
            allowedRefPrefixes: ["refs/lifeos/", "refs/tecer/", "refs/ouroboros/"],
        },
        approvalRequirements: [],
        contextRefs: [],
        state: MissionState.CREATED,
        currentPlanRevisionId: null,
        invocationRefs: [],
        evidenceRefs: [],
        criterionVerifications: [],
        unresolvedQuestions: [],
        createdAt: now,
        updatedAt: now,
        recoveryMetadata: { recovered: false, recoveryCount: 0 },
        ...overrides,
    };
}

/** Deterministic request factory (explicit budget — deny-before-compile). */
export function makeContextRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
    return {
        subject: "refs/lifeos/journal/2026-08",
        purpose: "weekly review compilation",
        missionId: "mission-ctx-1",
        budget: {
            maxItems: 12,
            maxTotalChars: 8000,
            maxEstimatedTokens: 2000,
        },
        ...overrides,
    };
}

/** Read-only context descriptor for an owner (`context:<owner>`). */
export function makeContextDescriptor(
    owner: string,
    overrides: Partial<CapabilityDescriptor> = {},
): CapabilityDescriptor {
    return defineCapabilityDescriptor({
        capabilityId: `context:${owner}`,
        moduleOwner: owner,
        purpose: `Authorized context reads for ${owner} (read-only, reference-only)`,
        effectClass: CapabilityEffectClass.READ,
        allowedInputRefPrefixes: [`refs/${owner}/`],
        // Real-world owners (LifeOS/Tecer) legitimately read their OWN
        // storage through their capabilities (review blocker 2). The
        // context boundary still never sees a DB path/schema.
        ownsStorage: true,
        ...overrides,
    });
}

/**
 * The matching #62 policy contract for a context descriptor — registered
 * in the FakeCapabilityResolver so the seam's split-brain guard sees ONE
 * consistent authority source (same trick as the #63 seam tests).
 */
export function makeContextContract(descriptor: CapabilityDescriptor): CapabilityContract {
    return {
        capabilityId: descriptor.capabilityId,
        moduleOwner: descriptor.moduleOwner,
        effectClass: descriptor.effectClass,
        requiresApproval: descriptor.requiresApproval,
        requiresOwnerVerification: descriptor.requiresOwnerVerification,
        allowedInputRefPrefixes: descriptor.allowedInputRefPrefixes,
        ownsStorage: descriptor.ownsStorage,
        factRowsOnly: descriptor.factRowsOnly,
    };
}

/** Rows an owner-side connector serves (deterministic, offline). */
export function journalRows(): ContextRow[] {
    return [
        {
            sourceRef: "refs/lifeos/journal/2026-08-30",
            content: "Morning pages: steady sleep, good focus block on the runtime contract.",
            epistemicClass: EpistemicClass.FACT,
            fetchedAt: "2026-08-30T09:00:00.000Z",
            sensitivity: SensitivityClass.NORMAL,
        },
        {
            sourceRef: "refs/lifeos/journal/2026-08-29",
            content: "Reflected on capability boundaries; decided provenance must be first-class.",
            epistemicClass: EpistemicClass.FACT,
            fetchedAt: "2026-08-29T09:00:00.000Z",
            sensitivity: SensitivityClass.NORMAL,
        },
        {
            sourceRef: "refs/lifeos/journal/2026-08-28",
            content: "Planned the week: fewer meetings, one deep-work day.",
            epistemicClass: EpistemicClass.FACT,
            fetchedAt: "2026-08-28T09:00:00.000Z",
            sensitivity: SensitivityClass.NORMAL,
        },
    ];
}

/** Base context connector state shared by the fixture factories. */
export interface ConnectorFixtureOptions {
    /** Rows served on a COMPLETED invocation (when not failing). */
    rows: ContextRow[];
    /** Force a non-completed honest result (failed / still_running). */
    status?: CapabilityResultStatus;
    /** Force the connector to THROW (seam preserves UNCERTAIN/BLOCKED). */
    throws?: boolean;
    /** Attach a POSITIVE owner verdict (sets requiresOwnerVerification). */
    withOwnerVerification?: boolean;
}

/**
 * Full lifecycle connector over a fixed row list. Registered via
 * `seam.registerConnector(...)` — the ONLY dispatch path (review blocker 1).
 */
export function makeContextConnector(
    descriptor: CapabilityDescriptor,
    options: ConnectorFixtureOptions,
): CapabilityConnector {
    return {
        connectorContractVersion: 1,
        capabilityId: descriptor.capabilityId,
        describe: () => descriptor,
        invoke: async (request: ConnectorRequest): Promise<CapabilityResult> => {
            if (options.throws) {
                throw new Error("connector offline");
            }
            const status = options.status ?? CapabilityResultStatus.COMPLETED;
            return {
                status,
                requestId: request.requestId,
                summary: `context rows for ${request.requestId}`,
                contextRows: status === CapabilityResultStatus.COMPLETED ? options.rows : [],
                evidence: [
                    {
                        owner: descriptor.moduleOwner,
                        externalRef: `refs/${descriptor.moduleOwner}/read/${request.requestId}`,
                        label: "context read",
                    },
                ],
                ...(options.withOwnerVerification
                    ? {
                          ownerVerification: {
                              owner: descriptor.moduleOwner,
                              verified: true,
                              reason: "verified by fixture owner",
                          },
                      }
                    : {}),
            };
        },
    };
}

/** Connector that returns rows MISSING the epistemic classification. */
export function makeUnclassifiedRowsConnector(
    descriptor: CapabilityDescriptor,
    rows: Array<Omit<ContextRow, "epistemicClass">>,
): CapabilityConnector {
    return {
        connectorContractVersion: 1,
        capabilityId: descriptor.capabilityId,
        describe: () => descriptor,
        invoke: async (request: ConnectorRequest): Promise<CapabilityResult> => ({
            status: CapabilityResultStatus.COMPLETED,
            requestId: request.requestId,
            summary: `unclassified rows for ${request.requestId}`,
            contextRows: rows,
            evidence: [],
        }),
    };
}

/** Deterministic clock pinned to the fixture timeline. */
export function fixedClock(iso: string = FIXTURE_NOW): () => Date {
    return () => new Date(iso);
}

/** Freshness helper for tests: rows fetched 3h before the clock. */
export const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

export { CapabilityAvailability, CapabilityResultStatus, CONTEXT_COMPILER_CONTRACT_VERSION, SourceStatus, SensitivityClass };
