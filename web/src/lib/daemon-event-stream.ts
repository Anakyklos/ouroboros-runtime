import {
  isAllowedDaemonEvent,
  isDaemonEventEnvelope,
  safeProtocolDiagnostic,
  type DaemonEventEnvelope,
  type DaemonSnapshot,
  type ProtocolDiagnostic,
} from "../../../shared/daemon-event-contract";

export type StreamDecision =
  | "applied"
  | "duplicate"
  | "resync_required"
  | "out_of_order"
  | "invalid"
  | "unknown";

export interface DaemonEventStreamOptions {
  onEnvelope?: (envelope: DaemonEventEnvelope) => void;
  onSnapshot?: (snapshot: DaemonSnapshot) => void;
  onDiagnostic?: (diagnostic: ProtocolDiagnostic) => void;
  maxRememberedEventIds?: number;
}

export const INITIAL_RECONNECT_DELAY = 1000;
export const MAX_RECONNECT_DELAY = 30000;

export function calculateReconnectDelay(attempt: number): number {
  const boundedAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(INITIAL_RECONNECT_DELAY * 2 ** boundedAttempt, MAX_RECONNECT_DELAY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isMetric(value: unknown): boolean {
  if (!isRecord(value) || typeof value.available !== "boolean") return false;
  if (value.available) {
    return isFiniteNonNegative(value.value) &&
      typeof value.unit === "string" &&
      value.unit.length > 0;
  }
  return typeof value.reason === "string" && value.reason.length > 0;
}

function isCapabilities(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.statusMetrics === "boolean" &&
    typeof value.modeSwitching === "boolean" &&
    Array.isArray(value.supportedModes) &&
    value.supportedModes.every((mode) => mode === "running" || mode === "pause") &&
    typeof value.emergencyBrake === "boolean" &&
    typeof value.brakeRecoverable === "boolean" &&
    typeof value.modePersistence === "boolean" &&
    typeof value.tokenMetrics === "boolean";
}

function isStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const memory = value.memory;
  return value.processStatus === "alive" &&
    (value.mode === "running" || value.mode === "pause") &&
    isFiniteNonNegative(value.uptimeSeconds) &&
    isMetric(value.activeSessions) &&
    isMetric(value.activeWaves) &&
    isMetric(value.activeTasks) &&
    isMetric(value.tokensUsed) &&
    isRecord(memory) &&
    isFiniteNonNegative(memory.rssBytes) &&
    isFiniteNonNegative(memory.heapUsedBytes) &&
    isFiniteNonNegative(memory.heapTotalBytes) &&
    isCapabilities(value.capabilities) &&
    typeof value.timestamp === "string" &&
    !Number.isNaN(Date.parse(value.timestamp));
}

function isSession(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && value.id.length > 0 &&
    (value.status === "active" || value.status === "paused" ||
      value.status === "completed" || value.status === "failed") &&
    typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt));
}

function isSnapshot(value: unknown): value is DaemonSnapshot {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.cursor) &&
    (value.cursor as number) >= 0 &&
    isStatus(value.status) &&
    isCapabilities(value.capabilities) &&
    (value.sessions === undefined ||
      (Array.isArray(value.sessions) && value.sessions.every(isSession)));
}

export class DaemonEventStream {
  private readonly onEnvelope?: (envelope: DaemonEventEnvelope) => void;
  private readonly onSnapshot?: (snapshot: DaemonSnapshot) => void;
  private readonly onDiagnostic?: (diagnostic: ProtocolDiagnostic) => void;
  private readonly maxRememberedEventIds: number;
  private readonly rememberedEventIds = new Set<string>();
  private _cursor = 0;
  private awaitingResync = false;

  constructor(options: DaemonEventStreamOptions = {}) {
    this.onEnvelope = options.onEnvelope;
    this.onSnapshot = options.onSnapshot;
    this.onDiagnostic = options.onDiagnostic;
    this.maxRememberedEventIds = Number.isSafeInteger(options.maxRememberedEventIds) &&
      (options.maxRememberedEventIds ?? 0) > 0
      ? options.maxRememberedEventIds!
      : 1024;
  }

  get cursor(): number {
    return this._cursor;
  }

  accept(value: unknown): StreamDecision {
    if (!isRecord(value)) {
      this.report("invalid_envelope");
      return "invalid";
    }

    if (!isDaemonEventEnvelope(value)) {
      if ("event" in value && typeof value.event === "string" && !isAllowedDaemonEvent(value.event)) {
        this.report("unknown_event");
        return "unknown";
      }
      this.report("invalid_envelope");
      return "invalid";
    }

    const envelope = value;
    if (this.rememberedEventIds.has(envelope.eventId)) {
      this.report("duplicate_event");
      return "duplicate";
    }

    if (envelope.event === "snapshot") {
      if (!isSnapshot(envelope.data)) {
        this.report("invalid_envelope");
        return "invalid";
      }
      if (envelope.data.cursor < this._cursor || envelope.sequence < this._cursor) {
        this.report("out_of_order");
        return "out_of_order";
      }

      this.remember(envelope.eventId);
      this._cursor = Math.max(envelope.sequence, envelope.data.cursor);
      this.awaitingResync = false;
      this.onSnapshot?.(envelope.data);
      return "applied";
    }

    if (this.awaitingResync) {
      this.report("out_of_order");
      return "out_of_order";
    }

    if (envelope.sequence <= this._cursor) {
      this.report("out_of_order");
      return "out_of_order";
    }

    if (envelope.sequence > this._cursor + 1) {
      this.awaitingResync = true;
      this.report("sequence_gap");
      return "resync_required";
    }

    this.remember(envelope.eventId);
    this._cursor = envelope.sequence;
    this.onEnvelope?.(envelope);
    return "applied";
  }

  private remember(eventId: string): void {
    this.rememberedEventIds.add(eventId);
    while (this.rememberedEventIds.size > this.maxRememberedEventIds) {
      const oldest = this.rememberedEventIds.values().next().value;
      if (typeof oldest !== "string") break;
      this.rememberedEventIds.delete(oldest);
    }
  }

  private report(code: ProtocolDiagnostic["code"]): void {
    this.onDiagnostic?.(safeProtocolDiagnostic(code));
  }
}
