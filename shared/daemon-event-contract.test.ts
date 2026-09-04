import { describe, expect, it } from "bun:test";
import * as contract from "./daemon-event-contract.ts";

const capabilities = {
  statusMetrics: true,
  modeSwitching: true,
  supportedModes: ["running", "pause"],
  emergencyBrake: true,
  brakeRecoverable: false,
  modePersistence: true,
  tokenMetrics: false,
} as const;

const status = {
  processStatus: "alive",
  mode: "running",
  uptimeSeconds: 12,
  activeSessions: { available: true, value: 1, unit: "count" },
  activeWaves: { available: true, value: 0, unit: "count" },
  activeTasks: { available: true, value: 1, unit: "count" },
  tokensUsed: { available: false, reason: "not wired" },
  memory: { rssBytes: 1, heapUsedBytes: 2, heapTotalBytes: 3 },
  capabilities,
  timestamp: "2026-09-04T00:00:00.000Z",
};

const validMissionEnvelope = {
  version: 1,
  eventId: "mission-event-1",
  sequence: 1,
  event: "mission",
  data: {
    kind: "state_changed",
    missionId: "mission-1",
    state: "waiting_for_provider",
    source: "mission_control",
    currentPlanRevisionId: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    recoveryCount: 0,
    invocationIds: [],
    pendingApprovalCount: 0,
  },
  timestamp: "2026-09-04T00:00:00.000Z",
  missionId: "mission-1",
};

const validSnapshotEnvelope = {
  version: 1,
  eventId: "snapshot-event-1",
  sequence: 1,
  event: "snapshot",
  data: {
    protocolVersion: 1,
    transportCapabilities: {
      orderedEvents: true,
      authoritativeSnapshot: true,
      resync: true,
      durableMissions: true,
      durableInvocations: true,
    },
    cursor: 1,
    status,
    capabilities,
    missions: [
      {
        missionId: "mission-1",
        state: "waiting_for_provider",
        source: "mission_control",
        currentPlanRevisionId: null,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        recoveryCount: 0,
        invocationIds: [],
        pendingApprovalCount: 0,
      },
    ],
    invocations: [],
  },
  timestamp: "2026-09-04T00:00:00.000Z",
};

function validate(value: unknown): { ok: boolean; code?: string } {
  const candidate = (contract as Record<string, unknown>).validateDaemonEventEnvelope;
  expect(typeof candidate).toBe("function");
  if (typeof candidate !== "function") return { ok: false };
  return candidate(value) as { ok: boolean; code?: string };
}

describe("daemon event contract", () => {
  it("accepts a valid snapshot and operational Mission envelope", () => {
    expect(contract.isAllowedDaemonEvent("mission")).toBe(true);
    expect(contract.isDaemonEventEnvelope(validSnapshotEnvelope)).toBe(true);
    expect(contract.isDaemonEventEnvelope(validMissionEnvelope)).toBe(true);
  });

  it("rejects incompatible versions, unknown events and invalid payloads", () => {
    expect(validate({ ...validMissionEnvelope, version: 2 })).toEqual({
      ok: false,
      code: "unsupported_version",
    });
    expect(validate({ ...validMissionEnvelope, event: "future_event" })).toEqual({
      ok: false,
      code: "unknown_event",
    });
    expect(validate({
      ...validMissionEnvelope,
      data: { ...validMissionEnvelope.data, state: "not-a-mission-state" },
    })).toEqual({ ok: false, code: "invalid_payload" });
    expect(validate({
      ...validSnapshotEnvelope,
      data: { ...validSnapshotEnvelope.data, cursor: 2 },
    })).toEqual({ ok: false, code: "invalid_payload" });
  });

  it("requires a complete sanitized Mission projection for Mission events", () => {
    const { source: _source, ...withoutSource } = validMissionEnvelope.data;
    expect(validate({
      ...validMissionEnvelope,
      data: withoutSource,
    })).toEqual({ ok: false, code: "invalid_payload" });
  });
  it("rejects malformed envelope fields without throwing", () => {
    const malformed = [
      { ...validMissionEnvelope, eventId: "" },
      { ...validMissionEnvelope, sequence: 0 },
      { ...validMissionEnvelope, timestamp: "not-a-date" },
      { ...validMissionEnvelope, missionId: 42 },
      { ...validMissionEnvelope, data: undefined },
      { ...validMissionEnvelope, authorization: "Bearer secret" },
    ];

    for (const value of malformed) {
      expect(() => contract.isDaemonEventEnvelope(value)).not.toThrow();
      expect(contract.isDaemonEventEnvelope(value)).toBe(false);
    }
  });

  it("preserves waiting states as valid operational payloads", () => {
    expect(contract.isDaemonEventEnvelope(validMissionEnvelope)).toBe(true);
    expect((validMissionEnvelope.data.state)).toBe("waiting_for_provider");
  });

  it("rejects sensitive log content before it can reach the wire", () => {
    expect(validate({
      ...validMissionEnvelope,
      event: "log",
      data: { level: "warn", source: "test", message: "Authorization: Bearer secret" },
    })).toEqual({ ok: false, code: "invalid_payload" });
  });

  it("returns bounded diagnostics without echoing untrusted content", () => {
    const diagnostic = contract.safeProtocolDiagnostic("invalid_payload");
    expect(diagnostic).toEqual({ code: "invalid_payload" });
    expect(JSON.stringify(diagnostic)).not.toContain("Authorization");
    expect(JSON.stringify(diagnostic)).not.toContain("apiKey");
    expect(JSON.stringify(diagnostic)).not.toContain("prompt");
    expect(JSON.stringify(diagnostic)).not.toContain("response");
  });
});
