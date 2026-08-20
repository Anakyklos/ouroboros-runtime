import { randomUUID } from "node:crypto";
import {
  ALLOWED_DAEMON_EVENTS,
  type AllowedDaemonEvent,
  type DaemonEventEnvelope,
  type DaemonSnapshot,
  safeProtocolDiagnostic,
  type ProtocolDiagnostic,
} from "../../../shared/daemon-event-contract.js";

export interface ProjectionClient {
  readyState: number;
  bufferedAmount: number;
  send(message: string): void;
  close(): void;
}

export interface DaemonProjectionOptions {
  snapshot(cursor: number): DaemonSnapshot;
  createEventId?: () => string;
  maxBufferedAmount?: number;
  onDiagnostic?: (diagnostic: ProtocolDiagnostic) => void;
}

const OPEN_READY_STATE = 1;
const DEFAULT_MAX_BUFFERED_AMOUNT = 1024 * 1024;

export class DaemonProjection {
  private readonly clients = new Set<ProjectionClient>();
  private readonly snapshot: DaemonProjectionOptions["snapshot"];
  private readonly createEventId: () => string;
  private readonly maxBufferedAmount: number;
  private readonly onDiagnostic?: (diagnostic: ProtocolDiagnostic) => void;
  private sequence = 0;

  constructor(options: DaemonProjectionOptions) {
    this.snapshot = options.snapshot;
    this.createEventId = options.createEventId ?? randomUUID;
    this.maxBufferedAmount = Number.isFinite(options.maxBufferedAmount) &&
      (options.maxBufferedAmount ?? 0) > 0
      ? options.maxBufferedAmount!
      : DEFAULT_MAX_BUFFERED_AMOUNT;
    this.onDiagnostic = options.onDiagnostic;
  }

  get currentSequence(): number {
    return this.sequence;
  }

  get connectedClientCount(): number {
    return this.clients.size;
  }

  connectClient(client: ProjectionClient): void {
    if (client.readyState !== OPEN_READY_STATE) return;
    if (this.sequence === 0) this.sequence = 1;

    const snapshot = this.snapshot(this.sequence);
    const envelope = this.createEnvelope("snapshot", {
      ...snapshot,
      cursor: this.sequence,
    });

    if (this.sendToClient(client, envelope)) {
      this.clients.add(client);
    }
  }

  disconnectClient(client: ProjectionClient): void {
    this.clients.delete(client);
  }

  broadcast(event: AllowedDaemonEvent, data: unknown): void {
    if (!(ALLOWED_DAEMON_EVENTS as readonly string[]).includes(event)) {
      this.onDiagnostic?.(safeProtocolDiagnostic("unknown_event"));
      return;
    }

    if (event === "snapshot") {
      this.onDiagnostic?.(safeProtocolDiagnostic("invalid_envelope"));
      return;
    }

    if (this.clients.size === 0) return;

    this.sequence = Math.max(1, this.sequence + 1);
    const envelope = this.createEnvelope(event, data);

    for (const client of [...this.clients]) {
      this.sendToClient(client, envelope);
    }
  }

  closeClients(): void {
    for (const client of [...this.clients]) {
      this.closeClient(client);
    }
    this.clients.clear();
  }

  private createEnvelope<T>(
    event: AllowedDaemonEvent,
    data: T,
  ): DaemonEventEnvelope<T> {
    return {
      version: 1,
      eventId: this.createEventId(),
      sequence: this.sequence,
      event,
      data,
      timestamp: new Date().toISOString(),
    };
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
      this.closeClient(client);
      return false;
    }

    try {
      client.send(JSON.stringify(envelope));
      return true;
    } catch {
      this.closeClient(client);
      this.onDiagnostic?.(safeProtocolDiagnostic("invalid_envelope"));
      return false;
    }
  }

  private closeClient(client: ProjectionClient): void {
    this.clients.delete(client);
    try {
      client.close();
    } catch {
      // A broken client is already isolated; cleanup remains best effort.
    }
  }
}
