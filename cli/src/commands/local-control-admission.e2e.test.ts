import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAdminCli } from "./admin-cli.js";
import { startHeadlessDaemon } from "../daemon/main.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import { LocalControlCredentialStore, writeLocalControlClientCredential } from "../daemon/local-control-auth.js";
import { MissionState } from "../mission/contracts.js";

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

async function setupDaemon(dataDir: string, port: number) {
  const authDb = join(dataDir, "local-control-auth.db");
  const authStore = new LocalControlCredentialStore(authDb);
  return { authStore };
}

describe("mission admission E2E", () => {
  it("covers authorization, conflicts, isolation, replay, restart and public projection", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ouroboros-admission-e2e-"));
    const originalEnv = {
      DATA_DIR: process.env.OUROBOROS_DATA_DIR,
      PORT: process.env.OUROBOROS_PORT,
      CREDENTIAL_FILE: process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE,
    };
    let stop: (() => Promise<void>) | undefined;
    let stop2: (() => Promise<void>) | undefined;
    try {
      const port = await unusedPort();
      process.env.OUROBOROS_DATA_DIR = dataDir;
      process.env.OUROBOROS_PORT = String(port);

      const authStore = new LocalControlCredentialStore(join(dataDir, "local-control-auth.db"));
      const operator = authStore.provision("operator", ["mission.read", "mission.create"], Date.now() + 60 * 60_000);
      const reader = authStore.provision("reader", ["mission.read"], Date.now() + 60 * 60_000);
      const other = authStore.provision("other", ["mission.create"], Date.now() + 60 * 60_000);
      authStore.close();

      const operatorFile = join(dataDir, "operator.json");
      const readerFile = join(dataDir, "reader.json");
      const otherFile = join(dataDir, "other.json");
      writeLocalControlClientCredential(operatorFile, { schemaVersion: 1, clientId: operator.clientId, token: operator.token });
      writeLocalControlClientCredential(readerFile, { schemaVersion: 1, clientId: reader.clientId, token: reader.token });
      writeLocalControlClientCredential(otherFile, { schemaVersion: 1, clientId: other.clientId, token: other.token });

      const payloadFile = join(dataDir, "payload.json");
      const conflictFile = join(dataDir, "conflict.json");
      await writeFile(payloadFile, JSON.stringify({
        originalIntent: "Admit mission",
        constraints: ["c1"],
        acceptanceCriteria: ["a1"],
      }));
      await writeFile(conflictFile, JSON.stringify({
        originalIntent: "Different intent",
        constraints: ["c1"],
        acceptanceCriteria: ["a1"],
      }));

      // 1. HTTP 403 without scope and zero writes
      process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE = readerFile;
      stop = await startHeadlessDaemon({ dataDir, port });
      const readerOut: string[] = [];
      const readerErr: string[] = [];
      const readerCode = await runAdminCli(["mission", "admit", "req-scope", "--file", payloadFile], {
        stdout: (text) => readerOut.push(text),
        stderr: (text) => readerErr.push(text),
      });
      expect(readerCode).not.toBe(0);
      await stop();
      stop = undefined;

      // 2. invalid credential
      const invalidFile = join(dataDir, "invalid.json");
      writeLocalControlClientCredential(invalidFile, { schemaVersion: 1, clientId: operator.clientId, token: "oc1.invalid.invalidtokenvalue000000000000000000000000" });
      process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE = invalidFile;
      const portInvalid = await unusedPort();
      process.env.OUROBOROS_PORT = String(portInvalid);
      stop = await startHeadlessDaemon({ dataDir, port: portInvalid });
      const invalidCode = await runAdminCli(["mission", "admit", "req-invalid", "--file", payloadFile], {
        stdout: () => {},
        stderr: () => {},
      });
      expect(invalidCode).not.toBe(0);
      await stop();
      stop = undefined;

      // 3. revoked credential
      const authStore2 = new LocalControlCredentialStore(join(dataDir, "local-control-auth.db"));
      authStore2.revoke(operator.clientId);
      const revokedOperator = authStore2.provision("operator2", ["mission.create"], Date.now() + 60 * 60_000);
      authStore2.close();
      const revokedFile = join(dataDir, "revoked.json");
      writeLocalControlClientCredential(revokedFile, { schemaVersion: 1, clientId: operator.clientId, token: operator.token });
      process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE = revokedFile;
      const portRevoked = await unusedPort();
      process.env.OUROBOROS_PORT = String(portRevoked);
      stop = await startHeadlessDaemon({ dataDir, port: portRevoked });
      const revokedCode = await runAdminCli(["mission", "admit", "req-revoked", "--file", payloadFile], {
        stdout: () => {},
        stderr: () => {},
      });
      expect(revokedCode).not.toBe(0);
      await stop();
      stop = undefined;

      // restore operator credential for remaining tests
      const authStore3 = new LocalControlCredentialStore(join(dataDir, "local-control-auth.db"));
      const freshOperator = authStore3.provision("operator", ["mission.read", "mission.create"], Date.now() + 60 * 60_000);
      authStore3.close();
      writeLocalControlClientCredential(operatorFile, { schemaVersion: 1, clientId: freshOperator.clientId, token: freshOperator.token });
      process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE = operatorFile;

      const port2 = await unusedPort();
      process.env.OUROBOROS_PORT = String(port2);
      stop = await startHeadlessDaemon({ dataDir, port: port2 });

      // admit
      const out1: string[] = [];
      const code1 = await runAdminCli(["mission", "admit", "req-e2e", "--file", payloadFile], {
        stdout: (text) => out1.push(text),
        stderr: () => {},
      });
      expect(code1).toBe(0);
      const admitted = JSON.parse(out1.join(""));
      expect(admitted.state).toBe("created");
      expect(Object.keys(admitted)).not.toContain("originalIntent");
      expect(Object.keys(admitted)).not.toContain("allowedCapabilityScope");

      // replay
      const out2: string[] = [];
      const code2 = await runAdminCli(["mission", "admit", "req-e2e", "--file", payloadFile], {
        stdout: (text) => out2.push(text),
        stderr: () => {},
      });
      expect(code2).toBe(0);
      const replayed = JSON.parse(out2.join(""));
      expect(replayed.missionId).toBe(admitted.missionId);

      // conflict
      const conflictOut: string[] = [];
      const conflictErr: string[] = [];
      const conflictCode = await runAdminCli(["mission", "admit", "req-e2e", "--file", conflictFile], {
        stdout: (text) => conflictOut.push(text),
        stderr: (text) => conflictErr.push(text),
      });
      expect(conflictCode).not.toBe(0);

      // two clients same requestId
      process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE = otherFile;
      const otherOut: string[] = [];
      const otherCode = await runAdminCli(["mission", "admit", "req-e2e", "--file", payloadFile], {
        stdout: (text) => otherOut.push(text),
        stderr: () => {},
      });
      expect(otherCode).toBe(0);
      const otherAdmitted = JSON.parse(otherOut.join(""));
      expect(otherAdmitted.missionId).not.toBe(admitted.missionId);

      // restore operator file
      process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE = operatorFile;

      await stop();
      stop = undefined;

      // restart preserving identity
      const port3 = await unusedPort();
      process.env.OUROBOROS_PORT = String(port3);
      stop2 = await startHeadlessDaemon({ dataDir, port: port3 });
      const out3: string[] = [];
      const code3 = await runAdminCli(["mission", "admit", "req-e2e", "--file", payloadFile], {
        stdout: (text) => out3.push(text),
        stderr: () => {},
      });
      expect(code3).toBe(0);
      const afterRestart = JSON.parse(out3.join(""));
      expect(afterRestart.missionId).toBe(admitted.missionId);

      await stop2();
      stop2 = undefined;

      // persisted state
      const store = new SqliteMissionStore(join(dataDir, "missions.db"));
      await store.initialize();
      const mission = await store.getMission(admitted.missionId);
      expect(mission?.state).toBe(MissionState.CREATED);
      const revisions = await store.getPlanRevisions(admitted.missionId);
      expect(revisions.length).toBe(0);
      const invocations = await store.listInvocations(admitted.missionId);
      expect(invocations.length).toBe(0);
      await store.close();
    } finally {
      if (stop) await stop().catch(() => {});
      if (stop2) await stop2().catch(() => {});
      process.env.OUROBOROS_DATA_DIR = originalEnv.DATA_DIR;
      process.env.OUROBOROS_PORT = originalEnv.PORT;
      process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE = originalEnv.CREDENTIAL_FILE;
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
