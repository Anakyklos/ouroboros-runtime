import { describe, expect, it } from "bun:test";
import {
  LOCAL_CONTROL_COMMAND_PROTOCOL_VERSION,
  type LocalControlCommandRequest,
  type LocalControlCommandResponse,
} from "../../../shared/local-control-command-contract.js";
import {
  LocalControlCommandClient,
  LocalControlFailureError,
  LocalControlPayloadError,
  LoopbackJsonRpcTransport,
  ProtocolVersionMismatchError,
  type LocalControlCommandTransport,
} from "./local-control-client.js";

const projection = {
  missionId: "mission-1",
  state: "paused",
  source: "cli",
  currentPlanRevisionId: null,
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:01:00.000Z",
  recoveryCount: 0,
  invocationIds: [],
  pendingApprovalCount: 0,
};

function success(operation: "mission.pause" | "mission.resume" | "mission.cancel", data: unknown = projection): LocalControlCommandResponse {
  return { ok: true, protocolVersion: LOCAL_CONTROL_COMMAND_PROTOCOL_VERSION, operation, data } as LocalControlCommandResponse;
}

class ScriptedCommandTransport implements LocalControlCommandTransport {
  readonly calls: LocalControlCommandRequest[] = [];

  constructor(private readonly respond: (request: LocalControlCommandRequest) => unknown | Promise<unknown>) {}

  async request(params: LocalControlCommandRequest): Promise<unknown> {
    this.calls.push(params);
    return this.respond(params);
  }
}

describe("LocalControlCommandClient", () => {
  it("sends pause once with its command protocol version and supplied reason", async () => {
    const transport = new ScriptedCommandTransport(() => success("mission.pause"));
    const client = new LocalControlCommandClient(transport);

    const response = await client.execute({ operation: "mission.pause", missionId: "mission-1", reason: "operator hold" });

    expect(transport.calls).toEqual([{
      operation: "mission.pause",
      protocolVersion: LOCAL_CONTROL_COMMAND_PROTOCOL_VERSION,
      missionId: "mission-1",
      reason: "operator hold",
    }]);
    expect(response.data).toEqual(projection);
  });

  it("sends resume without a reason or extra fields", async () => {
    const resumed = { ...projection, state: "waiting_for_provider" };
    const transport = new ScriptedCommandTransport(() => success("mission.resume", resumed));
    const client = new LocalControlCommandClient(transport);

    await client.execute({ operation: "mission.resume", missionId: "mission-1" });

    expect(transport.calls).toEqual([{
      operation: "mission.resume",
      protocolVersion: 1,
      missionId: "mission-1",
    }]);
  });

  it("preserves a successful idempotent pause projection returned by the daemon", async () => {
    const transport = new ScriptedCommandTransport(() => success("mission.pause", projection));
    const client = new LocalControlCommandClient(transport);

    expect(await client.execute({ operation: "mission.pause", missionId: "mission-1", reason: "repeat" })).toEqual({
      ok: true,
      protocolVersion: 1,
      operation: "mission.pause",
      data: projection,
    });
  });

  it("preserves invalid-transition and not-found codes with sanitized messages", async () => {
    for (const code of ["INVALID_TRANSITION", "MISSION_NOT_FOUND"] as const) {
      const client = new LocalControlCommandClient(new ScriptedCommandTransport(() => ({
        ok: false,
        code,
        message: "PRIVATE PROMPT api_key=secret",
      })));

      const error = await client.execute({ operation: "mission.resume", missionId: "mission-1" })
        .then(() => null, (failure: unknown) => failure as Error);
      expect(error).toBeInstanceOf(LocalControlFailureError);
      expect(error).toMatchObject({ code });
      expect(error?.message).not.toContain("PRIVATE");
    }
  });

  it("maps authority-unavailable without exposing the daemon message", async () => {
    const client = new LocalControlCommandClient(new ScriptedCommandTransport(() => ({
      ok: false,
      code: "AUTHORITY_UNAVAILABLE",
      message: "PRIVATE AUTHORITY DETAIL",
    })));

    const error = await client.execute({ operation: "mission.cancel", missionId: "mission-1", reason: "stop" })
      .then(() => null, (failure: unknown) => failure as Error);
    expect(error).toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
    expect(error?.message).not.toContain("PRIVATE");
  });

  it("treats unsupported command protocol as an explicit version mismatch", async () => {
    const client = new LocalControlCommandClient(new ScriptedCommandTransport(() => ({
      ok: false,
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      message: "unsupported",
    })));

    await expect(client.execute({ operation: "mission.resume", missionId: "mission-1" })).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
  });

  it("rejects extra response fields, operation mismatch, invalid projection and unknown failure codes closed", async () => {
    const malformed = [
      { ...success("mission.pause"), privateField: "PRIVATE_SENTINEL" },
      success("mission.cancel"),
      success("mission.pause", { ...projection, pauseMetadata: "PRIVATE_SENTINEL" }),
      { ok: false, code: "PRIVATE_UNKNOWN_FAILURE", message: "PRIVATE_SENTINEL" },
      success("mission.pause", { ...projection, missionId: "other-mission" }),
    ];

    for (const response of malformed) {
      const client = new LocalControlCommandClient(new ScriptedCommandTransport(() => response));
      const error = await client.execute({ operation: "mission.pause", missionId: "mission-1", reason: "hold" })
        .then(() => null, (failure: unknown) => failure as Error);
      expect(error).toBeInstanceOf(LocalControlPayloadError);
      expect(error?.message).not.toContain("PRIVATE");
    }
  });

  it("does not retry when the connection fails after a command may have been delivered", async () => {
    let submissions = 0;
    const transport = new ScriptedCommandTransport(() => {
      submissions += 1;
      throw new Error("connection lost after send");
    });
    const client = new LocalControlCommandClient(transport);

    await expect(client.execute({ operation: "mission.cancel", missionId: "mission-1", reason: "stop" })).rejects.toThrow("connection lost after send");
    expect(submissions).toBe(1);
    expect(transport.calls).toHaveLength(1);
  });

  it("uses the command RPC method with one request and its versioned payload", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const rpc = new LoopbackJsonRpcTransport({
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { jsonrpc: string; id: string; method: string; params: unknown };
        requests.push({ method: body.method, params: body.params });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: success("mission.pause") }), { status: 200 });
      },
    });
    const client = new LocalControlCommandClient({ request: (params) => rpc.call("local_control.command", params) });

    await client.execute({ operation: "mission.pause", missionId: "mission-1", reason: "hold" });

    expect(requests).toEqual([{
      method: "local_control.command",
      params: { operation: "mission.pause", missionId: "mission-1", reason: "hold", protocolVersion: 1 },
    }]);
  });
});
