import type {
  DaemonDurableProjection,
  DaemonInvocationProjection,
  DaemonMissionProjection,
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
  const storedMissions = await store.listMissions();
  const missions: DaemonMissionProjection[] = [];
  const invocations: DaemonInvocationProjection[] = [];

  for (const mission of storedMissions.slice(0, maxMissions)) {
    try {
      missions.push(projectMission(mission));
    } catch {
      continue;
    }
  }

  for (const mission of storedMissions.slice(0, maxMissions)) {
    if (invocations.length >= maxInvocations) break;
    let storedInvocations: CapabilityInvocation[];
    try {
      storedInvocations = await store.listInvocations(mission.missionId);
    } catch {
      continue;
    }
    for (const invocation of storedInvocations) {
      if (invocations.length >= maxInvocations) break;
      try {
        invocations.push(projectInvocation(invocation));
      } catch {
        continue;
      }
    }
  }

  return { missions, invocations };
}
