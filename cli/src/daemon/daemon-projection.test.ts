import { describe, expect, it, spyOn } from "bun:test";
import { DaemonProjection, DEFAULT_MAX_PROJECTION_CLIENTS, type ProjectionClient } from "./daemon-projection.js";
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
    completeness: {
      missions: { liveIncluded: 0, liveOmitted: 0, historicalIncluded: 0, historicalOmitted: 0, truncated: false },
      invocations: { liveIncluded: 0, liveOmitted: 0, historicalIncluded: 0, historicalOmitted: 0, truncated: false },
    },
  };
}

const missionEvent: DaemonMissionEventData = {
  kind: "state_changed",
  missionId: "mission-1",
  state: "executing",
  source: "mission_control",
  currentPlanRevisionId: "revision-1",
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
  recoveryCount: 0,
  invocationIds: [],
  pendingApprovalCount: 0,
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
  it("uses a finite default capacity", () => {
    const projection = new DaemonProjection({ snapshot: createSnapshot });
    for (let index = 0; index < DEFAULT_MAX_PROJECTION_CLIENTS; index += 1) {
      expect(projection.reserveClient()).not.toBeNull();
    }
    expect(DEFAULT_MAX_PROJECTION_CLIENTS).toBeGreaterThan(0);
    expect(projection.connectedClientCount).toBe(0);
    expect(projection.admittedClientCount).toBe(DEFAULT_MAX_PROJECTION_CLIENTS);
    expect(projection.reserveClient()).toBeNull();
    projection.closeClients();
    expect(projection.connectedClientCount).toBe(0);
  });

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

  it("rejects clients above the configured global admission limit before sending a snapshot", async () => {
    const projection = new DaemonProjection({
      snapshot: createSnapshot,
      maxClients: 2,
    });
    const first = new FakeClient();
    const second = new FakeClient();
    const third = new FakeClient();

    await projection.connectClient(first);
    await projection.connectClient(second);
    await projection.connectClient(third);

    expect(projection.admittedClientCount).toBe(2);
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
    expect(third.messages).toHaveLength(0);
    expect(third.closeCalls).toBe(1);
  });

  it("counts handshake reservations and releases them on snapshot failure and transport cleanup", async () => {
    let failFirstSnapshot = true;
    const projection = new DaemonProjection({
      snapshot: async (cursor) => {
        if (failFirstSnapshot) {
          failFirstSnapshot = false;
          throw new Error("private snapshot failure");
        }
        return createSnapshot(cursor);
      },
      maxClients: 1,
    });
    const failed = new FakeClient();
    expect(await projection.connectClient(failed)).toBe(false);
    expect(failed.closeCalls).toBe(1);
    expect(projection.connectedClientCount).toBe(0);
    expect(projection.admittedClientCount).toBe(1);
    projection.disconnectClient(failed);
    expect(projection.admittedClientCount).toBe(0);

    const reservation = projection.reserveClient();
    expect(reservation).not.toBeNull();
    expect(projection.reserveClient()).toBeNull();
    const closedDuringUpgrade = new FakeClient();
    closedDuringUpgrade.readyState = 3;
    expect(await projection.connectClient(closedDuringUpgrade, reservation!)).toBe(false);
    expect(projection.admittedClientCount).toBe(0);

    const cleanupReservation = projection.reserveClient();
    expect(cleanupReservation).not.toBeNull();
    projection.closeClients();
    expect(projection.connectedClientCount).toBe(0);
    expect(projection.admittedClientCount).toBe(0);

    const next = new FakeClient();
    await projection.connectClient(next);
    expect(next.messages).toHaveLength(1);
    expect(projection.connectedClientCount).toBe(1);
  });

  it("does not advance the event cursor when only unclaimed reservations exist", () => {
    const projection = new DaemonProjection({ snapshot: createSnapshot, maxClients: 1 });
    expect(projection.reserveClient()).not.toBeNull();

    projection.broadcast("mission", missionEvent);

    expect(projection.currentSequence).toBe(0);
  });

  it("queues an event for an actual asynchronous handshake while another slot is only reserved", async () => {
    let releaseSnapshot!: () => void;
    const snapshotReady = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const projection = new DaemonProjection({
      snapshot: async (cursor) => {
        await snapshotReady;
        return createSnapshot(cursor);
      },
      maxPendingEvents: 2,
      maxClients: 2,
    });
    const unusedReservation = projection.reserveClient();
    expect(unusedReservation).not.toBeNull();
    const client = new FakeClient();
    const connecting = projection.connectClient(client);

    projection.broadcast("mission", missionEvent);
    expect(projection.currentSequence).toBe(2);
    releaseSnapshot();
    await connecting;

    expect(client.messages).toHaveLength(2);
    expect(readEnvelope(client.messages, 0).event).toBe("snapshot");
    expect(readEnvelope(client.messages, 1).event).toBe("mission");
    projection.releaseReservation(unusedReservation!);
  });

  it("bounds a never-settling snapshot handshake without affecting a healthy sibling", async () => {
    let snapshotCalls = 0;
    const projection = new DaemonProjection({
      snapshot: (cursor) => {
        snapshotCalls += 1;
        return snapshotCalls === 1
          ? new Promise<DaemonSnapshot>(() => {})
          : createSnapshot(cursor);
      },
      maxClients: 2,
      snapshotHandshakeTimeoutMs: 25,
    });
    const stalled = new FakeClient();
    const healthy = new FakeClient();
    const connectingStalled = projection.connectClient(stalled);
    await projection.connectClient(healthy);

    const outcome = await Promise.race([
      connectingStalled.then((connected) => ({ connected })),
      new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 100)),
    ]);

    expect(outcome).toEqual({ connected: false });
    expect(stalled.closeCalls).toBe(1);
    expect(projection.connectedClientCount).toBe(1);
    expect(projection.admittedClientCount).toBe(2);
    expect(projection.reserveClient()).toBeNull();
    projection.broadcast("mission", missionEvent);
    expect(healthy.messages).toHaveLength(2);
    expect(readEnvelope(healthy.messages, 0).event).toBe("snapshot");
    expect(readEnvelope(healthy.messages, 1).event).toBe("mission");
    expect(stalled.messages).toHaveLength(0);

    projection.disconnectClient(stalled);
    projection.disconnectClient(stalled);
    projection.disconnectClient(healthy);
    expect(projection.admittedClientCount).toBe(0);
  });

  it("keeps late snapshot work within the admission bound and ignores late fulfillment or rejection", async () => {
    let settleFirst!: (snapshot: DaemonSnapshot) => void;
    let rejectSecond!: (error: Error) => void;
    let snapshotCalls = 0;
    const projection = new DaemonProjection({
      snapshot: () => {
        snapshotCalls += 1;
        if (snapshotCalls === 1) return new Promise<DaemonSnapshot>((resolve) => { settleFirst = resolve; });
        return new Promise<DaemonSnapshot>((_resolve, reject) => { rejectSecond = reject; });
      },
      maxClients: 1,
      snapshotHandshakeTimeoutMs: 10,
    });
    const first = new FakeClient();
    expect(await projection.connectClient(first)).toBe(false);
    expect(first.closeCalls).toBe(1);
    expect(projection.admittedClientCount).toBe(1);
    projection.disconnectClient(first);
    expect(projection.admittedClientCount).toBe(0);
    expect(projection.reserveClient()).toBeNull();

    settleFirst(createSnapshot(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(first.messages).toHaveLength(0);
    const reservation = projection.reserveClient();
    expect(reservation).not.toBeNull();
    projection.releaseReservation(reservation!);

    const second = new FakeClient();
    expect(await projection.connectClient(second)).toBe(false);
    expect(second.closeCalls).toBe(1);
    projection.disconnectClient(second);
    expect(projection.reserveClient()).toBeNull();
    rejectSecond(new Error("late private snapshot failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(second.messages).toHaveLength(0);
    const recovered = projection.reserveClient();
    expect(recovered).not.toBeNull();
    projection.releaseReservation(recovered!);
  });

  it("cancels the handshake wait on shutdown while retaining unsettled snapshot admission", async () => {
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    let resolveSnapshot!: (snapshot: DaemonSnapshot) => void;
    const projection = new DaemonProjection({
      snapshot: () => new Promise<DaemonSnapshot>((resolve) => { resolveSnapshot = resolve; }),
      maxClients: 1,
      snapshotHandshakeTimeoutMs: 5_000,
    });
    const client = new FakeClient();
    try {
      const connecting = projection.connectClient(client);
      const timeoutIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 5_000);
      expect(timeoutIndex).toBeGreaterThanOrEqual(0);
      const timeoutResult = setTimeoutSpy.mock.results[timeoutIndex];
      expect(timeoutResult?.type).toBe("return");
      const timeoutHandle = timeoutResult?.type === "return" ? timeoutResult.value : undefined;
      projection.closeClients();

      expect(await connecting).toBe(false);
      expect(clearTimeoutSpy.mock.calls.some(([handle]) => handle === timeoutHandle)).toBe(true);
      expect(client.closeCalls).toBe(1);
      expect(projection.connectedClientCount).toBe(0);
      expect(projection.admittedClientCount).toBe(1);
      projection.disconnectClient(client);
      expect(projection.admittedClientCount).toBe(0);
      expect(projection.reserveClient()).toBeNull();

      resolveSnapshot(createSnapshot(1));
      await Promise.resolve();
      await Promise.resolve();
      expect(client.messages).toHaveLength(0);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it("closes a client when the authoritative snapshot cannot be read", async () => {
    const diagnostics: string[] = [];
    const client = new FakeClient();
    const projection = new DaemonProjection({
      snapshot: async () => { throw new Error("private store failure"); },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });

    await projection.connectClient(client);

    expect(client.closeCalls).toBe(1);
    expect(projection.connectedClientCount).toBe(0);
    expect(diagnostics).toEqual(["invalid_payload"]);
  });

  it("does not restore ready or advance the cursor after revocation closes during snapshot send", async () => {
    let projection!: DaemonProjection;
    const client = new FakeClient();
    client.send = () => {
      client.readyState = 2;
      client.closeCalls += 1;
      projection.markClientClosing(client);
    };
    projection = new DaemonProjection({ snapshot: createSnapshot, maxClients: 1 });

    expect(await projection.connectClient(client)).toBe(false);
    expect(projection.connectedClientCount).toBe(0);
    expect(projection.admittedClientCount).toBe(1);
    const cursorAfterSnapshotAttempt = projection.currentSequence;

    projection.broadcast("mission", missionEvent);

    expect(projection.currentSequence).toBe(cursorAfterSnapshotAttempt);
    expect(projection.admittedClientCount).toBe(1);
    projection.disconnectClient(client);
    expect(projection.admittedClientCount).toBe(0);
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

  it("retains admission capacity until a closing transport disconnects", async () => {
    const projection = new DaemonProjection({ snapshot: createSnapshot, maxClients: 1 });
    const first = new FakeClient();
    await projection.connectClient(first);

    projection.closeClients();

    expect(first.closeCalls).toBe(1);
    expect(projection.admittedClientCount).toBe(1);
    expect(projection.connectedClientCount).toBe(0);
    expect(projection.reserveClient()).toBeNull();

    projection.disconnectClient(first);
    expect(projection.admittedClientCount).toBe(0);
    expect(projection.reserveClient()).not.toBeNull();
  });

  it("retains a reserved slot when an upgraded socket is rejected after revocation", () => {
    const projection = new DaemonProjection({ snapshot: createSnapshot, maxClients: 1 });
    const reservation = projection.reserveClient();
    const rejected = new FakeClient();

    expect(reservation).not.toBeNull();
    expect(projection.retainClosingClient(rejected, reservation!)).toBe(true);
    projection.releaseReservation(reservation!);
    expect(projection.admittedClientCount).toBe(1);
    expect(projection.connectedClientCount).toBe(0);
    expect(projection.reserveClient()).toBeNull();

    projection.disconnectClient(rejected);
    expect(projection.admittedClientCount).toBe(0);
  });
});
