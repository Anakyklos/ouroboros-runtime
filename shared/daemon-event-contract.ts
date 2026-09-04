export const DAEMON_EVENT_VERSION = 1 as const;

/** Public facts that the daemon may expose through the observation stream. */
export const ALLOWED_DAEMON_EVENTS = [
  "snapshot",
  "mission",
  "plan_revision",
  "approval",
  "capability_invocation",
  "capability_availability",
  "context_request",
  "human_decision",
  "mission_verification",
  "daemon",
  "log",
] as const;

export type AllowedDaemonEvent = (typeof ALLOWED_DAEMON_EVENTS)[number];

export const DAEMON_MISSION_STATES = [
  "created",
  "planning",
  "waiting_for_context",
  "waiting_for_approval",
  "ready",
  "executing",
  "waiting_for_capability",
  "waiting_for_provider",
  "waiting_for_budget",
  "verifying",
  "paused",
  "completed",
  "blocked",
  "failed_terminal",
  "cancelled",
] as const;

export type DaemonMissionState = (typeof DAEMON_MISSION_STATES)[number];

export const DAEMON_INVOCATION_STATUSES = [
  "pending",
  "dispatched",
  "running",
  "completed",
  "failed",
  "cancelled",
  "blocked",
] as const;

export type DaemonInvocationStatus = (typeof DAEMON_INVOCATION_STATUSES)[number];

export const DAEMON_DELIVERY_STATES = [
  "not_submitted",
  "submitted",
  "acknowledged",
  "running",
  "failed",
  "uncertain",
] as const;

export type DaemonDeliveryState = (typeof DAEMON_DELIVERY_STATES)[number];

export const DAEMON_OWNER_VERIFICATION_STATES = [
  "not_required",
  "pending",
  "verified",
  "rejected",
] as const;

export type DaemonOwnerVerificationState = (typeof DAEMON_OWNER_VERIFICATION_STATES)[number];

export const DAEMON_PLAN_REVISION_STATUSES = [
  "proposed",
  "accepted",
  "superseded",
  "rejected",
] as const;

export type DaemonPlanRevisionStatus = (typeof DAEMON_PLAN_REVISION_STATUSES)[number];

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
}

export interface DaemonTransportCapabilities {
  orderedEvents: true;
  authoritativeSnapshot: true;
  resync: true;
  durableMissions: boolean;
  durableInvocations: boolean;
}

export interface DaemonMissionProjection {
  missionId: string;
  state: DaemonMissionState;
  source: "katherine" | "mission_control" | "cli" | "api" | "operator";
  currentPlanRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
  recoveryCount: number;
  invocationIds: string[];
  pendingApprovalCount: number;
}

export interface DaemonInvocationProjection {
  invocationId: string;
  missionId: string;
  stepId: string;
  capabilityId: string;
  moduleOwner: string;
  planRevisionId: string;
  status: DaemonInvocationStatus;
  deliveryState: DaemonDeliveryState;
  ownerVerificationState: DaemonOwnerVerificationState;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  completedAt?: string;
}

export interface DaemonDurableProjection {
  missions: DaemonMissionProjection[];
  invocations: DaemonInvocationProjection[];
}

export interface DaemonSnapshot extends DaemonDurableProjection {
  protocolVersion: typeof DAEMON_EVENT_VERSION;
  transportCapabilities: DaemonTransportCapabilities;
  cursor: number;
  status: DaemonStatusProjection;
  capabilities: DaemonCapabilitiesProjection;
}

export interface DaemonEventCorrelation {
  missionId?: string;
  invocationId?: string;
  sessionId?: string;
}

export interface DaemonMissionEventData {
  kind: "created" | "updated" | "state_changed";
  missionId: string;
  state: DaemonMissionState;
  currentPlanRevisionId: string | null;
  updatedAt: string;
}

export interface DaemonPlanRevisionEventData {
  kind: "proposed" | "accepted" | "superseded" | "rejected";
  missionId: string;
  revisionId: string;
  revisionNumber: number;
  status: DaemonPlanRevisionStatus;
  createdAt: string;
  acceptedAt?: string;
}

export interface DaemonApprovalEventData {
  kind: "requested" | "resolved";
  missionId: string;
  approvalId: string;
  state: "pending" | "granted" | "rejected";
  updatedAt: string;
}

export interface DaemonCapabilityInvocationEventData {
  kind: "started" | "waiting" | "completed" | "failed" | "cancelled" | "updated";
  invocationId: string;
  missionId: string;
  stepId: string;
  capabilityId: string;
  moduleOwner: string;
  status: DaemonInvocationStatus;
  deliveryState: DaemonDeliveryState;
  updatedAt: string;
}

export interface DaemonCapabilityAvailabilityEventData {
  capabilityId: string;
  available: boolean;
  observedAt: string;
  moduleOwner?: string;
  connectorVersion?: number;
}

export interface DaemonContextRequestEventData {
  kind: "requested" | "resolved" | "unavailable";
  missionId: string;
  requestId: string;
  state: "pending" | "resolved" | "unavailable";
  updatedAt: string;
}

export interface DaemonHumanDecisionEventData {
  kind: "required" | "resolved";
  missionId: string;
  decisionId: string;
  state: "required" | "approved" | "rejected" | "deferred";
  updatedAt: string;
}

export interface DaemonMissionVerificationEventData {
  missionId: string;
  satisfied: boolean;
  ownerBlocked: boolean;
  updatedAt: string;
}

export interface DaemonEventDataMap {
  snapshot: DaemonSnapshot;
  mission: DaemonMissionEventData;
  plan_revision: DaemonPlanRevisionEventData;
  approval: DaemonApprovalEventData;
  capability_invocation: DaemonCapabilityInvocationEventData;
  capability_availability: DaemonCapabilityAvailabilityEventData;
  context_request: DaemonContextRequestEventData;
  human_decision: DaemonHumanDecisionEventData;
  mission_verification: DaemonMissionVerificationEventData;
  daemon: {
    type: "starting" | "ready" | "shutting_down" | "stopped" | "emergency_brake" | "mode_changed";
    port?: number;
    mode?: DaemonMode;
    previousMode?: DaemonMode;
    outcome?: string;
    interruptedCount?: number;
    failedCount?: number;
  };
  log: {
    level: "debug" | "info" | "warn" | "error";
    message: string;
    source?: string;
  };
}

export type DaemonEventData = DaemonEventDataMap[AllowedDaemonEvent];

export interface DaemonEventEnvelope<T = DaemonEventData> {
  version: typeof DAEMON_EVENT_VERSION;
  eventId: string;
  sequence: number;
  event: AllowedDaemonEvent;
  data: T;
  timestamp: string;
  missionId?: string;
  invocationId?: string;
  sessionId?: string;
}

const OPTIONAL_ENVELOPE_FIELDS = ["missionId", "invocationId", "sessionId"] as const;

const PROTOCOL_DIAGNOSTIC_CODES = [
  "invalid_envelope",
  "unsupported_version",
  "unknown_event",
  "invalid_payload",
  "duplicate_event",
  "sequence_gap",
  "out_of_order",
  "resync_required",
  "client_send_failed",
  "client_backpressure",
  "transport_error",
] as const;

export type ProtocolDiagnosticCode = (typeof PROTOCOL_DIAGNOSTIC_CODES)[number];

export interface ProtocolDiagnostic {
  code: ProtocolDiagnosticCode;
}

export type DaemonEventValidationResult =
  | { ok: true; envelope: DaemonEventEnvelope }
  | { ok: false; code: ProtocolDiagnosticCode };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => hasOwn(value, key))) return false;
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isSafePublicText(value: unknown, maxLength = 2048): value is string {
  if (!isNonEmptyString(value, maxLength)) return false;
  return !/(?:authorization\s*:|bearer\s+|api[_-]?key\s*[:=]|secret\s*[:=]|password\s*[:=]|\b(?:system\s+prompt|hidden\s+prompt|chain[- ]of[- ]thought|provider\s+response|raw\s+response)\b|sk-[a-z0-9])/i.test(value);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isMetric(value: unknown): value is DaemonMetric {
  if (!isRecord(value) || typeof value.available !== "boolean") return false;
  if (value.available) {
    return hasExactKeys(value, ["available", "value", "unit"])
      && isFiniteNonNegative(value.value)
      && isSafePublicText(value.unit, 32);
  }
  return hasExactKeys(value, ["available", "reason"])
    && isSafePublicText(value.reason, 128);
}

function isCapabilities(value: unknown): value is DaemonCapabilitiesProjection {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, [
    "statusMetrics",
    "modeSwitching",
    "supportedModes",
    "emergencyBrake",
    "brakeRecoverable",
    "modePersistence",
    "tokenMetrics",
  ])
    && typeof value.statusMetrics === "boolean"
    && typeof value.modeSwitching === "boolean"
    && Array.isArray(value.supportedModes)
    && value.supportedModes.every((mode) => isOneOf(mode, ["running", "pause"] as const))
    && typeof value.emergencyBrake === "boolean"
    && typeof value.brakeRecoverable === "boolean"
    && typeof value.modePersistence === "boolean"
    && typeof value.tokenMetrics === "boolean";
}

function isStatus(value: unknown): value is DaemonStatusProjection {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, [
    "processStatus",
    "mode",
    "uptimeSeconds",
    "activeSessions",
    "activeWaves",
    "activeTasks",
    "tokensUsed",
    "memory",
    "capabilities",
    "timestamp",
  ])) return false;
  if (!isRecord(value.memory)) return false;
  return value.processStatus === "alive"
    && isOneOf(value.mode, ["running", "pause"] as const)
    && isFiniteNonNegative(value.uptimeSeconds)
    && isMetric(value.activeSessions)
    && isMetric(value.activeWaves)
    && isMetric(value.activeTasks)
    && isMetric(value.tokensUsed)
    && hasExactKeys(value.memory, ["rssBytes", "heapUsedBytes", "heapTotalBytes"])
    && isFiniteNonNegative(value.memory.rssBytes)
    && isFiniteNonNegative(value.memory.heapUsedBytes)
    && isFiniteNonNegative(value.memory.heapTotalBytes)
    && isCapabilities(value.capabilities)
    && isValidTimestamp(value.timestamp);
}

function isMissionProjection(value: unknown): value is DaemonMissionProjection {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, [
    "missionId",
    "state",
    "source",
    "currentPlanRevisionId",
    "createdAt",
    "updatedAt",
    "recoveryCount",
    "invocationIds",
    "pendingApprovalCount",
  ])
    && isNonEmptyString(value.missionId)
    && isOneOf(value.state, DAEMON_MISSION_STATES)
    && isOneOf(value.source, ["katherine", "mission_control", "cli", "api", "operator"] as const)
    && (value.currentPlanRevisionId === null || isNonEmptyString(value.currentPlanRevisionId))
    && isValidTimestamp(value.createdAt)
    && isValidTimestamp(value.updatedAt)
    && isSafeInteger(value.recoveryCount)
    && Array.isArray(value.invocationIds)
    && value.invocationIds.every((id) => isNonEmptyString(id))
    && isSafeInteger(value.pendingApprovalCount);
}

function isInvocationProjection(value: unknown): value is DaemonInvocationProjection {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, [
    "invocationId",
    "missionId",
    "stepId",
    "capabilityId",
    "moduleOwner",
    "planRevisionId",
    "status",
    "deliveryState",
    "ownerVerificationState",
    "createdAt",
    "updatedAt",
  ], ["dispatchedAt", "completedAt"])
    && isNonEmptyString(value.invocationId)
    && isNonEmptyString(value.missionId)
    && isNonEmptyString(value.stepId)
    && isNonEmptyString(value.capabilityId)
    && isSafePublicText(value.moduleOwner, 128)
    && isNonEmptyString(value.planRevisionId)
    && isOneOf(value.status, DAEMON_INVOCATION_STATUSES)
    && isOneOf(value.deliveryState, DAEMON_DELIVERY_STATES)
    && isOneOf(value.ownerVerificationState, DAEMON_OWNER_VERIFICATION_STATES)
    && isValidTimestamp(value.createdAt)
    && isValidTimestamp(value.updatedAt)
    && (value.dispatchedAt === undefined || isValidTimestamp(value.dispatchedAt))
    && (value.completedAt === undefined || isValidTimestamp(value.completedAt));
}

function isTransportCapabilities(value: unknown): value is DaemonTransportCapabilities {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, [
    "orderedEvents",
    "authoritativeSnapshot",
    "resync",
    "durableMissions",
    "durableInvocations",
  ])
    && value.orderedEvents === true
    && value.authoritativeSnapshot === true
    && value.resync === true
    && typeof value.durableMissions === "boolean"
    && typeof value.durableInvocations === "boolean";
}

function isSnapshot(value: unknown): value is DaemonSnapshot {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, [
    "protocolVersion",
    "transportCapabilities",
    "cursor",
    "status",
    "capabilities",
    "missions",
    "invocations",
  ])
    && value.protocolVersion === DAEMON_EVENT_VERSION
    && isTransportCapabilities(value.transportCapabilities)
    && isSafeInteger(value.cursor)
    && isStatus(value.status)
    && isCapabilities(value.capabilities)
    && Array.isArray(value.missions)
    && value.missions.every(isMissionProjection)
    && Array.isArray(value.invocations)
    && value.invocations.every(isInvocationProjection);
}

function isMissionEventData(value: unknown): value is DaemonMissionEventData {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, ["kind", "missionId", "state", "currentPlanRevisionId", "updatedAt"])
    && isOneOf(value.kind, ["created", "updated", "state_changed"] as const)
    && isNonEmptyString(value.missionId)
    && isOneOf(value.state, DAEMON_MISSION_STATES)
    && (value.currentPlanRevisionId === null || isNonEmptyString(value.currentPlanRevisionId))
    && isValidTimestamp(value.updatedAt);
}

function isPlanRevisionEventData(value: unknown): value is DaemonPlanRevisionEventData {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, ["kind", "missionId", "revisionId", "revisionNumber", "status", "createdAt"], ["acceptedAt"])
    && isOneOf(value.kind, ["proposed", "accepted", "superseded", "rejected"] as const)
    && isNonEmptyString(value.missionId)
    && isNonEmptyString(value.revisionId)
    && isSafeInteger(value.revisionNumber, 1)
    && isOneOf(value.status, DAEMON_PLAN_REVISION_STATUSES)
    && isValidTimestamp(value.createdAt)
    && (value.acceptedAt === undefined || isValidTimestamp(value.acceptedAt));
}

function isApprovalEventData(value: unknown): value is DaemonApprovalEventData {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, ["kind", "missionId", "approvalId", "state", "updatedAt"])
    && isOneOf(value.kind, ["requested", "resolved"] as const)
    && isNonEmptyString(value.missionId)
    && isNonEmptyString(value.approvalId)
    && isOneOf(value.state, ["pending", "granted", "rejected"] as const)
    && isValidTimestamp(value.updatedAt);
}

function isCapabilityInvocationEventData(value: unknown): value is DaemonCapabilityInvocationEventData {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, [
    "kind",
    "invocationId",
    "missionId",
    "stepId",
    "capabilityId",
    "moduleOwner",
    "status",
    "deliveryState",
    "updatedAt",
  ])
    && isOneOf(value.kind, ["started", "waiting", "completed", "failed", "cancelled", "updated"] as const)
    && isNonEmptyString(value.invocationId)
    && isNonEmptyString(value.missionId)
    && isNonEmptyString(value.stepId)
    && isNonEmptyString(value.capabilityId)
    && isSafePublicText(value.moduleOwner, 128)
    && isOneOf(value.status, DAEMON_INVOCATION_STATUSES)
    && isOneOf(value.deliveryState, DAEMON_DELIVERY_STATES)
    && isValidTimestamp(value.updatedAt);
}

function isCapabilityAvailabilityEventData(value: unknown): value is DaemonCapabilityAvailabilityEventData {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, ["capabilityId", "available", "observedAt"], ["moduleOwner", "connectorVersion"])
    && isNonEmptyString(value.capabilityId)
    && typeof value.available === "boolean"
    && isValidTimestamp(value.observedAt)
    && (value.moduleOwner === undefined || isSafePublicText(value.moduleOwner, 128))
    && (value.connectorVersion === undefined || isSafeInteger(value.connectorVersion, 1));
}

function isContextRequestEventData(value: unknown): value is DaemonContextRequestEventData {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, ["kind", "missionId", "requestId", "state", "updatedAt"])
    && isOneOf(value.kind, ["requested", "resolved", "unavailable"] as const)
    && isNonEmptyString(value.missionId)
    && isNonEmptyString(value.requestId)
    && isOneOf(value.state, ["pending", "resolved", "unavailable"] as const)
    && isValidTimestamp(value.updatedAt);
}

function isHumanDecisionEventData(value: unknown): value is DaemonHumanDecisionEventData {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, ["kind", "missionId", "decisionId", "state", "updatedAt"])
    && isOneOf(value.kind, ["required", "resolved"] as const)
    && isNonEmptyString(value.missionId)
    && isNonEmptyString(value.decisionId)
    && isOneOf(value.state, ["required", "approved", "rejected", "deferred"] as const)
    && isValidTimestamp(value.updatedAt);
}

function isMissionVerificationEventData(value: unknown): value is DaemonMissionVerificationEventData {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, ["missionId", "satisfied", "ownerBlocked", "updatedAt"])
    && isNonEmptyString(value.missionId)
    && typeof value.satisfied === "boolean"
    && typeof value.ownerBlocked === "boolean"
    && isValidTimestamp(value.updatedAt);
}

function isDaemonEventDataInternal<E extends AllowedDaemonEvent>(
  event: E,
  value: unknown,
): value is DaemonEventDataMap[E] {
  switch (event) {
    case "snapshot":
      return isSnapshot(value);
    case "mission":
      return isMissionEventData(value);
    case "plan_revision":
      return isPlanRevisionEventData(value);
    case "approval":
      return isApprovalEventData(value);
    case "capability_invocation":
      return isCapabilityInvocationEventData(value);
    case "capability_availability":
      return isCapabilityAvailabilityEventData(value);
    case "context_request":
      return isContextRequestEventData(value);
    case "human_decision":
      return isHumanDecisionEventData(value);
    case "mission_verification":
      return isMissionVerificationEventData(value);
    case "daemon": {
      if (!isRecord(value)) return false;
      return hasExactKeys(value, ["type"], ["port", "mode", "previousMode", "outcome", "interruptedCount", "failedCount"])
        && isOneOf(value.type, ["starting", "ready", "shutting_down", "stopped", "emergency_brake", "mode_changed"] as const)
        && (value.port === undefined || isSafeInteger(value.port))
        && (value.mode === undefined || isOneOf(value.mode, ["running", "pause"] as const))
        && (value.previousMode === undefined || isOneOf(value.previousMode, ["running", "pause"] as const))
        && (value.outcome === undefined || isSafePublicText(value.outcome, 128))
        && (value.interruptedCount === undefined || isSafeInteger(value.interruptedCount))
        && (value.failedCount === undefined || isSafeInteger(value.failedCount));
    }
    case "log": {
      if (!isRecord(value)) return false;
      return hasExactKeys(value, ["level", "message"], ["source"])
        && isOneOf(value.level, ["debug", "info", "warn", "error"] as const)
        && isSafePublicText(value.message)
        && (value.source === undefined || isSafePublicText(value.source, 128));
    }
  }
}

export function isAllowedDaemonEvent(value: unknown): value is AllowedDaemonEvent {
  return typeof value === "string" && (ALLOWED_DAEMON_EVENTS as readonly string[]).includes(value);
}

export function isDaemonEventData<E extends AllowedDaemonEvent>(
  event: E,
  value: unknown,
): value is DaemonEventDataMap[E] {
  return isDaemonEventDataInternal(event, value);
}

export function validateDaemonEventEnvelope(value: unknown): DaemonEventValidationResult {
  if (!isRecord(value)) return { ok: false, code: "invalid_envelope" };
  if (value.version !== DAEMON_EVENT_VERSION) return { ok: false, code: "unsupported_version" };
  if (!hasExactKeys(value, ["version", "eventId", "sequence", "event", "data", "timestamp"], OPTIONAL_ENVELOPE_FIELDS)) {
    return { ok: false, code: "invalid_envelope" };
  }
  if (!isNonEmptyString(value.eventId) || !isSafeInteger(value.sequence, 1) || !isValidTimestamp(value.timestamp)) {
    return { ok: false, code: "invalid_envelope" };
  }
  for (const field of OPTIONAL_ENVELOPE_FIELDS) {
    if (hasOwn(value, field) && !isNonEmptyString(value[field])) {
      return { ok: false, code: "invalid_envelope" };
    }
  }
  if (!isAllowedDaemonEvent(value.event)) return { ok: false, code: "unknown_event" };
  const event = value.event;
  const data = value.data;
  if (!hasOwn(value, "data") || !isDaemonEventData(event, data)) {
    return { ok: false, code: "invalid_payload" };
  }
  if (event === "snapshot" && (!isSnapshot(data) || data.cursor !== value.sequence)) {
    return { ok: false, code: "invalid_payload" };
  }
  return { ok: true, envelope: value as unknown as DaemonEventEnvelope };
}

export function isDaemonEventEnvelope(value: unknown): value is DaemonEventEnvelope {
  return validateDaemonEventEnvelope(value).ok;
}

export function createDaemonEventEnvelope<E extends AllowedDaemonEvent>(
  event: E,
  data: DaemonEventDataMap[E],
  sequence: number,
  ids: { eventId: string; timestamp: string },
  correlation: DaemonEventCorrelation = {},
): DaemonEventEnvelope<DaemonEventDataMap[E]> {
  const envelope: DaemonEventEnvelope<DaemonEventDataMap[E]> = {
    version: DAEMON_EVENT_VERSION,
    eventId: ids.eventId,
    sequence,
    event,
    data,
    timestamp: ids.timestamp,
    ...correlation,
  };
  const validation = validateDaemonEventEnvelope(envelope);
  if (!validation.ok) throw new Error(`Cannot create invalid daemon event envelope: ${validation.code}`);
  return envelope;
}

export function safeProtocolDiagnostic(code: ProtocolDiagnosticCode): ProtocolDiagnostic {
  return { code };
}
