import { randomUUID } from "node:crypto";
import {
  createDaemonEventEnvelope,
  isAllowedDaemonEvent,
  isDaemonEventData,
  safeProtocolDiagnostic,
  type AllowedDaemonEvent,
  type DaemonEventCorrelation,
  type DaemonEventDataMap,
  type DaemonEventEnvelope,
  type DaemonSnapshot,
  type ProtocolDiagnostic,
} from "../../../shared/daemon-event-contract.js";

export interface ProjectionClient {
  readyState: number;
  bufferedAmount: number;
  send(message: string): void;
  close(): void;
}

export interface DaemonProjectionOptions {
  snapshot: (cursor: number) => DaemonSnapshot | Promise<DaemonSnapshot>;
  createEventId?: () => string;
  now?: () => string;
  maxBufferedAmount?: number;
  maxPendingEvents?: number;
  onDiagnostic?: (diagnostic: ProtocolDiagnostic) => void;
}

type ClientPhase = "handshaking" | "ready";

interface ClientState {
  phase: ClientPhase;
  pending: DaemonEventEnvelope[];
}

const OPEN_READY_STATE = 1;
const DEFAULT_MAX_BUFFERED_AMOUNT = 1024 * 1024;
const DEFAULT_MAX_PENDING_EVENTS = 32;

export class DaemonProjection {
  private readonly clients = new Map<ProjectionClient, ClientState>();
  private readonly snapshot: DaemonProjectionOptions["snapshot"];
  private readonly createEventId: () => string;
  private readonly now: () => string;
  private readonly maxBufferedAmount: number;
  private readonly maxPendingEvents: number;
  private readonly onDiagnostic?: (diagnostic: ProtocolDiagnostic) => void;
  private sequence = 0;

  constructor(options: DaemonProjectionOptions) {
    this.snapshot = options.snapshot;
    this.createEventId = options.createEventId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxBufferedAmount = Number.isSafeInteger(options.maxBufferedAmount) &&
      (options.maxBufferedAmount ?? 0) > 0
      ? options.maxBufferedAmount!
      : DEFAULT_MAX_BUFFERED_AMOUNT;
    this.maxPendingEvents = Number.isSafeInteger(options.maxPendingEvents) &&
      (options.maxPendingEvents ?? 0) > 0
      ? options.maxPendingEvents!
      : DEFAULT_MAX_PENDING_EVENTS;
    this.onDiagnostic = options.onDiagnostic;
  }

  get currentSequence(): number {
    return this.sequence;
  }

  get connectedClientCount(): number {
    return this.clients.size;
  }

  /** Register a client and send its authoritative snapshot before normal facts. */
  async connectClient(client: ProjectionClient): Promise<void> {
    if (client.readyState !== OPEN_READY_STATE || this.clients.has(client)) return;

    const state: ClientState = { phase: "handshaking", pending: [] };
    this.clients.set(client, state);
    const snapshotSequence = this.ensureSequence();

    let snapshot: DaemonSnapshot;
    try {
      snapshot = await this.snapshot(snapshotSequence);
    } catch {
      this.closeClient(client, "invalid_payload");
      return;
    }

    if (this.clients.get(client) !== state) return;

    const snapshotEnvelope = this.createEnvelope("snapshot", {
      ...snapshot,
      cursor: snapshotSequence,
    }, snapshotSequence);
    if (!this.sendToClient(client, snapshotEnvelope)) return;

    state.phase = "ready";
    const pending = state.pending.splice(0);
    for (const envelope of pending) {
      if (this.clients.get(client) !== state || !this.sendToClient(client, envelope)) break;
    }
  }

  disconnectClient(client: ProjectionClient): void {
    this.removeClient(client);
  }

  broadcast<E extends AllowedDaemonEvent>(
    event: E,
    data: DaemonEventDataMap[E],
    correlation: DaemonEventCorrelation = {},
  ): void {
    if (!isAllowedDaemonEvent(event) || event === "snapshot") {
      this.report("unknown_event");
      return;
    }
    if (!isDaemonEventData(event, data)) {
      this.report("invalid_payload");
      return;
    }
    if (this.clients.size === 0) return;

    const sequence = this.reserveSequence();
    let envelope: DaemonEventEnvelope<DaemonEventDataMap[E]>;
    try {
      envelope = this.createEnvelope(event, data, sequence, correlation);
    } catch {
      this.report("invalid_envelope");
      return;
    }

    for (const [client, state] of [...this.clients.entries()]) {
      if (state.phase === "handshaking") {
        if (state.pending.length >= this.maxPendingEvents) {
          this.closeClient(client, "client_backpressure");
          continue;
        }
        state.pending.push(envelope);
        continue;
      }
      this.sendToClient(client, envelope);
    }
  }

  closeClients(): void {
    for (const client of [...this.clients.keys()]) this.closeClient(client);
  }

  private reserveSequence(): number {
    this.sequence = Math.max(1, this.sequence + 1);
    return this.sequence;
  }

  private ensureSequence(): number {
    this.sequence = Math.max(1, this.sequence);
    return this.sequence;
  }

  private createEnvelope<E extends AllowedDaemonEvent>(
    event: E,
    data: DaemonEventDataMap[E],
    sequence: number,
    correlation: DaemonEventCorrelation = {},
  ): DaemonEventEnvelope<DaemonEventDataMap[E]> {
    return createDaemonEventEnvelope(event, data, sequence, {
      eventId: this.createEventId(),
      timestamp: this.now(),
    }, correlation);
  }

  private sendToClient(
    client: ProjectionClient,
    envelope: DaemonEventEnvelope,
  ): boolean {
    if (
      client.readyState !== OPEN_READY_STATE ||
      !Number.isFinite(client.bufferedAmount) ||
      client.bufferedAmount > this.maxBufferedAmount
    ) {
      this.closeClient(client, "client_backpressure");
      return false;
    }

    try {
      client.send(JSON.stringify(envelope));
      return true;
    } catch {
      this.closeClient(client, "client_send_failed");
      return false;
    }
  }

  private closeClient(client: ProjectionClient, diagnostic?: ProtocolDiagnostic["code"]): void {
    const removed = this.removeClient(client);
    if (!removed) return;
    try {
      client.close();
    } catch {
      // A broken client is already isolated; cleanup remains best effort.
    }
    if (diagnostic) this.report(diagnostic);
  }

  private removeClient(client: ProjectionClient): boolean {
    return this.clients.delete(client);
  }

  private report(code: ProtocolDiagnostic["code"]): void {
    this.onDiagnostic?.(safeProtocolDiagnostic(code));
  }
}
