import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { isAbsolute } from "node:path";
import type {
  LocalControlReadRequest,
  LocalControlReadResponse,
} from "../../../shared/local-control-read-contract.js";

export const LOCAL_CONTROL_UDS_MAX_REQUEST_BYTES = 64 * 1024;
export const LOCAL_CONTROL_UDS_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_QUEUED_REQUESTS_PER_CLIENT = 16;

export interface LocalControlUdsServerOptions {
  socketPath: string;
  read(request: unknown): Promise<LocalControlReadResponse>;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  const directory = dirname(socketPath);
  const directoryStat = await lstat(directory).catch(() => null);
  if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("UDS parent directory must exist and be a real directory");
  }
  const uid = currentUid();
  if (uid !== undefined && directoryStat.uid !== uid) {
    throw new Error("UDS parent directory must belong to the current user");
  }
  if ((directoryStat.mode & 0o700) !== 0o700 || (directoryStat.mode & 0o077) !== 0) {
    throw new Error("UDS parent directory must not be accessible by group or other users");
  }

  const existing = await lstat(socketPath).catch(() => null);
  if (!existing) return;
  if (!existing.isSocket() || existing.isSymbolicLink()) {
    throw new Error("UDS path already exists and is not a removable socket");
  }
  if (uid !== undefined && existing.uid !== uid) {
    throw new Error("Existing UDS socket belongs to another user");
  }
  const probeResult = await new Promise<boolean | null>((resolve) => {
    const probe = createConnection(socketPath);
    const finish = (connected: boolean | null) => {
      probe.destroy();
      resolve(connected);
    };
    probe.once("connect", () => finish(true));
    probe.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? false : null);
    });
    probe.setTimeout(250, () => finish(null));
  });
  if (probeResult === true) throw new Error("UDS socket is already accepting connections");
  if (probeResult === null) throw new Error("Could not verify whether the existing UDS socket is stale");
  const current = await lstat(socketPath).catch(() => null);
  if (!current?.isSocket() || current.dev !== existing.dev || current.ino !== existing.ino) {
    throw new Error("UDS path changed during stale socket inspection");
  }
  await unlink(socketPath);
}

/** Experimental newline-framed read-only UDS adapter for the v1 read contract. */
export class LocalControlUdsServer {
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  private socketIdentity: { dev: number; ino: number } | null = null;

  constructor(private readonly options: LocalControlUdsServerOptions) {}

  /** Bind a private Linux UDS endpoint; no Mission authority is added here. */
  async start(): Promise<void> {
    if (this.server) return;
    if (!isAbsolute(this.options.socketPath) || Buffer.byteLength(this.options.socketPath) > 100) {
      throw new Error("UDS socket path must be absolute and fit the Linux socket path limit");
    }
    await prepareSocketPath(this.options.socketPath);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.socketPath, resolve);
      });
      const before = await lstat(this.options.socketPath);
      await chmod(this.options.socketPath, 0o600);
      const after = await lstat(this.options.socketPath);
      if (!after.isSocket() || before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error("UDS path changed while applying socket permissions");
      }
      if ((after.mode & 0o777) !== 0o600) throw new Error("UDS socket permissions could not be restricted");
      this.socketIdentity = { dev: after.dev, ino: after.ino };
    } catch (error) {
      this.server = null;
      this.socketIdentity = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const current = await lstat(this.options.socketPath).catch(() => null);
      if (current?.isSocket()) await unlink(this.options.socketPath).catch(() => undefined);
      throw error;
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let queued = 0;
    let chain = Promise.resolve();
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (buffer.length > LOCAL_CONTROL_UDS_MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length === 0 || line.length > LOCAL_CONTROL_UDS_MAX_REQUEST_BYTES || ++queued > MAX_QUEUED_REQUESTS_PER_CLIENT) {
          socket.destroy();
          return;
        }
        chain = chain.then(async () => {
          queued -= 1;
          if (socket.destroyed) return;
          let response: LocalControlReadResponse;
          try {
            const request = JSON.parse(line.toString("utf8")) as unknown;
            response = await this.options.read(request);
          } catch {
            response = { ok: false, code: "INVALID_REQUEST", message: "The local-control request is invalid" };
          }
          const encoded = Buffer.from(`${JSON.stringify(response)}\n`);
          if (encoded.length > LOCAL_CONTROL_UDS_MAX_RESPONSE_BYTES) {
            socket.destroy();
            return;
          }
          if (!socket.destroyed) {
            socket.write(encoded);
          }
        }).catch(() => {
          socket.destroy();
        });
      }
    });
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
  }

  /** Close admission and terminate remaining experimental client connections. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const current = await lstat(this.options.socketPath).catch(() => null);
    const identity = this.socketIdentity;
    this.socketIdentity = null;
    if (current?.isSocket() && identity && current.dev === identity.dev && current.ino === identity.ino) {
      await unlink(this.options.socketPath).catch(() => undefined);
    }
  }
}

/** One bounded request over the experimental newline-framed UDS protocol. */
export async function requestLocalControlUds(
  socketPath: string,
  request: LocalControlReadRequest,
  timeoutMs = 2_000,
): Promise<unknown> {
  const encoded = Buffer.from(`${JSON.stringify(request)}\n`);
  if (encoded.length > LOCAL_CONTROL_UDS_MAX_REQUEST_BYTES) throw new Error("UDS request exceeds the maximum payload size");
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("UDS request timed out")), timeoutMs);
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (buffer.length > LOCAL_CONTROL_UDS_MAX_RESPONSE_BYTES) {
        finish(new Error("UDS response exceeds the maximum payload size"));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(buffer.subarray(0, newline).toString("utf8")) as unknown);
      } catch {
        finish(new Error("UDS response is invalid JSON"));
      }
    });
    socket.once("connect", () => socket.write(encoded));
  });
}
