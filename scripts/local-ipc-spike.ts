#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { createServer, createConnection } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { SqliteMissionStore } from "../cli/src/mission/sqlite-mission-store.js";
import type { Mission } from "../cli/src/mission/contracts.js";
import { DaemonServer } from "../cli/src/daemon/server.js";
import { EventBus } from "../cli/src/daemon/event-bus.js";
import { DAEMON_EVENT_VERSION } from "../shared/daemon-event-contract.js";
import { LocalControlReadService } from "../cli/src/daemon/local-control-read.js";
import type { DaemonRpcGatewayPort } from "../cli/src/daemon/rpc-gateway.js";
import type { StoragePort } from "../cli/src/ports/storage.port.js";
import { LocalControlUdsServer, requestLocalControlUds } from "../cli/src/daemon/local-control-uds.js";
import type { LocalControlReadRequest } from "../shared/local-control-read-contract.js";

const repetitions = Number(process.argv[2] ?? 5);
const requests = Number(process.argv[3] ?? 50);
const idleSeconds = Number(process.argv[4] ?? 3);
const outputPath = process.argv[5] ?? "docs/evidence/local-ipc-spike-2026-10-07.json";
if (!Number.isSafeInteger(repetitions) || repetitions < 5 || !Number.isSafeInteger(requests) || requests < 10 || !Number.isFinite(idleSeconds) || idleSeconds < 1) {
  throw new Error("usage: bun scripts/local-ipc-spike.ts [repetitions>=5] [requests>=10] [idle-seconds>=1] [output-path]");
}

const status = {
  processStatus: "alive", mode: "running", uptimeSeconds: 1,
  activeSessions: { available: true, value: 0, unit: "count" },
  activeWaves: { available: true, value: 0, unit: "count" },
  activeTasks: { available: true, value: 0, unit: "count" },
  tokensUsed: { available: false, reason: "not_available" },
  memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1 },
  capabilities: { statusMetrics: true, modeSwitching: true, supportedModes: ["running", "pause"], emergencyBrake: true, brakeRecoverable: false, modePersistence: true, tokenMetrics: false },
  timestamp: "2026-10-07T00:00:00.000Z",
} as const;

const storage = {} as StoragePort;
function makeMission(): Mission {
  return {
    missionId: "fixture-ipc-ready", schemaVersion: 1, source: "operator",
    originalIntent: "fixture intent", sanitizedOriginalIntent: "fixture intent", originalIntentRef: "sha256:fixture",
    interpretedObjective: "fixture objective", constraints: [], acceptanceCriteria: ["fixture accepted"],
    budgetPolicy: {}, allowedCapabilityScope: { capabilityIds: [], allowedEffectClasses: [], allowedRefPrefixes: [] },
    approvalRequirements: [], contextRefs: [], state: "ready", currentPlanRevisionId: null,
    invocationRefs: [], evidenceRefs: [], criterionVerifications: [], unresolvedQuestions: [],
    createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z",
    recoveryMetadata: { recovered: false, recoveryCount: 0 },
  } as Mission;
}

async function port(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("ephemeral TCP listener has no address");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !["timestamp", "processId", "processTitle", "runtimeVersion", "uptimeSeconds"].includes(key))
    .map(([key, child]) => [key, normalize(child)]));
}

function summarize(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  return { min: ordered[0], median: ordered[Math.floor(ordered.length / 2)], max: ordered.at(-1), samples: values };
}

async function loopback(url: string, request: LocalControlReadRequest): Promise<unknown> {
  const response = await fetch(`${url}/rpc`, {
    method: "POST", headers: { "Content-Type": "application/json", "Connection": "close" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "bench", method: "local_control.read", params: request }),
  });
  if (!response.ok) throw new Error(`loopback returned HTTP ${response.status}`);
  const envelope = await response.json() as { result?: unknown; error?: unknown };
  if (envelope.error || envelope.result === undefined) throw new Error("loopback JSON-RPC failed");
  return envelope.result;
}

async function idleWebSocket(url: string): Promise<{ close(): void; bytes: number }> {
  const socket = new WebSocket(url.replace("http://", "ws://").concat("/ws"));
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket idle handshake timed out")), 3000);
    socket.addEventListener("message", (event) => {
      bytes += typeof event.data === "string" ? Buffer.byteLength(event.data) : 0;
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket idle connection failed")); }, { once: true });
  });
  return { close: () => socket.close(), get bytes() { return bytes; } };
}

async function idleUds(socketPath: string): Promise<{ close(): void; bytes: number }> {
  const socket = createConnection(socketPath);
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify({ operation: "health", protocolVersion: 1 })}\n`));
    socket.on("data", (chunk) => {
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (typeof chunk === "string" ? chunk.includes("\n") : chunk.includes(0x0a)) resolve();
    });
  });
  return { close: () => socket.destroy(), get bytes() { return bytes; } };
}

const operations: LocalControlReadRequest[] = [
  { operation: "protocol.negotiate", supportedVersions: [1] },
  { operation: "health", protocolVersion: 1 },
  { operation: "status", protocolVersion: 1 },
  { operation: "mission.list", protocolVersion: 1, limit: 10 },
  { operation: "mission.show", protocolVersion: 1, missionId: "fixture-ipc-ready" },
  { operation: "invocation.list", protocolVersion: 1, limit: 10 },
  { operation: "invocation.show", protocolVersion: 1, invocationId: "fixture-ipc-missing" },
  { operation: "capability_registry.list", protocolVersion: 1, limit: 10 },
  { operation: "diagnostics.list", protocolVersion: 1, limit: 10 },
];

const timings: Record<string, number[]> = {
  loopbackStartMs: [], udsStartMs: [], loopbackShutdownMs: [], udsShutdownMs: [],
  loopbackListenerRestartMs: [], udsListenerRestartMs: [],
  loopbackClientReconnectMs: [], udsClientReconnectMs: [],
  ...Object.fromEntries(operations.map((request) => [`loopback:${request.operation}`, [] as number[]])),
  ...Object.fromEntries(operations.map((request) => [`uds:${request.operation}`, [] as number[]])),
};
const idleSamples: Array<Record<string, unknown>> = [];
const payloadSizes: Record<string, { requestBytes: number; responseBytes: number }> = {};
const tempPaths: string[] = [];

for (let iteration = 0; iteration < repetitions; iteration += 1) {
  const directory = await mkdtemp(join(tmpdir(), "ouroboros-ipc-bench-"));
  tempPaths.push(directory);
  const socketPath = join(directory, "control.sock");
  const missions = new SqliteMissionStore(join(directory, "missions.db"));
  await missions.initialize();
  await missions.createMission(makeMission());
  const service = new LocalControlReadService({
    getStatus: () => status,
    getRuntimeIdentity: () => ({ processId: process.pid, processTitle: process.title, runtime: "bun", runtimeVersion: Bun.version }),
    missionStore: missions,
  });
  const gateway: DaemonRpcGatewayPort = {
    registerMethod: () => undefined,
    handleRequest: async (request) => ({ jsonrpc: "2.0", id: request.id, result: await service.read(request.params) }),
    getProjectionSnapshot: async (cursor = 0) => {
      const facts = await service.readProjectionFacts();
      return {
        protocolVersion: DAEMON_EVENT_VERSION,
        transportCapabilities: {
          orderedEvents: true, authoritativeSnapshot: true, resync: true,
          durableMissions: facts.durableProjectionAvailable, durableInvocations: facts.durableProjectionAvailable,
        },
        cursor, status: facts.status, capabilities: facts.status.capabilities,
        missions: facts.missions, invocations: facts.invocations, completeness: facts.completeness,
      };
    },
  };
  const httpPort = await port();
  const createHttp = () => new DaemonServer(storage, { port: httpPort, host: "127.0.0.1" }, new EventBus(), missions, gateway);
  let http = createHttp();
  const uds = new LocalControlUdsServer({ socketPath, read: (request) => service.read(request) });
  const startupOrder = iteration % 2 === 0 ? ["loopback", "uds"] : ["uds", "loopback"];
  for (const transport of startupOrder) {
    const start = performance.now();
    if (transport === "loopback") await http.start(); else await uds.start();
    timings[`${transport}StartMs`].push(performance.now() - start);
  }

  const url = `http://127.0.0.1:${httpPort}`;
  for (const request of operations) {
    for (let sample = 0; sample < requests; sample += 1) {
      let loopResult: unknown;
      let udsResult: unknown;
      const order = (iteration + sample) % 2 === 0 ? ["loopback", "uds"] : ["uds", "loopback"];
      for (const transport of order) {
        const start = performance.now();
        if (transport === "loopback") loopResult = await loopback(url, request);
        else udsResult = await requestLocalControlUds(socketPath, request);
        timings[`${transport}:${request.operation}`].push(performance.now() - start);
      }
      if (JSON.stringify(normalize(loopResult)) !== JSON.stringify(normalize(udsResult))) {
        throw new Error(`semantic parity failed for ${request.operation}`);
      }
      payloadSizes[request.operation] = {
        requestBytes: Buffer.byteLength(JSON.stringify(request)),
        responseBytes: Buffer.byteLength(JSON.stringify(udsResult)),
      };
    }
  }

  const rssBeforeConnect = process.memoryUsage().rss;
  const ws = await idleWebSocket(url);
  const udsClient = await idleUds(socketPath);
  const rssAfterConnect = process.memoryUsage().rss;
  const usageBefore = process.cpuUsage();
  const intervalStart = performance.now();
  await new Promise((resolve) => setTimeout(resolve, idleSeconds * 1000));
  const idleDurationSeconds = (performance.now() - intervalStart) / 1000;
  const cpu = process.cpuUsage(usageBefore);
  const rssAfterIdle = process.memoryUsage().rss;
  idleSamples.push({
    repetition: iteration + 1,
    idleDurationSeconds,
    aggregateProcessCpuSeconds: (cpu.user + cpu.system) / 1_000_000,
    processRssBeforeConnectBytes: rssBeforeConnect,
    processRssAfterConnectBytes: rssAfterConnect,
    pairedClientRssDeltaBytes: rssAfterConnect - rssBeforeConnect,
    processRssAfterIdleBytes: rssAfterIdle,
    idleRssDeltaBytes: rssAfterIdle - rssAfterConnect,
    websocketHandshakeAndSnapshotBytes: ws.bytes,
    udsHealthResponseBytes: udsClient.bytes,
    idleClients: 1,
  });
  ws.close();
  udsClient.close();

  const shutdownOrder = iteration % 2 === 0 ? ["loopback", "uds"] : ["uds", "loopback"];
  for (const transport of shutdownOrder) {
    const start = performance.now();
    if (transport === "loopback") await http.stop(); else await uds.stop();
    timings[`${transport}ShutdownMs`].push(performance.now() - start);
  }
  const restartOrder = iteration % 2 === 0 ? ["loopback", "uds"] : ["uds", "loopback"];
  for (const transport of restartOrder) {
    const start = performance.now();
    if (transport === "loopback") {
      http = createHttp();
      await http.start();
    } else {
      await uds.start();
    }
    timings[`${transport}ListenerRestartMs`].push(performance.now() - start);
  }
  const loopReconnectStart = performance.now();
  const reconnectWs = await idleWebSocket(url);
  timings.loopbackClientReconnectMs.push(performance.now() - loopReconnectStart);
  reconnectWs.close();
  const udsReconnectStart = performance.now();
  const reconnectUds = await idleUds(socketPath);
  timings.udsClientReconnectMs.push(performance.now() - udsReconnectStart);
  reconnectUds.close();
  await Promise.all([http.stop(), uds.stop()]);
  await missions.close();
}

const wakeupProbe = spawnSync("perf", ["stat", "-e", "sched:sched_wakeup,sched:sched_wakeup_new", "--", "true"], { encoding: "utf8" });
const tracepointsDenied = wakeupProbe.status === 129 || /No permissions to read .*sched_wakeup/.test(wakeupProbe.stderr ?? "");
const wakeups = {
  status: "unavailable",
  reason: tracepointsDenied
    ? "Host denied access to sched_wakeup tracepoints; perf probe exited 129."
    : "Tracepoint availability was probed, but this harness does not wrap its full paired measurement window in perf.",
  probeExitCode: wakeupProbe.status,
};
const environment = {
  kernel: execFileSync("uname", ["-sr"], { encoding: "utf8" }).trim(),
  architecture: process.arch,
  logicalCpuCount: cpus().length,
  memoryTotalBytes: totalmem(),
  bunVersion: Bun.version,
  nodeCompatibilityVersion: process.version,
  pythonVersion: execFileSync("python3", ["--version"], { encoding: "utf8" }).trim(),
};
const output = {
  schema: "ouroboros.local-ipc-spike/v1",
  baseSha: execFileSync("git", ["merge-base", "origin/main", "HEAD"], { encoding: "utf8" }).trim(),
  measuredHeadSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  workingTreeDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
  environment,
  method: {
    repetitions, requestsPerOperationPerTransport: requests, idleSeconds,
    fixture: "one isolated SQLite-backed ready Mission, no Invocation, no effects",
    startupAndShutdownOrder: "alternates each repetition; request order alternates within each paired sample; both listeners run in the same Bun process",
    latency: "sequential request round trips; connection establishment included for each request",
    payloadSizesBytes: payloadSizes,
    idleCpuAndRss: "aggregate process measurement with one loopback WebSocket and one connected UDS client open together",
    lifecycle: "listener startup, stop, same-process rebind, and reconnecting one client; does not measure daemon process startup",
  },
  measurements: {
    timings: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, summarize(values)])),
    pairedIdleSamples: idleSamples,
    wakeups,
  },
  limitations: [
    "WebSocket event streaming and typed Mission commands are not compared by this read-only UDS adapter.",
    "Loopback idle bytes include the WebSocket handshake snapshot; UDS idle bytes include one health response, so these byte counts are not equivalent payloads.",
    "CPU and RSS are process-wide paired observations and cannot be attributed to one transport.",
    "Listener startup/shutdown excludes daemon process creation and SQLite initialization; the existing #105 baseline is not paired because its code/runtime context differs.",
    "Linux peer credentials are not exposed by the Node/Bun net.Socket API used here; access control evidence is the private owner-only directory/socket mode.",
  ],
};
await Bun.write(outputPath, `${JSON.stringify(output, null, 2)}\n`);
for (const path of tempPaths) await rm(path, { recursive: true, force: true });
console.log(JSON.stringify({ outputPath, repetitions, requestCountPerTransport: requests * operations.length * repetitions, wakeups: output.measurements.wakeups.status }));
