import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
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

describe("mission admission E2E", () => {
  it("admits, replays and survives restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ouroboros-admission-e2e-"));
    const port = await unusedPort();
    process.env.OUROBOROS_DATA_DIR = dataDir;
    process.env.OUROBOROS_PORT = String(port);
    const credentialFile = join(dataDir, "operator.json");
    const payloadFile = join(dataDir, "payload.json");

    const authStore = new LocalControlCredentialStore(join(dataDir, "local-control-auth.db"));
    const credential = authStore.provision("operator", ["mission.read", "mission.create"], Date.now() + 60 * 60_000);
    authStore.close();
    writeLocalControlClientCredential(credentialFile, { schemaVersion: 1, clientId: credential.clientId, token: credential.token });
    process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE = credentialFile;

    await writeFile(payloadFile, JSON.stringify({
      originalIntent: "Admit mission",
      constraints: ["c1"],
      acceptanceCriteria: ["a1"],
    }));

    let stop = await startHeadlessDaemon({ dataDir, port });

    const out1: string[] = [];
    const code1 = await runAdminCli(["mission", "admit", "req-e2e", "--file", payloadFile], {
      stdout: (text) => out1.push(text),
      stderr: () => {},
    });
    expect(code1).toBe(0);
    const admitted = JSON.parse(out1.join(""));
    expect(admitted.state).toBe("created");

    const out2: string[] = [];
    const code2 = await runAdminCli(["mission", "admit", "req-e2e", "--file", payloadFile], {
      stdout: (text) => out2.push(text),
      stderr: () => {},
    });
    expect(code2).toBe(0);
    const replayed = JSON.parse(out2.join(""));
    expect(replayed.missionId).toBe(admitted.missionId);

    await stop();

    // restart
    const port2 = await unusedPort();
    process.env.OUROBOROS_PORT = String(port2);
    let stop2 = await startHeadlessDaemon({ dataDir, port: port2 });
    const out3: string[] = [];
    const code3 = await runAdminCli(["mission", "admit", "req-e2e", "--file", payloadFile], {
      stdout: (text) => out3.push(text),
      stderr: () => {},
    });
    expect(code3).toBe(0);
    const afterRestart = JSON.parse(out3.join(""));
    expect(afterRestart.missionId).toBe(admitted.missionId);

    await stop2();

    // verify persisted state
    const store = new SqliteMissionStore(join(dataDir, "missions.db"));
    await store.initialize();
    const mission = await store.getMission(admitted.missionId);
    expect(mission?.state).toBe(MissionState.CREATED);
    const revisions = await store.getPlanRevisions(admitted.missionId);
    expect(revisions.length).toBe(0);
    const invocations = await store.listInvocations(admitted.missionId);
    expect(invocations.length).toBe(0);
    await store.close();

    delete process.env.OUROBOROS_DATA_DIR;
    delete process.env.OUROBOROS_PORT;
    delete process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE;
  });
});
