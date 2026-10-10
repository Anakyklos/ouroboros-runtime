import type {
  DaemonInvocationProjection,
  DaemonMissionProjection,
  DaemonProjectionCompletenessEntry,
  DaemonStatusProjection,
} from "./daemon-event-contract.js";
import {
  isDaemonInvocationProjection,
  isDaemonMissionProjection,
  isDaemonProjectionCompletenessEntry,
  isDaemonStatusProjection,
} from "./daemon-event-contract.js";

/** Version of the transport-neutral, read-only local-control contract. */
export const LOCAL_CONTROL_PROTOCOL_VERSION = 1 as const;
export const LOCAL_CONTROL_MAX_MISSIONS = 100;
export const LOCAL_CONTROL_MAX_INVOCATIONS = 500;
export const LOCAL_CONTROL_MAX_REGISTRY_ITEMS = 100;
export const LOCAL_CONTROL_MAX_DIAGNOSTICS = 20;
export const LOCAL_CONTROL_MAX_ID_LENGTH = 256;
export const LOCAL_CONTROL_READ_OPERATIONS = [
  "protocol.negotiate",
  "health",
  "status",
  "mission.list",
  "mission.show",
  "invocation.list",
  "invocation.show",
  "capability_registry.list",
  "diagnostics.list",
] as const;
export type LocalControlReadOperation = (typeof LOCAL_CONTROL_READ_OPERATIONS)[number];

export interface LocalControlRuntimeIdentity {
  processId: number;
  processTitle: string;
  runtime: "bun" | "node";
  runtimeVersion: string;
}

export interface LocalControlHealth {
  healthy: boolean;
  runtime: LocalControlRuntimeIdentity;
  uptimeSeconds: number;
  timestamp: string;
}

/** Sanitized semantic facts shared by read clients and transport adapters. */
export interface LocalControlProjectionFacts {
  status: DaemonStatusProjection;
  missions: DaemonMissionProjection[];
  invocations: DaemonInvocationProjection[];
  completeness: {
    missions: DaemonProjectionCompletenessEntry;
    invocations: DaemonProjectionCompletenessEntry;
  };
  durableProjectionAvailable: boolean;
}

export interface LocalControlCollection<T> {
  available: boolean;
  items: T[];
  completeness?: DaemonProjectionCompletenessEntry;
}

export interface LocalControlItem<T> {
  available: boolean;
  item: T | null;
}

export interface LocalControlCapabilityDescriptorProjection {
  capabilityId: string;
  moduleOwner: string;
  contractVersion: number;
  purpose: string;
  effectClass: string;
  requiresApproval: boolean;
  requiresOwnerVerification: boolean;
  ownsStorage: boolean;
  availability: string;
}

export interface LocalControlRegistryProjection {
  available: boolean;
  items: LocalControlCapabilityDescriptorProjection[];
  truncated: boolean;
}

export type LocalControlDiagnosticCode =
  | "MISSION_PROJECTION_UNAVAILABLE"
  | "INVOCATION_PROJECTION_UNAVAILABLE"
  | "CAPABILITY_REGISTRY_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE"
  | "PROJECTION_TRUNCATED";

export interface LocalControlDiagnostic {
  code: LocalControlDiagnosticCode;
  severity: "info" | "warning" | "error";
  timestamp?: string;
}

export interface LocalControlDiagnosticsProjection {
  available: boolean;
  items: LocalControlDiagnostic[];
  completeness: { included: number; omitted: number; truncated: boolean };
}

interface VersionedRequest {
  protocolVersion: number;
}

export type LocalControlReadRequest =
  | { operation: "protocol.negotiate"; supportedVersions: readonly number[] }
  | (VersionedRequest & { operation: "health" })
  | (VersionedRequest & { operation: "status" })
  | (VersionedRequest & { operation: "mission.list"; limit?: number })
  | (VersionedRequest & { operation: "mission.show"; missionId: string })
  | (VersionedRequest & { operation: "invocation.list"; limit?: number })
  | (VersionedRequest & { operation: "invocation.show"; invocationId: string })
  | (VersionedRequest & { operation: "capability_registry.list"; limit?: number })
  | (VersionedRequest & { operation: "diagnostics.list"; limit?: number });

export type LocalControlReadFailureCode =
  | "INVALID_REQUEST"
  | "PROTOCOL_VERSION_REQUIRED"
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "INVALID_ID"
  | "INVALID_LIMIT"
  | "READ_FAILED";

export type LocalControlReadResponse =
  | { ok: false; code: LocalControlReadFailureCode; message: string }
  | {
      ok: true;
      protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
      operation: "protocol.negotiate";
      selectedVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
      supportedVersions: readonly [typeof LOCAL_CONTROL_PROTOCOL_VERSION];
    }
  | { ok: true; protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION; operation: "health"; data: LocalControlHealth }
  | { ok: true; protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION; operation: "status"; data: DaemonStatusProjection }
  | {
      ok: true;
      protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
      operation: "mission.list";
      data: LocalControlCollection<DaemonMissionProjection>;
    }
  | {
      ok: true;
      protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
      operation: "mission.show";
      data: LocalControlItem<DaemonMissionProjection>;
    }
  | {
      ok: true;
      protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
      operation: "invocation.list";
      data: LocalControlCollection<DaemonInvocationProjection>;
    }
  | {
      ok: true;
      protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
      operation: "invocation.show";
      data: LocalControlItem<DaemonInvocationProjection>;
    }
  | {
      ok: true;
      protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
      operation: "capability_registry.list";
      data: LocalControlRegistryProjection;
    }
  | {
      ok: true;
      protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
      operation: "diagnostics.list";
      data: LocalControlDiagnosticsProjection;
    };

const FAILURE_MESSAGES: Record<LocalControlReadFailureCode, string> = {
  INVALID_REQUEST: "The local-control request is invalid",
  PROTOCOL_VERSION_REQUIRED: "A supported protocol version is required",
  PROTOCOL_VERSION_UNSUPPORTED: "The requested protocol version is not supported",
  INVALID_ID: "The requested identity is invalid",
  INVALID_LIMIT: "The requested limit is invalid",
  READ_FAILED: "The requested facts could not be read",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isRegistryDescriptor(value: unknown): value is LocalControlCapabilityDescriptorProjection {
  if (!isRecord(value) || !hasExactKeys(value, [
    "capabilityId", "moduleOwner", "contractVersion", "purpose", "effectClass",
    "requiresApproval", "requiresOwnerVerification", "ownsStorage", "availability",
  ])) return false;
  return isBoundedText(value.capabilityId)
    && isBoundedText(value.moduleOwner, 128)
    && Number.isSafeInteger(value.contractVersion) && (value.contractVersion as number) > 0
    && isBoundedText(value.purpose, 512)
    && isBoundedText(value.effectClass, 128)
    && typeof value.requiresApproval === "boolean"
    && typeof value.requiresOwnerVerification === "boolean"
    && typeof value.ownsStorage === "boolean"
    && isBoundedText(value.availability, 128);
}

/** Validate an untrusted gateway response and return only the versioned public read contract. */
export function sanitizeLocalControlReadResponse(value: unknown, expectedOperation: unknown): LocalControlReadResponse | null {
  if (!isRecord(value) || value.ok !== true && value.ok !== false) return null;
  if (value.ok === false) {
    const codes = Object.keys(FAILURE_MESSAGES) as LocalControlReadFailureCode[];
    if (!hasExactKeys(value, ["ok", "code", "message"]) || !codes.includes(value.code as LocalControlReadFailureCode)) return null;
    const code = value.code as LocalControlReadFailureCode;
    return { ok: false, code, message: FAILURE_MESSAGES[code] };
  }
  if (value.protocolVersion !== LOCAL_CONTROL_PROTOCOL_VERSION || value.operation !== expectedOperation) return null;
  if (expectedOperation === "protocol.negotiate") {
    return hasExactKeys(value, ["ok", "protocolVersion", "operation", "selectedVersion", "supportedVersions"])
      && value.selectedVersion === LOCAL_CONTROL_PROTOCOL_VERSION
      && Array.isArray(value.supportedVersions)
      && value.supportedVersions.length === 1
      && value.supportedVersions[0] === LOCAL_CONTROL_PROTOCOL_VERSION
      ? { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: "protocol.negotiate", selectedVersion: LOCAL_CONTROL_PROTOCOL_VERSION, supportedVersions: [LOCAL_CONTROL_PROTOCOL_VERSION] }
      : null;
  }
  if (!Object.prototype.hasOwnProperty.call(value, "data") || !hasExactKeys(value, ["ok", "protocolVersion", "operation", "data"])) return null;
  const data = value.data;
  switch (expectedOperation) {
    case "health": {
      if (!isRecord(data) || !hasExactKeys(data, ["healthy", "runtime", "uptimeSeconds", "timestamp"]) ||
          typeof data.healthy !== "boolean" || typeof data.uptimeSeconds !== "number" || !Number.isFinite(data.uptimeSeconds) || data.uptimeSeconds < 0 ||
          typeof data.timestamp !== "string" || !Number.isFinite(Date.parse(data.timestamp)) || !isRecord(data.runtime) ||
          !hasExactKeys(data.runtime, ["processId", "processTitle", "runtime", "runtimeVersion"]) ||
          !Number.isSafeInteger(data.runtime.processId) || (data.runtime.processId as number) < 0 ||
          !isBoundedText(data.runtime.processTitle, 128) || !["bun", "node"].includes(data.runtime.runtime as string) ||
          !isBoundedText(data.runtime.runtimeVersion, 64)) return null;
      return { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: "health", data: {
        healthy: data.healthy, runtime: { processId: data.runtime.processId as number, processTitle: data.runtime.processTitle, runtime: data.runtime.runtime as "bun" | "node", runtimeVersion: data.runtime.runtimeVersion },
        uptimeSeconds: data.uptimeSeconds, timestamp: data.timestamp,
      } };
    }
    case "status":
      return isDaemonStatusProjection(data) ? { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: "status", data } : null;
    case "mission.list":
    case "invocation.list": {
      if (!isRecord(data) || !hasExactKeys(data, ["available", "items"], ["completeness"]) || typeof data.available !== "boolean" || !Array.isArray(data.items)) return null;
      if (!data.available && data.items.length !== 0) return null;
      if (expectedOperation === "mission.list" && !data.items.every(isDaemonMissionProjection)) return null;
      if (expectedOperation === "invocation.list" && !data.items.every(isDaemonInvocationProjection)) return null;
      if (data.completeness !== undefined && !isDaemonProjectionCompletenessEntry(data.completeness)) return null;
      const max = expectedOperation === "mission.list" ? LOCAL_CONTROL_MAX_MISSIONS : LOCAL_CONTROL_MAX_INVOCATIONS;
      if (data.items.length > max) return null;
      if (expectedOperation === "invocation.list" && data.completeness !== undefined) {
        const completeness = data.completeness as DaemonProjectionCompletenessEntry;
        if (completeness.liveIncluded + completeness.historicalIncluded !== data.items.length ||
            completeness.liveIncluded + completeness.historicalIncluded > LOCAL_CONTROL_MAX_INVOCATIONS) return null;
      }
      return { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: expectedOperation, data: {
        available: data.available, items: data.items,
        ...(data.completeness === undefined ? {} : { completeness: data.completeness }),
      } } as LocalControlReadResponse;
    }
    case "mission.show":
    case "invocation.show": {
      if (!isRecord(data) || !hasExactKeys(data, ["available", "item"]) || typeof data.available !== "boolean") return null;
      const validItem = expectedOperation === "mission.show" ? isDaemonMissionProjection : isDaemonInvocationProjection;
      if (data.item !== null && !validItem(data.item)) return null;
      if (!data.available && data.item !== null) return null;
      return { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: expectedOperation, data } as unknown as LocalControlReadResponse;
    }
    case "capability_registry.list":
      if (!isRecord(data) || !hasExactKeys(data, ["available", "items", "truncated"]) || typeof data.available !== "boolean" ||
          !Array.isArray(data.items) || data.items.length > LOCAL_CONTROL_MAX_REGISTRY_ITEMS || !data.items.every(isRegistryDescriptor) || typeof data.truncated !== "boolean") return null;
      return { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: "capability_registry.list", data } as unknown as LocalControlReadResponse;
    case "diagnostics.list":
      if (!isRecord(data) || !hasExactKeys(data, ["available", "items", "completeness"]) || typeof data.available !== "boolean" || !Array.isArray(data.items) ||
          data.items.length > LOCAL_CONTROL_MAX_DIAGNOSTICS || !isRecord(data.completeness) || !hasExactKeys(data.completeness, ["included", "omitted", "truncated"]) ||
          !Number.isSafeInteger(data.completeness.included) || (data.completeness.included as number) < 0 ||
          !Number.isSafeInteger(data.completeness.omitted) || (data.completeness.omitted as number) < 0 ||
          data.completeness.included !== data.items.length || typeof data.completeness.truncated !== "boolean" ||
          data.completeness.truncated !== ((data.completeness.omitted as number) > 0) ||
          (!data.available && (data.items.length !== 0 || data.completeness.omitted !== 0))) return null;
      if (!data.items.every((item) => isRecord(item) && hasExactKeys(item, ["code", "severity"], ["timestamp"]) &&
          ["MISSION_PROJECTION_UNAVAILABLE", "INVOCATION_PROJECTION_UNAVAILABLE", "CAPABILITY_REGISTRY_UNAVAILABLE", "STORAGE_UNAVAILABLE", "PROJECTION_TRUNCATED"].includes(item.code as string) &&
          ["info", "warning", "error"].includes(item.severity as string) &&
          (item.timestamp === undefined || (typeof item.timestamp === "string" && Number.isFinite(Date.parse(item.timestamp)))))) return null;
      return { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: "diagnostics.list", data } as unknown as LocalControlReadResponse;
    default:
      return null;
  }
}
