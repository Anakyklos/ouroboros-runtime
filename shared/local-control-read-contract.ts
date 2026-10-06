import type {
  DaemonInvocationProjection,
  DaemonMissionProjection,
  DaemonProjectionCompletenessEntry,
  DaemonSnapshot,
  DaemonStatusProjection,
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
  "snapshot",
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
  | (VersionedRequest & { operation: "snapshot" })
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
  | { ok: true; protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION; operation: "snapshot"; data: DaemonSnapshot }
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

export type LocalControlSnapshot = DaemonSnapshot;
