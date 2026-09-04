import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { DaemonServer } from './server.js';
import { EventBus } from './event-bus.js';
import type { StoragePort } from "../ports/storage.port.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import { EffectClass, MissionState, type Mission } from "../mission/contracts.js";

// Mock StoragePort to bypass better-sqlite3 in Bun tests
class MockStorage implements StoragePort {
  async initialize() { }
  async close() { }
  async store(key: string, value: any) { }
  async get(key: string) { return null; }
  async delete(key: string) { }
  async list() { return []; }
  async clear() { }
}

describe("DaemonServer", () => {
  let server: DaemonServer;
  let storage: StoragePort;
  let missionStore: SqliteMissionStore;
  const eventBus = new EventBus();
  const TEST_PORT = 17777;

  beforeAll(async () => {
    storage = new MockStorage();
    missionStore = new SqliteMissionStore(":memory:");
    await missionStore.initialize();
    const mission: Mission = {
      missionId: "mission-server-1",
      schemaVersion: 1,
      source: "cli",
      originalIntent: "Authorization: Bearer private prompt",
      sanitizedOriginalIntent: "[REDACTED] private prompt",
      originalIntentRef: "hash-server-mission",
      interpretedObjective: "sanitized objective",
      constraints: [],
      acceptanceCriteria: ["mission complete"],
      budgetPolicy: {},
      allowedCapabilityScope: {
        capabilityIds: ["runstead.code-review"],
        allowedEffectClasses: [EffectClass.EXECUTION],
        allowedRefPrefixes: ["refs/runstead/"],
      },
      approvalRequirements: [],
      contextRefs: [],
      state: MissionState.WAITING_FOR_PROVIDER,
      currentPlanRevisionId: "revision-server-1",
      invocationRefs: [],
      evidenceRefs: [],
      criterionVerifications: [],
      unresolvedQuestions: [],
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
      recoveryMetadata: { recovered: true, recoveryCount: 1 },
    };
    await missionStore.createMission(mission);

    server = new DaemonServer(storage, {
      port: TEST_PORT,
      host: "127.0.0.1",
      enableWebUI: false,
    }, eventBus, missionStore);

    await server.start();
    expect(eventBus.listenerCount("*")).toBe(1);
  });

  afterAll(async () => {
    await server.stop();
    expect(eventBus.listenerCount("*")).toBe(0);
    await missionStore.close();
  });

  it("should respond to health check", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("ok");
  });

  it("should handle JSON-RPC requests", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "system.health",
      }),
    });

    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe("1");
    expect(data.result).toBeDefined();
  });

  it("should reject invalid JSON-RPC", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: 1,
        method: "daemon.status",
      }),
    });

    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(-32600);
  });

  it("should forward normal daemon events through the same versioned envelope", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
    const messages: Record<string, unknown>[] = [];
    const nextMessage = () => new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
          messages.push(parsed);
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      }, { once: true });
      socket.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
    });

    try {
      await nextMessage();
      eventBus.emit("daemon", { type: "ready", port: TEST_PORT });
      const message = await nextMessage();

      expect(message.version).toBe(1);
      expect(message.event).toBe("daemon");
      expect(message.sequence).toBe(2);
      expect(message.data).toMatchObject({ type: "ready", port: TEST_PORT });
      expect(messages).toHaveLength(2);
    } finally {
      socket.close();
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.addEventListener("close", () => resolve(), { once: true });
      });
    }
  });

  it("should send a versioned snapshot envelope when a websocket connects", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
    const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        try {
          resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      }, { once: true });
      socket.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
    });

    try {
      expect(message.version).toBe(1);
      expect(typeof message.eventId).toBe("string");
      expect(message.sequence).toBe(2);
      expect(message.event).toBe("snapshot");
      expect(typeof message.timestamp).toBe("string");
      expect(message.data).toMatchObject({
        cursor: 2,
        status: { processStatus: "alive" },
        protocolVersion: 1,
        missions: [{ missionId: "mission-server-1", state: "waiting_for_provider" }],
      });
      expect(JSON.stringify(message)).not.toContain("Authorization");
      expect(JSON.stringify(message)).not.toContain("private prompt");
    } finally {
      socket.close();
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.addEventListener("close", () => resolve(), { once: true });
      });
    }
  });

  it("does not alter the durable Mission when a client disconnects", async () => {
    const before = await missionStore.getMission("mission-server-1");
    const socket = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
    });
    socket.close();
    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    const after = await missionStore.getMission("mission-server-1");

    expect(before?.state).toBe("waiting_for_provider");
    expect(after?.state).toBe(before?.state);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });
  it("should expose only explicit operational events, not legacy EventBus events", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
    const messages: Record<string, unknown>[] = [];
    const nextMessage = () => new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
          messages.push(parsed);
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      }, { once: true });
      socket.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
    });

    try {
      await nextMessage();
      eventBus.emit("thought", {
        type: "reasoning",
        content: "private chain-of-thought",
        timestamp: new Date(),
      });
      eventBus.emit("wave", {
        type: "wave_started",
        waveId: "legacy-wave",
        waveIndex: 1,
        totalWaves: 1,
        tasks: [],
      });
      eventBus.emit("mission", {
        kind: "state_changed",
        missionId: "mission-server-1",
        state: "waiting_for_provider",
        source: "cli",
        currentPlanRevisionId: "revision-server-1",
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        recoveryCount: 1,
        invocationIds: [],
        pendingApprovalCount: 0,
      });
      const message = await nextMessage();

      expect(message.event).toBe("mission");
      expect(messages).toHaveLength(2);
    } finally {
      socket.close();
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.addEventListener("close", () => resolve(), { once: true });
      });
    }
  });
});
