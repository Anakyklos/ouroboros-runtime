import {
  SESSION_OPERATIONAL_STATUSES,
  SESSION_RPC_CONTRACT_VERSION,
  SESSION_RPC_MAX_ITEMS,
  type SessionGetResultV1,
  type SessionListResultV1,
  type SessionOperationalProjectionV1,
  type SessionOperationalStatus,
} from "../../../shared/session-rpc-contract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationalTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) throw new Error("Session projection is invalid");
  return date.toISOString();
}

/** Project an internal storage value to the allowlisted public session facts. */
export function projectSessionOperationalFacts(value: unknown): SessionOperationalProjectionV1 {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 256 ||
      typeof value.status !== "string" || !SESSION_OPERATIONAL_STATUSES.includes(value.status as SessionOperationalStatus)) {
    throw new Error("Session projection is invalid");
  }

  return {
    id: value.id,
    status: value.status as SessionOperationalStatus,
    createdAt: operationalTimestamp(value.createdAt),
    updatedAt: operationalTimestamp(value.updatedAt),
  };
}

/** Build the versioned session.get result from either internal or prior projected data. */
export function projectSessionGetResult(value: unknown): SessionGetResultV1 {
  const candidate = isRecord(value) && "session" in value ? value.session : value;
  return {
    contractVersion: SESSION_RPC_CONTRACT_VERSION,
    session: projectSessionOperationalFacts(candidate),
  };
}

/** Build a bounded, versioned session.list result from an internal list or RPC envelope. */
export function projectSessionListResult(value: unknown): SessionListResultV1 {
  const envelope = isRecord(value) ? value : undefined;
  const rows = Array.isArray(value) ? value : envelope && Array.isArray(envelope.sessions) ? envelope.sessions : null;
  if (!rows) throw new Error("Session projection is invalid");
  const sessions = rows.slice(0, SESSION_RPC_MAX_ITEMS).map(projectSessionOperationalFacts);
  return {
    contractVersion: SESSION_RPC_CONTRACT_VERSION,
    sessions,
    truncated: rows.length > SESSION_RPC_MAX_ITEMS || envelope?.truncated === true,
  };
}
