import { describe, expect, it } from "bun:test";
import { DaemonProjection, type ProjectionClient } from "./daemon-projection.js";
import type { DaemonSnapshot } from "../../../shared/daemon-event-contract.ts";

class FakeClient implements ProjectionClient {
  readyState = 1;
  bufferedAmount = 0;
  readonly messages: string[] = [];
  throwOnSend = false;
  closeCalls = 0;

  send(message: string): void {
    if (this.throwOnSend) throw new Error("send failed");
    this.messages.push(message);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }
}

function createSnapshot(cursor: number): DaemonSnapshot {
  const capabilities = {
    statusMetrics: true,
    modeSwitching: true,
    supportedModes: ["running", "pause"] as const,
    emergencyBrake: true,
    brakeRecoverable: false,
    modePersistence: true,
    tokenMetrics: false,
  };

  return {
    cursor,
    capabilities,
    status: {
      processStatus: "alive",
      mode: "running",
      uptimeSeconds: 12,
      activeSessions: { available: true, value: 0, unit: "count" },
      activeWaves: { available: true, value: 0, unit: "count" },
      activeTasks: { available: true, value: 0, unit: "count" },
      tokensUsed: { available: false, reason: "not wired" },
      memory: { rssBytes: 1, heapUsedBytes: 2, heapTotalBytes: 3 },
      capabilities,
      timestamp: "2026-08-19T22:00:00.000Z",
    },
  };
}

describe("DaemonProjection", () => {
  it("uses one snapshot envelope cursor without consuming a global event sequence", () => {
    const projection = new DaemonProjection({
      snapshot: createSnapshot,
      createEventId: (() => {
        let count = 0;
        return () => `event-${++count}`;
      })(),
    });
    const first = new FakeClient();
    const second = new FakeClient();

    projection.connectClient(first);
    projection.connectClient(second);
    projection.broadcast("daemon", { type: "ready" });

    const firstSnapshot = JSON.parse(first.messages[0]) as Record<string, any>;
    const secondSnapshot = JSON.parse(second.messages[0]) as Record<string, any>;
    const event = JSON.parse(first.messages[1]) as Record<string, any>;

    expect(firstSnapshot.event).toBe("snapshot");
    expect(secondSnapshot.event).toBe("snapshot");
    expect(firstSnapshot.sequence).toBe(1);
    expect(secondSnapshot.sequence).toBe(1);
    expect(firstSnapshot.data.cursor).toBe(1);
    expect(event.sequence).toBe(2);
    expect(projection.currentSequence).toBe(2);
  });

  it("isolates a send failure so healthy clients still receive the event", () => {
    const projection = new DaemonProjection({ snapshot: createSnapshot });
    const failing = new FakeClient();
    const healthy = new FakeClient();
    projection.connectClient(failing);
    projection.connectClient(healthy);
    failing.throwOnSend = true;

    projection.broadcast("task", { type: "progress", sessionId: "session-1" });

    expect(failing.closeCalls).toBe(1);
    expect(healthy.messages).toHaveLength(2);
    expect(JSON.parse(healthy.messages[1]).event).toBe("task");
    expect(projection.connectedClientCount).toBe(1);
  });

  it("removes a client whose buffered amount exceeds the finite backpressure limit", () => {
    const projection = new DaemonProjection({
      snapshot: createSnapshot,
      maxBufferedAmount: 10,
    });
    const slow = new FakeClient();
    const healthy = new FakeClient();
    projection.connectClient(slow);
    projection.connectClient(healthy);
    slow.bufferedAmount = 11;

    projection.broadcast("wave", { type: "wave_started", waveId: "wave-1" });

    expect(slow.closeCalls).toBe(1);
    expect(projection.connectedClientCount).toBe(1);
    expect(healthy.messages).toHaveLength(2);
  });

  it("closes and removes every client during transport cleanup", () => {
    const projection = new DaemonProjection({ snapshot: createSnapshot });
    const first = new FakeClient();
    const second = new FakeClient();
    projection.connectClient(first);
    projection.connectClient(second);

    projection.closeClients();

    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(1);
    expect(projection.connectedClientCount).toBe(0);
  });
});
