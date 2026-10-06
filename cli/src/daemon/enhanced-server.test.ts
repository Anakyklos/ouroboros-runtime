import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { DaemonServer } from './server.js';
import { LegacyRpcGateway } from './legacy-rpc-gateway.js';
import { DAEMON_EVENT_VERSION } from "../../../shared/daemon-event-contract.js";
import { LOCAL_CONTROL_PROTOCOL_VERSION } from "../../../shared/local-control-read-contract.js";
import { EventBus } from './event-bus.js';
import type { StoragePort } from "../ports/storage.port.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import {
  EffectClass,
  InvocationStatus,
  MissionState,
  type CapabilityInvocation,
  type Mission,
} from "../mission/contracts.js";
import {
  CancellationSupport,
  IdempotencyMode,
  ReconciliationSupport,
  RetryBackoff,
} from "../capabilities/contracts.js";

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

function makeInvocation(missionId: string, invocationId = "invocation-server-1"): CapabilityInvocation {
  return {
    invocationId,
    missionId,
    stepId: "step-server-1",
    capabilityId: "runstead.code-review",
    planRevisionId: "revision-server-1",
    contractVersion: 1,
    moduleOwner: "runstead",
    effectClass: EffectClass.EXECUTION,
    requestId: "request-server-1",
    effectFingerprint: "fingerprint-server-1",
    inputRefs: ["refs/runstead/review"],
    idempotency: { mode: IdempotencyMode.IDEMPOTENT, key: "idempotency-server-1" },
    retry: {
      maxAttempts: 1,
      attempt: 0,
      backoff: RetryBackoff.NONE,
      backoffMs: 0,
      nextEligibleAt: null,
    },
    attempts: [],
    delivery: { state: "not_submitted" },
    cancellation: {
      support: CancellationSupport.UNSUPPORTED,
      requested: false,
      state: "not_requested",
    },
    reconciliation: { support: ReconciliationSupport.NONE, state: "not_required" },
    ownerVerificationState: "pending",
    status: InvocationStatus.PENDING,
    resultRefs: [],
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
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

  it("serves factual local-control reads from the headless daemon", async () => {
    await missionStore.saveInvocation(makeInvocation("mission-server-1"));
    const protocolResponse = await fetch(`http://127.0.0.1:${TEST_PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "local-control-protocol",
        method: "local_control.read",
        params: { operation: "protocol.negotiate", supportedVersions: [LOCAL_CONTROL_PROTOCOL_VERSION] },
      }),
    });
    const protocolBody = await protocolResponse.json() as { result?: { ok?: boolean; protocolVersion?: number } };
    expect(protocolBody.result).toMatchObject({ ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION });

    const healthResponse = await fetch(`http://127.0.0.1:${TEST_PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "local-control-health",
        method: "local_control.read",
        params: { operation: "health", protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION },
      }),
    });
    const healthBody = await healthResponse.json() as { result?: { data?: { healthy?: boolean } } };
    expect(healthBody.result?.data?.healthy).toBe(true);

    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "local-control-status",
        method: "local_control.read",
        params: { operation: "status", protocolVersion: 1 },
      }),
    });

    const body = await response.json() as { result?: { data?: Record<string, unknown> } };
    expect(body.result?.data?.processStatus).toBe("alive");

    const missionResponse = await fetch(`http://127.0.0.1:${TEST_PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "local-control-missions",
        method: "local_control.read",
        params: { operation: "mission.list", protocolVersion: 1 },
      }),
    });
    const missionBody = await missionResponse.json() as { result?: { data?: { items?: Array<Record<string, unknown>> } } };
    expect(missionBody.result?.data?.items).toContainEqual(expect.objectContaining({
      missionId: "mission-server-1",
      state: "waiting_for_provider",
    }));
    expect(JSON.stringify(missionBody)).not.toContain("Authorization");

    const invocationResponse = await fetch(`http://127.0.0.1:${TEST_PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "local-control-invocations",
        method: "local_control.read",
        params: { operation: "invocation.list", protocolVersion: 1 },
      }),
    });
    const invocationBody = await invocationResponse.json() as { result?: { data?: { items?: Array<Record<string, unknown>> } } };
    expect(invocationBody.result?.data?.items).toContainEqual(expect.objectContaining({
      invocationId: "invocation-server-1",
      missionId: "mission-server-1",
      status: "pending",
    }));

    const capabilitiesResponse = await fetch(`http://127.0.0.1:${TEST_PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "local-control-capabilities",
        method: "local_control.read",
        params: { operation: "capability_registry.list", protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION },
      }),
    });
    const capabilitiesBody = await capabilitiesResponse.json() as { result?: { data?: { available?: boolean } } };
    expect(capabilitiesBody.result?.data?.available).toBe(false);
  });

  it("reconnects with a fresh authoritative Mission and Invocation snapshot", async () => {
    const connectAndReadSnapshot = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
      const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
        socket.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
      });
      socket.close();
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) resolve();
        else socket.addEventListener("close", () => resolve(), { once: true });
      });
      return message;
    };

    await missionStore.saveInvocation(makeInvocation("mission-server-1"));
    const first = await connectAndReadSnapshot();
    try {
      await missionStore.updateMission("mission-server-1", {
        state: MissionState.EXECUTING,
        updatedAt: "2026-09-04T00:02:00.000Z",
      });
      const reconnected = await connectAndReadSnapshot();
      const data = reconnected.data as { missions: Array<Record<string, unknown>>; invocations: Array<Record<string, unknown>> };

      expect(first.event).toBe("snapshot");
      expect(reconnected.event).toBe("snapshot");
      expect(data.missions).toContainEqual(expect.objectContaining({
        missionId: "mission-server-1",
        state: "executing",
      }));
      expect(data.invocations).toContainEqual(expect.objectContaining({
        invocationId: "invocation-server-1",
        missionId: "mission-server-1",
      }));
    } finally {
      await missionStore.updateMission("mission-server-1", {
        state: MissionState.WAITING_FOR_PROVIDER,
        updatedAt: "2026-09-04T00:03:00.000Z",
      });
    }
  });

  it("reports legacy agent and delegate methods as unsupported without executing them", async () => {
    const methods = [
      { method: "agent.input", params: { sessionId: "missing", prompt: "must not run" } },
      { method: "agent.interrupt", params: { sessionId: "missing" } },
      { method: "agent.resume", params: { sessionId: "missing" } },
      { method: "daemon.delegate", params: { agent: "glm", prompt: "must not run" } },
      { method: "daemon.list_agents" },
    ];

    for (const [index, request] of methods.entries()) {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: `legacy-${index}`, ...request }),
      });
      const body = await response.json() as { error?: { code?: number; message?: string } };
      expect(body.error?.code).toBe(-32601);
      expect(body.error?.message).toContain("Method not found");
    }
  });

  it("exposes legacy methods only when a legacy gateway is explicitly composed", async () => {
    const legacyGateway = new LegacyRpcGateway({
      checkBridgeAvailability: async () => ({ gemini: false, antigravity: false, jules: false }),
    } as never, storage, new EventBus());
    const legacyServer = new DaemonServer(storage, {
      port: TEST_PORT + 1,
      host: "127.0.0.1",
    }, new EventBus(), undefined, legacyGateway);

    try {
      await legacyServer.start();
      const response = await fetch(`http://127.0.0.1:${TEST_PORT + 1}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "legacy-opt-in", method: "daemon.list_agents" }),
      });
      const body = await response.json() as { result?: { agents?: Record<string, string> } };
      expect(body.result?.agents).toMatchObject({
        gemini: "unavailable",
        antigravity: "unavailable",
        jules: "unavailable",
      });
    } finally {
      await legacyServer.stop();
    }
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

      expect(message.version).toBe(DAEMON_EVENT_VERSION);
      expect(message.event).toBe("daemon");
      expect(typeof message.sequence).toBe("number");
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
      expect(typeof message.sequence).toBe("number");
      expect(message.event).toBe("snapshot");
      expect(typeof message.timestamp).toBe("string");
      expect(message.data).toMatchObject({
        status: { processStatus: "alive" },
        protocolVersion: DAEMON_EVENT_VERSION,
        transportCapabilities: {
          orderedEvents: true,
          authoritativeSnapshot: true,
          resync: true,
          durableMissions: true,
          durableInvocations: true,
        },
        missions: [{ missionId: "mission-server-1", state: "waiting_for_provider" }],
      });
      expect(message.sequence).toBe((message.data as Record<string, unknown>).cursor);
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

  it("publishes authoritative Mission and Invocation mutations to an active client", async () => {
    const eventMissionId = "mission-server-events";
    const baseMission = await missionStore.getMission("mission-server-1");
    expect(baseMission).not.toBeNull();
    if (!baseMission) return;
    await missionStore.createMission({
      ...baseMission,
      missionId: eventMissionId,
      originalIntentRef: "hash-server-events",
      state: MissionState.WAITING_FOR_PROVIDER,
    });
    const socket = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
    const messages: Record<string, unknown>[] = [];
    const nextMessage = () => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for durable event")), 1000);
      socket.addEventListener("message", (event) => {
        clearTimeout(timeout);
        const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
        messages.push(parsed);
        resolve(parsed);
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("websocket connection failed"));
      }, { once: true });
    });

    try {
      await nextMessage();

      const missionEvent = nextMessage();
      await missionStore.updateMission(eventMissionId, {
        state: MissionState.EXECUTING,
        updatedAt: "2026-09-04T00:01:00.000Z",
      });
      const missionMessage = await missionEvent;
      expect(missionMessage.event).toBe("mission");
      expect(missionMessage.data).toMatchObject({
        missionId: eventMissionId,
        state: "executing",
      });

      const invocationEvent = nextMessage();
      await missionStore.saveInvocation(makeInvocation(eventMissionId, "invocation-server-events"));
      const invocationMessage = await invocationEvent;
      expect(invocationMessage.event).toBe("capability_invocation");
      expect(invocationMessage.data).toMatchObject({
        invocationId: "invocation-server-events",
        missionId: eventMissionId,
        status: "pending",
      });
      expect(invocationMessage.sequence).toBe((missionMessage.sequence as number) + 1);
      expect(JSON.stringify(messages)).not.toContain("idempotency-server-1");
      expect(JSON.stringify(messages)).not.toContain("refs/runstead/review");
    } finally {
      socket.close();
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.addEventListener("close", () => resolve(), { once: true });
      });
      await missionStore.deleteMission(eventMissionId);
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
        state: "not-a-mission-state",
        source: "cli",
        currentPlanRevisionId: "revision-server-1",
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        recoveryCount: 1,
        invocationIds: [],
        pendingApprovalCount: 0,
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
