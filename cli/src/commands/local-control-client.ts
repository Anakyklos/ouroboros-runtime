import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  type LocalControlReadRequest,
  type LocalControlReadResponse,
} from "../../../shared/local-control-read-contract.js";
import { DAEMON_MISSION_STATES } from "../../../shared/daemon-event-contract.js";

/** Transport-neutral request surface consumed by the factual CLI. */
export interface LocalControlReadTransport {
  request(params: LocalControlReadRequest): Promise<unknown>;
}

type ReadOperation = Exclude<LocalControlReadRequest["operation"], "protocol.negotiate">;
type ClientRequest = {
  [Operation in ReadOperation]: Omit<Extract<LocalControlReadRequest, { operation: Operation }>, "protocolVersion">;
}[ReadOperation];

export class DaemonUnavailableError extends Error {
  constructor() {
    super("daemon unavailable; start ouroborosd and try again");
    this.name = "DaemonUnavailableError";
  }
}

/** Invalid JSON-RPC framing, status, or envelope from the daemon. */
export class RpcProtocolError extends Error {
  constructor() {
    super("daemon returned an invalid RPC response");
    this.name = "RpcProtocolError";
  }
}

/** A JSON-RPC result that does not satisfy the versioned local-control contract. */
export class LocalControlPayloadError extends Error {
  constructor() {
    super("daemon returned a malformed local-control response");
    this.name = "LocalControlPayloadError";
  }
}

/** A sanitized failure returned by the local-control contract. */
export class LocalControlFailureError extends Error {
  constructor(readonly code: string, message: string) {
    super(`local-control request failed (${code}): ${message}`);
    this.name = "LocalControlFailureError";
  }
}

/** The daemon and client cannot agree on the local-control protocol version. */
export class ProtocolVersionMismatchError extends Error {
  constructor() {
    super(`daemon local-control protocol is incompatible (client supports version ${LOCAL_CONTROL_PROTOCOL_VERSION})`);
    this.name = "ProtocolVersionMismatchError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMetric(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.available === false
    ? typeof value.reason === "string"
    : value.available === true && typeof value.value === "number" && typeof value.unit === "string";
}

function isStatus(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.memory) || !isRecord(value.capabilities)) return false;
  const capabilities = value.capabilities;
  return value.processStatus === "alive" &&
    (value.mode === "running" || value.mode === "pause") &&
    typeof value.uptimeSeconds === "number" &&
    isMetric(value.activeSessions) && isMetric(value.activeWaves) &&
    isMetric(value.activeTasks) && isMetric(value.tokensUsed) &&
    typeof value.memory.rssBytes === "number" &&
    typeof value.memory.heapUsedBytes === "number" &&
    typeof value.memory.heapTotalBytes === "number" &&
    typeof capabilities.statusMetrics === "boolean" &&
    typeof capabilities.modeSwitching === "boolean" &&
    Array.isArray(capabilities.supportedModes) &&
    capabilities.supportedModes.every((mode) => mode === "running" || mode === "pause") &&
    typeof capabilities.emergencyBrake === "boolean" &&
    typeof capabilities.brakeRecoverable === "boolean" &&
    typeof capabilities.modePersistence === "boolean" &&
    typeof capabilities.tokenMetrics === "boolean" &&
    typeof value.timestamp === "string";
}

function isMission(value: unknown): boolean {
  return isRecord(value) && typeof value.missionId === "string" &&
    typeof value.state === "string" && DAEMON_MISSION_STATES.includes(value.state as (typeof DAEMON_MISSION_STATES)[number]) &&
    ["katherine", "mission_control", "cli", "api", "operator"].includes(String(value.source)) &&
    (value.currentPlanRevisionId === null || typeof value.currentPlanRevisionId === "string") &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" &&
    Array.isArray(value.invocationIds) && value.invocationIds.every((id) => typeof id === "string") &&
    typeof value.recoveryCount === "number" && typeof value.pendingApprovalCount === "number";
}

function isLocalControlResponse(value: unknown, operation: LocalControlReadRequest["operation"]): value is LocalControlReadResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return typeof value.code === "string" && typeof value.message === "string";
  if (value.protocolVersion !== LOCAL_CONTROL_PROTOCOL_VERSION || value.operation !== operation) return false;
  if (operation === "protocol.negotiate") {
    return value.selectedVersion === LOCAL_CONTROL_PROTOCOL_VERSION &&
      Array.isArray(value.supportedVersions) && value.supportedVersions.includes(LOCAL_CONTROL_PROTOCOL_VERSION);
  }
  if (!isRecord(value.data)) return false;
  switch (operation) {
    case "status":
      return isStatus(value.data);
    case "health":
      return typeof value.data.healthy === "boolean" && typeof value.data.uptimeSeconds === "number" &&
        typeof value.data.timestamp === "string" && isRecord(value.data.runtime) &&
        typeof value.data.runtime.processId === "number" && typeof value.data.runtime.processTitle === "string" &&
        (value.data.runtime.runtime === "bun" || value.data.runtime.runtime === "node") &&
        typeof value.data.runtime.runtimeVersion === "string";
    case "mission.list":
      return typeof value.data.available === "boolean" && Array.isArray(value.data.items) && value.data.items.every(isMission);
    case "mission.show":
      return typeof value.data.available === "boolean" && (value.data.item === null || isMission(value.data.item));
    case "capability_registry.list":
      return typeof value.data.available === "boolean" && typeof value.data.truncated === "boolean" &&
        Array.isArray(value.data.items) && value.data.items.every((item) => isRecord(item) &&
          typeof item.capabilityId === "string" && typeof item.moduleOwner === "string" &&
          typeof item.contractVersion === "number" && typeof item.purpose === "string" &&
          typeof item.effectClass === "string" && typeof item.availability === "string" &&
          typeof item.requiresApproval === "boolean" && typeof item.requiresOwnerVerification === "boolean" &&
          typeof item.ownsStorage === "boolean");
    default:
      return false;
  }
}

/** Version-negotiating typed client over a transport that knows no CLI semantics. */
export class LocalControlReadClient {
  private negotiated = false;

  constructor(private readonly transport: LocalControlReadTransport) {}

  /** Read one typed local-control projection after negotiating its protocol. */
  read(request: Omit<Extract<LocalControlReadRequest, { operation: "health" }>, "protocolVersion">): Promise<Extract<LocalControlReadResponse, { operation: "health" }>>;
  read(request: Omit<Extract<LocalControlReadRequest, { operation: "status" }>, "protocolVersion">): Promise<Extract<LocalControlReadResponse, { operation: "status" }>>;
  read(request: Omit<Extract<LocalControlReadRequest, { operation: "mission.list" }>, "protocolVersion">): Promise<Extract<LocalControlReadResponse, { operation: "mission.list" }>>;
  read(request: Omit<Extract<LocalControlReadRequest, { operation: "mission.show" }>, "protocolVersion">): Promise<Extract<LocalControlReadResponse, { operation: "mission.show" }>>;
  read(request: Omit<Extract<LocalControlReadRequest, { operation: "capability_registry.list" }>, "protocolVersion">): Promise<Extract<LocalControlReadResponse, { operation: "capability_registry.list" }>>;
  async read(request: ClientRequest): Promise<LocalControlReadResponse> {
    if (!this.negotiated) {
      const negotiation = await this.transport.request({
        operation: "protocol.negotiate",
        supportedVersions: [LOCAL_CONTROL_PROTOCOL_VERSION],
      });
      if (isRecord(negotiation) && negotiation.ok === false && typeof negotiation.code === "string" && typeof negotiation.message === "string") {
        if (negotiation.code === "PROTOCOL_VERSION_UNSUPPORTED") throw new ProtocolVersionMismatchError();
        throw new LocalControlFailureError(negotiation.code, negotiation.message);
      }
      if (isRecord(negotiation) && negotiation.ok === false) throw new LocalControlPayloadError();
      if (!isLocalControlResponse(negotiation, "protocol.negotiate")) {
        if (isRecord(negotiation) && negotiation.ok === true &&
          ((typeof negotiation.protocolVersion === "number" && negotiation.protocolVersion !== LOCAL_CONTROL_PROTOCOL_VERSION) ||
            (typeof negotiation.selectedVersion === "number" && negotiation.selectedVersion !== LOCAL_CONTROL_PROTOCOL_VERSION))) {
          throw new ProtocolVersionMismatchError();
        }
        throw new LocalControlPayloadError();
      }
      const negotiated = negotiation as Extract<LocalControlReadResponse, { operation: "protocol.negotiate" }>;
      if (!negotiated.ok || negotiated.selectedVersion !== LOCAL_CONTROL_PROTOCOL_VERSION) {
        throw new ProtocolVersionMismatchError();
      }
      this.negotiated = true;
    }

    const operation = request.operation;
    const params = { ...request, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION } as LocalControlReadRequest;
    const response = await this.transport.request(params);
    if (isRecord(response) && response.ok === true && typeof response.protocolVersion === "number" &&
      response.protocolVersion !== LOCAL_CONTROL_PROTOCOL_VERSION) throw new ProtocolVersionMismatchError();
    if (!isLocalControlResponse(response, operation)) throw new LocalControlPayloadError();
    if (!response.ok) {
      if (response.code === "PROTOCOL_VERSION_UNSUPPORTED") throw new ProtocolVersionMismatchError();
      throw new LocalControlFailureError(response.code, response.message);
    }
    return response;
  }
}

/** POST adapter for the current loopback JSON-RPC transport. */
export class LoopbackJsonRpcTransport implements LocalControlReadTransport {
  private nextId = 1;
  private readonly baseUrl: string;

  constructor(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
    this.baseUrl = options.baseUrl ?? `http://127.0.0.1:${process.env.OUROBOROS_PORT || "7777"}`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private readonly fetchImpl: typeof fetch;

  async request(params: LocalControlReadRequest): Promise<unknown> {
    const id = String(this.nextId++);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "local_control.read", params }),
      });
    } catch {
      throw new DaemonUnavailableError();
    }
    if (!response.ok) throw new RpcProtocolError();

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RpcProtocolError();
    }
    if (!isRecord(body) || body.jsonrpc !== "2.0" || body.id !== id) throw new RpcProtocolError();
    if (body.error !== undefined) {
      if (!isRecord(body.error) || typeof body.error.code !== "number" || typeof body.error.message !== "string") {
        throw new RpcProtocolError();
      }
      throw new RpcProtocolError();
    }
    if (!("result" in body)) throw new RpcProtocolError();
    return body.result;
  }
}
