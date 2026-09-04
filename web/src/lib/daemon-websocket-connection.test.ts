import { describe, expect, it } from "bun:test";
import {
  DaemonWebSocketConnection,
  type WebSocketLike,
} from "./daemon-websocket-connection";
import type { DaemonSnapshot } from "../../../shared/daemon-event-contract";

const capabilities = {
  statusMetrics: true,
  modeSwitching: true,
  supportedModes: ["running", "pause"] as const,
  emergencyBrake: true,
  brakeRecoverable: false,
  modePersistence: true,
  tokenMetrics: false,
};

function snapshotEnvelope(
  sequence = 1,
  missionState: "executing" | "waiting_for_provider" = "executing",
) {
  const snapshot: DaemonSnapshot = {
    protocolVersion: 1,
    transportCapabilities: {
      orderedEvents: true,
      authoritativeSnapshot: true,
      resync: true,
      durableMissions: true,
      durableInvocations: true,
    },
    cursor: sequence,
    capabilities,
    status: {
      processStatus: "alive",
      mode: "running",
      uptimeSeconds: 1,
      activeSessions: { available: true, value: 1, unit: "count" },
      activeWaves: { available: true, value: 0, unit: "count" },
      activeTasks: { available: true, value: 1, unit: "count" },
      tokensUsed: { available: false, reason: "not wired" },
      memory: { rssBytes: 1, heapUsedBytes: 2, heapTotalBytes: 3 },
      capabilities,
      timestamp: "2026-09-04T00:00:00.000Z",
    },
    missions: [{
      missionId: "mission-1",
      state: missionState,
      source: "mission_control",
      currentPlanRevisionId: "revision-1",
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
      recoveryCount: 1,
      invocationIds: [],
      pendingApprovalCount: 0,
    }],
    invocations: [],
  };
  return {
    version: 1,
    eventId: `snapshot-${sequence}-${missionState}`,
    sequence,
    event: "snapshot" as const,
    timestamp: "2026-09-04T00:00:00.000Z",
    data: snapshot,
  };
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(value: unknown): void {
    this.onmessage?.({ data: value });
  }

  closeFromPeer(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  errorFromPeer(error: unknown = new Error("socket failed")): void {
    this.onerror?.(error);
  }
}

describe("DaemonWebSocketConnection", () => {
  it("connects initially and recovers an executing Mission after peer disconnect", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const snapshots: DaemonSnapshot[] = [];
    const connection = new DaemonWebSocketConnection({
      url: "ws://daemon.test/ws",
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => {},
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    connection.start();
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify(snapshotEnvelope(1, "executing")));
    sockets[0]!.closeFromPeer();
    expect(timers).toHaveLength(1);

    timers[0]!();
    sockets[1]!.open();
    sockets[1]!.message(JSON.stringify(snapshotEnvelope(2, "executing")));

    expect(sockets).toHaveLength(2);
    expect(snapshots.map((value) => value.missions[0]?.state)).toEqual(["executing", "executing"]);
  });

  it("recovers a waiting Mission without converting it to failure", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const snapshots: DaemonSnapshot[] = [];
    const connection = new DaemonWebSocketConnection({
      url: "ws://daemon.test/ws",
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => {},
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    connection.start();
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify(snapshotEnvelope(1, "waiting_for_provider")));
    sockets[0]!.closeFromPeer();
    timers[0]!();
    sockets[1]!.open();
    sockets[1]!.message(JSON.stringify(snapshotEnvelope(2, "waiting_for_provider")));

    expect(snapshots[1]?.missions[0]?.state).toBe("waiting_for_provider");
  });

  it("closes and schedules reconnect after a sequence gap without sending a command", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const connection = new DaemonWebSocketConnection({
      url: "ws://daemon.test/ws",
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => {},
    });

    connection.start();
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify(snapshotEnvelope()));
    sockets[0]!.message(JSON.stringify({
      version: 1,
      eventId: "event-3",
      sequence: 3,
      event: "mission",
      timestamp: "2026-09-04T00:00:00.000Z",
      data: {
        kind: "state_changed",
        missionId: "mission-1",
        state: "executing",
        source: "mission_control",
        currentPlanRevisionId: "revision-1",
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        recoveryCount: 1,
        invocationIds: [],
        pendingApprovalCount: 0,
      },
    }));

    expect(sockets[0]!.closeCalls).toBe(1);
    expect(sockets[0]!.sent).toEqual([]);
    expect(timers).toHaveLength(1);
  });

  it("never replays a command or effect on reconnect", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const connection = new DaemonWebSocketConnection({
      url: "ws://daemon.test/ws",
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => {},
    });

    connection.start();
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify(snapshotEnvelope()));
    expect(connection.send({ method: "agent.input", params: { prompt: "effect" } })).toBe(true);
    sockets[0]!.closeFromPeer();
    timers[0]!();

    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.sent).toEqual([]);
  });

  it("schedules reconnect when the socket reports an error without a close event", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const connection = new DaemonWebSocketConnection({
      url: "ws://daemon.test/ws",
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => {},
    });

    connection.start();
    sockets[0]!.errorFromPeer();

    expect(sockets[0]!.closeCalls).toBe(1);
    expect(timers).toHaveLength(1);
  });

  it("does not create duplicate reconnect timers after error and close", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const connection = new DaemonWebSocketConnection({
      url: "ws://daemon.test/ws",
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => {},
    });

    connection.start();
    sockets[0]!.errorFromPeer();
    sockets[0]!.closeFromPeer();
    expect(timers).toHaveLength(1);
  });

  it("clears a pending reconnect timer during explicit disconnect", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const cleared: unknown[] = [];
    const connection = new DaemonWebSocketConnection({
      url: "ws://daemon.test/ws",
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: (handle) => cleared.push(handle),
    });

    connection.start();
    sockets[0]!.closeFromPeer();
    connection.disconnect();

    expect(timers).toHaveLength(1);
    expect(cleared).toEqual([1]);
  });

  it("disconnects explicitly without creating a new socket or timer and removes handlers", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const cleared: unknown[] = [];
    const connection = new DaemonWebSocketConnection({
      url: "ws://daemon.test/ws",
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: (handle) => cleared.push(handle),
    });

    connection.start();
    const socket = sockets[0]!;
    connection.disconnect();
    socket.closeFromPeer();
    timers[0]?.();

    expect(sockets).toHaveLength(1);
    expect(socket.closeCalls).toBe(1);
    expect(cleared).toHaveLength(0);
    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(socket.onerror).toBeNull();
  });

  it("keeps connect idempotent while a socket is connecting", () => {
    const sockets: FakeSocket[] = [];
    const connection = new DaemonWebSocketConnection({
      url: "ws://daemon.test/ws",
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    connection.start();
    connection.start();
    expect(sockets).toHaveLength(1);
  });
});
