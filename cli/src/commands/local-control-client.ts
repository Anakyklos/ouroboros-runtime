import {
  LOCAL_CONTROL_MAX_MISSIONS,
  LOCAL_CONTROL_MAX_REGISTRY_ITEMS,
  LOCAL_CONTROL_PROTOCOL_VERSION,
  type LocalControlReadFailureCode,
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, requiredKeys: readonly string[], optionalKeys: readonly string[] = []): boolean {
  const ownKeys = Reflect.ownKeys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    ownKeys.length >= requiredKeys.length &&
    ownKeys.every((key) => typeof key === "string" && allowed.has(key));
}

const LOCAL_CONTROL_FAILURE_CODES: Record<LocalControlReadFailureCode, true> = {
  INVALID_REQUEST: true,
  PROTOCOL_VERSION_REQUIRED: true,
  PROTOCOL_VERSION_UNSUPPORTED: true,
  INVALID_ID: true,
  INVALID_LIMIT: true,
  READ_FAILED: true,
};

function isFailureCode(value: unknown): value is LocalControlReadFailureCode {
  return typeof value === "string" && Object.hasOwn(LOCAL_CONTROL_FAILURE_CODES, value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isMetric(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.available === false
    ? hasExactKeys(value, ["available", "reason"]) && typeof value.reason === "string"
    : value.available === true && hasExactKeys(value, ["available", "value", "unit"]) &&
      isFiniteNonNegative(value.value) && typeof value.unit === "string";
}

function isStatus(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.memory) || !isRecord(value.capabilities)) return false;
  if (!hasExactKeys(value, ["processStatus", "mode", "uptimeSeconds", "activeSessions", "activeWaves", "activeTasks", "tokensUsed", "memory", "capabilities", "timestamp"])) return false;
  if (!hasExactKeys(value.memory, ["rssBytes", "heapUsedBytes", "heapTotalBytes"])) return false;
  if (!hasExactKeys(value.capabilities, ["statusMetrics", "modeSwitching", "supportedModes", "emergencyBrake", "brakeRecoverable", "modePersistence", "tokenMetrics"])) return false;
  const capabilities = value.capabilities;
  return value.processStatus === "alive" &&
    (value.mode === "running" || value.mode === "pause") &&
    isFiniteNonNegative(value.uptimeSeconds) &&
    isMetric(value.activeSessions) && isMetric(value.activeWaves) &&
    isMetric(value.activeTasks) && isMetric(value.tokensUsed) &&
    isFiniteNonNegative(value.memory.rssBytes) &&
    isFiniteNonNegative(value.memory.heapUsedBytes) &&
    isFiniteNonNegative(value.memory.heapTotalBytes) &&
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
  return isRecord(value) && hasExactKeys(value, ["missionId", "state", "source", "currentPlanRevisionId", "createdAt", "updatedAt", "recoveryCount", "invocationIds", "pendingApprovalCount"]) &&
    typeof value.missionId === "string" &&
    typeof value.state === "string" && DAEMON_MISSION_STATES.includes(value.state as (typeof DAEMON_MISSION_STATES)[number]) &&
    ["katherine", "mission_control", "cli", "api", "operator"].includes(String(value.source)) &&
    (value.currentPlanRevisionId === null || typeof value.currentPlanRevisionId === "string") &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" &&
    Array.isArray(value.invocationIds) && value.invocationIds.every((id) => typeof id === "string") &&
    Number.isSafeInteger(value.recoveryCount) && Number(value.recoveryCount) >= 0 &&
    Number.isSafeInteger(value.pendingApprovalCount) && Number(value.pendingApprovalCount) >= 0;
}

function isMissionCompleteness(value: unknown, itemCount: number): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["liveIncluded", "liveOmitted", "historicalIncluded", "historicalOmitted", "truncated"])) return false;
  const counts = [value.liveIncluded, value.liveOmitted, value.historicalIncluded, value.historicalOmitted];
  if (!counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0) || typeof value.truncated !== "boolean") return false;
  const liveIncluded = Number(value.liveIncluded);
  const liveOmitted = Number(value.liveOmitted);
  const historicalIncluded = Number(value.historicalIncluded);
  const historicalOmitted = Number(value.historicalOmitted);
  const includedTotal = liveIncluded + historicalIncluded;
  const omittedTotal = liveOmitted + historicalOmitted;
  return includedTotal === itemCount && includedTotal <= LOCAL_CONTROL_MAX_MISSIONS &&
    Number.isSafeInteger(includedTotal + omittedTotal) &&
    (omittedTotal === 0 || value.truncated === true);
}

function isMissionCollection(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ["available", "items"], ["completeness"]) || typeof value.available !== "boolean" ||
      !Array.isArray(value.items) || value.items.length > LOCAL_CONTROL_MAX_MISSIONS || !value.items.every(isMission)) return false;
  if (!value.available && value.items.length !== 0) return false;
  if (Object.hasOwn(value, "completeness") && !isMissionCompleteness(value.completeness, value.items.length)) return false;
  return true;
}

function isLocalControlResponse(value: unknown, operation: LocalControlReadRequest["operation"]): value is LocalControlReadResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return hasExactKeys(value, ["ok", "code", "message"]) && isFailureCode(value.code) && typeof value.message === "string";
  if (value.protocolVersion !== LOCAL_CONTROL_PROTOCOL_VERSION || value.operation !== operation) return false;
  if (operation === "protocol.negotiate") {
    if (!hasExactKeys(value, ["ok", "protocolVersion", "operation", "selectedVersion", "supportedVersions"])) return false;
    return value.selectedVersion === LOCAL_CONTROL_PROTOCOL_VERSION &&
      Array.isArray(value.supportedVersions) && value.supportedVersions.length === 1 &&
      value.supportedVersions[0] === LOCAL_CONTROL_PROTOCOL_VERSION;
  }
  if (!isRecord(value.data)) return false;
  switch (operation) {
    case "status":
      if (!hasExactKeys(value, ["ok", "protocolVersion", "operation", "data"])) return false;
      return isStatus(value.data);
    case "health":
      if (!hasExactKeys(value, ["ok", "protocolVersion", "operation", "data"]) ||
          !hasExactKeys(value.data, ["healthy", "runtime", "uptimeSeconds", "timestamp"]) || !isRecord(value.data.runtime)) return false;
      return typeof value.data.healthy === "boolean" && isFiniteNonNegative(value.data.uptimeSeconds) &&
        typeof value.data.timestamp === "string" &&
        hasExactKeys(value.data.runtime, ["processId", "processTitle", "runtime", "runtimeVersion"]) &&
        typeof value.data.runtime.processId === "number" && typeof value.data.runtime.processTitle === "string" &&
        (value.data.runtime.runtime === "bun" || value.data.runtime.runtime === "node") &&
        typeof value.data.runtime.runtimeVersion === "string";
    case "mission.list":
      return hasExactKeys(value, ["ok", "protocolVersion", "operation", "data"]) && isMissionCollection(value.data);
    case "mission.show":
      return hasExactKeys(value, ["ok", "protocolVersion", "operation", "data"]) &&
        hasExactKeys(value.data, ["available", "item"]) && typeof value.data.available === "boolean" &&
        (value.data.item === null || isMission(value.data.item)) && (value.data.available || value.data.item === null);
    case "capability_registry.list":
      return hasExactKeys(value, ["ok", "protocolVersion", "operation", "data"]) &&
        hasExactKeys(value.data, ["available", "items", "truncated"]) &&
        typeof value.data.available === "boolean" && typeof value.data.truncated === "boolean" &&
        Array.isArray(value.data.items) && value.data.items.length <= LOCAL_CONTROL_MAX_REGISTRY_ITEMS && value.data.items.every((item) => isRecord(item) &&
          hasExactKeys(item, ["capabilityId", "moduleOwner", "contractVersion", "purpose", "effectClass", "requiresApproval", "requiresOwnerVerification", "ownsStorage", "availability"]) &&
          typeof item.capabilityId === "string" && typeof item.moduleOwner === "string" &&
          Number.isSafeInteger(item.contractVersion) && Number(item.contractVersion) > 0 && typeof item.purpose === "string" &&
          typeof item.effectClass === "string" && typeof item.availability === "string" &&
          typeof item.requiresApproval === "boolean" && typeof item.requiresOwnerVerification === "boolean" &&
          typeof item.ownsStorage === "boolean") && (value.data.available || (value.data.items.length === 0 && value.data.truncated === false));
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
      if (isRecord(negotiation) && negotiation.ok === false) {
        if (!hasExactKeys(negotiation, ["ok", "code", "message"]) || !isFailureCode(negotiation.code) || typeof negotiation.message !== "string") {
          throw new LocalControlPayloadError();
        }
        if (negotiation.code === "PROTOCOL_VERSION_UNSUPPORTED") throw new ProtocolVersionMismatchError();
        throw new LocalControlFailureError(negotiation.code, negotiation.message);
      }
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
      if (!hasExactKeys(body, ["jsonrpc", "id", "error"]) || !isRecord(body.error) ||
          !hasExactKeys(body.error, ["code", "message"]) || typeof body.error.code !== "number" || typeof body.error.message !== "string") {
        throw new RpcProtocolError();
      }
      throw new RpcProtocolError();
    }
    if (!hasExactKeys(body, ["jsonrpc", "id", "result"])) throw new RpcProtocolError();
    return body.result;
  }
}
