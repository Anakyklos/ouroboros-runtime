import {
  DaemonUnavailableError,
  LocalControlPayloadError,
  LocalControlFailureError,
  LocalControlReadClient,
  LoopbackJsonRpcTransport,
  ProtocolVersionMismatchError,
  RpcProtocolError,
} from "./local-control-client.js";

export interface AdminCliDependencies {
  client?: LocalControlReadClient;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function writeJson(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return [
    "Usage:",
    "  ouroboros version",
    "  ouroboros status",
    "  ouroboros missions",
    "  ouroboros mission show <id>",
    "  ouroboros capabilities",
    "  ouroboros tui",
  ].join("\n");
}

/** Run the factual read-only administrator CLI. */
export async function runAdminCli(args: readonly string[], dependencies: AdminCliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
  const client = dependencies.client ?? new LocalControlReadClient(new LoopbackJsonRpcTransport());

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    stdout(`${usage()}\n`);
    return 0;
  }

  try {
    switch (args[0]) {
      case "version": {
        if (args.length !== 1) break;
        const response = await client.read({ operation: "health" });
        writeJson(stdout, {
          protocolVersion: response.protocolVersion,
          healthy: response.data.healthy,
          runtime: response.data.runtime,
          uptimeSeconds: response.data.uptimeSeconds,
          timestamp: response.data.timestamp,
        });
        return 0;
      }
      case "status": {
        if (args.length !== 1) break;
        const response = await client.read({ operation: "status" });
        writeJson(stdout, response.data);
        return 0;
      }
      case "missions": {
        if (args.length !== 1) break;
        const response = await client.read({ operation: "mission.list" });
        if (!response.data.available) {
          writeJson(stdout, { available: false, items: [] });
          stderr("mission projection unavailable\n");
          return 1;
        }
        writeJson(stdout, response.data);
        return 0;
      }
      case "mission": {
        if (args.length !== 3 || args[1] !== "show" || !args[2]) break;
        const missionId = args[2];
        const response = await client.read({ operation: "mission.show", missionId });
        if (!response.data.available) {
          writeJson(stdout, { result: "projection unavailable", missionId });
          stderr(`mission projection unavailable: ${missionId}\n`);
          return 1;
        }
        if (response.data.item === null) {
          writeJson(stdout, { result: "not found", missionId });
          stderr(`mission not found: ${missionId}\n`);
          return 1;
        }
        writeJson(stdout, { result: "found", mission: response.data.item });
        return 0;
      }
      case "capabilities": {
        if (args.length !== 1) break;
        const response = await client.read({ operation: "capability_registry.list" });
        if (!response.data.available) {
          writeJson(stdout, { available: false, items: [], truncated: false });
          stderr("capability registry projection unavailable\n");
          return 1;
        }
        writeJson(stdout, response.data);
        return 0;
      }
    }
  } catch (error) {
    const message = error instanceof DaemonUnavailableError ||
      error instanceof RpcProtocolError ||
      error instanceof LocalControlPayloadError ||
      error instanceof ProtocolVersionMismatchError ||
      error instanceof LocalControlFailureError
      ? error.message
      : "local-control request failed";
    stderr(`${message}\n`);
    return 1;
  }

  stderr(`${usage()}\n`);
  return 2;
}

if (import.meta.main) {
  process.exitCode = await runAdminCli(process.argv.slice(2));
}
