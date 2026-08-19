import { describe, expect, it } from "bun:test";
import {
  isDaemonEventEnvelope,
  safeProtocolDiagnostic,
  type DaemonEventEnvelope,
} from "./daemon-event-contract.ts";

describe("daemon event contract", () => {
  const validEnvelope: DaemonEventEnvelope = {
    version: 1,
    eventId: "evt-1",
    sequence: 1,
    event: "task",
    data: { type: "started", sessionId: "session-1", data: { taskId: "task-1" } },
    timestamp: "2026-08-19T22:00:00.000Z",
    taskId: "task-1",
    sessionId: "session-1",
  };

  it("accepts a valid versioned envelope and preserves its cursor fields", () => {
    expect(isDaemonEventEnvelope(validEnvelope)).toBe(true);
  });

  it("rejects malformed envelopes without throwing", () => {
    const malformed = [
      { ...validEnvelope, version: 2 },
      { ...validEnvelope, eventId: "" },
      { ...validEnvelope, sequence: 0 },
      { ...validEnvelope, sequence: 1.5 },
      { ...validEnvelope, timestamp: "not-a-date" },
      { ...validEnvelope, event: "unknown" },
      { ...validEnvelope, data: undefined },
      { ...validEnvelope, sessionId: 42 },
    ];

    for (const value of malformed) {
      expect(() => isDaemonEventEnvelope(value)).not.toThrow();
      expect(isDaemonEventEnvelope(value)).toBe(false);
    }
  });

  it("returns a bounded diagnostic without echoing untrusted payload content", () => {
    const diagnostic = safeProtocolDiagnostic("invalid_envelope");

    expect(diagnostic).toEqual({ code: "invalid_envelope" });
    expect(JSON.stringify(diagnostic)).not.toContain("Authorization");
    expect(JSON.stringify(diagnostic)).not.toContain("apiKey");
    expect(JSON.stringify(diagnostic)).not.toContain("prompt");
    expect(JSON.stringify(diagnostic)).not.toContain("response");
  });
});
