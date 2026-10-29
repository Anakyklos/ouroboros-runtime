import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAdminCli } from "./admin-cli.js";
import { startHeadlessDaemon } from "../daemon/main.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import { LocalControlCredentialStore, writeLocalControlClientCredential } from "../daemon/local-control-auth.js";

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

describe("mission admission expired credential E2E", () => {
  it("rejects an expired credential", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ouroboros-admission-expired-"));
    const originalEnv = {
      DATA_DIR: process.env.OUROBOROS_DATA_DIR,
      PORT: process.env.OUROBOROS_PORT,
      CREDENTIAL_FILE: process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE,
    };
    let stop: (() => Promise<void>) | undefined;
    try {
      const port = await unusedPort();
      process.env.OUROBOROS_DATA_DIR = dataDir;
      process.env.OUROBOROS_PORT = String(port);

      const authStore = new LocalControlCredentialStore(join(dataDir, "local-control-auth.db"));
      authStore.provision("active", ["mission.read"], Date.now() + 60 * 60_000);
      const expired = authStore.provision("expired", ["mission.create"], Date.now() + 1);
      authStore.close();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const expiredFile = join(dataDir, "expired.json");
      writeLocalControlClientCredential(expiredFile, { schemaVersion: 1, clientId: expired.clientId, token: expired.token });
      process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE = expiredFile;

      const payloadFile = join(dataDir, "payload.json");
      await (await import("node:fs/promises")).writeFile(payloadFile, JSON.stringify({
        originalIntent: "Admit mission",
        constraints: [],
        acceptanceCriteria: [],
      }));

      stop = await startHeadlessDaemon({ dataDir, port });
      const code = await runAdminCli(["mission", "admit", "req-expired", "--file", payloadFile], {
        stdout: () => {},
        stderr: () => {},
      });
      expect(code).not.toBe(0);
      await stop();
      stop = undefined;
    } finally {
      if (stop) await stop().catch(() => {});
      process.env.OUROBOROS_DATA_DIR = originalEnv.DATA_DIR;
      process.env.OUROBOROS_PORT = originalEnv.PORT;
      process.env.OUROBOROS_CLIENT_CREDENTIAL_FILE = originalEnv.CREDENTIAL_FILE;
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
