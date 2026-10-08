import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { SqliteAdapter } from "../adapters/sqlite.adapter.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import { MissionEngine } from "../mission/mission-engine.js";
import { PlanPolicyValidator } from "../mission/policy.js";
import { FakeCapabilityResolver } from "../mission/testing.js";
import { DaemonServer } from "./server.js";
import { EventBus } from "./event-bus.js";
import { LocalControlAuthorizer, LocalControlCredentialStore, getBrowserSessionCookieName } from "./local-control-auth.js";
import type { LocalControlAuthScope } from "../../../shared/local-control-auth-contract.js";
import { LocalControlReadClient, LoopbackJsonRpcTransport } from "../commands/local-control-client.js";
import { writeLocalControlClientCredential } from "./local-control-auth.js";

interface RawFrame { opcode: number; payload: Buffer; }

class RawWebSocketProbe {
  private buffer = Buffer.alloc(0);
  private frames: RawFrame[] = [];
  private frameWaiters: Array<(frame: RawFrame) => void> = [];
  private headerResolver!: (response: { status: number; headers: string }) => void;
  readonly response = new Promise<{ status: number; headers: string }>((resolve) => { this.headerResolver = resolve; });

  constructor(readonly socket: Socket) {
    socket.on("data", (chunk) => this.onData(Buffer.from(chunk)));
  }

  static async connect(port: number, headers: Record<string, string>): Promise<RawWebSocketProbe> {
    const socket = createConnection({ host: "127.0.0.1", port });
    const probe = new RawWebSocketProbe(socket);
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
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const separator = this.buffer.indexOf("\r\n\r\n");
    if (separator >= 0 && !this.headerResolved) {
      this.headerResolved = true;
      const header = this.buffer.subarray(0, separator).toString("utf8");
      this.headerText = header;
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(header)?.[1] ?? 0);
      this.buffer = this.buffer.subarray(separator + 4);
      this.headerResolver({ status, headers: header });
    }
    if (!this.headerResolved || !/^HTTP\/1\.1 101 /.test(this.headerText ?? "")) return;
    this.readFrames();
  }

  private headerResolved = false;
  private headerText: string | null = null;

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

describe("local-control authentication over real Fastify and SQLite", () => {
  let directory: string;
  let port: number;
  let daemonStorage: SqliteAdapter;
  let missionStore: SqliteMissionStore;
  let credentialStore: LocalControlCredentialStore;
  let authorizer: LocalControlAuthorizer;
  let server: DaemonServer;
  let missionEngine: MissionEngine;
  let readToken: string;
  let controlToken: string;
  let adminToken: string;
  let missionId: string;

  async function rpc(method: string, params?: unknown, token?: string, origin?: string) {
    return await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    });
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "ouroboros-local-control-auth-e2e-"));
    process.env.OUROBOROS_OPS_PATH = join(directory, "daemon-ops.json");
    port = await unusedPort();
    daemonStorage = new SqliteAdapter(join(directory, "daemon.db"));
    await daemonStorage.initialize();
    missionStore = new SqliteMissionStore(join(directory, "missions.db"));
    await missionStore.initialize();
    credentialStore = new LocalControlCredentialStore(join(directory, "auth", "clients.db"));
    readToken = credentialStore.provision("read-client", ["mission.read"], Date.now() + 60_000).token;
    controlToken = credentialStore.provision("control-client", ["mission.control"], Date.now() + 60_000).token;
    adminToken = credentialStore.provision("admin-client", ["daemon.admin"], Date.now() + 60_000).token;
    authorizer = new LocalControlAuthorizer(credentialStore, ["http://localhost:5173"]);
    const resolver = new FakeCapabilityResolver();
    missionEngine = new MissionEngine({ store: missionStore, policy: new PlanPolicyValidator(resolver) });
    const mission = await missionEngine.createMission({
      intent: { requestId: "authz-e2e-request", source: "cli", originalIntent: "fictional authz canary", constraints: [], acceptanceCriteria: [] },
      allowedCapabilityScope: { capabilityIds: [], allowedEffectClasses: [], allowedRefPrefixes: [] },
    });
    missionId = mission.missionId;
    server = new DaemonServer(
      daemonStorage,
      { port, host: "127.0.0.1" },
      new EventBus(), missionStore, undefined, missionEngine, undefined, authorizer,
    );
    await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    credentialStore?.close();
    await daemonStorage?.close();
    await missionStore?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

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

  it("requires browser Origin and authenticated session before the first WS snapshot", async () => {
    const anonymous = await RawWebSocketProbe.connect(port, { Origin: "http://localhost:5173" });
    expect((await anonymous.response).status).toBe(401);
    anonymous.close();

    const browserSession = await fetch(`http://127.0.0.1:${port}/auth/browser-session`, {
      method: "POST", headers: { authorization: `Bearer ${readToken}`, origin: "http://localhost:5173" },
    });
    expect(browserSession.status).toBe(204);
    const setCookie = browserSession.headers.get("set-cookie");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie!.split(";")[0]!;

    const wrongOrigin = await RawWebSocketProbe.connect(port, { Origin: "http://attacker.invalid", Cookie: cookie });
    expect((await wrongOrigin.response).status).toBe(403);
    wrongOrigin.close();

    const authorized = await RawWebSocketProbe.connect(port, { Origin: "http://localhost:5173", Cookie: cookie });
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
