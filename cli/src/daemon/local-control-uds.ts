import { link, lstat } from "node:fs/promises";
import { chmodSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
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
  unlinkSocketPathIfOwned(socketPath, existing);
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

/** Remove a socket pathname only while its current inode still matches. */
function unlinkSocketPathIfOwned(socketPath: string, identity: SocketIdentity): boolean {
  try {
    const current = lstatSync(socketPath);
    if (!current.isSocket() || current.dev !== identity.dev || current.ino !== identity.ino) return false;
    unlinkSync(socketPath);
    return true;
  } catch {
    return false;
  }
}

function unlinkSocketPathIfOwnedOrMissing(socketPath: string, identity: SocketIdentity): boolean {
  try {
    const current = lstatSync(socketPath);
    if (!current.isSocket() || current.dev !== identity.dev || current.ino !== identity.ino) return false;
    unlinkSync(socketPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Keep a substituted pathname out of Bun's unconditional Unix-listener close cleanup. */
function preserveReplacementForClose(socketPath: string, identity: SocketIdentity | null): string | null {
  let current;
  try {
    current = lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (identity && current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) return null;

  const preservedPath = `${socketPath}.preserved-${process.pid}-${randomUUID()}`;
  renameSync(socketPath, preservedPath);
  return preservedPath;
}

function restorePreservedPath(preservedPath: string | null, socketPath: string): void {
  if (!preservedPath) return;
  try {
    lstatSync(socketPath);
    // Another pathname now occupies the requested name; never overwrite it.
    throw new Error("A newer UDS pathname appeared while preserving a replacement socket");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  renameSync(preservedPath, socketPath);
}

async function closeServerPreservingPathname(
  server: Server,
  socketPath: string,
  identity: SocketIdentity | null,
): Promise<void> {
  if (!identity) {
    // listen() failed before this instance acquired a socket inode. Closing its
    // unbound Server does not authorize touching the winner's pathname.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return;
  }
  const preservedPath = preserveReplacementForClose(socketPath, identity);
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // Bun's net.Server.close() unlinks the configured pathname. Do not let that
  // runtime cleanup target a substitute inode.
  unlinkSocketPathIfOwned(socketPath, identity);
  restorePreservedPath(preservedPath, socketPath);
  await closed;
}

/** Experimental newline-framed read-only UDS adapter for the v1 read contract. */
export class LocalControlUdsServer {
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  private bindPath: string | null = null;
  private boundIdentity: SocketIdentity | null = null;
  private publishedIdentity: SocketIdentity | null = null;

  constructor(private readonly options: LocalControlUdsServerOptions) {}

  /** Bind a private Linux UDS endpoint; no Mission authority is added here. */
  async start(): Promise<void> {
    if (this.server) return;
    if (!isAbsolute(this.options.socketPath) || Buffer.byteLength(this.options.socketPath) > 100) {
      throw new Error("UDS socket path must be absolute and fit the Linux socket path limit");
    }
    const bindPath = join(dirname(this.options.socketPath), `.ouroboros-uds-${process.pid}-${randomUUID()}`);
    if (Buffer.byteLength(bindPath) > 100) throw new Error("UDS parent directory leaves no room for a private bind pathname");
    await prepareSocketPath(this.options.socketPath);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    this.bindPath = bindPath;
    try {
      this.boundIdentity = await this.bind(server, bindPath);
      await this.configureSocketPath(bindPath, this.boundIdentity);
      await this.publishSocketPath(bindPath, this.options.socketPath);
      this.publishedIdentity = this.boundIdentity;
      if (!unlinkSocketPathIfOwnedOrMissing(bindPath, this.boundIdentity)) {
        throw new Error("UDS private bind pathname changed before publication completed");
      }
      await this.verifyPublishedSocketPath(this.options.socketPath, this.publishedIdentity);
    } catch (error) {
      const bindIdentity = this.boundIdentity;
      const publishedIdentity = this.publishedIdentity;
      await closeServerPreservingPathname(server, bindPath, bindIdentity);
      if (bindIdentity) unlinkSocketPathIfOwned(bindPath, bindIdentity);
      if (publishedIdentity) unlinkSocketPathIfOwned(this.options.socketPath, publishedIdentity);
      this.server = null;
      this.bindPath = null;
      this.boundIdentity = null;
      this.publishedIdentity = null;
      throw error;
    }
  }

  /** Bind is a seam for deterministic lifecycle tests; failed listen owns no pathname. */
  protected async bind(server: Server, socketPath: string): Promise<SocketIdentity> {
    return await new Promise<SocketIdentity>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        try {
          const boundPath = lstatSync(socketPath);
          if (!boundPath.isSocket()) throw new Error("UDS bind did not create a socket pathname");
          resolve({ dev: boundPath.dev, ino: boundPath.ino });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /** Record restrictive permissions only while the path still names our bound socket. */
  protected async configureSocketPath(socketPath: string, identity: SocketIdentity): Promise<void> {
    const before = lstatSync(socketPath);
    if (!before.isSocket() || before.dev !== identity.dev || before.ino !== identity.ino) {
      throw new Error("UDS path changed after bind");
    }
    chmodSync(socketPath, 0o600);
    const after = lstatSync(socketPath);
    if (!after.isSocket() || after.dev !== identity.dev || after.ino !== identity.ino) {
      throw new Error("UDS path changed while applying socket permissions");
    }
    if ((after.mode & 0o777) !== 0o600) throw new Error("UDS socket permissions could not be restricted");
  }

  /** Atomically publish a hard link without replacing a concurrently-created pathname. */
  protected async publishSocketPath(bindPath: string, socketPath: string): Promise<void> {
    await link(bindPath, socketPath);
  }

  /** Confirm the published pathname still refers to the bound listener inode. */
  protected async verifyPublishedSocketPath(socketPath: string, identity: SocketIdentity): Promise<void> {
    const published = await lstat(socketPath);
    if (!published.isSocket() || published.dev !== identity.dev || published.ino !== identity.ino) {
      throw new Error("UDS path changed during publication");
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
    for (const socket of this.sockets) socket.destroy();
    const bindPath = this.bindPath;
    const boundIdentity = this.boundIdentity;
    const publishedIdentity = this.publishedIdentity;
    if (bindPath) await closeServerPreservingPathname(server, bindPath, boundIdentity);
    if (boundIdentity && bindPath) unlinkSocketPathIfOwned(bindPath, boundIdentity);
    if (publishedIdentity) unlinkSocketPathIfOwned(this.options.socketPath, publishedIdentity);
    this.server = null;
    this.bindPath = null;
    this.boundIdentity = null;
    this.publishedIdentity = null;
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
