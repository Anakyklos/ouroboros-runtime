import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertPrivateRegularFileOrMissing,
  securePrivateDirectory,
} from "./local-control-auth.js";

/** Designated holder identities for administrative authority fencing under D12. */
export type AuthorityFenceHolderType = "daemon" | "offline_admin";

/** An active, exclusive authority fence handle. */
export interface AuthorityFenceHandle {
  readonly holder: AuthorityFenceHolderType;
  readonly fencePath: string;
  readonly pid: number;
  readonly acquiredAt: number;
  /** Release the exclusive fence lock and close the backing database. */
  release(): void;
  /** Check if the handle is still actively held. */
  isHeld(): boolean;
}

/** Base error for authority fencing failures. */
export class AuthorityFenceError extends Error {
  constructor(message: string, readonly reason?: string) {
    super(message);
    this.name = "AuthorityFenceError";
  }
}

/** Error thrown when an exclusive authority fence cannot be acquired because another holder owns it. */
export class AuthorityFenceLockedError extends AuthorityFenceError {
  constructor(message: string, readonly holder?: string) {
    super(message, "LOCKED");
    this.name = "AuthorityFenceLockedError";
  }
}

/** Compute the deterministic default fence database path for an AuthStore SQLite file. */
export function defaultAuthorityFencePath(databasePath: string): string {
  if (databasePath === ":memory:") return ":memory:";
  return `${databasePath}.fence`;
}

interface FenceRow {
  id: number;
  holder: string;
  acquired_at: number;
  pid: number;
}

const activeProcessFences = new Map<string, AuthorityFenceHandle>();

function readFenceHolderInfo(db: Database): { holder?: string; pid?: number } {
  try {
    const row = db.query(
      "SELECT holder, pid FROM authority_fence WHERE id = 1",
    ).get() as FenceRow | null;
    return { holder: row?.holder, pid: row?.pid };
  } catch {
    return {};
  }
}

/**
 * Acquire the exclusive daemon authority fence.
 *
 * Under D12 (Alternative 1), the daemon owns administrative authority coordination
 * during its runtime. This lock is held continuously across daemon lifetime and is
 * automatically freed by the OS kernel upon normal shutdown or SIGKILL.
 */
export function acquireDaemonAuthorityFence(
  fencePath: string,
  options: { timeoutMs?: number } = {},
): AuthorityFenceHandle {
  return acquireAuthorityFence(fencePath, "daemon", options.timeoutMs ?? 0);
}

/**
 * Acquire the exclusive offline authority fence for administrative CLI operations.
 *
 * Offline mutations (bootstrap, recovery, rotate, revoke) require proven exclusive
 * ownership. If the daemon or another offline writer holds the fence, this fails closed.
 */
export function acquireOfflineAuthorityFence(
  fencePath: string,
  options: { timeoutMs?: number } = {},
): AuthorityFenceHandle {
  return acquireAuthorityFence(fencePath, "offline_admin", options.timeoutMs ?? 50);
}

function acquireAuthorityFence(
  fencePath: string,
  holder: AuthorityFenceHolderType,
  timeoutMs: number,
): AuthorityFenceHandle {
  if (fencePath === ":memory:") {
    let held = true;
    return {
      holder,
      fencePath,
      pid: process.pid,
      acquiredAt: Date.now(),
      release() { held = false; },
      isHeld() { return held; },
    };
  }

  // Check in-process registration first
  const existingInProcess = activeProcessFences.get(fencePath);
  if (existingInProcess && existingInProcess.isHeld()) {
    throw new AuthorityFenceLockedError(
      `Authority fence at ${fencePath} is held by ${existingInProcess.holder} (pid: ${existingInProcess.pid})`,
      existingInProcess.holder,
    );
  }

  securePrivateDirectory(dirname(fencePath));
  assertPrivateRegularFileOrMissing(fencePath);

  const db = new Database(fencePath);
  try {
    chmodSync(fencePath, 0o600);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, timeoutMs)};`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS authority_fence (
        id INTEGER PRIMARY KEY,
        holder TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        pid INTEGER NOT NULL
      );
    `);

    // 1. Commit current holder record so external readers can inspect holder metadata
    const acquiredAt = Date.now();
    db.query(`
      INSERT INTO authority_fence (id, holder, acquired_at, pid)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        holder = excluded.holder,
        acquired_at = excluded.acquired_at,
        pid = excluded.pid;
    `).run(holder, acquiredAt, process.pid);

    // 2. Open active exclusive transaction to hold the WAL write lock
    db.exec("BEGIN IMMEDIATE;");

    let held = true;
    const handle: AuthorityFenceHandle = {
      holder,
      fencePath,
      pid: process.pid,
      acquiredAt,
      release() {
        if (!held) return;
        held = false;
        activeProcessFences.delete(fencePath);
        try {
          db.exec("ROLLBACK;");
        } catch {
          // Ignore rollback failure if already closed or aborted
        } finally {
          try {
            db.close();
          } catch {
            // Ignore close errors
          }
        }
      },
      isHeld() {
        return held;
      },
    };
    activeProcessFences.set(fencePath, handle);
    return handle;
  } catch (error) {
    const isBusy =
      error instanceof Error &&
      ((error as { code?: string }).code === "SQLITE_BUSY" ||
        error.message.includes("database is locked"));

    if (isBusy) {
      const holderInfo = readFenceHolderInfo(db);
      try {
        db.close();
      } catch {
        // Ignore close error on cleanup
      }
      throw new AuthorityFenceLockedError(
        `Authority fence at ${fencePath} is held by ${holderInfo.holder ?? "another process"} (pid: ${holderInfo.pid ?? "unknown"})`,
        holderInfo.holder,
      );
    }

    try {
      db.close();
    } catch {
      // Ignore close error on cleanup
    }
    throw error;
  }
}

/**
 * Probe whether an authority fence is currently locked by an active process.
 * Does not block or hold the lock.
 */
export function probeAuthorityFence(fencePath: string): {
  locked: boolean;
  holder?: string;
  pid?: number;
} {
  if (fencePath === ":memory:") return { locked: false };
  const inProcess = activeProcessFences.get(fencePath);
  if (inProcess && inProcess.isHeld()) {
    return { locked: true, holder: inProcess.holder, pid: inProcess.pid };
  }
  if (!existsSync(fencePath)) {
    return { locked: false };
  }

  let db: Database | undefined;
  try {
    db = new Database(fencePath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 0;");
    db.exec("BEGIN IMMEDIATE;");
    // If BEGIN IMMEDIATE succeeded, nobody holds the exclusive lock.
    db.exec("ROLLBACK;");
    return { locked: false };
  } catch (error) {
    const isBusy =
      error instanceof Error &&
      ((error as { code?: string }).code === "SQLITE_BUSY" ||
        error.message.includes("database is locked"));

    if (isBusy && db) {
      const info = readFenceHolderInfo(db);
      return { locked: true, holder: info.holder, pid: info.pid };
    }
    return { locked: false };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close error
    }
  }
}
