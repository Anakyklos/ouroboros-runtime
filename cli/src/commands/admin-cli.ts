import {
  DaemonUnavailableError,
  LocalControlPayloadError,
  LocalControlFailureError,
  LocalControlCommandClient,
  LocalControlReadClient,
  LoopbackJsonRpcTransport,
  ProtocolVersionMismatchError,
  RpcProtocolError,
} from "./local-control-client.js";
import { join } from "node:path";
import {
  LocalControlCredentialStore,
  defaultLocalControlClientCredentialPath,
  writeLocalControlClientCredential,
} from "../daemon/local-control-auth.js";
import { LOCAL_CONTROL_AUTH_SCOPES, type LocalControlAuthScope } from "../../../shared/local-control-auth-contract.js";

export interface AdminCliDependencies {
  client?: Pick<LocalControlReadClient, "read">;
  commandClient?: Pick<LocalControlCommandClient, "execute">;
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
    "  ouroboros mission pause <id> [reason]",
    "  ouroboros mission resume <id>",
    "  ouroboros mission cancel <id> [reason]",
    "  ouroboros capabilities",
    "  ouroboros auth provision <client-id> <scope,scope> [days] [credential-file]",
    "  ouroboros auth rotate <client-id> <scope,scope> [days] [credential-file]",
    "  ouroboros auth revoke <client-id>",
  ].join("\n");
}

/** Run the factual administrator and recovery CLI. */
export async function runAdminCli(args: readonly string[], dependencies: AdminCliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
  const transport = new LoopbackJsonRpcTransport();
  const client = dependencies.client ?? new LocalControlReadClient(transport);
  const commandClient = dependencies.commandClient ?? new LocalControlCommandClient({
    request: (params) => transport.call("local_control.command", params),
  });

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    stdout(`${usage()}\n`);
    return 0;
  }

  try {
    if (args[0] === "auth") {
      const dataDir = process.env.OUROBOROS_DATA_DIR || ".ouroboros";
      const registry = new LocalControlCredentialStore(join(dataDir, "local-control-auth.db"));
      try {
        const action = args[1];
        const clientId = args[2];
        if ((action === "provision" || action === "rotate") && clientId && args.length >= 4 && args.length <= 6) {
          const scopes = args[3].split(",") as LocalControlAuthScope[];
          if (!scopes.length || scopes.some((scope) => !LOCAL_CONTROL_AUTH_SCOPES.includes(scope)) || new Set(scopes).size !== scopes.length) {
            stderr("invalid scope list\n");
            return 2;
          }
          const days = args[4] === undefined ? 90 : Number(args[4]);
          if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
            stderr("credential lifetime must be between 1 and 365 days\n");
            return 2;
          }
          const path = args[5] ?? process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE ?? defaultLocalControlClientCredentialPath(clientId);
          const credential = registry.provision(clientId, scopes, Date.now() + days * 24 * 60 * 60_000);
          writeLocalControlClientCredential(path, { schemaVersion: 1, clientId, token: credential.token });
          writeJson(stdout, { result: action === "rotate" ? "rotated" : "provisioned", clientId, scopes: credential.scopes, expiresAt: new Date(credential.expiresAt).toISOString(), credentialFile: path });
          return 0;
        }
        if (action === "revoke" && clientId && args.length === 3) {
          const revoked = registry.revoke(clientId);
          writeJson(stdout, { result: revoked ? "revoked" : "already_inactive", clientId });
          return 0;
        }
        stderr(`${usage()}\n`);
        return 2;
      } finally {
        registry.close();
      }
    }
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
        if (args[1] === "show") {
          if (args.length !== 3 || !args[2]) break;
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

        const missionId = args[2];
        if (!missionId) break;
        if (args[1] === "resume") {
          if (args.length !== 3) break;
          const response = await commandClient.execute({ operation: "mission.resume", missionId });
          writeJson(stdout, response.data);
          return 0;
        }
        if (args[1] === "pause" || args[1] === "cancel") {
          if (args.length !== 3 && args.length !== 4) break;
          const operation = args[1] === "pause" ? "mission.pause" : "mission.cancel";
          const reason = args[3] ?? (operation === "mission.pause"
            ? "operator requested pause via CLI"
            : "operator requested cancel via CLI");
          const response = await commandClient.execute({ operation, missionId, reason });
          writeJson(stdout, response.data);
          return 0;
        }
        break;
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
