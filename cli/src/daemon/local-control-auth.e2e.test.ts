import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { SqliteAdapter } from "../adapters/sqlite.adapter.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import { MissionEngine } from "../mission/mission-engine.js";
import { PlanPolicyValidator } from "../mission/policy.js";
import { FakeCapabilityResolver } from "../mission/testing.js";
import { DaemonServer } from "./server.js";
import type { DaemonProjection } from "./daemon-projection.js";
import { RpcGateway, type DaemonRpcGatewayPort } from "./rpc-gateway.js";
import { EventBus } from "./event-bus.js";
import { LocalControlAuthorizer, LocalControlCredentialStore, getBrowserSessionCookieName } from "./local-control-auth.js";
import type { LocalControlAuthScope } from "../../../shared/local-control-auth-contract.js";
import { LocalControlReadClient, LoopbackJsonRpcTransport } from "../commands/local-control-client.js";
import { writeLocalControlClientCredential } from "./local-control-auth.js";
import { establishDaemonBrowserSession, setDaemonBearerToken } from "../../../web/src/lib/daemon-auth.js";

interface RawFrame { opcode: number; payload: Buffer; }
interface RawHandshakeResponse { status: number; headers: string; body: string; }

class RawWebSocketProbe {
  private buffer = Buffer.alloc(0);
  private frames: RawFrame[] = [];
  private frameWaiters: Array<(frame: RawFrame) => void> = [];
  private headerResolver!: (response: RawHandshakeResponse) => void;
  private headerRejecter!: (error: Error) => void;
  private headerTimer: ReturnType<typeof setTimeout>;
  private responseBody = Buffer.alloc(0);
  private expectedResponseBodyLength = 0;
  private isUpgradeResponse = false;
  readonly response = new Promise<RawHandshakeResponse>((resolve, reject) => {
    this.headerResolver = resolve;
    this.headerRejecter = reject;
  });

  constructor(readonly socket: Socket, private readonly description = "WebSocket") {
    this.headerTimer = setTimeout(() => {
      this.close();
      this.headerRejecter(new Error(`${this.description} handshake timed out`));
    }, 5_000);
    socket.on("data", (chunk) => this.onData(Buffer.from(chunk)));
    socket.once("close", () => {
      clearTimeout(this.headerTimer);
      if (!this.headerResolved) this.headerRejecter(new Error("WebSocket closed before handshake"));
    });
  }

  static async connect(port: number, headers: Record<string, string>, description?: string): Promise<RawWebSocketProbe> {
    const socket = createConnection({ host: "127.0.0.1", port });
    const probe = new RawWebSocketProbe(socket, description);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const key = randomBytes(16).toString("base64");
    const lines = [
      `GET /ws HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), "", "",
    ];
    socket.write(lines.join("\r\n"));
    return probe;
  }

  nextFrame(timeoutMs = 2_000): Promise<RawFrame> {
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter((waiter) => waiter !== onFrame);
        reject(new Error("WebSocket frame timed out"));
      }, timeoutMs);
      const onFrame = (frame: RawFrame) => { clearTimeout(timer); resolve(frame); };
      this.frameWaiters.push(onFrame);
    });
  }

  close(): void { this.socket.destroy(); }

  private onData(chunk: Buffer): void {
    if (this.headerResolved && !this.isUpgradeResponse) {
      this.responseBody = Buffer.concat([this.responseBody, chunk]);
      if (this.responseBody.length >= this.expectedResponseBodyLength) {
        this.headerResolver({
          status: this.responseStatus,
          headers: this.headerText ?? "",
          body: this.responseBody.subarray(0, this.expectedResponseBodyLength).toString("utf8"),
        });
      }
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const separator = this.buffer.indexOf("\r\n\r\n");
    if (separator >= 0 && !this.headerResolved) {
      this.headerResolved = true;
      clearTimeout(this.headerTimer);
      const header = this.buffer.subarray(0, separator).toString("utf8");
      this.headerText = header;
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(header)?.[1] ?? 0);
      this.buffer = this.buffer.subarray(separator + 4);
      this.responseStatus = status;
      this.isUpgradeResponse = status === 101;
      if (this.isUpgradeResponse) {
        this.headerResolver({ status, headers: header, body: "" });
      } else {
        this.expectedResponseBodyLength = Number(/^content-length:\s*(\d+)/im.exec(header)?.[1] ?? 0);
        this.responseBody = Buffer.from(this.buffer);
        this.buffer = Buffer.alloc(0);
        if (this.responseBody.length >= this.expectedResponseBodyLength) {
          this.headerResolver({
            status,
            headers: header,
            body: this.responseBody.subarray(0, this.expectedResponseBodyLength).toString("utf8"),
          });
        }
      }
    }
    if (!this.headerResolved || !/^HTTP\/1\.1 101 /.test(this.headerText ?? "")) return;
    this.readFrames();
  }

  private headerResolved = false;
  private headerText: string | null = null;
  private responseStatus = 0;

  private readFrames(): void {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const large = this.buffer.readBigUInt64BE(2);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) { this.close(); return; }
        length = Number(large); offset = 10;
      }
      if ((second & 0x80) !== 0 || this.buffer.length < offset + length) return;
      const frame = { opcode: first & 0x0f, payload: this.buffer.subarray(offset, offset + length) };
      this.buffer = this.buffer.subarray(offset + length);
      const waiter = this.frameWaiters.shift();
      if (waiter) waiter(frame); else this.frames.push(frame);
    }
  }
}

async function unusedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate loopback port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the expected local test state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("local-control authentication over real Fastify and SQLite", () => {
  let directory: string;
  let port: number;
  let frontendPort: number;
  let frontendOrigin: string;
  let viteServer: ChildProcess | undefined;
  let viteOutput = "";
  let previousProxyTarget: string | undefined;
  let daemonStorage: SqliteAdapter;
  let missionStore: SqliteMissionStore;
  let credentialStore: LocalControlCredentialStore;
  let authorizer: LocalControlAuthorizer;
  let server: DaemonServer;
  let eventBus: EventBus;
  let injectedGatewayServer: DaemonServer | undefined;
  let missionEngine: MissionEngine;
  let shutdownRequests = 0;
  let readToken: string;
  let controlToken: string;
  let adminToken: string;
  let multiScopeToken: string;
  let missionId: string;

  async function rpc(method: string, params?: unknown, token?: string, origin?: string, cookie?: string) {
    return await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? { origin } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    });
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "ouroboros-local-control-auth-e2e-"));
    process.env.OUROBOROS_OPS_PATH = join(directory, "daemon-ops.json");
    port = await unusedPort();
    frontendPort = await unusedPort();
    frontendOrigin = `http://127.0.0.1:${frontendPort}`;
    previousProxyTarget = process.env.OUROBOROS_DEV_DAEMON_URL;
    process.env.OUROBOROS_DEV_DAEMON_URL = `http://127.0.0.1:${port}`;
    daemonStorage = new SqliteAdapter(join(directory, "daemon.db"));
    await daemonStorage.initialize();
    missionStore = new SqliteMissionStore(join(directory, "missions.db"));
    await missionStore.initialize();
    credentialStore = new LocalControlCredentialStore(join(directory, "auth", "clients.db"));
    readToken = credentialStore.provision("read-client", ["mission.read"], Date.now() + 60_000).token;
    controlToken = credentialStore.provision("control-client", ["mission.control"], Date.now() + 60_000).token;
    adminToken = credentialStore.provision("admin-client", ["daemon.admin"], Date.now() + 60_000).token;
    multiScopeToken = credentialStore.provision("browser-admin", ["mission.read", "mission.control", "daemon.admin"], Date.now() + 60_000).token;
    authorizer = new LocalControlAuthorizer(credentialStore, [frontendOrigin]);
    const resolver = new FakeCapabilityResolver();
    missionEngine = new MissionEngine({ store: missionStore, policy: new PlanPolicyValidator(resolver) });
    const mission = await missionEngine.createMission({
      intent: { requestId: "authz-e2e-request", source: "cli", originalIntent: "fictional authz canary", constraints: [], acceptanceCriteria: [] },
      allowedCapabilityScope: { capabilityIds: [], allowedEffectClasses: [], allowedRefPrefixes: [] },
    });
    missionId = mission.missionId;
    eventBus = new EventBus();
    server = new DaemonServer(
      daemonStorage,
      { port, host: "127.0.0.1" },
      eventBus, missionStore, undefined, missionEngine, () => { shutdownRequests += 1; }, authorizer,
    );
    await server.start();
    viteServer = spawn("node", [
      resolve(process.cwd(), "web/node_modules/vite/bin/vite.js"),
      "--config", resolve(process.cwd(), "web/vite.config.ts"),
      "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort",
    ], {
      cwd: resolve(process.cwd(), "web"),
      env: { ...process.env, OUROBOROS_DEV_DAEMON_URL: `http://127.0.0.1:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    viteServer.stdout?.on("data", (chunk: Buffer) => { viteOutput = `${viteOutput}${chunk.toString("utf8")}`.slice(-2_000); });
    viteServer.stderr?.on("data", (chunk: Buffer) => { viteOutput = `${viteOutput}${chunk.toString("utf8")}`.slice(-2_000); });
    await waitForFrontend();
  }, 20_000);

  afterAll(async () => {
    await injectedGatewayServer?.stop();
    await server?.stop();
    if (viteServer && viteServer.exitCode === null) {
      const viteExited = new Promise<void>((resolveExit) => viteServer!.once("exit", () => resolveExit()));
      viteServer.kill("SIGTERM");
      await viteExited;
    }
    credentialStore?.close();
    await daemonStorage?.close();
    await missionStore?.close();
    if (previousProxyTarget === undefined) delete process.env.OUROBOROS_DEV_DAEMON_URL;
    else process.env.OUROBOROS_DEV_DAEMON_URL = previousProxyTarget;
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 20_000);

  async function waitForFrontend(): Promise<void> {
    const deadline = Date.now() + 10_000;
    let lastError = "no response";
    while (Date.now() < deadline) {
      if (viteServer?.exitCode !== null && viteServer?.exitCode !== undefined) {
        throw new Error(`Vite exited before becoming ready (${viteServer.exitCode})`);
      }
      try {
        const response = await fetch(frontendOrigin);
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        // The development server is still binding its loopback port.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`Vite did not become ready on its loopback port (${lastError}): ${viteOutput || "no process output"}`);
  }

  it("denies anonymous, invalid-token, malformed, and unknown RPC without reads or effects", async () => {
    const before = await missionStore.getMission(missionId);
    const anonymousRead = await rpc("local_control.read", { operation: "mission.show", protocolVersion: 1, missionId });
    const invalidToken = await rpc("system.shutdown", undefined, "oc1.invalid.invalid");
    const unknown = await rpc("dynamic.registered.method", {}, readToken);
    const malformed = await rpc("local_control.command", { operation: "mission.pause", missionId, pausedBy: "operator" }, readToken);
    expect(anonymousRead.status).toBe(401);
    expect(JSON.stringify(await anonymousRead.json())).not.toContain(missionId);
    expect(invalidToken.status).toBe(401);
    expect(unknown.status).toBe(403);
    expect(malformed.status).toBe(403);
    expect((await missionStore.getMission(missionId))?.state).toBe(before?.state);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  });

  it("keeps a multi-scope browser cookie read-only and rejects every daemon-admin RPC before effects", async () => {
    const origin = frontendOrigin;
    const statusBeforeResponse = await rpc("daemon.status", {}, multiScopeToken);
    const statusBefore = await statusBeforeResponse.json() as { result: { mode: string } };
    const opsPath = join(directory, "daemon-ops.json");
    const opsBefore = await readFile(opsPath, "utf8").catch(() => null);
    const session = await fetch(`http://127.0.0.1:${port}/auth/browser-session`, {
      method: "POST", headers: { authorization: `Bearer ${multiScopeToken}`, origin },
    });
    expect(session.status).toBe(204);
    const cookie = session.headers.get("set-cookie")!.split(";", 1)[0]!;

    const attempts = await Promise.all([
      rpc("daemon.setMode", { mode: "pause" }, undefined, origin, cookie),
      rpc("daemon.emergencyBrake", {}, undefined, origin, cookie),
      rpc("system.shutdown", {}, undefined, origin, cookie),
    ]);
    const statusAfterResponse = await rpc("daemon.status", {}, multiScopeToken);
    const statusAfter = await statusAfterResponse.json() as { result: { mode: string } };
    const opsAfter = await readFile(opsPath, "utf8").catch(() => null);

    expect(attempts.map((response) => response.status)).toEqual([401, 401, 401]);
    expect(statusAfter.result.mode).toBe(statusBefore.result.mode);
    expect(opsAfter).toBe(opsBefore);
    expect(shutdownRequests).toBe(0);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  });

  it("enforces read, mission-control, and daemon-admin as independent grants before dispatch", async () => {
    const read = await rpc("local_control.read", { operation: "mission.show", protocolVersion: 1, missionId }, readToken);
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toContain(missionId);
    const readCannotPause = await rpc("local_control.command", { operation: "mission.pause", protocolVersion: 1, missionId, reason: "hold" }, readToken);
    expect(readCannotPause.status).toBe(403);
    expect((await missionStore.getMission(missionId))?.state).not.toBe("paused");

    const controlCannotRead = await rpc("local_control.read", { operation: "mission.list", protocolVersion: 1 }, controlToken);
    expect(controlCannotRead.status).toBe(403);
    const pause = await rpc("local_control.command", { operation: "mission.pause", protocolVersion: 1, missionId, reason: "authorized pause", pausedBy: "client claim" }, controlToken);
    expect(pause.status).toBe(200);
    expect((await missionStore.getMission(missionId))?.state).toBe("paused");
    const resume = await rpc("local_control.command", { operation: "mission.resume", protocolVersion: 1, missionId }, controlToken);
    expect(resume.status).toBe(200);
    const controlCannotAdmin = await rpc("daemon.setMode", { mode: "pause" }, controlToken);
    expect(controlCannotAdmin.status).toBe(403);
    expect((await rpc("daemon.status", {}, adminToken)).status).toBe(403);
    const adminCannotRead = await rpc("local_control.read", { operation: "mission.list", protocolVersion: 1 }, adminToken);
    expect(adminCannotRead.status).toBe(403);
    const mode = await rpc("daemon.setMode", { mode: "pause" }, adminToken);
    expect(mode.status).toBe(200);
    const brake = await rpc("daemon.emergencyBrake", {}, adminToken);
    expect(brake.status).toBe(200);
    const shutdownDenied = await rpc("system.shutdown", undefined, readToken);
    expect(shutdownDenied.status).toBe(403);
  });

  it("runs the factual CLI transport against the real daemon using its private credential file", async () => {
    const credentialPath = join(directory, "cli", "operator.json");
    writeLocalControlClientCredential(credentialPath, { schemaVersion: 1, clientId: "read-client", token: readToken });
    const cli = new LocalControlReadClient(new LoopbackJsonRpcTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      credentialFile: credentialPath,
    }));
    const response = await cli.read({ operation: "mission.show", missionId });
    expect(response.data.item?.missionId).toBe(missionId);
    expect((await readFile(credentialPath, "utf8"))).not.toContain("PRIVATE");
  });

  it("returns only the versioned allowlisted session projection to mission.read", async () => {
    const contextCanary = "CANARY_PRIVATE_CONTEXT_124";
    const metadataCanary = "CANARY_PRIVATE_METADATA_124";
    const stored = await daemonStorage.createSession({
      status: "active",
      contextSnapshot: contextCanary,
      metadata: { private: metadataCanary, nested: { arbitrary: metadataCanary } },
    });
    const capturedLogs: string[] = [];
    const unsubscribe = eventBus.on("log", (entry) => capturedLogs.push(entry.message));
    try {
      const getResponse = await rpc("session.get", { id: stored.id }, readToken);
      const getBody = await getResponse.json() as { result?: { contractVersion?: number; session?: Record<string, unknown> }; error?: unknown };
      const listResponse = await rpc("session.list", {}, readToken);
      const listBody = await listResponse.json() as { result?: { contractVersion?: number; truncated?: boolean; sessions?: Array<Record<string, unknown>> }; error?: unknown };

      expect(getResponse.status).toBe(200);
      expect(listResponse.status).toBe(200);
      expect(JSON.stringify({ getBody, listBody })).not.toContain(contextCanary);
      expect(JSON.stringify({ getBody, listBody })).not.toContain(metadataCanary);
      expect(getBody.result).toEqual({
        contractVersion: 1,
        session: {
          id: stored.id,
          status: "active",
          createdAt: stored.createdAt.toISOString(),
          updatedAt: stored.updatedAt.toISOString(),
        },
      });
      expect(listBody.result?.contractVersion).toBe(1);
      expect(listBody.result?.truncated).toBe(false);
      expect(listBody.result?.sessions?.find((session) => session.id === stored.id)).toEqual(getBody.result?.session);

      const browserSession = await fetch(`http://127.0.0.1:${port}/auth/browser-session`, {
        method: "POST", headers: { authorization: `Bearer ${readToken}`, origin: frontendOrigin },
      });
      const cookie = browserSession.headers.get("set-cookie")!.split(";", 1)[0]!;
      const stream = await RawWebSocketProbe.connect(port, { Origin: frontendOrigin, Cookie: cookie });
      expect((await stream.response).status).toBe(101);
      const snapshot = (await stream.nextFrame()).payload.toString("utf8");
      expect(snapshot).not.toContain(contextCanary);
      expect(snapshot).not.toContain(metadataCanary);
      stream.close();
      expect(JSON.stringify(capturedLogs)).not.toContain(contextCanary);
      expect(JSON.stringify(capturedLogs)).not.toContain(metadataCanary);
    } finally {
      unsubscribe();
    }
  });

  it("reprojects untrusted session results and errors from an injected gateway", async () => {
    const contextCanary = "CANARY_PRIVATE_CONTEXT_124";
    const metadataCanary = "CANARY_PRIVATE_METADATA_124";
    const stored = await daemonStorage.createSession({
      status: "active",
      contextSnapshot: contextCanary,
      metadata: { private: metadataCanary },
    });
    const targetPort = await unusedPort();
    const injectedEventBus = new EventBus();
    const injectedLogMessages: string[] = [];
    const unsubscribe = injectedEventBus.on("log", (entry) => injectedLogMessages.push(entry.message));
    const delegate = new RpcGateway(daemonStorage, injectedEventBus, missionStore);
    const injectedGateway: DaemonRpcGatewayPort = {
      registerMethod: (name, handler) => delegate.registerMethod(name, handler),
      getProjectionSnapshot: (cursor) => delegate.getProjectionSnapshot(cursor),
      handleRequest: async (request) => {
        if (request.method === "session.get") {
          const session = await daemonStorage.getSession(String(request.params?.id));
          if (!session) return { jsonrpc: "2.0", id: request.id, error: { code: -32001, message: contextCanary } };
          return { jsonrpc: "2.0", id: request.id, result: { session, privateDiagnostic: metadataCanary } };
        }
        if (request.method === "session.list") {
          return { jsonrpc: "2.0", id: request.id, result: { sessions: await daemonStorage.listSessions(), privateDiagnostic: metadataCanary } };
        }
        return delegate.handleRequest(request);
      },
    };
    injectedGatewayServer = new DaemonServer(
      daemonStorage,
      { port: targetPort, host: "127.0.0.1" },
      injectedEventBus,
      missionStore,
      injectedGateway,
      undefined,
      undefined,
      authorizer,
    );
    await injectedGatewayServer.start();
    try {
      const getResponse = await fetch(`http://127.0.0.1:${targetPort}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${readToken}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "session.get", method: "session.get", params: { id: stored.id } }),
      });
      const getBody = await getResponse.text();
      const listResponse = await fetch(`http://127.0.0.1:${targetPort}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${readToken}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "session.list", method: "session.list", params: {} }),
      });
      const listBody = await listResponse.text();
      const errorResponse = await fetch(`http://127.0.0.1:${targetPort}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${readToken}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "missing", method: "session.get", params: { id: "missing" } }),
      });
      const errorBody = await errorResponse.text();
      const errorJson = JSON.parse(errorBody) as { error?: { message?: string } };

      expect(getResponse.status).toBe(200);
      expect(listResponse.status).toBe(200);
      expect(errorResponse.status).toBe(200);
      expect(errorJson.error?.message).toBe("The RPC request could not be completed");
      expect(`${getBody}${listBody}${errorBody}`).not.toContain(contextCanary);
      expect(`${getBody}${listBody}${errorBody}`).not.toContain(metadataCanary);
      expect(JSON.stringify(injectedLogMessages)).not.toContain(contextCanary);
      expect(JSON.stringify(injectedLogMessages)).not.toContain(metadataCanary);
    } finally {
      await injectedGatewayServer.stop();
      injectedGatewayServer = undefined;
      unsubscribe();
      injectedEventBus.clear();
    }
  });

  it("sanitizes injected gateway exceptions at the authenticated HTTP boundary", async () => {
    const gateway = (server as unknown as { rpcGateway: { registerMethod(method: string, handler: () => Promise<never>): void } }).rpcGateway;
    gateway.registerMethod("system.version", async () => { throw new Error("PRIVATE storage path and token=secret"); });
    const response = await rpc("system.version", {}, readToken);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("The RPC request could not be completed");
    expect(body).not.toContain("PRIVATE");
    expect(body).not.toContain("secret");
  });

  it("rejects malformed injected protected reads and normalizes gateway errors", async () => {
    const codeCanary = "CANARY_PRIVATE_ERROR_CODE_124";
    const dataCanary = "CANARY_PRIVATE_READ_DATA_124";
    const targetPort = await unusedPort();
    const injectedEventBus = new EventBus();
    const injectedLogMessages: string[] = [];
    const unsubscribe = injectedEventBus.on("log", (entry) => injectedLogMessages.push(entry.message));
    const delegate = new RpcGateway(daemonStorage, injectedEventBus, missionStore);
    const injectedGateway: DaemonRpcGatewayPort = {
      registerMethod: (name, handler) => delegate.registerMethod(name, handler),
      getProjectionSnapshot: (cursor) => delegate.getProjectionSnapshot(cursor),
      handleRequest: async (request) => {
        if (request.method === "system.version") {
          return { jsonrpc: "2.0", id: request.id, result: { name: "ouroboros-daemon", version: "1.0.0", private: dataCanary } };
        }
        if (request.method === "daemon.status") {
          return { jsonrpc: "2.0", id: request.id, result: { processStatus: "alive", private: dataCanary } };
        }
        if (request.method === "local_control.read") {
          return { jsonrpc: "2.0", id: request.id, result: { ok: true, protocolVersion: 1, operation: "status", data: { private: dataCanary } } };
        }
        return {
          jsonrpc: "2.0", id: request.id,
          error: { code: codeCanary, message: dataCanary, private: dataCanary },
          private: dataCanary,
        };
      },
    };
    injectedGatewayServer = new DaemonServer(
      daemonStorage, { port: targetPort, host: "127.0.0.1" }, injectedEventBus,
      missionStore, injectedGateway, undefined, undefined, authorizer,
    );
    await injectedGatewayServer.start();
    try {
      const request = async (method: string, params: unknown = {}) => fetch(`http://127.0.0.1:${targetPort}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${readToken}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
      });
      const errorResponse = await request("session.get", { id: "missing" });
      const errorText = await errorResponse.text();
      const versionResponse = await request("system.version");
      const versionText = await versionResponse.text();
      const statusResponse = await request("daemon.status");
      const statusText = await statusResponse.text();
      const localReadResponse = await request("local_control.read", { operation: "status", protocolVersion: 1 });
      const localReadText = await localReadResponse.text();
      const allBodies = `${errorText}${versionText}${statusText}${localReadText}`;

      expect(errorResponse.status).toBe(200);
      expect(JSON.parse(errorText)).toEqual({
        jsonrpc: "2.0", id: "session.get",
        error: { code: -32603, message: "The RPC request could not be completed" },
      });
      for (const response of [versionResponse, statusResponse, localReadResponse]) expect(response.status).toBe(200);
      for (const canary of [codeCanary, dataCanary]) {
        expect(allBodies).not.toContain(canary);
        expect(JSON.stringify(injectedLogMessages)).not.toContain(canary);
      }
      expect(JSON.parse(versionText).error?.code).toBe(-32603);
      expect(JSON.parse(statusText).error?.code).toBe(-32603);
      expect(JSON.parse(localReadText).error?.code).toBe(-32603);
    } finally {
      await injectedGatewayServer.stop();
      injectedGatewayServer = undefined;
      unsubscribe();
      injectedEventBus.clear();
    }
  });

  it("requires browser Origin and authenticated session before the first WS snapshot", async () => {
    const anonymous = await RawWebSocketProbe.connect(port, { Origin: frontendOrigin });
    expect((await anonymous.response).status).toBe(401);
    anonymous.close();

    const browserSession = await fetch(`http://127.0.0.1:${port}/auth/browser-session`, {
      method: "POST", headers: { authorization: `Bearer ${readToken}`, origin: frontendOrigin },
    });
    expect(browserSession.status).toBe(204);
    const setCookie = browserSession.headers.get("set-cookie");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie!.split(";")[0]!;

    const wrongOrigin = await RawWebSocketProbe.connect(port, { Origin: "http://attacker.invalid", Cookie: cookie });
    expect((await wrongOrigin.response).status).toBe(403);
    wrongOrigin.close();

    const authorized = await RawWebSocketProbe.connect(port, { Origin: frontendOrigin, Cookie: cookie });
    expect((await authorized.response).status).toBe(101);
    const snapshot = await authorized.nextFrame();
    expect(snapshot.opcode).toBe(1);
    expect(snapshot.payload.toString("utf8")).toContain(missionId);
    credentialStore.revoke("read-client");
    expect((await rpc("local_control.read", { operation: "status" }, readToken)).status).toBe(401);
    const closed = await authorized.nextFrame(2_000);
    expect(closed.opcode).toBe(8);
    authorized.close();
  });

  it("owns one authorization interval only while authenticated WebSocket streams are active", async () => {
    const targetPort = await unusedPort();
    const timerToken = credentialStore.provision("timer-lifecycle-client", ["mission.read"], Date.now() + 60_000).token;
    const timerServer = new DaemonServer(
      daemonStorage,
      { port: targetPort, host: "127.0.0.1" },
      new EventBus(),
      missionStore,
      undefined,
      undefined,
      undefined,
      authorizer,
    );
    const setIntervalSpy = spyOn(globalThis, "setInterval");
    const clearIntervalSpy = spyOn(globalThis, "clearInterval");
    let first: RawWebSocketProbe | undefined;
    let second: RawWebSocketProbe | undefined;
    try {
      await timerServer.start();
      const authIntervals = () => setIntervalSpy.mock.calls.filter((call) => call[1] === 500);
      expect(authIntervals()).toHaveLength(0);
      expect((await fetch(`http://127.0.0.1:${targetPort}/health`)).status).toBe(200);
      const versionResponse = await fetch(`http://127.0.0.1:${targetPort}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${timerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "system.version", method: "system.version", params: {} }),
      });
      expect(versionResponse.status).toBe(200);
      expect(authIntervals()).toHaveLength(0);

      const anonymous = await RawWebSocketProbe.connect(targetPort, {});
      expect((await anonymous.response).status).toBe(401);
      anonymous.close();
      const wrongScope = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${controlToken}` });
      expect((await wrongScope.response).status).toBe(403);
      wrongScope.close();
      const wrongOrigin = await RawWebSocketProbe.connect(targetPort, {
        Authorization: `Bearer ${timerToken}`,
        Origin: "http://attacker.invalid",
      });
      expect((await wrongOrigin.response).status).toBe(403);
      wrongOrigin.close();
      expect(authIntervals()).toHaveLength(0);

      first = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${timerToken}` });
      expect((await first.response).status).toBe(101);
      expect((await first.nextFrame()).payload.toString("utf8")).toContain(missionId);
      expect(authIntervals()).toHaveLength(1);

      second = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${timerToken}` });
      expect((await second.response).status).toBe(101);
      expect((await second.nextFrame()).payload.toString("utf8")).toContain(missionId);
      expect(authIntervals()).toHaveLength(1);

      first.close();
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      expect(clearIntervalSpy).not.toHaveBeenCalled();
      second.close();
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

      for (let reconnectCount = 0; reconnectCount < 3; reconnectCount += 1) {
        const reconnect = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${timerToken}` });
        expect((await reconnect.response).status).toBe(101);
        expect((await reconnect.nextFrame()).payload.toString("utf8")).toContain(missionId);
        expect(authIntervals()).toHaveLength(2 + reconnectCount);
        reconnect.close();
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        expect(clearIntervalSpy).toHaveBeenCalledTimes(2 + reconnectCount);
      }
    } finally {
      first?.close();
      second?.close();
      await timerServer.stop();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("bounds concurrent projection clients and releases capacity without affecting healthy streams or RPC", async () => {
    const targetPort = await unusedPort();
    const targetEventBus = new EventBus();
    const delegate = new RpcGateway(daemonStorage, targetEventBus, missionStore);
    let snapshotReads = 0;
    let releaseSnapshots!: () => void;
    const snapshotsReleased = new Promise<void>((resolve) => { releaseSnapshots = resolve; });
    const gatedGateway: DaemonRpcGatewayPort = {
      registerMethod: (name, handler) => delegate.registerMethod(name, handler),
      handleRequest: (request) => delegate.handleRequest(request),
      getProjectionSnapshot: async (cursor) => {
        snapshotReads += 1;
        await snapshotsReleased;
        return delegate.getProjectionSnapshot(cursor);
      },
    };
    const boundedServer = new DaemonServer(
      daemonStorage,
      { port: targetPort, host: "127.0.0.1", maxProjectionClients: 2 },
      targetEventBus,
      missionStore,
      gatedGateway,
      undefined,
      undefined,
      authorizer,
    );
    const setIntervalSpy = spyOn(globalThis, "setInterval");
    const authIntervals = () => setIntervalSpy.mock.calls.filter((call) => call[1] === 500);
    const firstToken = credentialStore.provision("capacity-first", ["mission.read"], Date.now() + 60_000).token;
    const secondToken = credentialStore.provision("capacity-second", ["mission.read"], Date.now() + 60_000).token;
    const thirdToken = credentialStore.provision("capacity-third", ["mission.read"], Date.now() + 60_000).token;
    const fourthToken = credentialStore.provision("capacity-fourth", ["mission.read"], Date.now() + 60_000).token;
    const rpcToken = credentialStore.provision("capacity-rpc", ["mission.read"], Date.now() + 60_000).token;
    let first: RawWebSocketProbe | undefined;
    let second: RawWebSocketProbe | undefined;
    let overCapacity: RawWebSocketProbe | undefined;
    let replacement: RawWebSocketProbe | undefined;
    let afterDisconnect: RawWebSocketProbe | undefined;
    try {
      await boundedServer.start();
      [first, second] = await Promise.all([
        RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${firstToken}` }),
        RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${secondToken}` }),
      ]);
      expect((await Promise.all([first.response, second.response])).map(({ status }) => status)).toEqual([101, 101]);
      await waitForCondition(() => snapshotReads === 2);
      expect(authIntervals()).toHaveLength(1);

      const missionStateBeforeCapacityRejection = (await missionStore.getMission(missionId))?.state;
      overCapacity = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${thirdToken}` });
      const rejected = await overCapacity.response;
      expect(rejected.status).toBe(503);
      expect(JSON.parse(rejected.body)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: "SERVICE_UNAVAILABLE", message: "WebSocket client capacity is unavailable" },
      });
      expect(rejected.headers).not.toContain("Set-Cookie");
      expect(snapshotReads).toBe(2);
      expect(authIntervals()).toHaveLength(1);
      expect(rejected.body).not.toContain(missionId);
      expect(rejected.headers).not.toContain(missionId);
      expect(rejected.headers).not.toContain(firstToken);
      expect(rejected.body).not.toContain(firstToken);
      expect((await missionStore.getMission(missionId))?.state).toBe(missionStateBeforeCapacityRejection);

      const anonymous = await RawWebSocketProbe.connect(targetPort, {});
      expect((await anonymous.response).status).toBe(401);
      anonymous.close();
      const wrongScope = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${controlToken}` });
      expect((await wrongScope.response).status).toBe(403);
      wrongScope.close();
      const wrongOrigin = await RawWebSocketProbe.connect(targetPort, {
        Authorization: `Bearer ${thirdToken}`,
        Origin: "http://attacker.invalid",
      });
      expect((await wrongOrigin.response).status).toBe(403);
      wrongOrigin.close();
      expect(snapshotReads).toBe(2);
      expect(authIntervals()).toHaveLength(1);

      const rpcWhileFull = await fetch(`http://127.0.0.1:${targetPort}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${rpcToken}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "system.version", method: "system.version", params: {} }),
      });
      expect(rpcWhileFull.status).toBe(200);

      credentialStore.provision("capacity-first", ["mission.control"], Date.now() + 60_000);
      expect((await first.nextFrame(2_000)).opcode).toBe(8);
      replacement = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${thirdToken}` });
      expect((await replacement.response).status).toBe(101);
      await waitForCondition(() => snapshotReads === 3);
      expect(authIntervals()).toHaveLength(1);

      releaseSnapshots();
      expect((await second.nextFrame()).payload.toString("utf8")).toContain(missionId);
      expect((await replacement.nextFrame()).payload.toString("utf8")).toContain(missionId);
      targetEventBus.emit("daemon", { type: "ready", port: targetPort });
      expect((await second.nextFrame()).payload.toString("utf8")).toContain('"event":"daemon"');
      expect((await replacement.nextFrame()).payload.toString("utf8")).toContain('"event":"daemon"');

      replacement.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      afterDisconnect = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${fourthToken}` });
      expect((await afterDisconnect.response).status).toBe(101);
      expect((await afterDisconnect.nextFrame()).payload.toString("utf8")).toContain(missionId);
      expect(snapshotReads).toBe(4);
      expect(authIntervals()).toHaveLength(1);
      targetEventBus.emit("daemon", { type: "ready", port: targetPort });
      expect((await second.nextFrame()).payload.toString("utf8")).toContain('"event":"daemon"');
      expect((await afterDisconnect.nextFrame()).payload.toString("utf8")).toContain('"event":"daemon"');
    } finally {
      releaseSnapshots();
      first?.close();
      second?.close();
      overCapacity?.close();
      replacement?.close();
      afterDisconnect?.close();
      await boundedServer.stop();
      setIntervalSpy.mockRestore();
    }
  });

  it("closes a failed snapshot peer without a response and terminates upgraded WebSockets on shutdown", async () => {
    const targetPort = await unusedPort();
    const targetEventBus = new EventBus();
    const delegate = new RpcGateway(daemonStorage, targetEventBus, missionStore);
    let snapshotReads = 0;
    const failingOnceGateway: DaemonRpcGatewayPort = {
      registerMethod: (name, handler) => delegate.registerMethod(name, handler),
      handleRequest: (request) => delegate.handleRequest(request),
      getProjectionSnapshot: async (cursor) => {
        snapshotReads += 1;
        if (snapshotReads === 1) throw new Error("private snapshot failure");
        return delegate.getProjectionSnapshot(cursor);
      },
    };
    const boundedServer = new DaemonServer(
      daemonStorage,
      { port: targetPort, host: "127.0.0.1", maxProjectionClients: 1 },
      targetEventBus,
      missionStore,
      failingOnceGateway,
      undefined,
      undefined,
      authorizer,
    );
    const projection = (boundedServer as unknown as { projection: DaemonProjection }).projection;
    const firstToken = credentialStore.provision("snapshot-close", ["mission.read"], Date.now() + 60_000).token;
    const secondToken = credentialStore.provision("snapshot-retry", ["mission.read"], Date.now() + 60_000).token;
    let failed: RawWebSocketProbe | undefined;
    let recovered: RawWebSocketProbe | undefined;
    let shutdownClient: RawWebSocketProbe | undefined;
    try {
      await boundedServer.start();
      failed = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${firstToken}` });
      expect((await failed.response).status).toBe(101);
      expect((await failed.nextFrame()).opcode).toBe(8);
      expect(projection.connectedClientCount).toBe(0);
      await waitForCondition(() => projection.admittedClientCount === 0);

      recovered = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${secondToken}` });
      expect((await recovered.response).status).toBe(101);
      expect(JSON.parse((await recovered.nextFrame()).payload.toString("utf8")).event).toBe("snapshot");

      const recoveredClosed = new Promise<void>((resolveClosed) => recovered!.socket.once("close", () => resolveClosed()));
      recovered.close();
      await recoveredClosed;
      await waitForCondition(() => projection.admittedClientCount === 0);
      shutdownClient = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${firstToken}` });
      expect((await shutdownClient.response).status).toBe(101);
      await shutdownClient.nextFrame();
      const shutdownClosed = new Promise<void>((resolveClosed) => shutdownClient!.socket.once("close", () => resolveClosed()));
      await boundedServer.stop();
      await shutdownClosed;
      expect(shutdownClient.socket.destroyed).toBe(true);
      await waitForCondition(() => projection.admittedClientCount === 0);
    } finally {
      failed?.close();
      recovered?.close();
      shutdownClient?.close();
      await boundedServer.stop();
    }
  });

  it("releases a reservation when the HTTP transport aborts during an asynchronous pre-upgrade hook", async () => {
    const targetPort = await unusedPort();
    const targetEventBus = new EventBus();
    const delegate = new RpcGateway(daemonStorage, targetEventBus, missionStore);
    const targetServer = new DaemonServer(
      daemonStorage,
      { port: targetPort, host: "127.0.0.1", maxProjectionClients: 1 },
      targetEventBus,
      missionStore,
      delegate,
      undefined,
      undefined,
      authorizer,
    );
    const projection = (targetServer as unknown as { projection: DaemonProjection }).projection;
    const app = (targetServer as unknown as { app: FastifyInstance }).app;
    let releaseFirstHook!: () => void;
    const firstHookGate = new Promise<void>((resolveGate) => { releaseFirstHook = resolveGate; });
    let hookCalls = 0;
    let firstHookStarted!: () => void;
    const firstHookObserved = new Promise<void>((resolveObserved) => { firstHookStarted = resolveObserved; });
    app.addHook("preHandler", async (request) => {
      if (request.url !== "/ws") return;
      hookCalls += 1;
      if (hookCalls === 1) {
        firstHookStarted();
        await firstHookGate;
      }
    });
    const firstToken = credentialStore.provision("upgrade-abort-first", ["mission.read"], Date.now() + 60_000).token;
    const secondToken = credentialStore.provision("upgrade-abort-second", ["mission.read"], Date.now() + 60_000).token;
    let aborted: RawWebSocketProbe | undefined;
    let admitted: RawWebSocketProbe | undefined;
    try {
      await targetServer.start();
      aborted = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${firstToken}` });
      void aborted.response.catch(() => undefined);
      await firstHookObserved;
      expect(projection.admittedClientCount).toBe(1);
      const abortedClosed = new Promise<void>((resolveClosed) => aborted!.socket.once("close", () => resolveClosed()));
      aborted.close();
      await abortedClosed;
      await waitForCondition(() => projection.admittedClientCount === 0);

      admitted = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${secondToken}` });
      expect((await admitted.response).status).toBe(101);
      expect((await admitted.nextFrame()).payload.toString("utf8")).toContain('"event":"snapshot"');
    } finally {
      releaseFirstHook();
      aborted?.close();
      admitted?.close();
      await targetServer.stop();
    }
  });

  it("closes streams after credential rotation, expiry, or mission.read scope loss before forwarding events", async () => {
    const cases = [
      {
        clientId: "rotation-stream",
        invalidate: () => credentialStore.provision("rotation-stream", ["mission.read"], Date.now() + 60_000),
      },
      {
        clientId: "scope-loss-stream",
        invalidate: () => credentialStore.provision("scope-loss-stream", ["mission.control"], Date.now() + 60_000),
      },
    ];
    for (const scenario of cases) {
      const credential = credentialStore.provision(scenario.clientId, ["mission.read"], Date.now() + 60_000);
      const stream = await RawWebSocketProbe.connect(port, { Authorization: `Bearer ${credential.token}` });
      expect((await stream.response).status).toBe(101);
      expect((await stream.nextFrame()).payload.toString("utf8")).toContain(missionId);
      scenario.invalidate();
      eventBus.emit("daemon", { type: "ready", port });
      const close = await stream.nextFrame(2_000);
      expect(close.opcode).toBe(8);
      expect(close.payload.toString("utf8")).not.toContain(credential.token);
      stream.close();
    }

    const expiring = credentialStore.provision("expiry-stream", ["mission.read"], Date.now() + 900);
    const expiringStream = await RawWebSocketProbe.connect(port, { Authorization: `Bearer ${expiring.token}` });
    expect((await expiringStream.response).status).toBe(101);
    expect((await expiringStream.nextFrame()).payload.toString("utf8")).toContain(missionId);
    const expiryClose = await expiringStream.nextFrame(2_000);
    expect(expiryClose.opcode).toBe(8);
    expect(expiryClose.payload.toString("utf8")).not.toContain(expiring.token);
    expiringStream.close();
  });

  it("removes daemon listeners after a listener startup failure", async () => {
    const failedEventBus = new EventBus();
    const failedServer = new DaemonServer(
      daemonStorage,
      { port, host: "127.0.0.1" },
      failedEventBus,
      missionStore,
      undefined,
      undefined,
      undefined,
      authorizer,
    );
    await expect(failedServer.start()).rejects.toThrow();
    expect(failedEventBus.listenerCount("*")).toBe(0);
    await failedServer.stop();
    expect(failedEventBus.listenerCount("*")).toBe(0);
  });

  it("isolates a revalidation exception to its WebSocket client and sanitizes diagnostics", async () => {
    const targetPort = await unusedPort();
    const failureCanary = "PRIVATE_REVALIDATION_FAILURE_CANARY";
    let faultyClientChecks = 0;
    const faultyAuthorization = new Proxy(authorizer, {
      get(target, property, receiver) {
        if (property === "isClientStillAuthorized") {
          return (principal: { clientId: string }, scope: "mission.read" | "mission.control" | "daemon.admin") => {
            if (principal.clientId === "faulty-stream") {
              faultyClientChecks += 1;
              if (faultyClientChecks > 2) throw new Error(failureCanary);
            }
            return target.isClientStillAuthorized(principal, scope);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const isolatedEventBus = new EventBus();
    const logMessages: string[] = [];
    const unsubscribeLogs = isolatedEventBus.on("log", (entry) => logMessages.push(entry.message));
    const isolatedServer = new DaemonServer(
      daemonStorage,
      { port: targetPort, host: "127.0.0.1" },
      isolatedEventBus,
      missionStore,
      undefined,
      undefined,
      undefined,
      faultyAuthorization,
    );
    let faultyStream: RawWebSocketProbe | undefined;
    let healthyStream: RawWebSocketProbe | undefined;
    try {
      const faultyToken = credentialStore.provision("faulty-stream", ["mission.read"], Date.now() + 60_000).token;
      const healthyToken = credentialStore.provision("healthy-stream", ["mission.read"], Date.now() + 60_000).token;
      await isolatedServer.start();
      faultyStream = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${faultyToken}` });
      healthyStream = await RawWebSocketProbe.connect(targetPort, { Authorization: `Bearer ${healthyToken}` });
      expect((await faultyStream.response).status).toBe(101);
      expect((await healthyStream.response).status).toBe(101);
      expect((await faultyStream.nextFrame()).payload.toString("utf8")).toContain(missionId);
      expect((await healthyStream.nextFrame()).payload.toString("utf8")).toContain(missionId);
      expect((await faultyStream.nextFrame(1_500)).opcode).toBe(8);

      isolatedEventBus.emit("daemon", { type: "ready", port: targetPort });
      const healthyEvents: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const frame = await healthyStream.nextFrame(1_000);
        if (frame.opcode !== 1) break;
        const payload = frame.payload.toString("utf8");
        healthyEvents.push(payload);
        if (payload.includes('"event":"daemon"')) break;
      }
      expect(healthyEvents.some((payload) => payload.includes('"event":"daemon"'))).toBe(true);
      expect(healthyEvents.join(" ")).not.toContain(failureCanary);
      expect(logMessages.join(" ")).not.toContain(failureCanary);
      expect(JSON.stringify(logMessages)).not.toContain(faultyToken);
    } finally {
      faultyStream?.close();
      healthyStream?.close();
      await isolatedServer.stop();
      unsubscribeLogs();
    }
  });

  it("routes the browser exchange through real Vite and reconnects through the proxied WS snapshot", async () => {
    const originalFetch = globalThis.fetch;
    let setCookie: string | null = null;
    let exchangeUrl = "";
    let exchangeAuthorization = "";
    const frontendFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Origin", frontendOrigin);
      exchangeUrl = String(input);
      exchangeAuthorization = headers.get("authorization") ?? "";
      const response = await originalFetch(input, { ...init, headers });
      setCookie = response.headers.get("set-cookie");
      return response;
    };
    setDaemonBearerToken(multiScopeToken);
    const websocketUrl = `ws://${frontendOrigin.slice("http://".length)}/ws`;
    try {
      await establishDaemonBrowserSession(websocketUrl, { baseUrl: `${frontendOrigin}/`, fetchImpl: frontendFetch });
      expect(exchangeUrl).toBe(`${frontendOrigin}/auth/browser-session`);
      expect(new URL(websocketUrl).search).toBe("");
      expect(exchangeAuthorization).toBe(`Bearer ${multiScopeToken}`);
      expect(setCookie).toContain("HttpOnly");
      const firstCookie = setCookie!.split(";", 1)[0]!;
      const firstConnection = await RawWebSocketProbe.connect(frontendPort, {
        Origin: frontendOrigin,
        Cookie: firstCookie,
      }, "initial Vite proxy");
      expect((await firstConnection.response).status).toBe(101);
      expect((await firstConnection.nextFrame()).payload.toString("utf8")).toContain(missionId);
      firstConnection.close();

      setCookie = null;
      await establishDaemonBrowserSession(websocketUrl, { baseUrl: `${frontendOrigin}/`, fetchImpl: frontendFetch });
      expect(setCookie).toContain("HttpOnly");
      const reconnectCookie = setCookie!.split(";", 1)[0]!;
      expect(reconnectCookie).not.toBe(firstCookie);
      const reconnected = await RawWebSocketProbe.connect(frontendPort, {
        Origin: frontendOrigin,
        Cookie: reconnectCookie,
      }, "reconnected Vite proxy");
      expect((await reconnected.response).status).toBe(101);
      expect((await reconnected.nextFrame()).payload.toString("utf8")).toContain(missionId);
      reconnected.close();
    } finally {
      setDaemonBearerToken("");
    }
  }, 15_000);

  it("keeps public health metadata minimal and rejects Origin outside the explicit allowlist", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin: "http://attacker.invalid" } });
    expect(response.status).toBe(403);
    const publicHealth = await fetch(`http://127.0.0.1:${port}/health`);
    expect(publicHealth.status).toBe(200);
    const body = await publicHealth.json();
    expect(body).toHaveProperty("status", "ok");
    expect(JSON.stringify(body)).not.toContain(missionId);
  });
});
