import { describe, expect, it } from "bun:test";
import type {
  DaemonEventEnvelope,
  DaemonSnapshot,
} from "../../../shared/daemon-event-contract";

const snapshot: DaemonSnapshot = {
  protocolVersion: 1,
  transportCapabilities: {
    orderedEvents: true,
    authoritativeSnapshot: true,
    resync: true,
    durableMissions: true,
    durableInvocations: true,
  },
  cursor: 3,
  status: {
    processStatus: "alive",
    mode: "running",
    uptimeSeconds: 1,
    activeSessions: { available: true, value: 0, unit: "count" },
    activeWaves: { available: true, value: 0, unit: "count" },
    activeTasks: { available: true, value: 0, unit: "count" },
    tokensUsed: { available: false, reason: "not wired" },
    memory: { rssBytes: 1, heapUsedBytes: 2, heapTotalBytes: 3 },
    capabilities: {
      statusMetrics: true,
      modeSwitching: true,
      supportedModes: ["running", "pause"],
      emergencyBrake: true,
      brakeRecoverable: false,
      modePersistence: true,
      tokenMetrics: false,
    },
    timestamp: "2026-09-04T00:00:00.000Z",
  },
  capabilities: {
    statusMetrics: true,
    modeSwitching: true,
    supportedModes: ["running", "pause"],
    emergencyBrake: true,
    brakeRecoverable: false,
    modePersistence: true,
    tokenMetrics: false,
  },
  missions: [],
  invocations: [],
  completeness: {
    missions: { liveIncluded: 0, liveOmitted: 0, historicalIncluded: 0, historicalOmitted: 0, truncated: false },
    invocations: { liveIncluded: 0, liveOmitted: 0, historicalIncluded: 0, historicalOmitted: 0, truncated: false },
  },
};

const envelope: DaemonEventEnvelope = {
  version: 1,
  eventId: "mission-event-1",
  sequence: 4,
  event: "mission",
  data: {
    kind: "created",
    missionId: "mission-1",
    state: "executing",
    source: "mission_control",
    currentPlanRevisionId: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    recoveryCount: 0,
    invocationIds: [],
    pendingApprovalCount: 0,
  },
  timestamp: "2026-09-04T00:00:00.000Z",
};

async function loadStoreModule(): Promise<Record<string, unknown> | null> {
  return import("./daemon-projection-store").catch(() => null);
}

describe("daemon projection store", () => {
  it("replaces snapshots and applies accepted envelopes without commands", async () => {
    const module = await loadStoreModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const useDaemonProjectionStore = module.useDaemonProjectionStore as {
      getState: () => {
        replaceFromSnapshot: (value: DaemonSnapshot) => void;
        applyEnvelope: (value: DaemonEventEnvelope) => void;
        projection: { cursor: number; missions: Record<string, { state: string }> };
        reset: () => void;
      };
    };
    useDaemonProjectionStore.getState().reset();
    useDaemonProjectionStore.getState().replaceFromSnapshot(snapshot);
    expect(useDaemonProjectionStore.getState().projection.cursor).toBe(3);

    useDaemonProjectionStore.getState().applyEnvelope(envelope);
    expect(useDaemonProjectionStore.getState().projection.missions["mission-1"]?.state)
      .toBe("executing");
  });

  it("resets the projection on cleanup without implying Mission cancellation", async () => {
    const module = await loadStoreModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const useDaemonProjectionStore = module.useDaemonProjectionStore as {
      getState: () => {
        replaceFromSnapshot: (value: DaemonSnapshot) => void;
        reset: () => void;
        projection: { cursor: number };
      };
    };
    useDaemonProjectionStore.getState().replaceFromSnapshot(snapshot);
    useDaemonProjectionStore.getState().reset();
    expect(useDaemonProjectionStore.getState().projection.cursor).toBe(0);
  });
});
