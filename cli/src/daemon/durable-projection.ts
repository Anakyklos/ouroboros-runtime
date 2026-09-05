import type {
  DaemonDurableProjection,
  DaemonInvocationProjection,
  DaemonMissionProjection,
  DaemonProjectionCompletenessEntry,
  DaemonStatusProjection,
} from "../../../shared/daemon-event-contract.js";
import type {
  CapabilityInvocation,
  Mission,
} from "../mission/contracts.js";
import type { MissionStore } from "../mission/ports.js";
import type { DaemonStatusResult } from "./daemon-controls.js";

export const DEFAULT_MAX_PROJECTED_MISSIONS = 100;
export const DEFAULT_MAX_PROJECTED_INVOCATIONS = 500;

export interface DurableProjectionLimits {
  maxMissions?: number;
  maxInvocations?: number;
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function requirePublicId(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new Error(`Cannot project durable ${field}: invalid identity`);
  }
  return value;
}

/** Copy only the operational fields safe for the public daemon snapshot. */
export function projectDaemonStatus(status: DaemonStatusResult): DaemonStatusProjection {
  return {
    processStatus: status.processStatus,
    mode: status.mode,
    uptimeSeconds: status.uptimeSeconds,
    activeSessions: { ...status.activeSessions },
    activeWaves: { ...status.activeWaves },
    activeTasks: { ...status.activeTasks },
    tokensUsed: { ...status.tokensUsed },
    memory: { ...status.memory },
    capabilities: {
      statusMetrics: status.capabilities.statusMetrics,
      modeSwitching: status.capabilities.modeSwitching,
      supportedModes: [...status.capabilities.supportedModes],
      emergencyBrake: status.capabilities.emergencyBrake,
      brakeRecoverable: status.capabilities.brakeRecoverable,
      modePersistence: status.capabilities.modePersistence,
      tokenMetrics: status.capabilities.tokenMetrics,
    },
    timestamp: status.timestamp,
  };
}

/** Project a Mission without intent, context contents, questions, or policy internals. */
export function projectMission(mission: Mission): DaemonMissionProjection {
  return {
    missionId: requirePublicId(mission.missionId, "Mission id"),
    state: mission.state,
    source: mission.source,
    currentPlanRevisionId: mission.currentPlanRevisionId,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    recoveryCount: mission.recoveryMetadata.recoveryCount,
    invocationIds: mission.invocationRefs.map((ref) => requirePublicId(ref.invocationId, "invocation id")),
    pendingApprovalCount: mission.approvalRequirements.filter((requirement) => !requirement.granted).length,
  };
}

/** Project a CapabilityInvocation without result, idempotency, effect, or error content. */
export function projectInvocation(invocation: CapabilityInvocation): DaemonInvocationProjection {
  return {
    invocationId: requirePublicId(invocation.invocationId, "invocation id"),
    missionId: requirePublicId(invocation.missionId, "Mission id"),
    stepId: requirePublicId(invocation.stepId, "step id"),
    capabilityId: requirePublicId(invocation.capabilityId, "capability id"),
    moduleOwner: requirePublicId(invocation.moduleOwner, "module owner"),
    planRevisionId: requirePublicId(invocation.planRevisionId, "plan revision id"),
    status: invocation.status,
    deliveryState: invocation.delivery.state,
    ownerVerificationState: invocation.ownerVerificationState,
    createdAt: invocation.createdAt,
    updatedAt: invocation.updatedAt,
    ...(invocation.dispatchedAt === undefined ? {} : { dispatchedAt: invocation.dispatchedAt }),
    ...(invocation.completedAt === undefined ? {} : { completedAt: invocation.completedAt }),
  };
}

function emptyCompleteness(): DaemonProjectionCompletenessEntry {
  return {
    liveIncluded: 0,
    liveOmitted: 0,
    historicalIncluded: 0,
    historicalOmitted: 0,
    truncated: false,
  };
}

function completenessFor(
  liveTotal: number,
  liveIncluded: number,
  historicalTotal: number,
  historicalIncluded: number,
): DaemonProjectionCompletenessEntry {
  const liveOmitted = Math.max(0, liveTotal - liveIncluded);
  const historicalOmitted = Math.max(0, historicalTotal - historicalIncluded);
  return {
    liveIncluded,
    liveOmitted,
    historicalIncluded,
    historicalOmitted,
    truncated: liveOmitted > 0 || historicalOmitted > 0,
  };
}

function projectCollection<T, P>(values: readonly T[], project: (value: T) => P): P[] {
  const projected: P[] = [];
  for (const value of values) {
    try {
      projected.push(project(value));
    } catch {
      // Invalid durable rows are omitted and reflected by completeness.
    }
  }
  return projected;
}

/**
 * Read the existing durable MissionStore and return a finite public projection.
 * Invalid rows are omitted rather than turned into guessed operational state.
 */
export async function readDurableProjection(
  store: MissionStore,
  limits: DurableProjectionLimits = {},
): Promise<DaemonDurableProjection> {
  const maxMissions = boundedLimit(limits.maxMissions, DEFAULT_MAX_PROJECTED_MISSIONS);
  const maxInvocations = boundedLimit(limits.maxInvocations, DEFAULT_MAX_PROJECTED_INVOCATIONS);
  if (!store.readProjection) {
    return {
      missions: [],
      invocations: [],
      completeness: {
        missions: emptyCompleteness(),
        invocations: emptyCompleteness(),
      },
    };
  }

  const read = await store.readProjection({
    maxHistoricalMissions: maxMissions,
    maxHistoricalInvocations: maxInvocations,
  });
  const liveMissions = projectCollection(
    read.liveMissions.slice(0, read.liveMissionCount),
    projectMission,
  );
  const historicalMissions = projectCollection(
    read.historicalMissions.slice(0, maxMissions),
    projectMission,
  );
  const liveInvocations = projectCollection(
    read.liveInvocations.slice(0, read.liveInvocationCount),
    projectInvocation,
  );
  const historicalInvocations = projectCollection(
    read.historicalInvocations.slice(0, maxInvocations),
    projectInvocation,
  );

  return {
    missions: [...liveMissions, ...historicalMissions],
    invocations: [...liveInvocations, ...historicalInvocations],
    completeness: {
      missions: completenessFor(
        read.liveMissionCount,
        liveMissions.length,
        read.historicalMissionCount,
        historicalMissions.length,
      ),
      invocations: completenessFor(
        read.liveInvocationCount,
        liveInvocations.length,
        read.historicalInvocationCount,
        historicalInvocations.length,
      ),
    },
  };
}
