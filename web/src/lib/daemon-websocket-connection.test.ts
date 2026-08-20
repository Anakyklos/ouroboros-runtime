import { describe, expect, it } from "bun:test";
import {
  DaemonWebSocketConnection,
  type WebSocketLike,
} from "./daemon-websocket-connection";

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
}

function snapshotEnvelope(sequence = 1) {
  const capabilities = {
    statusMetrics: true,
    modeSwitching: true,
    supportedModes: ["running", "pause"],
    emergencyBrake: true,
    brakeRecoverable: false,
    modePersistence: true,
    tokenMetrics: false,
  };
  return {
    version: 1,
    eventId: `snapshot-${sequence}`,
    sequence,
    event: "snapshot",
    timestamp: "2026-08-19T22:00:00.000Z",
    data: {
      cursor: sequence,
      capabilities,
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
        timestamp: "2026-08-19T22:00:00.000Z",
      },
    },
  };
}

describe("DaemonWebSocketConnection", () => {
  it("reconnects after a peer disconnect and accepts a fresh snapshot", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const statuses: string[] = [];
    const snapshots: unknown[] = [];
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
      onStatus: (status) => statuses.push(status),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    connection.start();
    sockets[0].open();
    sockets[0].message(JSON.stringify(snapshotEnvelope()));
    sockets[0].closeFromPeer();
    expect(timers).toHaveLength(1);

    timers[0]();
    sockets[1].open();
    sockets[1].message(JSON.stringify(snapshotEnvelope(2)));

    expect(sockets).toHaveLength(2);
    expect(snapshots).toHaveLength(2);
    expect(statuses).toContain("reconnecting");
    expect(statuses).toContain("connected");
  });

  it("closes and schedules a reconnect after a sequence gap without sending a command", () => {
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
    sockets[0].open();
    sockets[0].message(JSON.stringify(snapshotEnvelope()));
    sockets[0].message(JSON.stringify({
      version: 1,
      eventId: "event-3",
      sequence: 3,
      event: "daemon",
      timestamp: "2026-08-19T22:00:00.000Z",
      data: { type: "waiting_for_provider" },
    }));

    expect(sockets[0].closeCalls).toBe(1);
    expect(sockets[0].sent).toEqual([]);
    expect(timers).toHaveLength(1);
  });

  it("disconnects explicitly without creating a new socket after cleanup", () => {
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
    connection.disconnect();
    sockets[0].closeFromPeer();
    timers[0]?.();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].closeCalls).toBe(1);
  });
});
