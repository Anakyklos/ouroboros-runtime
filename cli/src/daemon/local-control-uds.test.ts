import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { LocalControlReadService } from "./local-control-read.js";
import { DaemonServer } from "./server.js";
import { EventBus } from "./event-bus.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import type { Mission } from "../mission/contracts.js";
import type { StoragePort } from "../ports/storage.port.js";
import type { DaemonRpcGatewayPort } from "./rpc-gateway.js";
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  LOCAL_CONTROL_READ_OPERATIONS,
  type LocalControlReadRequest,
  type LocalControlReadResponse,
} from "../../../shared/local-control-read-contract.js";
import {
  LocalControlUdsServer,
  LOCAL_CONTROL_UDS_MAX_REQUEST_BYTES,
  requestLocalControlUds,
} from "./local-control-uds.js";

const temporaryDirectories: string[] = [];

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ouroboros-uds-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP test listener did not expose an address");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const storage = {
  async createSession() { throw new Error("unused"); }, async getSession() { return null; },
  async updateSession() {}, async listSessions() { return []; }, async deleteSession() {},
  async appendLog() { throw new Error("unused"); }, async getLogs() { return []; },
  async saveWave() { throw new Error("unused"); }, async getWave() { return null; },
  async listWaves() { return []; }, async updateWave() {}, async deleteWave() {},
  async createCheckpoint() { throw new Error("unused"); }, async getCheckpoints() { return []; },
  async saveMemory() {}, async getMemory() { return []; }, async deleteMemory() {},
  async clear() {}, async initialize() {}, async close() {},
} as unknown as StoragePort;

function fixtureMission(): Mission {
  return {
    missionId: "fixture-uds-mission",
    schemaVersion: 1,
    source: "operator",
    originalIntent: "fixture intent",
    sanitizedOriginalIntent: "fixture intent",
    originalIntentRef: "sha256:fixture",
    interpretedObjective: "fixture objective",
    constraints: [],
    acceptanceCriteria: ["fixture accepted"],
    budgetPolicy: {},
    allowedCapabilityScope: { capabilityIds: [], allowedEffectClasses: [], allowedRefPrefixes: [] },
    approvalRequirements: [],
    contextRefs: [],
    state: "ready",
    currentPlanRevisionId: null,
    invocationRefs: [],
    evidenceRefs: [],
    criterionVerifications: [],
    unresolvedQuestions: [],
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
    recoveryMetadata: { recovered: false, recoveryCount: 0 },
  } as Mission;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !["timestamp", "processId", "processTitle", "runtimeVersion", "uptimeSeconds"].includes(key))
    .map(([key, item]) => [key, normalize(item)]));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("LocalControlUdsServer", () => {
  it("enforces a private socket and safely removes it on shutdown", async () => {
    const directory = await privateDirectory();
    const socketPath = join(directory, "control.sock");
    const uds = new LocalControlUdsServer({
      socketPath,
      read: async () => ({ ok: true, protocolVersion: 1, operation: "status", data: {} }) as LocalControlReadResponse,
    });
    await uds.start();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await expect(requestLocalControlUds(socketPath, { operation: "status", protocolVersion: 1 })).resolves.toMatchObject({
      ok: true,
      operation: "status",
    });
    await uds.stop();
    expect(await readdir(directory)).toEqual([]);
    await expect(requestLocalControlUds(socketPath, { operation: "status", protocolVersion: 1 })).rejects.toThrow();
    await uds.start();
    await expect(requestLocalControlUds(socketPath, { operation: "status", protocolVersion: 1 })).resolves.toMatchObject({ ok: true });
    await uds.stop();
  });

  it("compares every read operation over real loopback JSON-RPC and UDS using one SQLite fixture", async () => {
    const directory = await privateDirectory();
    const missionStore = new SqliteMissionStore(join(directory, "missions.db"));
    await missionStore.initialize();
    await missionStore.createMission(fixtureMission());
    const status = {
      processStatus: "alive", mode: "running", uptimeSeconds: 1,
      activeSessions: { available: true, value: 0, unit: "count" },
      activeWaves: { available: true, value: 0, unit: "count" },
      activeTasks: { available: true, value: 0, unit: "count" },
      tokensUsed: { available: false, reason: "not_available" },
      memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1 },
      capabilities: {
        statusMetrics: true, modeSwitching: true, supportedModes: ["running", "pause"],
        emergencyBrake: true, brakeRecoverable: false, modePersistence: true, tokenMetrics: false,
      },
      timestamp: "2026-10-07T00:00:00.000Z",
    } as const;
    const service = new LocalControlReadService({
      getStatus: () => status,
      getRuntimeIdentity: () => ({ processId: process.pid, processTitle: process.title, runtime: "bun", runtimeVersion: process.versions.bun ?? "unknown" }),
      missionStore,
    });
    const gateway: DaemonRpcGatewayPort = {
      registerMethod: () => undefined,
      handleRequest: async (request) => ({ jsonrpc: "2.0", id: request.id, result: await service.read(request.params) }),
      getProjectionSnapshot: async () => { throw new Error("not used by read parity test"); },
    };
    const port = await freePort();
    const http = new DaemonServer(storage, { port, host: "127.0.0.1" }, new EventBus(), missionStore, gateway);
    const socketPath = join(directory, "control.sock");
    const uds = new LocalControlUdsServer({ socketPath, read: (request) => service.read(request) });
    try {
      await Promise.all([http.start(), uds.start()]);
      const operations: LocalControlReadRequest[] = [
        { operation: "protocol.negotiate", supportedVersions: [LOCAL_CONTROL_PROTOCOL_VERSION] },
        ...LOCAL_CONTROL_READ_OPERATIONS.filter((operation) => operation !== "protocol.negotiate").map((operation) => {
          switch (operation) {
            case "health": case "status": return { operation, protocolVersion: 1 } as const;
            case "mission.list": case "invocation.list": case "capability_registry.list": case "diagnostics.list":
              return { operation, protocolVersion: 1, limit: 10 } as const;
            case "mission.show": return { operation, protocolVersion: 1, missionId: "fixture-uds-mission" } as const;
            case "invocation.show": return { operation, protocolVersion: 1, invocationId: "missing-invocation" } as const;
          }
        }),
      ];
      for (const [index, request] of operations.entries()) {
        const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: String(index), method: "local_control.read", params: request }),
        });
        const envelope = await response.json() as { result: unknown };
        const udsResult = await requestLocalControlUds(udsPath(directory), request);
        expect(normalize(udsResult)).toEqual(normalize(envelope.result));
      }
      const isolated = await Promise.all([
        requestLocalControlUds(socketPath, { operation: "status", protocolVersion: 1 }),
        requestLocalControlUds(socketPath, { operation: "mission.list", protocolVersion: 1 }),
      ]);
      expect(isolated[0]).toMatchObject({ ok: true, operation: "status" });
      expect(isolated[1]).toMatchObject({ ok: true, operation: "mission.list" });
      const invalidJson = createConnection(socketPath);
      const invalidResponse = new Promise<string>((resolve, reject) => {
        let response = "";
        invalidJson.once("error", reject);
        invalidJson.on("data", (chunk) => {
          response += chunk.toString("utf8");
          if (response.includes("\n")) resolve(response);
        });
        invalidJson.once("connect", () => invalidJson.write("{broken-json}\n"));
      });
      expect(JSON.parse(await invalidResponse)).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
      invalidJson.destroy();
      const malformed = { operation: "mission.list", protocolVersion: 2 } as const;
      expect(await requestLocalControlUds(udsPath(directory), malformed as LocalControlReadRequest)).toMatchObject({ ok: false, code: "PROTOCOL_VERSION_UNSUPPORTED" });
      await expect(requestLocalControlUds(udsPath(directory), { operation: "protocol.negotiate", supportedVersions: [99] })).resolves.toMatchObject({ ok: false, code: "PROTOCOL_VERSION_UNSUPPORTED" });
      await expect(requestLocalControlUds(udsPath(directory), { operation: "mission.list", protocolVersion: 1, limit: 100_000 } as LocalControlReadRequest)).resolves.toMatchObject({ ok: false, code: "INVALID_LIMIT" });
      const idleClient = createConnection(socketPath);
      await new Promise<void>((resolve, reject) => idleClient.once("connect", resolve).once("error", reject));
      const stalePath = join(directory, "live.sock");
      const competing = new LocalControlUdsServer({ socketPath, read: (request) => service.read(request) });
      await expect(competing.start()).rejects.toThrow("already accepting connections");
      idleClient.destroy();
      const reconnectStart = performance.now();
      expect(await requestLocalControlUds(socketPath, { operation: "status", protocolVersion: 1 })).toMatchObject({ ok: true });
      const reconnectMs = performance.now() - reconnectStart;
      expect(reconnectMs).toBeGreaterThanOrEqual(0);
      await uds.stop();
      await uds.start();
      expect(await requestLocalControlUds(socketPath, { operation: "mission.list", protocolVersion: 1 })).toMatchObject({ ok: true });
      await uds.stop();
      const staleListener = createServer();
      await new Promise<void>((resolve, reject) => staleListener.once("error", reject).listen(stalePath, resolve));
      await new Promise<void>((resolve, reject) => staleListener.close((error) => error ? reject(error) : resolve()));
      const staleUds = new LocalControlUdsServer({ socketPath: stalePath, read: (request) => service.read(request) });
      await staleUds.start();
      expect(await requestLocalControlUds(stalePath, { operation: "status", protocolVersion: 1 })).toMatchObject({ ok: true });
      await staleUds.stop();
    } finally {
      await uds.stop();
      await http.stop();
      await missionStore.close();
    }
  });

  it("rejects public directories and oversized requests without weakening the contract", async () => {
    const directory = await privateDirectory();
    const socketPath = join(directory, "control.sock");
    const uds = new LocalControlUdsServer({ socketPath, read: async () => ({ ok: false, code: "INVALID_REQUEST", message: "invalid" }) });
    await expect(requestLocalControlUds(socketPath, { operation: "mission.list", protocolVersion: 1, limit: 1 } as LocalControlReadRequest)).rejects.toThrow();
    const oversized = { operation: "status", protocolVersion: 1, padding: "x".repeat(LOCAL_CONTROL_UDS_MAX_REQUEST_BYTES) } as unknown as LocalControlReadRequest;
    await expect(requestLocalControlUds(socketPath, oversized)).rejects.toThrow("maximum payload size");
    await uds.start();
    const maliciousClient = createConnection(socketPath);
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("oversized UDS client was not closed")), 2_000);
      maliciousClient.once("error", () => { clearTimeout(timeout); resolve(); });
      maliciousClient.once("close", () => { clearTimeout(timeout); resolve(); });
      maliciousClient.once("connect", () => maliciousClient.write(Buffer.alloc(LOCAL_CONTROL_UDS_MAX_REQUEST_BYTES + 1, 0x78)));
    });
    await closed;
    maliciousClient.destroy();
    await expect(requestLocalControlUds(socketPath, { operation: "status", protocolVersion: 1 })).resolves.toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    const publicDirectory = await mkdtemp(join(tmpdir(), "ouroboros-uds-public-"));
    temporaryDirectories.push(publicDirectory);
    await Bun.write(join(publicDirectory, "marker"), "fixture");
    const { chmod } = await import("node:fs/promises");
    await chmod(publicDirectory, 0o755);
    const unsafe = new LocalControlUdsServer({ socketPath: join(publicDirectory, "control.sock"), read: async () => ({ ok: false, code: "INVALID_REQUEST", message: "invalid" }) });
    await expect(unsafe.start()).rejects.toThrow("group or other users");
    await uds.stop();
    await chmod(publicDirectory, 0o700);
    const regularPath = join(publicDirectory, "regular.sock");
    await writeFile(regularPath, "keep");
    const regularPathServer = new LocalControlUdsServer({ socketPath: regularPath, read: async () => ({ ok: false, code: "INVALID_REQUEST", message: "invalid" }) });
    await expect(regularPathServer.start()).rejects.toThrow("not a removable socket");
    const symlinkPath = join(publicDirectory, "symlink.sock");
    await symlink(regularPath, symlinkPath);
    const symlinkServer = new LocalControlUdsServer({ socketPath: symlinkPath, read: async () => ({ ok: false, code: "INVALID_REQUEST", message: "invalid" }) });
    await expect(symlinkServer.start()).rejects.toThrow("not a removable socket");
  });
});

function udsPath(directory: string): string {
  return join(directory, "control.sock");
}
