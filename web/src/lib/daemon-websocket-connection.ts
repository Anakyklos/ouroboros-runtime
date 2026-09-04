import {
  DaemonEventStream,
  calculateReconnectDelay,
} from "./daemon-event-stream";
import type {
  DaemonEventEnvelope,
  DaemonSnapshot,
  ProtocolDiagnostic,
} from "../../../shared/daemon-event-contract";

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
}

export interface DaemonWebSocketConnectionOptions {
  url: string;
  maxReconnectAttempts?: number;
  createWebSocket?: (url: string) => WebSocketLike;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  onStatus?: (status: "connected" | "disconnected" | "reconnecting") => void;
  onSnapshot?: (snapshot: DaemonSnapshot) => void;
  onEnvelope?: (envelope: DaemonEventEnvelope) => void;
  onDiagnostic?: (diagnostic: ProtocolDiagnostic) => void;
}

const CONNECTING_READY_STATE = 0;
const OPEN_READY_STATE = 1;

function defaultCreateWebSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

export class DaemonWebSocketConnection {
  private readonly url: string;
  private readonly maxReconnectAttempts: number;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly setTimer: (callback: () => void, delay: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onStatus?: DaemonWebSocketConnectionOptions["onStatus"];
  private readonly onSnapshot?: DaemonWebSocketConnectionOptions["onSnapshot"];
  private readonly onEnvelope?: DaemonWebSocketConnectionOptions["onEnvelope"];
  private readonly onDiagnostic?: DaemonWebSocketConnectionOptions["onDiagnostic"];
  private readonly stream: DaemonEventStream;
  private socket: WebSocketLike | null = null;
  private reconnectTimer: unknown = null;
  private reconnectAttempts = 0;
  private generation = 0;
  private stopped = true;

  constructor(options: DaemonWebSocketConnectionOptions) {
    this.url = options.url;
    this.maxReconnectAttempts = Math.max(0, options.maxReconnectAttempts ?? 10);
    this.createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
    this.setTimer = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onStatus = options.onStatus;
    this.onSnapshot = options.onSnapshot;
    this.onEnvelope = options.onEnvelope;
    this.onDiagnostic = options.onDiagnostic;
    this.stream = new DaemonEventStream({
      onSnapshot: (snapshot) => {
        this.reconnectAttempts = 0;
        this.onSnapshot?.(snapshot);
        this.onStatus?.("connected");
      },
      onEnvelope: (envelope) => this.onEnvelope?.(envelope),
      onDiagnostic: (diagnostic) => this.onDiagnostic?.(diagnostic),
    });
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  disconnect(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      this.clearSocketHandlers(socket);
      if (socket.readyState === CONNECTING_READY_STATE || socket.readyState === OPEN_READY_STATE) {
        socket.close();
      }
    }
    this.onStatus?.("disconnected");
  }

  send(data: unknown): boolean {
    if (this.socket?.readyState !== OPEN_READY_STATE) return false;
    try {
      this.socket.send(JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  get cursor(): number {
    return this.stream.cursor;
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.socket && (this.socket.readyState === CONNECTING_READY_STATE || this.socket.readyState === OPEN_READY_STATE)) {
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = this.createWebSocket(this.url);
    } catch {
      this.onDiagnostic?.({ code: "transport_error" });
      this.scheduleReconnect();
      return;
    }
    const generation = ++this.generation;
    this.socket = socket;
    this.onStatus?.("reconnecting");

    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.clearReconnectTimer();
    };

    socket.onmessage = (event) => {
      if (!this.isCurrent(socket, generation)) return;
      let value: unknown;
      try {
        value = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        this.onDiagnostic?.({ code: "invalid_envelope" });
        return;
      }

      const decision = this.stream.accept(value);
      if (decision === "resync_required") {
        this.scheduleReconnect();
        this.invalidateSocket(socket, generation);
      }
    };

    socket.onerror = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.onDiagnostic?.({ code: "transport_error" });
      this.invalidateSocket(socket, generation);
      this.scheduleReconnect();
    };

    socket.onclose = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      this.clearSocketHandlers(socket);
      if (this.stopped) {
        this.onStatus?.("disconnected");
        return;
      }
      this.onStatus?.("disconnected");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

    const delay = calculateReconnectDelay(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.onStatus?.("reconnecting");
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private invalidateSocket(socket: WebSocketLike, generation: number): void {
    if (!this.isCurrent(socket, generation)) return;
    this.socket = null;
    this.generation += 1;
    this.clearSocketHandlers(socket);
    if (socket.readyState === CONNECTING_READY_STATE || socket.readyState === OPEN_READY_STATE) {
      socket.close();
    }
  }

  private clearSocketHandlers(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  private isCurrent(socket: WebSocketLike, generation: number): boolean {
    return !this.stopped && this.socket === socket && this.generation === generation;
  }
}
