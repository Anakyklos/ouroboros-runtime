import { describe, expect, it } from "bun:test";
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  type LocalControlReadRequest,
  type LocalControlReadResponse,
} from "../../../shared/local-control-read-contract.js";
import { runAdminCli } from "./admin-cli.js";
import {
  DaemonUnavailableError,
  LocalControlReadClient,
  LoopbackJsonRpcTransport,
  ProtocolVersionMismatchError,
  RpcProtocolError,
  type LocalControlReadTransport,
} from "./local-control-client.js";

const mission = {
  missionId: "mission-1",
  state: "waiting_for_provider",
  source: "cli",
  currentPlanRevisionId: null,
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
  recoveryCount: 0,
  invocationIds: [],
  pendingApprovalCount: 0,
};

const status = {
  processStatus: "alive",
  mode: "running",
  uptimeSeconds: 20,
  activeSessions: { available: false, reason: "not tracked" },
  activeWaves: { available: false, reason: "not tracked" },
  activeTasks: { available: false, reason: "not tracked" },
  tokensUsed: { available: false, reason: "not tracked" },
  memory: { rssBytes: 100, heapUsedBytes: 50, heapTotalBytes: 80 },
  capabilities: { statusMetrics: false, modeSwitching: true, supportedModes: ["running", "pause"], emergencyBrake: true, brakeRecoverable: true, modePersistence: true, tokenMetrics: false },
  timestamp: "2026-10-06T00:00:00.000Z",
};

const descriptor = {
  capabilityId: "runstead.code-review",
  moduleOwner: "runstead",
  contractVersion: 1,
  purpose: "Review code",
  effectClass: "execution",
  requiresApproval: true,
  requiresOwnerVerification: true,
  ownsStorage: false,
  availability: "available",
};

function success(operation: string, data: unknown): LocalControlReadResponse {
  return { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation, data } as LocalControlReadResponse;
}

function negotiation(): LocalControlReadResponse {
  return {
    ok: true,
    protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
    operation: "protocol.negotiate",
    selectedVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
    supportedVersions: [LOCAL_CONTROL_PROTOCOL_VERSION],
  };
}

class ScriptedTransport implements LocalControlReadTransport {
  readonly calls: LocalControlReadRequest[] = [];
  constructor(private readonly responses: Partial<Record<LocalControlReadRequest["operation"], unknown>>) {}

  async request(params: LocalControlReadRequest): Promise<unknown> {
    this.calls.push(params);
    if (params.operation === "protocol.negotiate") return negotiation();
    return this.responses[params.operation];
  }
}

function harness(transport: LocalControlReadTransport) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client = new LocalControlReadClient(transport);
  return {
    stdout,
    stderr,
    run: (args: string[]) => runAdminCli(args, {
      client,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    }),
  };
}

describe("factual admin CLI", () => {
  it("negotiates the versioned contract before reading status", async () => {
    const transport = new ScriptedTransport({ status: success("status", status) });
    const cli = harness(transport);

    expect(await cli.run(["status"])).toBe(0);
    expect(transport.calls.map((call) => call.operation)).toEqual(["protocol.negotiate", "status"]);
    expect(transport.calls[0]).toEqual({ operation: "protocol.negotiate", supportedVersions: [LOCAL_CONTROL_PROTOCOL_VERSION] });
    expect(JSON.parse(cli.stdout[0])).toEqual(status);
  });

  it("reports negotiated protocol and daemon runtime versions", async () => {
    const health = {
      healthy: true,
      runtime: { processId: 42, processTitle: "ouroboros-daemon", runtime: "bun", runtimeVersion: "1.3.9" },
      uptimeSeconds: 99,
      timestamp: "2026-10-06T00:00:00.000Z",
    };
    const transport = new ScriptedTransport({ health: success("health", health) });
    const cli = harness(transport);

    expect(await cli.run(["version"])).toBe(0);
    expect(transport.calls.map((call) => call.operation)).toEqual(["protocol.negotiate", "health"]);
    expect(JSON.parse(cli.stdout[0])).toEqual({ protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, ...health });
  });

  it("lists mission identities and retains completeness facts", async () => {
    const completeness = { liveIncluded: 1, liveOmitted: 0, historicalIncluded: 0, historicalOmitted: 2, truncated: true };
    const cli = harness(new ScriptedTransport({ "mission.list": success("mission.list", { available: true, items: [mission], completeness }) }));

    expect(await cli.run(["missions"])).toBe(0);
    expect(JSON.parse(cli.stdout[0])).toEqual({ available: true, items: [mission], completeness });
  });

  it("shows a found mission using only projected fields", async () => {
    const cli = harness(new ScriptedTransport({ "mission.show": success("mission.show", { available: true, item: mission }) }));

    expect(await cli.run(["mission", "show", "mission-1"])).toBe(0);
    expect(JSON.parse(cli.stdout[0])).toEqual({ result: "found", mission });
    expect(cli.stdout.join("")).not.toMatch(/intent|Council|persona|reasoning|chain.of.thought/i);
  });

  it("reports a missing mission distinctly", async () => {
    const cli = harness(new ScriptedTransport({ "mission.show": success("mission.show", { available: true, item: null }) }));

    expect(await cli.run(["mission", "show", "missing"])).toBe(1);
    expect(JSON.parse(cli.stdout[0])).toEqual({ result: "not found", missionId: "missing" });
    expect(cli.stderr.join("")).toContain("mission not found");
  });

  it("reports unavailable projections distinctly", async () => {
    const cli = harness(new ScriptedTransport({ "mission.show": success("mission.show", { available: false, item: null }) }));

    expect(await cli.run(["mission", "show", "mission-1"])).toBe(1);
    expect(JSON.parse(cli.stdout[0])).toEqual({ result: "projection unavailable", missionId: "mission-1" });
  });

  it("lists public capability registry descriptors", async () => {
    const cli = harness(new ScriptedTransport({ "capability_registry.list": success("capability_registry.list", { available: true, items: [descriptor], truncated: false }) }));

    expect(await cli.run(["capabilities"])).toBe(0);
    expect(JSON.parse(cli.stdout[0]).items[0]).toEqual(descriptor);
  });

  it("fails with a factual daemon-unavailable error", async () => {
    const client = { read: async () => { throw new DaemonUnavailableError(); } } as unknown as LocalControlReadClient;
    const cli = harness({ request: async () => null });
    const stdout: string[] = [];
    const stderr: string[] = [];

    expect(await runAdminCli(["status"], { client, stdout: (v) => stdout.push(v), stderr: (v) => stderr.push(v) })).toBe(1);
    expect(stderr.join("")).toContain("daemon unavailable");
    expect(stdout).toEqual([]);
  });

  it("rejects malformed JSON-RPC responses", async () => {
    const transport = new LoopbackJsonRpcTransport({
      baseUrl: "http://127.0.0.1:7777",
      fetch: async () => new Response("not-json", { status: 200 }),
    });

    await expect(transport.request({ operation: "status", protocolVersion: 1 })).rejects.toBeInstanceOf(RpcProtocolError);
  });

  it("rejects a malformed JSON-RPC envelope", async () => {
    const transport = new LoopbackJsonRpcTransport({
      baseUrl: "http://127.0.0.1:7777",
      fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "wrong", result: {} }), { status: 200 }),
    });

    await expect(transport.request({ operation: "status", protocolVersion: 1 })).rejects.toBeInstanceOf(RpcProtocolError);
  });

  it("classifies malformed local-control payloads separately from RPC envelopes", async () => {
    const transport: LocalControlReadTransport = {
      request: async (request) => request.operation === "protocol.negotiate"
        ? negotiation()
        : { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: "status", data: { processStatus: "alive" } },
    };
    const client = new LocalControlReadClient(transport);
    const errorName = await client.read({ operation: "status" }).then(() => "none", (error: unknown) => (error as Error).name);

    expect(errorName).toBe("LocalControlPayloadError");
  });

  it("preserves typed local-control failures", async () => {
    const transport: LocalControlReadTransport = {
      request: async (request) => request.operation === "protocol.negotiate"
        ? negotiation()
        : { ok: false, code: "READ_FAILED", message: "The requested facts could not be read" },
    };
    const cli = harness(transport);

    expect(await cli.run(["status"])).toBe(1);
    expect(cli.stderr.join("")).toContain("READ_FAILED");
  });

  it("rejects incompatible protocol versions", async () => {
    const transport: LocalControlReadTransport = {
      request: async () => ({ ok: true, protocolVersion: 2, operation: "protocol.negotiate", selectedVersion: 2, supportedVersions: [2] }),
    };
    const client = new LocalControlReadClient(transport);

    await expect(client.read({ operation: "status" })).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
  });

  it("recognizes the contract's explicit unsupported-version failure", async () => {
    const transport: LocalControlReadTransport = {
      request: async () => ({ ok: false, code: "PROTOCOL_VERSION_UNSUPPORTED", message: "The requested protocol version is not supported" }),
    };
    const client = new LocalControlReadClient(transport);

    await expect(client.read({ operation: "status" })).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
  });

  it("fails honestly when mission or capability projections are unavailable", async () => {
    const missions = harness(new ScriptedTransport({ "mission.list": success("mission.list", { available: false, items: [] }) }));
    const capabilities = harness(new ScriptedTransport({ "capability_registry.list": success("capability_registry.list", { available: false, items: [], truncated: false }) }));

    expect(await missions.run(["missions"])).toBe(1);
    expect(missions.stderr.join("")).toContain("projection unavailable");
    expect(await capabilities.run(["capabilities"])).toBe(1);
    expect(capabilities.stderr.join("")).toContain("projection unavailable");
  });

  it("uses only read operations and exposes no private or legacy data", async () => {
    const transport = new ScriptedTransport({
      status: success("status", status),
      "mission.list": success("mission.list", { available: true, items: [mission], completeness: { liveIncluded: 1, liveOmitted: 0, historicalIncluded: 0, historicalOmitted: 0, truncated: false } }),
      "mission.show": success("mission.show", { available: true, item: mission }),
      "capability_registry.list": success("capability_registry.list", { available: true, items: [descriptor], truncated: false }),
    });
    const cli = harness(transport);
    for (const args of [["status"], ["missions"], ["mission", "show", "mission-1"], ["capabilities"]]) {
      expect(await cli.run(args)).toBe(0);
    }

    expect(transport.calls.every((call) => ["protocol.negotiate", "status", "mission.list", "mission.show", "capability_registry.list"].includes(call.operation))).toBe(true);
    const output = cli.stdout.join("");
    expect(output).not.toMatch(/Council|persona|CoT|reasoning|originalIntent|sanitizedOriginalIntent|acceptanceCriteria|private prompt/i);
  });
});
