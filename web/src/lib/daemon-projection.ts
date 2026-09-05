import {
  isDaemonEventEnvelope,
  type AllowedDaemonEvent,
  type DaemonApprovalEventData,
  type DaemonCapabilityAvailabilityEventData,
  type DaemonCapabilityInvocationEventData,
  type DaemonContextRequestEventData,
  type DaemonEventEnvelope,
  type DaemonHumanDecisionEventData,
  type DaemonMissionEventData,
  type DaemonMissionVerificationEventData,
  type DaemonPlanRevisionEventData,
  type DaemonSnapshot,
  type DaemonStatusProjection,
  type DaemonCapabilitiesProjection,
  type DaemonTransportCapabilities,
  type DaemonProjectionCompleteness,
  type DaemonMissionProjection,
  type DaemonInvocationProjection,
} from "../../../shared/daemon-event-contract";

export interface DaemonProjectionState {
  cursor: number;
  status: DaemonStatusProjection | null;
  capabilities: DaemonCapabilitiesProjection | null;
  transportCapabilities: DaemonTransportCapabilities | null;
  completeness: DaemonProjectionCompleteness | null;
  missions: Record<string, DaemonMissionProjection>;
  invocations: Record<string, DaemonInvocationProjection>;
  planRevisions: Record<string, DaemonPlanRevisionEventData>;
  approvals: Record<string, DaemonApprovalEventData>;
  capabilityAvailability: Record<string, DaemonCapabilityAvailabilityEventData>;
  contextRequests: Record<string, DaemonContextRequestEventData>;
  humanDecisions: Record<string, DaemonHumanDecisionEventData>;
  missionVerifications: Record<string, DaemonMissionVerificationEventData>;
  lastEventId: string | null;
  lastEvent: AllowedDaemonEvent | null;
}

export const initialDaemonProjectionState: DaemonProjectionState = {
  cursor: 0,
  status: null,
  capabilities: null,
  transportCapabilities: null,
  completeness: null,
  missions: {},
  invocations: {},
  planRevisions: {},
  approvals: {},
  capabilityAvailability: {},
  contextRequests: {},
  humanDecisions: {},
  missionVerifications: {},
  lastEventId: null,
  lastEvent: null,
};

function indexById<T>(values: readonly T[], getId: (value: T) => string): Record<string, T> {
  return Object.fromEntries(values.map((value) => [getId(value), value]));
}

function withEventMetadata(
  state: DaemonProjectionState,
  envelope: DaemonEventEnvelope,
): DaemonProjectionState {
  return {
    ...state,
    cursor: envelope.sequence,
    lastEventId: envelope.eventId,
    lastEvent: envelope.event,
  };
}

/** Replace local state with the authoritative durable snapshot. */
export function replaceFromSnapshot(snapshot: DaemonSnapshot): DaemonProjectionState {
  return {
    ...initialDaemonProjectionState,
    cursor: snapshot.cursor,
    status: { ...snapshot.status },
    capabilities: { ...snapshot.capabilities, supportedModes: [...snapshot.capabilities.supportedModes] },
    transportCapabilities: { ...snapshot.transportCapabilities },
    completeness: {
      missions: { ...snapshot.completeness.missions },
      invocations: { ...snapshot.completeness.invocations },
    },
    missions: indexById(snapshot.missions, (mission) => mission.missionId),
    invocations: indexById(snapshot.invocations, (invocation) => invocation.invocationId),
  };
}

/**
 * Apply a validated operational fact to the client projection.
 * Invalid values are ignored defensively even when called outside the stream.
 */
export function applyDaemonEnvelope(
  state: DaemonProjectionState,
  envelope: DaemonEventEnvelope,
): DaemonProjectionState {
  if (!isDaemonEventEnvelope(envelope)) return state;

  if (envelope.event === "snapshot") {
    const snapshotState = replaceFromSnapshot(envelope.data as DaemonSnapshot);
    return withEventMetadata(snapshotState, envelope);
  }

  switch (envelope.event) {
    case "mission": {
      const data = envelope.data as DaemonMissionEventData;
      const { kind: _kind, ...mission } = data;
      return withEventMetadata({
        ...state,
        missions: { ...state.missions, [mission.missionId]: mission },
      }, envelope);
    }
    case "capability_invocation": {
      const data = envelope.data as DaemonCapabilityInvocationEventData;
      const { kind: _kind, ...invocation } = data;
      return withEventMetadata({
        ...state,
        invocations: { ...state.invocations, [invocation.invocationId]: invocation },
      }, envelope);
    }
    case "plan_revision": {
      const data = envelope.data as DaemonPlanRevisionEventData;
      return withEventMetadata({
        ...state,
        planRevisions: { ...state.planRevisions, [data.revisionId]: { ...data } },
      }, envelope);
    }
    case "approval": {
      const data = envelope.data as DaemonApprovalEventData;
      return withEventMetadata({
        ...state,
        approvals: { ...state.approvals, [data.approvalId]: { ...data } },
      }, envelope);
    }
    case "capability_availability": {
      const data = envelope.data as DaemonCapabilityAvailabilityEventData;
      return withEventMetadata({
        ...state,
        capabilityAvailability: { ...state.capabilityAvailability, [data.capabilityId]: { ...data } },
      }, envelope);
    }
    case "context_request": {
      const data = envelope.data as DaemonContextRequestEventData;
      return withEventMetadata({
        ...state,
        contextRequests: { ...state.contextRequests, [data.requestId]: { ...data } },
      }, envelope);
    }
    case "human_decision": {
      const data = envelope.data as DaemonHumanDecisionEventData;
      return withEventMetadata({
        ...state,
        humanDecisions: { ...state.humanDecisions, [data.decisionId]: { ...data } },
      }, envelope);
    }
    case "mission_verification": {
      const data = envelope.data as DaemonMissionVerificationEventData;
      return withEventMetadata({
        ...state,
        missionVerifications: { ...state.missionVerifications, [data.missionId]: { ...data } },
      }, envelope);
    }
    case "daemon":
    case "log":
      return withEventMetadata(state, envelope);
  }
}
