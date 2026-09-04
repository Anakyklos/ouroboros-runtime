import { describe, expect, it } from "bun:test";
import { DaemonProjection, type ProjectionClient } from "./daemon-projection.js";
import type {
  DaemonMissionEventData,
  DaemonSnapshot,
} from "../../../shared/daemon-event-contract.ts";

const capabilities = {
  statusMetrics: true,
  modeSwitching: true,
  supportedModes: ["running", "pause"] as const,
  emergencyBrake: true,
  brakeRecoverable: false,
  modePersistence: true,
  tokenMetrics: false,
};

function createSnapshot(cursor: number): DaemonSnapshot {
  return {
    protocolVersion: 1,
    transportCapabilities: {
      orderedEvents: true,
      authoritativeSnapshot: true,
      resync: true,
      durableMissions: true,
      durableInvocations: true,
    },
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
      timestamp: "2026-09-04T00:00:00.000Z",
    },
    missions: [],
    invocations: [],
  };
}

const missionEvent: DaemonMissionEventData = {
  kind: "state_changed",
  missionId: "mission-1",
  state: "executing",
  currentPlanRevisionId: "revision-1",
  updatedAt: "2026-09-04T00:00:00.000Z",
};

class FakeClient implements ProjectionClient {
  readyState = 1;
  bufferedAmount: number;
  readonly messages: string[] = [];
  readonly throwOnSend: boolean;
  closeCalls = 0;

  constructor(options: { bufferedAmount?: number; throwOnSend?: boolean } = {}) {
    this.bufferedAmount = options.bufferedAmount ?? 0;
    this.throwOnSend = options.throwOnSend ?? false;
  }

  send(message: string): void {
    if (this.throwOnSend) throw new Error("send failed");
    this.messages.push(message);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }
}

function readEnvelope(messages: string[], index: number): Record<string, any> {
  return JSON.parse(messages[index]!) as Record<string, any>;
}

describe("DaemonProjection", () => {
  it("uses one snapshot envelope before contiguous normal events", async () => {
    const projection = new DaemonProjection({
      snapshot: createSnapshot,
      createEventId: (() => {
        let count = 0;
        return () => `event-${++count}`;
      })(),
    });
    const first = new FakeClient();
    const second = new FakeClient();

    await projection.connectClient(first);
    await projection.connectClient(second);
    projection.broadcast("mission", missionEvent);

    const firstSnapshot = readEnvelope(first.messages, 0);
    const secondSnapshot = readEnvelope(second.messages, 0);
    const event = readEnvelope(first.messages, 1);

    expect(firstSnapshot.event).toBe("snapshot");
    expect(secondSnapshot.event).toBe("snapshot");
    expect(firstSnapshot.sequence).toBe(1);
    expect(secondSnapshot.sequence).toBe(1);
    expect(firstSnapshot.data.cursor).toBe(1);
    expect(event.sequence).toBe(2);
    expect(event.data).toEqual(missionEvent);
    expect(projection.currentSequence).toBe(2);
  });

  it("queues a bounded event during an asynchronous handshake and flushes after snapshot", async () => {
    let releaseSnapshot!: () => void;
    const snapshotReady = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const projection = new DaemonProjection({
      snapshot: async (cursor) => {
        await snapshotReady;
        return createSnapshot(cursor);
      },
      maxPendingEvents: 2,
    });
    const client = new FakeClient();
    const connecting = projection.connectClient(client);

    projection.broadcast("mission", missionEvent);
    releaseSnapshot();
    await connecting;

    expect(client.messages).toHaveLength(2);
    expect(readEnvelope(client.messages, 0).event).toBe("snapshot");
    expect(readEnvelope(client.messages, 1).event).toBe("mission");
  });

  it("closes a handshake whose bounded pending buffer is exceeded", async () => {
    let releaseSnapshot!: () => void;
    const snapshotReady = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const projection = new DaemonProjection({
      snapshot: async (cursor) => {
        await snapshotReady;
        return createSnapshot(cursor);
      },
      maxPendingEvents: 1,
    });
    const client = new FakeClient();
    const connecting = projection.connectClient(client);

    projection.broadcast("mission", missionEvent);
    projection.broadcast("mission", { ...missionEvent, kind: "updated" });
    releaseSnapshot();
    await connecting;

    expect(client.closeCalls).toBe(1);
    expect(client.messages).toHaveLength(0);
    expect(projection.connectedClientCount).toBe(0);
  });

  it("isolates a send failure so healthy clients still receive the event", async () => {
    const diagnostics: string[] = [];
    const projection = new DaemonProjection({
      snapshot: createSnapshot,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    const failing = new FakeClient();
    const healthy = new FakeClient();
    await projection.connectClient(failing);
    await projection.connectClient(healthy);
    failing.readyState = 1;
    (failing as FakeClient).messages.splice(0);
    const originalSend = failing.send.bind(failing);
    failing.send = () => { throw new Error("send failed"); };

    projection.broadcast("mission", missionEvent);

    expect(originalSend).toBeDefined();
    expect(failing.closeCalls).toBe(1);
    expect(healthy.messages).toHaveLength(2);
    expect(readEnvelope(healthy.messages, 1).event).toBe("mission");
    expect(diagnostics).toContain("client_send_failed");
  });

  it("removes a client whose buffered amount exceeds the finite backpressure limit", async () => {
    const projection = new DaemonProjection({
      snapshot: createSnapshot,
      maxBufferedAmount: 10,
    });
    const slow = new FakeClient();
    const healthy = new FakeClient();
    await projection.connectClient(slow);
    await projection.connectClient(healthy);
    slow.bufferedAmount = 11;

    projection.broadcast("mission", missionEvent);

    expect(slow.closeCalls).toBe(1);
    expect(projection.connectedClientCount).toBe(1);
    expect(healthy.messages).toHaveLength(2);
  });

  it("does not advance sequence for an invalid payload", async () => {
    const diagnostics: string[] = [];
    const projection = new DaemonProjection({
      snapshot: createSnapshot,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    const client = new FakeClient();
    await projection.connectClient(client);

    projection.broadcast("mission", { ...missionEvent, state: "invalid" } as never);

    expect(projection.currentSequence).toBe(1);
    expect(client.messages).toHaveLength(1);
    expect(diagnostics).toEqual(["invalid_payload"]);
  });

  it("closes and removes every client during transport cleanup", async () => {
    const projection = new DaemonProjection({ snapshot: createSnapshot });
    const first = new FakeClient();
    const second = new FakeClient();
    await projection.connectClient(first);
    await projection.connectClient(second);

    projection.closeClients();

    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(1);
    expect(projection.connectedClientCount).toBe(0);
  });
});
