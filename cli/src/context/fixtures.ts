/**
 * 🧪 Deterministic Context Compiler Fixtures (Issue #64)
 *
 * Synthetic, offline, provider-free missions, descriptors and adapters used
 * to prove the #64 contracts without LifeOS/Tecer/Runstead/Katherine or any
 * external service. Contract fixtures — NOT production modules. All strings
 * are benign by construction; secret-pattern rows are explicit test inputs
 * for the fail-closed path.
 */

import type { Mission } from "../mission/contracts.js";
import {
    EffectClass,
    MISSION_CONTRACT_VERSION,
    MissionState,
} from "../mission/contracts.js";
import { CapabilityAvailability } from "../capabilities/contracts.js";
import { EffectClass as CapabilityEffectClass } from "../capabilities/contracts.js";
import { defineCapabilityDescriptor } from "../capabilities/fixtures.js";
import type { CapabilityDescriptor } from "../capabilities/contracts.js";
import type { ContextRequest } from "./contracts.js";
import { SensitivityClass, SourceStatus } from "./contracts.js";
import { CONTEXT_COMPILER_CONTRACT_VERSION } from "./contracts.js";
import type { ContextCapabilityAdapter, ContextRow } from "./sources.js";

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
        ownsStorage: false,
        ...overrides,
    });
}

/** Rows an owner-side adapter serves (deterministic, offline). */
export function journalRows(): ContextRow[] {
    return [
        {
            sourceRef: "refs/lifeos/journal/2026-08-30",
            content: "Morning pages: steady sleep, good focus block on the runtime contract.",
            fetchedAt: "2026-08-30T09:00:00.000Z",
            sensitivity: SensitivityClass.NORMAL,
        },
        {
            sourceRef: "refs/lifeos/journal/2026-08-29",
            content: "Reflected on capability boundaries; decided provenance must be first-class.",
            fetchedAt: "2026-08-29T09:00:00.000Z",
            sensitivity: SensitivityClass.NORMAL,
        },
        {
            sourceRef: "refs/lifeos/journal/2026-08-28",
            content: "Planned the week: fewer meetings, one deep-work day.",
            fetchedAt: "2026-08-28T09:00:00.000Z",
            sensitivity: SensitivityClass.NORMAL,
        },
    ];
}

/** Owner-side adapter backed by a fixed row list. */
export function makeStaticAdapter(
    capabilityId: string,
    rows: ContextRow[],
    overrides: Partial<{ status: SourceStatus; detail: string }> = {},
): ContextCapabilityAdapter {
    return {
        capabilityId,
        serve: async () => {
            if (overrides.status !== undefined) {
                return {
                    ok: false as const,
                    status: overrides.status,
                    detail: overrides.detail ?? "unavailable",
                };
            }
            return { ok: true as const, rows };
        },
    };
}

/** Adapter that throws (honest degradation path). */
export function makeThrowingAdapter(capabilityId: string): ContextCapabilityAdapter {
    return {
        capabilityId,
        serve: async () => {
            throw new Error("adapter offline");
        },
    };
}

/** Deterministic clock pinned to the fixture timeline. */
export function fixedClock(iso: string = FIXTURE_NOW): () => Date {
    return () => new Date(iso);
}

/** Freshness helper for tests: rows fetched 3h before the clock. */
export const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

export { CapabilityAvailability, CONTEXT_COMPILER_CONTRACT_VERSION };
