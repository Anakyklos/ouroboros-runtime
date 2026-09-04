import { describe, expect, it } from "bun:test";
import type {
  DaemonEventEnvelope,
  DaemonMissionEventData,
  DaemonCapabilityInvocationEventData,
  DaemonSnapshot,
} from "../../../shared/daemon-event-contract";

const capabilities = {
  statusMetrics: true,
  modeSwitching: true,
  supportedModes: ["running", "pause"] as const,
  emergencyBrake: true,
  brakeRecoverable: false,
  modePersistence: true,
  tokenMetrics: false,
};

const mission = {
  missionId: "mission-1",
  state: "executing" as const,
  source: "mission_control" as const,
  currentPlanRevisionId: "revision-1",
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
  recoveryCount: 0,
  invocationIds: ["invocation-1"],
  pendingApprovalCount: 0,
};

const invocation = {
  invocationId: "invocation-1",
  missionId: "mission-1",
  stepId: "step-1",
  capabilityId: "runstead.code-review",
  moduleOwner: "runstead",
  planRevisionId: "revision-1",
  status: "running" as const,
  deliveryState: "running" as const,
  ownerVerificationState: "pending" as const,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};

function snapshotWithMission(state: "executing" | "waiting_for_provider"): DaemonSnapshot {
  return {
    protocolVersion: 1,
    transportCapabilities: {
      orderedEvents: true,
      authoritativeSnapshot: true,
      resync: true,
      durableMissions: true,
      durableInvocations: true,
    },
    cursor: 4,
    status: {
      processStatus: "alive",
      mode: "running",
      uptimeSeconds: 1,
      activeSessions: { available: true, value: 0, unit: "count" },
      activeWaves: { available: true, value: 0, unit: "count" },
      activeTasks: { available: true, value: 0, unit: "count" },
      tokensUsed: { available: false, reason: "not wired" },
      memory: { rssBytes: 1, heapUsedBytes: 2, heapTotalBytes: 3 },
      capabilities,
      timestamp: "2026-09-04T00:00:00.000Z",
    },
    capabilities,
    missions: [{ ...mission, state }],
    invocations: [invocation],
  };
}

const missionEvent: DaemonMissionEventData = {
  kind: "state_changed",
  ...mission,
  state: "waiting_for_provider",
};

const invocationEvent: DaemonCapabilityInvocationEventData = {
  kind: "updated",
  ...invocation,
};

function envelope<E extends DaemonEventEnvelope["event"]>(
  event: E,
  data: unknown,
  sequence: number,
  eventId = `event-${sequence}`,
): DaemonEventEnvelope {
  return {
    version: 1,
    eventId,
    sequence,
    event,
    data,
    timestamp: "2026-09-04T00:00:00.000Z",
  } as DaemonEventEnvelope;
}

async function loadProjectionModule(): Promise<Record<string, unknown> | null> {
  return import("./daemon-projection").catch(() => null);
}

describe("daemon durable frontend projection", () => {
  it("replaces the projection with executing and waiting Mission snapshots", async () => {
    const module = await loadProjectionModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const replaceFromSnapshot = module.replaceFromSnapshot as (snapshot: DaemonSnapshot) => {
      missions: Record<string, { state: string }>;
      invocations: Record<string, unknown>;
      cursor: number;
    };
    const executing = replaceFromSnapshot(snapshotWithMission("executing"));
    const waiting = replaceFromSnapshot(snapshotWithMission("waiting_for_provider"));

    expect(executing.missions["mission-1"]?.state).toBe("executing");
    expect(waiting.missions["mission-1"]?.state).toBe("waiting_for_provider");
    expect(executing.invocations["invocation-1"]).toBeDefined();
    expect(executing.cursor).toBe(4);
  });

  it("applies complete Mission and invocation facts without storing sensitive material", async () => {
    const module = await loadProjectionModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const initialState = module.initialDaemonProjectionState as Record<string, unknown>;
    const applyDaemonEnvelope = module.applyDaemonEnvelope as (
      state: Record<string, unknown>,
      envelope: DaemonEventEnvelope,
    ) => Record<string, unknown>;
    const next = applyDaemonEnvelope(
      initialState,
      envelope("mission", missionEvent, 1),
    );
    const withInvocation = applyDaemonEnvelope(
      next,
      envelope("capability_invocation", invocationEvent, 2),
    );

    const missions = withInvocation.missions as Record<string, { state: string }>;
    const invocations = withInvocation.invocations as Record<string, { status: string }>;
    expect(missions["mission-1"]?.state).toBe("waiting_for_provider");
    expect(invocations["invocation-1"]?.status).toBe("running");
    expect(JSON.stringify(withInvocation)).not.toContain("prompt");
    expect(JSON.stringify(withInvocation)).not.toContain("Authorization");
  });

  it("replaces stale local entities when an authoritative snapshot arrives", async () => {
    const module = await loadProjectionModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const replaceFromSnapshot = module.replaceFromSnapshot as (snapshot: DaemonSnapshot) => Record<string, unknown>;
    const state = replaceFromSnapshot(snapshotWithMission("waiting_for_provider"));
    const next = replaceFromSnapshot({ ...snapshotWithMission("executing"), missions: [] });

    expect((state.missions as Record<string, unknown>)["mission-1"]).toBeDefined();
    expect((next.missions as Record<string, unknown>)["mission-1"]).toBeUndefined();
    expect((next.invocations as Record<string, unknown>)["invocation-1"]).toBeDefined();
  });
});
