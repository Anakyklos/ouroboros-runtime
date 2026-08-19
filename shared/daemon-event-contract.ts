export const DAEMON_EVENT_VERSION = 1 as const;

export const ALLOWED_DAEMON_EVENTS = [
  "snapshot",
  "log",
  "task",
  "daemon",
  "wave",
  "budget",
] as const;

export type AllowedDaemonEvent = (typeof ALLOWED_DAEMON_EVENTS)[number];

export type DaemonMode = "running" | "pause";

export type DaemonMetric =
  | { available: true; value: number; unit: string }
  | { available: false; reason: string };

export interface DaemonCapabilitiesProjection {
  statusMetrics: boolean;
  modeSwitching: boolean;
  supportedModes: readonly DaemonMode[];
  emergencyBrake: boolean;
  brakeRecoverable: boolean;
  modePersistence: boolean;
  tokenMetrics: boolean;
}

export interface DaemonStatusProjection {
  processStatus: "alive";
  mode: DaemonMode;
  uptimeSeconds: number;
  activeSessions: DaemonMetric;
  activeWaves: DaemonMetric;
  activeTasks: DaemonMetric;
  tokensUsed: DaemonMetric;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  capabilities: DaemonCapabilitiesProjection;
  timestamp: string;
  admissionOpen?: boolean;
  operationalState?: unknown;
  controlPlane?: unknown;
}

export interface DaemonSessionProjection {
  id: string;
  status: "active" | "paused" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface DaemonSnapshot {
  cursor: number;
  status: DaemonStatusProjection;
  capabilities: DaemonCapabilitiesProjection;
  sessions?: DaemonSessionProjection[];
}

export interface DaemonEventEnvelope<T = unknown> {
  version: typeof DAEMON_EVENT_VERSION;
  eventId: string;
  sequence: number;
  event: AllowedDaemonEvent;
  data: T;
  timestamp: string;
  taskId?: string;
  stepId?: string;
  sessionId?: string;
}

const OPTIONAL_STRING_FIELDS = ["taskId", "stepId", "sessionId"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

export function isAllowedDaemonEvent(value: unknown): value is AllowedDaemonEvent {
  return typeof value === "string" &&
    (ALLOWED_DAEMON_EVENTS as readonly string[]).includes(value);
}

export function isDaemonEventEnvelope(value: unknown): value is DaemonEventEnvelope {
  if (!isRecord(value)) return false;
  if (value.version !== DAEMON_EVENT_VERSION) return false;
  if (!isNonEmptyString(value.eventId)) return false;
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0) return false;
  if (!isAllowedDaemonEvent(value.event)) return false;
  if (!Object.prototype.hasOwnProperty.call(value, "data")) return false;
  if (value.data === undefined) return false;
  if (!isValidTimestamp(value.timestamp)) return false;

  for (const field of OPTIONAL_STRING_FIELDS) {
    if (field in value && !isNonEmptyString(value[field])) return false;
  }

  return true;
}

export type ProtocolDiagnosticCode =
  | "invalid_envelope"
  | "unknown_event"
  | "duplicate_event"
  | "sequence_gap"
  | "out_of_order"
  | "resync_required";

export interface ProtocolDiagnostic {
  code: ProtocolDiagnosticCode;
}

export function safeProtocolDiagnostic(code: ProtocolDiagnosticCode): ProtocolDiagnostic {
  return { code };
}
