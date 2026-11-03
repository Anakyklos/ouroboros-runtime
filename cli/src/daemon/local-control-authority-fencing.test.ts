import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer as createNetServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LocalControlCredentialStore,
  acquireDaemonAuthorityFence,
  acquireOfflineAuthorityFence,
  defaultAuthorityFencePath,
  probeAuthorityFence,
  writeLocalControlClientCredential,
  AuthorityFenceLockedError,
} from "./local-control-auth.js";
import { startHeadlessDaemon } from "./main.js";

const directories: string[] = [];

async function newDirectory(prefix = "ouroboros-auth-fencing-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
  }
  directories.length = 0;
});

async function unusedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine unused port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function runAdminCliProcess(
  dataDir: string,
  args: readonly string[],
  port?: number,
  credentialFile?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const adminCliEntry = fileURLToPath(new URL("../commands/admin-cli.ts", import.meta.url));
  const env: Record<string, string> = {
    ...process.env,
    OUROBOROS_DATA_DIR: dataDir,
  };
  if (port) {
    env.OUROBOROS_PORT = String(port);
  }
  if (credentialFile) {
    env.OUROBOROS_CLIENT_CREDENTIAL_FILE = credentialFile;
  }
  const child = Bun.spawn([process.execPath, "run", adminCliEntry, ...args], {
    cwd: dataDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("B2-4 — Administrative Authority Fencing (real SQLite & cross-process)", () => {
  it("proves offline administrative CLI mutations succeed with proven exclusive ownership", async () => {
    const dataDir = await newDirectory();
    const authDbPath = join(dataDir, "local-control-auth.db");
    const credFile = join(dataDir, "operator.json");

    // 1. Provision offline
    const provisionRes = await runAdminCliProcess(dataDir, [
      "auth", "provision", "operator-1", "mission.read,mission.create", "30", credFile,
    ]);
    expect(provisionRes.exitCode).toBe(0);
    expect(provisionRes.stderr).toBe("");
    expect(provisionRes.stdout).toContain('"result": "provisioned"');
    expect(existsSync(credFile)).toBe(true);

    const store1 = new LocalControlCredentialStore(authDbPath);
    expect(store1.hasActiveClients()).toBe(true);
    store1.close();

    // 2. Rotate offline
    const rotateRes = await runAdminCliProcess(dataDir, [
      "auth", "rotate", "operator-1", "mission.read", "60", credFile,
    ]);
    expect(rotateRes.exitCode).toBe(0);
    expect(rotateRes.stderr).toBe("");
    expect(rotateRes.stdout).toContain('"result": "rotated"');

    // 3. Revoke offline
    const revokeRes = await runAdminCliProcess(dataDir, [
      "auth", "revoke", "operator-1",
    ]);
    expect(revokeRes.exitCode).toBe(0);
    expect(revokeRes.stderr).toBe("");
    expect(revokeRes.stdout).toContain('"result": "revoked"');

    const store2 = new LocalControlCredentialStore(authDbPath);
    expect(store2.hasActiveClients()).toBe(false);
    store2.close();
  });

  it("refuses all online administrative CLI mutations fail-closed while daemon holds ownership", async () => {
    const dataDir = await newDirectory();
    const authDbPath = join(dataDir, "local-control-auth.db");
    const port = await unusedPort();
    const adminCredFile = join(dataDir, "admin-client.json");

    // Bootstrap initial client offline so daemon can start
    const initialStore = new LocalControlCredentialStore(authDbPath);
    const cred = initialStore.provision("admin-client", ["daemon.admin", "mission.read"], Date.now() + 60_000);
    writeLocalControlClientCredential(adminCredFile, { schemaVersion: 1, clientId: "admin-client", token: cred.token });
    initialStore.close();

    // Start daemon (daemon acquires daemon authority fence)
    const stopDaemon = await startHeadlessDaemon({
      dataDir,
      port,
      forceTerminate: () => {},
      setExitCode: () => {},
      onDiagnostic: () => {},
    });

    try {
      const credFile = join(dataDir, "new-client.json");

      // 1. Attempt online provision -> REFUSED
      const provRes = await runAdminCliProcess(dataDir, [
        "auth", "provision", "new-client", "mission.read", "30", credFile,
      ], port, adminCredFile);
      expect(provRes.exitCode).toBe(1);
      expect(provRes.stderr).toContain("administrative mutation refused: daemon is active and holds authority ownership");
      expect(provRes.stdout).toBe("");
      expect(existsSync(credFile)).toBe(false);

      // 2. Attempt online rotate -> REFUSED
      const rotRes = await runAdminCliProcess(dataDir, [
        "auth", "rotate", "admin-client", "mission.control", "30", credFile,
      ], port, adminCredFile);
      expect(rotRes.exitCode).toBe(1);
      expect(rotRes.stderr).toContain("administrative mutation refused: daemon is active and holds authority ownership");
      expect(rotRes.stdout).toBe("");
      expect(existsSync(credFile)).toBe(false);

      // 3. Attempt online revoke -> REFUSED
      const revRes = await runAdminCliProcess(dataDir, [
        "auth", "revoke", "admin-client",
      ], port, adminCredFile);
      expect(revRes.exitCode).toBe(1);
      expect(revRes.stderr).toContain("administrative mutation refused: daemon is active and holds authority ownership");
      expect(revRes.stdout).toBe("");

      // 4. Verify read-only CLI commands remain operational while daemon holds fence
      const statusRes = await runAdminCliProcess(dataDir, ["status"], port, adminCredFile);
      expect(statusRes.exitCode).toBe(0);
      expect(statusRes.stdout).toContain('"mode"');

      const versionRes = await runAdminCliProcess(dataDir, ["version"], port, adminCredFile);
      expect(versionRes.exitCode).toBe(0);
      expect(versionRes.stdout).toContain('"protocolVersion"');

      // 5. Verify direct store mutation attempt without fence also throws AuthorityFenceLockedError
      const unmanagedStore = new LocalControlCredentialStore(authDbPath);
      expect(() => {
        unmanagedStore.provision("rogue-client", ["mission.read"], Date.now() + 60_000);
      }).toThrow(AuthorityFenceLockedError);

      expect(() => {
        unmanagedStore.revoke("admin-client");
      }).toThrow(AuthorityFenceLockedError);

      unmanagedStore.close();
    } finally {
      await stopDaemon();
    }
  });

  it("releases fence upon clean daemon shutdown, allowing subsequent offline writes immediately", async () => {
    const dataDir = await newDirectory();
    const authDbPath = join(dataDir, "local-control-auth.db");
    const port = await unusedPort();

    const initialStore = new LocalControlCredentialStore(authDbPath);
    initialStore.provision("admin-client", ["mission.read"], Date.now() + 60_000);
    initialStore.close();

    const stopDaemon = await startHeadlessDaemon({
      dataDir,
      port,
      forceTerminate: () => {},
      setExitCode: () => {},
      onDiagnostic: () => {},
    });

    // Verify fence is held by daemon (probe from another process)
    const fencePath = defaultAuthorityFencePath(authDbPath);
    const probeRes = await runAdminCliProcess(dataDir, [
      "auth", "rotate", "admin-client", "mission.read", "30",
    ], port);
    expect(probeRes.exitCode).toBe(1);
    expect(probeRes.stderr).toContain("administrative mutation refused: daemon is active and holds authority ownership");

    // Clean shutdown
    await stopDaemon();

    // Subsequent offline mutation succeeds immediately
    const rotateRes = await runAdminCliProcess(dataDir, [
      "auth", "rotate", "admin-client", "mission.read,mission.control", "30",
    ]);
    expect(rotateRes.exitCode).toBe(0);
    expect(rotateRes.stdout).toContain('"result": "rotated"');
  });

  it("recovers fence immediately after SIGKILL of daemon without leaving stale lock", async () => {
    const dataDir = await newDirectory();
    const authDbPath = join(dataDir, "local-control-auth.db");
    const fencePath = defaultAuthorityFencePath(authDbPath);

    // Bootstrap client
    const initialStore = new LocalControlCredentialStore(authDbPath);
    initialStore.provision("sigkill-client", ["mission.read"], Date.now() + 60_000);
    initialStore.close();

    // Start daemon in a separate subprocess
    const mainEntry = fileURLToPath(new URL("./main.ts", import.meta.url));
    const port = await unusedPort();
    const daemonProcess = Bun.spawn([process.execPath, "run", mainEntry], {
      cwd: dataDir,
      env: {
        ...process.env,
        OUROBOROS_DATA_DIR: dataDir,
        OUROBOROS_PORT: String(port),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait until daemon is ready
    let daemonReady = false;
    const reader = daemonProcess.stdout.getReader();
    const decoder = new TextDecoder();
    while (!daemonReady) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      if (text.includes("ready on http")) {
        daemonReady = true;
      }
    }
    expect(daemonReady).toBe(true);
    reader.releaseLock();

    // Verify fence is locked while daemon runs by attempting a mutation
    const lockedRes = await runAdminCliProcess(dataDir, [
      "auth", "rotate", "sigkill-client", "mission.read", "30",
    ], port);
    expect(lockedRes.exitCode).toBe(1);
    expect(lockedRes.stderr).toContain("administrative mutation refused: daemon is active and holds authority ownership");

    // Send SIGKILL to the daemon process
    daemonProcess.kill("SIGKILL");
    await daemonProcess.exited;

    // Immediately after SIGKILL, kernel releases POSIX file lock; offline CLI writer succeeds immediately
    const rotateRes = await runAdminCliProcess(dataDir, [
      "auth", "rotate", "sigkill-client", "mission.read,mission.control", "30",
    ]);
    expect(rotateRes.exitCode).toBe(0);
    expect(rotateRes.stdout).toContain('"result": "rotated"');
  });

  it("fails closed when daemon startup cannot acquire authority fence held by another writer", async () => {
    const dataDir = await newDirectory();
    const authDbPath = join(dataDir, "local-control-auth.db");
    const fencePath = defaultAuthorityFencePath(authDbPath);
    const port = await unusedPort();

    // Bootstrap client
    const initialStore = new LocalControlCredentialStore(authDbPath);
    initialStore.provision("admin-client", ["mission.read"], Date.now() + 60_000);
    initialStore.close();

    // Simulate an offline writer holding the fence
    const offlineFence = acquireOfflineAuthorityFence(fencePath);
    expect(offlineFence.isHeld()).toBe(true);

    try {
      // Daemon attempts to start while fence is held
      let startupFailed = false;
      try {
        await startHeadlessDaemon({
          dataDir,
          port,
          forceTerminate: () => {},
          setExitCode: () => {},
          onDiagnostic: () => {},
        });
      } catch (error) {
        startupFailed = true;
        expect((error as Error).message).toContain("Headless daemon startup failed");
      }
      expect(startupFailed).toBe(true);
    } finally {
      offlineFence.release();
    }

    // Now that fence is released, daemon can start normally
    const stopDaemon = await startHeadlessDaemon({
      dataDir,
      port,
      forceTerminate: () => {},
      setExitCode: () => {},
      onDiagnostic: () => {},
    });
    await stopDaemon();
  });

  it("refuses concurrent offline CLI mutations when another offline writer holds the fence", async () => {
    const dataDir = await newDirectory();
    const authDbPath = join(dataDir, "local-control-auth.db");
    const fencePath = defaultAuthorityFencePath(authDbPath);

    // Bootstrap client
    const initialStore = new LocalControlCredentialStore(authDbPath);
    initialStore.provision("admin-client", ["mission.read"], Date.now() + 60_000);
    initialStore.close();

    // Hold the offline fence manually to simulate a concurrent writer in flight
    const holdingFence = acquireOfflineAuthorityFence(fencePath);

    try {
      // Second offline CLI writer attempts mutation
      const rotateRes = await runAdminCliProcess(dataDir, [
        "auth", "rotate", "admin-client", "mission.control", "30",
      ]);
      expect(rotateRes.exitCode).toBe(1);
      expect(rotateRes.stderr).toContain("administrative mutation refused: authority store is locked by another offline writer");
      expect(rotateRes.stdout).toBe("");
    } finally {
      holdingFence.release();
    }

    // After release, writer succeeds
    const rotateResAfter = await runAdminCliProcess(dataDir, [
      "auth", "rotate", "admin-client", "mission.control", "30",
    ]);
    expect(rotateResAfter.exitCode).toBe(0);
    expect(rotateResAfter.stdout).toContain('"result": "rotated"');
  });
});
