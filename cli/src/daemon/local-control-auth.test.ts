import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalControlAuthorizer,
  LocalControlCredentialStore,
  readLocalControlClientCredential,
  requiredLocalControlScope,
  writeLocalControlClientCredential,
} from "./local-control-auth.js";
import type { LocalControlAuthScope } from "../../../shared/local-control-auth-contract.js";

const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ouroboros-auth-unit-"));
  directories.push(directory);
  const store = new LocalControlCredentialStore(join(directory, "private", "auth.db"));
  const credential = store.provision("test-client", ["mission.read"], Date.now() + 60_000);
  const auth = new LocalControlAuthorizer(store, ["http://localhost:5173"]);
  return { directory, store, auth, credential };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("LocalControlCredentialStore", () => {
  it("assigns independent server-side scopes and never stores the raw token", async () => {
    const { directory, store, credential } = await fixture();
    expect(credential.token).toMatch(/^oc1\./);
    expect(store.authorizeToken(credential.token, "mission.read")).toMatchObject({
      clientId: "test-client",
      scopes: ["mission.read"],
    });
    expect(store.authorizeToken(credential.token, "mission.control")).toBeNull();
    expect(await Bun.file(join(directory, "private", "auth.db")).text()).not.toContain(credential.token);
    store.close();
  });

  it("revokes and rotates a credential immediately without granting its prior token", async () => {
    const { store, credential } = await fixture();
    const rotated = store.provision("test-client", ["daemon.admin"], Date.now() + 60_000);
    expect(store.authorizeToken(credential.token)).toBeNull();
    expect(store.authorizeToken(rotated.token, "daemon.admin")).not.toBeNull();
    expect(store.authorizeToken(rotated.token, "mission.read")).toBeNull();
    expect(store.revoke("test-client")).toBe(true);
    expect(store.authorizeToken(rotated.token)).toBeNull();
    expect(store.hasActiveClients()).toBe(false);
    store.close();
  });

  it("rejects expired credentials and malformed or repeated grants", async () => {
    const { store } = await fixture();
    expect(() => store.provision("expired", ["mission.read"], Date.now() - 1)).toThrow();
    expect(() => store.provision("bad-scope", ["mission.read", "daemon.root"] as LocalControlAuthScope[], Date.now() + 60_000)).toThrow();
    expect(() => store.provision("repeated", ["mission.read", "mission.read"], Date.now() + 60_000)).toThrow();
    store.close();
  });
});

describe("LocalControlAuthorizer", () => {
  it("requires bearer authentication and exact independent grants", async () => {
    const { auth, credential, store } = await fixture();
    expect(auth.authorizeBearer(undefined, "mission.read")).toBeNull();
    expect(auth.authorizeBearer(`Bearer ${credential.token}`, "mission.read")?.clientId).toBe("test-client");
    expect(auth.authorizeBearer(`Bearer ${credential.token}`, "daemon.admin")).toBeNull();
    expect(auth.authorizeBearer(`Bearer ${credential.token} extra`, "mission.read")).toBeNull();
    store.close();
  });

  it("binds browser stream sessions to allowlisted Origin and invalidates them on revoke or rotate", async () => {
    const { auth, store } = await fixture();
    const upgraded = store.provision("test-client", ["mission.read", "mission.control", "daemon.admin"], Date.now() + 60_000);
    const browserSession = auth.createBrowserSession(`Bearer ${upgraded.token}`, "http://localhost:5173");
    expect(browserSession).not.toBeNull();
    const cookie = `ouroboros_control_session=${browserSession!.cookie}`;
    expect(auth.authorizeBrowserSession(cookie, "http://localhost:5173")).toMatchObject({
      clientId: "test-client",
      scopes: ["mission.read"],
    });
    expect(auth.authorizeBearer(`Bearer ${upgraded.token}`, "daemon.admin")?.scopes).toContain("daemon.admin");
    expect(auth.authorizeBrowserSession(cookie, "http://attacker.invalid")).toBeNull();
    expect(auth.createBrowserSession(`Bearer ${upgraded.token}`, "http://attacker.invalid")).toBeNull();
    store.revoke("test-client");
    expect(auth.authorizeBrowserSession(cookie, "http://localhost:5173")).toBeNull();
    store.close();
  });

  it("classifies every approved RPC operation and denies unknown or malformed variants", () => {
    const expected: Array<[string, Record<string, unknown>, LocalControlAuthScope]> = [
      ["local_control.read", { operation: "protocol.negotiate" }, "mission.read"],
      ["local_control.read", { operation: "mission.show" }, "mission.read"],
      ["session.get", { id: "session" }, "mission.read"],
      ["daemon.status", {}, "mission.read"],
      ["system.version", {}, "mission.read"],
      ["local_control.command", { operation: "mission.cancel" }, "mission.control"],
      ["daemon.setMode", { mode: "pause" }, "daemon.admin"],
      ["daemon.emergencyBrake", {}, "daemon.admin"],
      ["system.shutdown", {}, "daemon.admin"],
    ];
    for (const [method, params, scope] of expected) expect(requiredLocalControlScope(method, params)).toBe(scope);
    expect(requiredLocalControlScope("dynamic.handler", {})).toBeNull();
    expect(requiredLocalControlScope("local_control.command", { operation: "daemon.admin" })).toBeNull();
    expect(requiredLocalControlScope("local_control.read", { operation: "unknown" })).toBeNull();
    expect(requiredLocalControlScope("system.shutdown", null)).toBeNull();
  });
});

describe("client credential file", () => {
  it("writes owner-only credentials and rejects permissive files", async () => {
    const { directory, credential, store } = await fixture();
    const filePath = join(directory, "clients", "test-client.json");
    writeLocalControlClientCredential(filePath, { schemaVersion: 1, clientId: credential.clientId, token: credential.token });
    expect(readLocalControlClientCredential(filePath).token).toBe(credential.token);
    chmodSync(filePath, 0o644);
    expect(() => readLocalControlClientCredential(filePath)).toThrow("permissions");
    store.close();
  });
});
