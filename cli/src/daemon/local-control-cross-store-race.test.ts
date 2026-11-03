import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_CONTROL_AUTH_SCOPES, type LocalControlAuthenticatedClient } from "../../../shared/local-control-auth-contract.js";
import { LocalControlAdmissionClient, LoopbackJsonRpcTransport, RpcProtocolError } from "../commands/local-control-client.js";
import { EffectClass, MissionState, type CapabilityContract, type Mission } from "../mission/contracts.js";
import type { MissionAdmissionStore, MissionStore } from "../mission/ports.js";
import { validateCapabilityGrantCoverage } from "../mission/capability-grants.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import { EventBus } from "./event-bus.js";
import { LocalControlAdmissionService, type MissionAdmissionAuthority } from "./local-control-admission.js";
import {
  LocalControlCredentialStore,
  readLocalControlClientCredential,
  requiredLocalControlScope,
} from "./local-control-auth.js";
import { startHeadlessDaemon, type HeadlessDaemonDependencies } from "./main.js";
import { DaemonServer } from "./server.js";

const directories: string[] = [];

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function newDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function unusedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function cleanEnvironment(dataDir: string): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  environment.OUROBOROS_DATA_DIR = dataDir;
  return environment;
}

async function runAdminCliProcess(dataDir: string, args: readonly string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const cliPath = fileURLToPath(new URL("../commands/admin-cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "run", cliPath, ...args], {
    cwd: process.cwd(),
    env: cleanEnvironment(dataDir),
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

interface AuthFacts {
  scopes_json: string;
  authority_epoch: number;
  credential_generation: number;
  revoked_at: number | null;
  limits_json: string | null;
  max_epoch: number | null;
}

function authFacts(databasePath: string, clientId: string): AuthFacts | null {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database.query(`
      SELECT scopes_json, authority_epoch, credential_generation, revoked_at, limits_json
      FROM local_control_clients WHERE client_id = ?
    `).get(clientId) as Omit<AuthFacts, "max_epoch"> | null;
    if (!row) return null;
    const highWater = database.query(`
      SELECT max_epoch FROM local_control_authority_epochs WHERE client_id = ?
    `).get(clientId) as { max_epoch: number } | null;
    return { ...row, max_epoch: highWater?.max_epoch ?? null };
  } finally {
    database.close();
  }
}

function missionFixture(missionId: string): Mission {
  const now = new Date().toISOString();
  return {
    missionId,
    schemaVersion: 1,
    source: "test",
    originalIntent: "Record an isolated cross-store fixture fact",
    sanitizedOriginalIntent: "Record an isolated cross-store fixture fact",
    originalIntentRef: "sha256:cross-store-fixture-intent",
    interpretedObjective: "Keep the test Mission durable",
    constraints: [],
    acceptanceCriteria: ["The Mission is persisted in its own SQLite store"],
    budgetPolicy: {},
    allowedCapabilityScope: {
      capabilityIds: [],
      allowedEffectClasses: [],
      allowedRefPrefixes: [],
    },
    approvalRequirements: [],
    contextRefs: [],
    state: MissionState.READY,
    currentPlanRevisionId: "cross-store-fixture-revision",
    invocationRefs: [],
    evidenceRefs: [],
    criterionVerifications: [],
    unresolvedQuestions: [],
    createdAt: now,
    updatedAt: now,
    recoveryMetadata: { recovered: false, recoveryCount: 0 },
  };
}

async function waitForWorkerMarker(stream: ReadableStream<Uint8Array>, marker: string): Promise<void> {
  const reader = stream.getReader();
  let text = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const reading = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`Crash fixture exited before marker ${marker}`);
      text += new TextDecoder().decode(value);
      if (text.split("\n").includes(marker)) return;
    }
  })();
  try {
    await Promise.race([
      reading,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Crash fixture did not reach marker ${marker}`)), 10_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function killWorkerAtMarker(dataDir: string, clientId: string, missionId: string, mode: string, marker: string): Promise<void> {
  const workerPath = fileURLToPath(new URL("./local-control-cross-store-crash-worker.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "run", workerPath, mode, dataDir, clientId, missionId], {
    cwd: process.cwd(),
    env: cleanEnvironment(dataDir),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let exited = false;
  try {
    await waitForWorkerMarker(child.stdout, marker);
    child.kill("SIGKILL");
    const exitCode = await child.exited;
    exited = true;
    expect(exitCode).not.toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    if (!exited) {
      child.kill("SIGKILL");
      await child.exited;
      await new Response(child.stderr).text();
    }
  }
}

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.length = 0;
});

describe("AuthStore and MissionStore cross-store boundary (real SQLite)", () => {
  it("lets an already admitted daemon request finish after a separate CLI authority commit", async () => {
    const dataDir = await newDirectory("ouroboros-cross-store-rpc-");
    const authPath = join(dataDir, "local-control-auth.db");
    const missionPath = join(dataDir, "missions.db");
    const clientId = "cross-store-admission-client";
    const requestId = "cross-store-admission-before-rotation";
    const newCredentialFile = join(dataDir, "new-credential.json");
    const port = await unusedPort();
    const authStore = new LocalControlCredentialStore(authPath);
    const initialCredential = authStore.provision(clientId, ["mission.create"], Date.now() + 60_000);
    authStore.close();

    const admissionEntered = deferred<LocalControlAuthenticatedClient>();
    const releaseAdmission = deferred<void>();
    let composedMissionStore: MissionStore | undefined;
    let stop: (() => Promise<void>) | undefined;

    try {
      const blockingCreateServer: NonNullable<HeadlessDaemonDependencies["createServer"]> = (
        storage,
        missionStore,
        engine,
        requestShutdown,
        authorization,
        capabilityRegistry,
      ) => {
        composedMissionStore = missionStore;
        const realAdmission = new LocalControlAdmissionService(
          engine,
          missionStore as MissionStore & MissionAdmissionStore,
        );
        const gatedAdmission: MissionAdmissionAuthority = {
          async admit(input, client) {
            admissionEntered.resolve(client);
            await releaseAdmission.promise;
            return realAdmission.admit(input, client);
          },
        };
        return new DaemonServer(
          storage,
          { port, host: "127.0.0.1" },
          new EventBus(),
          missionStore,
          undefined,
          engine,
          requestShutdown,
          authorization,
          capabilityRegistry,
          gatedAdmission,
        );
      };

      stop = await startHeadlessDaemon({
        dataDir,
        port,
        createServer: blockingCreateServer,
        forceTerminate: () => {},
        setExitCode: () => {},
        onDiagnostic: () => {},
      });

      const oldTransport = new LoopbackJsonRpcTransport({
        baseUrl: `http://127.0.0.1:${port}`,
        authorization: `Bearer ${initialCredential.token}`,
      });
      const admissionClient = new LocalControlAdmissionClient({
        request: (params) => oldTransport.call("local_control.admit", params),
      });
      const pendingAdmission = admissionClient.admit({
        requestId,
        originalIntent: "Create one inert Mission while authority changes",
        constraints: [],
        acceptanceCriteria: ["The Mission remains unprivileged"],
      });

      const admittedPrincipal = await admissionEntered.promise;
      expect(admittedPrincipal).toMatchObject({ clientId, scopes: ["mission.create"] });

      const cli = await runAdminCliProcess(dataDir, [
        "auth", "rotate", clientId, "mission.read", "1", newCredentialFile,
      ]);
      expect(cli.exitCode).toBe(0);
      expect(cli.stderr).toBe("");
      expect(cli.stdout).toContain('"result": "rotated"');
      expect(cli.stdout).not.toMatch(/oc1\.|token_hash|Bearer/iu);
      expect(authFacts(authPath, clientId)).toMatchObject({
        scopes_json: '["mission.read"]',
        authority_epoch: 2,
        credential_generation: 2,
        revoked_at: null,
        max_epoch: 2,
      });

      const newCredential = readLocalControlClientCredential(newCredentialFile);
      const currentTransport = new LoopbackJsonRpcTransport({
        baseUrl: `http://127.0.0.1:${port}`,
        authorization: `Bearer ${newCredential.token}`,
      });
      const deniedCurrentAdmission = new LocalControlAdmissionClient({
        request: (params) => currentTransport.call("local_control.admit", params),
      });
      await expect(deniedCurrentAdmission.admit({
        requestId: "cross-store-admission-after-rotation",
        originalIntent: "This current principal no longer has mission.create",
        constraints: [],
        acceptanceCriteria: [],
      })).rejects.toBeInstanceOf(RpcProtocolError);

      releaseAdmission.resolve();
      const committed = await pendingAdmission;
      expect(committed).toMatchObject({ ok: true, operation: "mission.admit" });
      const missionId = committed.data.missionId;
      const persisted = await (composedMissionStore as SqliteMissionStore).getMission(missionId);
      expect(persisted).toMatchObject({
        missionId,
        source: "operator",
        allowedCapabilityScope: {
          capabilityIds: [],
          allowedEffectClasses: [],
          allowedRefPrefixes: [],
        },
      });
      expect(await (composedMissionStore as SqliteMissionStore).getMissionAdmission(clientId, requestId))
        .toMatchObject({ missionId });
    } finally {
      releaseAdmission.resolve();
      await stop?.();
    }
  });

  it("keeps a valid SQLite authority snapshot stale after an entitlement commit on another connection", async () => {
    const dataDir = await newDirectory("ouroboros-cross-store-snapshot-");
    const authPath = join(dataDir, "local-control-auth.db");
    const clientId = "cross-store-snapshot-client";
    const originalLimits = {
      schemaVersion: 1,
      bindings: [{ capabilityId: "fixture.read", effectClass: "read", allowedRefPrefixes: ["refs/fixture/old"] }],
    };
    const updatedLimits = {
      schemaVersion: 1,
      bindings: [{ capabilityId: "fixture.read", effectClass: "read", allowedRefPrefixes: ["refs/fixture/new"] }],
    };
    const store = new LocalControlCredentialStore(authPath);
    store.provision(clientId, ["mission.create"], Date.now() + 60_000, originalLimits);
    const reader = new Database(authPath, { readonly: true });

    try {
      expect(store.getEntitlementLimits(clientId)).toEqual(originalLimits);
      reader.exec("BEGIN");
      const captured = reader.query(`
        SELECT scopes_json, authority_epoch, limits_json
        FROM local_control_clients WHERE client_id = ?
      `).get(clientId) as { scopes_json: string; authority_epoch: number; limits_json: string | null };
      expect(captured.authority_epoch).toBe(1);

      expect(store.setEntitlementLimits(clientId, updatedLimits)).toBe(true);
      const retainedSnapshot = reader.query(`
        SELECT scopes_json, authority_epoch, limits_json
        FROM local_control_clients WHERE client_id = ?
      `).get(clientId);
      expect(retainedSnapshot).toEqual(captured);

      reader.exec("COMMIT");
      const current = reader.query(`
        SELECT scopes_json, authority_epoch, limits_json
        FROM local_control_clients WHERE client_id = ?
      `).get(clientId) as { scopes_json: string; authority_epoch: number; limits_json: string | null };
      expect(current.authority_epoch).toBe(captured.authority_epoch + 1);
      expect(JSON.parse(current.limits_json!)).toEqual(updatedLimits);
      expect(store.getEntitlementLimits(clientId)).toEqual(updatedLimits);
    } finally {
      try { reader.exec("ROLLBACK"); } catch { /* The read transaction may already be committed. */ }
      reader.close();
      store.close();
    }

    const reopened = new LocalControlCredentialStore(authPath);
    try {
      expect(reopened.getEntitlementLimits(clientId)).toEqual(updatedLimits);
      expect(authFacts(authPath, clientId)).toMatchObject({ authority_epoch: 2, max_epoch: 2 });
    } finally {
      reopened.close();
    }
  });

  it("recovers the distinct durable states before and after each independent SQLite commit", async () => {
    const dataDir = await newDirectory("ouroboros-cross-store-crash-");
    const authPath = join(dataDir, "local-control-auth.db");
    const missionPath = join(dataDir, "missions.db");
    const clientId = "cross-store-crash-client";
    const missionId = "cross-store-crash-mission";
    const initialLimits = {
      schemaVersion: 1,
      bindings: [{ capabilityId: "fixture.read", effectClass: "read", allowedRefPrefixes: ["refs/fixture"] }],
    };

    const auth = new LocalControlCredentialStore(authPath);
    auth.provision(clientId, ["mission.create"], Date.now() + 60_000, initialLimits);
    auth.close();
    const missions = new SqliteMissionStore(missionPath);
    await missions.initialize();
    await missions.createMission(missionFixture(missionId));
    await missions.close();
    const initialAuthFacts = authFacts(authPath, clientId);

    await killWorkerAtMarker(
      dataDir,
      clientId,
      missionId,
      "hold-auth-update-before-commit",
      "AUTH_UPDATE_UNCOMMITTED",
    );
    const afterPreCommitCrash = new LocalControlCredentialStore(authPath);
    try {
      expect(authFacts(authPath, clientId)).toEqual(initialAuthFacts);
      expect(afterPreCommitCrash.getEntitlementLimits(clientId)).toEqual(initialLimits);
    } finally {
      afterPreCommitCrash.close();
    }
    const missionAfterPreCommitCrash = new SqliteMissionStore(missionPath);
    await missionAfterPreCommitCrash.initialize();
    expect(await missionAfterPreCommitCrash.listCapabilityGrants(missionId)).toEqual([]);
    await missionAfterPreCommitCrash.close();

    await killWorkerAtMarker(
      dataDir,
      clientId,
      missionId,
      "commit-auth-entitlement",
      "AUTH_COMMITTED_BEFORE_MISSION_OPERATION",
    );
    const afterAuthCommitCrash = new LocalControlCredentialStore(authPath);
    try {
      expect(afterAuthCommitCrash.getEntitlementLimits(clientId)).toBeNull();
      expect(authFacts(authPath, clientId)).toMatchObject({
        scopes_json: '["mission.create"]',
        authority_epoch: 2,
        credential_generation: 1,
        revoked_at: null,
        limits_json: null,
        max_epoch: 2,
      });
    } finally {
      afterAuthCommitCrash.close();
    }
    const missionAfterAuthCommitCrash = new SqliteMissionStore(missionPath);
    await missionAfterAuthCommitCrash.initialize();
    expect(await missionAfterAuthCommitCrash.listCapabilityGrants(missionId)).toEqual([]);
    await missionAfterAuthCommitCrash.close();

    // Fixture only: this models a future caller dying after the current
    // internal ledger append commits. It is not a production issuance path.
    await killWorkerAtMarker(
      dataDir,
      clientId,
      missionId,
      "append-untrusted-ledger-fixture",
      "MISSION_LEDGER_COMMITTED_BEFORE_CALLER_ACK",
    );
    const afterMissionCommitCrash = new SqliteMissionStore(missionPath);
    await afterMissionCommitCrash.initialize();
    try {
      const persistedFixture = await afterMissionCommitCrash.listCapabilityGrants(missionId);
      expect(persistedFixture).toHaveLength(1);
      expect(persistedFixture[0]).toMatchObject({
        grantId: "fixture-only-untrusted-ledger-fact",
        grantorClientId: "fixture-only-untrusted-principal",
        grantorCredentialGeneration: null,
        grantorAuthorityEpoch: null,
      });
      const contract: CapabilityContract = {
        capabilityId: "fixture.read",
        moduleOwner: "fixture-owner",
        effectClass: EffectClass.READ,
        requiresApproval: false,
        requiresOwnerVerification: false,
        allowedInputRefPrefixes: ["refs/fixture/"],
        ownsStorage: false,
      };
      expect(validateCapabilityGrantCoverage({
        missionId,
        capabilityId: contract.capabilityId,
        effectClass: contract.effectClass,
        inputRefs: ["refs/fixture/item"],
        capabilityContract: contract,
        grants: persistedFixture,
        revocations: [],
        evaluatedAt: new Date().toISOString(),
      })).toEqual({ valid: false, reason: "authority_unavailable" });
    } finally {
      await afterMissionCommitCrash.close();
    }
    const authAfterBothCommits = new LocalControlCredentialStore(authPath);
    try {
      expect(authAfterBothCommits.getEntitlementLimits(clientId)).toBeNull();
      expect(authFacts(authPath, clientId)).toMatchObject({ authority_epoch: 2, max_epoch: 2 });
    } finally {
      authAfterBothCommits.close();
    }
  });

  it("keeps missing entitlement, revoked identity, and grant RPC classification fail-closed", async () => {
    const dataDir = await newDirectory("ouroboros-cross-store-negative-");
    const authPath = join(dataDir, "local-control-auth.db");
    const clientId = "cross-store-negative-client";
    const store = new LocalControlCredentialStore(authPath);
    try {
      const credential = store.provision(clientId, ["mission.read"], Date.now() + 60_000);
      expect(store.getEntitlementLimits(clientId)).toBeNull();
      expect(store.authorizeToken(credential.token, "mission.read")?.clientId).toBe(clientId);
      expect(store.revoke(clientId)).toBe(true);
      expect(store.authorizeToken(credential.token, "mission.read")).toBeNull();
      expect(LOCAL_CONTROL_AUTH_SCOPES).toEqual([
        "mission.read", "mission.control", "mission.create", "daemon.admin",
      ]);
      expect(requiredLocalControlScope("mission.grant_capabilities", { missionId: "fixture" })).toBeNull();
      expect(requiredLocalControlScope("local_control.command", { operation: "mission.grant_capabilities" })).toBeNull();
    } finally {
      store.close();
    }
  });
});
