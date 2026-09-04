import { describe, expect, it } from "bun:test";
import {
  DaemonEventStream,
  calculateReconnectDelay,
} from "./daemon-event-stream";
import type {
  AllowedDaemonEvent,
  DaemonEventEnvelope,
  DaemonMissionEventData,
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

const snapshot: DaemonSnapshot = {
  protocolVersion: 1,
  transportCapabilities: {
    orderedEvents: true,
    authoritativeSnapshot: true,
    resync: true,
    durableMissions: true,
    durableInvocations: true,
  },
  cursor: 1,
  capabilities,
  status: {
    processStatus: "alive",
    mode: "pause",
    uptimeSeconds: 90,
    activeSessions: { available: true, value: 1, unit: "count" },
    activeWaves: { available: true, value: 1, unit: "count" },
    activeTasks: { available: true, value: 2, unit: "count" },
    tokensUsed: { available: false, reason: "not wired" },
    memory: { rssBytes: 1, heapUsedBytes: 2, heapTotalBytes: 3 },
    capabilities,
    timestamp: "2026-09-04T00:00:00.000Z",
  },
  missions: [],
  invocations: [],
};

function missionEventData(state: DaemonMissionEventData["state"]): DaemonMissionEventData {
  return {
    kind: "state_changed",
    missionId: "mission-1",
    state,
    source: "mission_control",
    currentPlanRevisionId: "revision-1",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    recoveryCount: 0,
    invocationIds: [],
    pendingApprovalCount: 0,
  };
}

function envelope<T>(
  event: AllowedDaemonEvent,
  sequence: number,
  data: T,
  eventId = `event-${sequence}`,
): DaemonEventEnvelope<T> {
  return {
    version: 1,
    eventId,
    sequence,
    event,
    data,
    timestamp: "2026-09-04T00:00:00.000Z",
  };
}

describe("DaemonEventStream", () => {
  it("accepts a snapshot and applies a contiguous normal event", () => {
    const applied: unknown[] = [];
    const snapshots: DaemonSnapshot[] = [];
    const stream = new DaemonEventStream({
      onEnvelope: (value) => applied.push(value),
      onSnapshot: (value) => snapshots.push(value),
    });

    expect(stream.accept(envelope("snapshot", 1, snapshot))).toBe("applied");
    expect(stream.accept(envelope("daemon", 2, { type: "ready" }))).toBe("applied");
    expect(snapshots).toEqual([snapshot]);
    expect(applied).toHaveLength(1);
    expect(stream.cursor).toBe(2);
  });

  it("preserves waiting states as valid Mission events", () => {
    const applied: unknown[] = [];
    const stream = new DaemonEventStream({ onEnvelope: (value) => applied.push(value) });

    expect(stream.accept(envelope("mission", 1, missionEventData("waiting_for_provider")))).toBe("applied");
    expect(applied).toHaveLength(1);
  });

  it("ignores malformed and unknown messages before callbacks run", () => {
    const applied: unknown[] = [];
    const diagnostics: string[] = [];
    const stream = new DaemonEventStream({
      onEnvelope: (value) => applied.push(value),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });

    const invalid = stream.accept({ version: 1, event: "daemon" });
    const unknown = stream.accept(envelope("future_event" as never, 1, { secret: "do not echo" }));

    expect(invalid).toBe("invalid");
    expect(unknown).toBe("unknown");
    expect(applied).toHaveLength(0);
    expect(diagnostics).toEqual(["invalid_envelope", "unknown_event"]);
  });

  it("reports version and payload diagnostics without invoking consumers", () => {
    const diagnostics: string[] = [];
    const applied: unknown[] = [];
    const stream = new DaemonEventStream({
      onEnvelope: (value) => applied.push(value),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });

    expect(stream.accept({ ...envelope("daemon", 1, { type: "ready" }), version: 2 })).toBe("invalid");
    expect(stream.accept(envelope("mission", 1, { ...missionEventData("executing"), state: "invalid" } as never))).toBe("invalid");
    expect(applied).toHaveLength(0);
    expect(diagnostics).toEqual(["unsupported_version", "invalid_payload"]);
  });

  it("rejects an incomplete or inconsistent snapshot without invoking snapshot consumers", () => {
    const snapshots: unknown[] = [];
    const diagnostics: string[] = [];
    const stream = new DaemonEventStream({
      onSnapshot: (value) => snapshots.push(value),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });

    expect(stream.accept(envelope("snapshot", 1, { cursor: 1, status: {}, capabilities: {} } as never))).toBe("invalid");
    expect(stream.accept(envelope("snapshot", 4, { ...snapshot, cursor: 3 }))).toBe("invalid");
    expect(snapshots).toHaveLength(0);
    expect(diagnostics).toEqual(["invalid_payload", "invalid_payload"]);
  });

  it("deduplicates an event by eventId and does not apply it twice", () => {
    const applied: unknown[] = [];
    const stream = new DaemonEventStream({ onEnvelope: (value) => applied.push(value) });
    const value = envelope("daemon", 1, { type: "ready" }, "same-event");

    expect(stream.accept(value)).toBe("applied");
    expect(stream.accept(value)).toBe("duplicate");
    expect(applied).toHaveLength(1);
  });

  it("requests resync on a sequence gap and refuses out-of-order state", () => {
    const applied: unknown[] = [];
    const decisions: string[] = [];
    const stream = new DaemonEventStream({
      onEnvelope: (value) => applied.push(value),
      onDiagnostic: (diagnostic) => decisions.push(diagnostic.code),
    });

    expect(stream.accept(envelope("daemon", 1, { type: "ready" }))).toBe("applied");
    expect(stream.accept(envelope("mission", 3, missionEventData("executing")))).toBe("resync_required");
    expect(stream.accept(envelope("daemon", 2, { type: "ready" }))).toBe("out_of_order");
    expect(applied).toHaveLength(1);
    expect(stream.cursor).toBe(1);
    expect(decisions).toEqual(["sequence_gap", "out_of_order"]);
  });

  it("uses a later authoritative snapshot to recover the cursor without issuing commands", () => {
    const snapshots: DaemonSnapshot[] = [];
    const stream = new DaemonEventStream({ onSnapshot: (value) => snapshots.push(value) });

    expect(stream.accept(envelope("daemon", 1, { type: "ready" }))).toBe("applied");
    expect(stream.accept(envelope("snapshot", 4, { ...snapshot, cursor: 4 }))).toBe("applied");
    expect(stream.accept(envelope("mission", 5, missionEventData("waiting_for_provider")))).toBe("applied");
    expect(snapshots).toHaveLength(1);
    expect(stream.cursor).toBe(5);
  });
});

describe("calculateReconnectDelay", () => {
  it("uses bounded exponential backoff", () => {
    expect(calculateReconnectDelay(0)).toBe(1000);
    expect(calculateReconnectDelay(1)).toBe(2000);
    expect(calculateReconnectDelay(20)).toBe(30000);
  });
});
