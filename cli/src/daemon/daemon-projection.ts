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

declare const projectionClientReservationBrand: unique symbol;

/** A slot reserved by the daemon before a WebSocket upgrade or snapshot read. */
export interface ProjectionClientReservation {
  readonly [projectionClientReservationBrand]: true;
}

export interface DaemonProjectionOptions {
  snapshot: (cursor: number) => DaemonSnapshot | Promise<DaemonSnapshot>;
  createEventId?: () => string;
  now?: () => string;
  maxBufferedAmount?: number;
  maxPendingEvents?: number;
  maxClients?: number;
  onDiagnostic?: (diagnostic: ProtocolDiagnostic) => void;
}

type ClientPhase = "handshaking" | "ready" | "closing";

interface ClientState {
  phase: ClientPhase;
  pending: DaemonEventEnvelope[];
  client: ProjectionClient | null;
}

const OPEN_READY_STATE = 1;
const DEFAULT_MAX_BUFFERED_AMOUNT = 1024 * 1024;
const DEFAULT_MAX_PENDING_EVENTS = 32;
export const DEFAULT_MAX_PROJECTION_CLIENTS = 64;

export class DaemonProjection {
  private readonly clients = new Map<object, ClientState>();
  private readonly snapshot: DaemonProjectionOptions["snapshot"];
  private readonly createEventId: () => string;
  private readonly now: () => string;
  private readonly maxBufferedAmount: number;
  private readonly maxPendingEvents: number;
  private readonly maxClients: number;
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
    this.maxClients = Number.isSafeInteger(options.maxClients) &&
      (options.maxClients ?? 0) > 0
      ? options.maxClients!
      : DEFAULT_MAX_PROJECTION_CLIENTS;
    this.onDiagnostic = options.onDiagnostic;
  }

  get currentSequence(): number {
    return this.sequence;
  }

  get connectedClientCount(): number {
    let connected = 0;
    for (const state of this.clients.values()) {
      if (state.client && state.phase !== "closing") connected += 1;
    }
    return connected;
  }

  get admittedClientCount(): number {
    return this.clients.size;
  }

  /** Reserve aggregate capacity before upgrading a socket or reading its snapshot. */
  reserveClient(): ProjectionClientReservation | null {
    if (this.clients.size >= this.maxClients) return null;
    const reservation = Object.freeze({}) as ProjectionClientReservation;
    this.clients.set(reservation, { phase: "handshaking", pending: [], client: null });
    return reservation;
  }

  /** Release an unused handshake slot after request failure or shutdown. */
  releaseReservation(reservation: ProjectionClientReservation): void {
    const state = this.clients.get(reservation);
    if (state?.client === null) this.clients.delete(reservation);
  }

  /** Register a client and send its authoritative snapshot before normal facts. */
  async connectClient(
    client: ProjectionClient,
    reservation?: ProjectionClientReservation,
  ): Promise<boolean> {
    if (client.readyState !== OPEN_READY_STATE || this.clients.has(client)) {
      if (reservation) this.releaseReservation(reservation);
      return false;
    }

    let state: ClientState;
    if (reservation) {
      const reservedState = this.clients.get(reservation);
      if (!reservedState || reservedState.client !== null) return false;
      this.clients.delete(reservation);
      state = { ...reservedState, client };
      this.clients.set(client, state);
    } else {
      const reserved = this.reserveClient();
      if (!reserved) {
        try { client.close(); } catch { /* capacity rejection is isolated */ }
        return false;
      }
      const reservedState = this.clients.get(reserved)!;
      this.clients.delete(reserved);
      state = { ...reservedState, client };
      this.clients.set(client, state);
    }
    const snapshotSequence = this.ensureSequence();

    let snapshot: DaemonSnapshot;
    try {
      snapshot = await this.snapshot(snapshotSequence);
    } catch {
      this.closeClient(client, "invalid_payload");
      return false;
    }

    if (this.clients.get(client) !== state || state.phase === "closing") return false;

    let snapshotEnvelope: DaemonEventEnvelope;
    try {
      snapshotEnvelope = this.createEnvelope("snapshot", {
        ...snapshot,
        cursor: snapshotSequence,
      }, snapshotSequence);
    } catch {
      this.closeClient(client, "invalid_payload");
      return false;
    }
    if (!this.sendToClient(client, snapshotEnvelope)) return false;

    state.phase = "ready";
    const pending = state.pending.splice(0);
    for (const envelope of pending) {
      const current = this.clients.get(client);
      if (current !== state || current.phase === "closing") return false;
      if (!this.sendToClient(client, envelope)) return false;
    }
    const current = this.clients.get(client);
    return current === state && current.phase !== "closing";
  }

  disconnectClient(client: ProjectionClient): void {
    this.clients.delete(client);
  }

  /** Mark a client as closing while retaining its aggregate admission slot. */
  markClientClosing(client: ProjectionClient): void {
    const state = this.clients.get(client);
    if (!state) return;
    state.phase = "closing";
    state.pending.length = 0;
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
    const eligible = [...this.clients.values()].filter(
      (state) => state.client !== null && state.phase !== "closing",
    );
    if (eligible.length === 0) return;

    const sequence = this.reserveSequence();
    let envelope: DaemonEventEnvelope<DaemonEventDataMap[E]>;
    try {
      envelope = this.createEnvelope(event, data, sequence, correlation);
    } catch {
      this.report("invalid_envelope");
      return;
    }

    for (const state of eligible) {
      const client = state.client;
      if (!client) continue;
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
    for (const [key, state] of [...this.clients.entries()]) {
      if (state.client) this.closeClient(state.client);
      else this.clients.delete(key);
    }
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
    const state = this.clients.get(client);
    if (!state || state.phase === "closing") return;
    this.markClientClosing(client);
    try {
      client.close();
    } catch {
      // A broken client is already isolated; cleanup remains best effort.
    }
    if (diagnostic) this.report(diagnostic);
  }

  private report(code: ProtocolDiagnostic["code"]): void {
    this.onDiagnostic?.(safeProtocolDiagnostic(code));
  }
}
