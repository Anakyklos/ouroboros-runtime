import {
  safeProtocolDiagnostic,
  validateDaemonEventEnvelope,
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
    const validation = validateDaemonEventEnvelope(value);
    if (!validation.ok) {
      this.report(validation.code);
      return validation.code === "unknown_event" ? "unknown" : "invalid";
    }

    const envelope = validation.envelope;
    if (this.rememberedEventIds.has(envelope.eventId)) {
      this.report("duplicate_event");
      return "duplicate";
    }

    if (envelope.event === "snapshot") {
      const snapshot = envelope.data as DaemonSnapshot;
      if (snapshot.cursor < this._cursor || envelope.sequence < this._cursor) {
        this.report("out_of_order");
        return "out_of_order";
      }

      this.remember(envelope.eventId);
      this._cursor = snapshot.cursor;
      this.awaitingResync = false;
      this.onSnapshot?.(snapshot);
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

    if (envelope.sequence !== this._cursor + 1) {
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
