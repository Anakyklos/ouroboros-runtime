import type { DaemonMissionProjection } from "./daemon-event-contract.js";
import {
  isDaemonMissionProjection,
} from "./daemon-event-contract.js";

/** Version of the transport-neutral Mission admission contract. */
export const LOCAL_CONTROL_ADMISSION_PROTOCOL_VERSION = 1 as const;
export const LOCAL_CONTROL_ADMISSION_OPERATION = "mission.admit" as const;

export const LOCAL_CONTROL_ADMISSION_MAX_REQUEST_ID_LENGTH = 256;
export const LOCAL_CONTROL_ADMISSION_MAX_INTENT_LENGTH = 4096;
export const LOCAL_CONTROL_ADMISSION_MAX_TEXT_ITEM_LENGTH = 1024;
export const LOCAL_CONTROL_ADMISSION_MAX_ARRAY_ITEMS = 64;
export const LOCAL_CONTROL_ADMISSION_MAX_TOTAL_TEXT_LENGTH = 65536;
export const LOCAL_CONTROL_ADMISSION_MAX_REPLAY_INVOCATION_IDS = 100;

export type LocalControlAdmissionFailureCode =
  | "INVALID_REQUEST"
  | "PROTOCOL_VERSION_REQUIRED"
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "INVALID_ID"
  | "INVALID_TEXT"
  | "INVALID_PAYLOAD"
  | "ADMISSION_CONFLICT"
  | "AUTHORITY_UNAVAILABLE"
  | "ADMISSION_FAILED";

export interface LocalControlAdmissionRecordIdentity {
  clientId: string;
  requestId: string;
}

export interface LocalControlAdmissionRequest {
  protocolVersion: typeof LOCAL_CONTROL_ADMISSION_PROTOCOL_VERSION;
  operation: typeof LOCAL_CONTROL_ADMISSION_OPERATION;
  requestId: string;
  originalIntent: string;
  constraints: string[];
  acceptanceCriteria: string[];
}

export type LocalControlAdmissionResponse =
  | { ok: false; code: LocalControlAdmissionFailureCode; message: string }
  | {
      ok: true;
      protocolVersion: typeof LOCAL_CONTROL_ADMISSION_PROTOCOL_VERSION;
      operation: typeof LOCAL_CONTROL_ADMISSION_OPERATION;
      data: DaemonMissionProjection;
    };

const FAILURE_MESSAGES: Record<LocalControlAdmissionFailureCode, string> = {
  INVALID_REQUEST: "The Mission admission request is invalid",
  PROTOCOL_VERSION_REQUIRED: "A protocol version is required",
  PROTOCOL_VERSION_UNSUPPORTED: "The requested protocol version is not supported",
  INVALID_ID: "The request identity is invalid",
  INVALID_TEXT: "Mission admission text is invalid",
  INVALID_PAYLOAD: "Mission admission payload is invalid",
  ADMISSION_CONFLICT: "Mission admission conflicts with an existing request",
  AUTHORITY_UNAVAILABLE: "Mission admission authority is unavailable",
  ADMISSION_FAILED: "Mission admission failed",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate an untrusted admission response before it reaches a client. */
export function sanitizeLocalControlAdmissionResponse(
  value: unknown,
  expectedOperation: typeof LOCAL_CONTROL_ADMISSION_OPERATION = LOCAL_CONTROL_ADMISSION_OPERATION,
): LocalControlAdmissionResponse | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  if (value.ok === false) {
    const codes = Object.keys(FAILURE_MESSAGES) as LocalControlAdmissionFailureCode[];
    if (!Object.prototype.hasOwnProperty.call(value, "ok") ||
      !Object.prototype.hasOwnProperty.call(value, "code") ||
      !Object.prototype.hasOwnProperty.call(value, "message") ||
      Object.keys(value).length !== 3) return null;
    if (!codes.includes(value.code as LocalControlAdmissionFailureCode)) return null;
    const code = value.code as LocalControlAdmissionFailureCode;
    return { ok: false, code, message: FAILURE_MESSAGES[code] };
  }
  if (value.protocolVersion !== LOCAL_CONTROL_ADMISSION_PROTOCOL_VERSION ||
    value.operation !== expectedOperation) return null;
  if (!Object.prototype.hasOwnProperty.call(value, "ok") ||
    !Object.prototype.hasOwnProperty.call(value, "protocolVersion") ||
    !Object.prototype.hasOwnProperty.call(value, "operation") ||
    !Object.prototype.hasOwnProperty.call(value, "data") ||
    Object.keys(value).length !== 4) return null;
  if (!isDaemonMissionProjection(value.data)) return null;
  return {
    ok: true,
    protocolVersion: LOCAL_CONTROL_ADMISSION_PROTOCOL_VERSION,
    operation: LOCAL_CONTROL_ADMISSION_OPERATION,
    data: value.data,
  };
}

export { FAILURE_MESSAGES as LOCAL_CONTROL_ADMISSION_FAILURE_MESSAGES };
