import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { LOCAL_CONTROL_AUTH_SCOPES } from "../../../shared/local-control-auth-contract.js";
import {
  LocalControlAuthorizer,
  LocalControlCredentialStore,
  requiredLocalControlScope,
} from "./local-control-auth.js";

const directories: string[] = [];
const legacySchema = `
  CREATE TABLE local_control_clients (
    client_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  )
`;

interface LegacyClientRow {
  client_id: string;
  token_hash: string;
  scopes_json: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}

interface AuthorityRow {
  client_id: string;
  credential_generation: number;
  authority_epoch: number;
  revoked_at: number | null;
}

async function newDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ouroboros-auth-authority-"));
  directories.push(directory);
  return directory;
}

function databaseFor(store: LocalControlCredentialStore): Database {
  return (store as unknown as { db: Database }).db;
}

function authorityRow(database: Database, clientId: string): AuthorityRow | null {
  return database.query(`
    SELECT client_id, credential_generation, authority_epoch, revoked_at
    FROM local_control_clients WHERE client_id = ?
  `).get(clientId) as AuthorityRow | null;
}

function highWaterMark(database: Database, clientId: string): number | null {
  const row = database.query(`
    SELECT max_epoch FROM local_control_authority_epochs WHERE client_id = ?
  `).get(clientId) as { max_epoch: number } | null;
  return row?.max_epoch ?? null;
}

function authStoreSnapshot(database: Database): {
  clients: unknown[];
  epochs: unknown[];
  schema: unknown[];
} {
  return {
    clients: database.query("SELECT * FROM local_control_clients ORDER BY client_id").all(),
    epochs: database.query("SELECT * FROM local_control_authority_epochs ORDER BY client_id").all(),
    schema: database.query(`
      SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all(),
  };
}

function tokenHash(token: string): string {
  const secret = token.split(".")[2];
  if (!secret) throw new Error("Fixture token has no secret");
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function makeToken(clientId: string, secret: string): string {
  return `oc1.${Buffer.from(clientId).toString("base64url")}.${secret}`;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("LocalControlCredentialStore authority facts (real SQLite)", () => {
  it("migrates active and revoked legacy rows additively and repeats idempotently", async () => {
    const directory = await newDirectory();
    const privateDirectory = join(directory, "private");
    mkdirSync(privateDirectory, { mode: 0o700 });
    const databasePath = join(privateDirectory, "auth.db");
    const database = new Database(databasePath);
    database.exec(legacySchema);

    const now = Date.now();
    const activeToken = makeToken("legacy-active", "A".repeat(43));
    const revokedToken = makeToken("legacy-revoked", "B".repeat(43));
    const legacyRows: LegacyClientRow[] = [
      {
        client_id: "legacy-active",
        token_hash: tokenHash(activeToken),
        scopes_json: '["mission.read","mission.create"]',
        expires_at: now + 60_000,
        revoked_at: null,
        created_at: now - 10_000,
      },
      {
        client_id: "legacy-revoked",
        token_hash: tokenHash(revokedToken),
        scopes_json: '["mission.control"]',
        expires_at: now + 60_000,
        revoked_at: now - 2_000,
        created_at: now - 20_000,
      },
    ];
    const insert = database.query(`
      INSERT INTO local_control_clients
        (client_id, token_hash, scopes_json, expires_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of legacyRows) {
      insert.run(row.client_id, row.token_hash, row.scopes_json, row.expires_at, row.revoked_at, row.created_at);
    }
    database.close();

    let store = new LocalControlCredentialStore(databasePath);
    expect(store.authorizeToken(activeToken, "mission.create")?.clientId).toBe("legacy-active");
    expect(store.authorizeToken(revokedToken)).toBeNull();
    const storeDb = databaseFor(store);
    expect(authorityRow(storeDb, "legacy-active")).toMatchObject({ credential_generation: 1, authority_epoch: 1, revoked_at: null });
    expect(authorityRow(storeDb, "legacy-revoked")).toMatchObject({ credential_generation: 1, authority_epoch: 1, revoked_at: legacyRows[1]!.revoked_at });
    expect(highWaterMark(storeDb, "legacy-active")).toBe(1);
    expect(highWaterMark(storeDb, "legacy-revoked")).toBe(1);
    const preservedRows = storeDb.query(`
      SELECT client_id, token_hash, scopes_json, expires_at, revoked_at, created_at
      FROM local_control_clients ORDER BY client_id
    `).all() as LegacyClientRow[];
    expect(preservedRows).toEqual([...legacyRows].sort((left, right) => left.client_id.localeCompare(right.client_id)));
    expect((storeDb.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode.toLowerCase()).toBe("wal");
    expect((storeDb.query("PRAGMA recursive_triggers").get() as { recursive_triggers: number }).recursive_triggers).toBe(1);
    store.close();

    store = new LocalControlCredentialStore(databasePath);
    const reopenedDb = databaseFor(store);
    const columns = reopenedDb.query("PRAGMA table_info(local_control_clients)").all() as Array<{ name: string }>;
    expect(columns.filter(({ name }) => name === "credential_generation")).toHaveLength(1);
    expect(columns.filter(({ name }) => name === "authority_epoch")).toHaveLength(1);
    expect(reopenedDb.query("SELECT client_id FROM local_control_authority_epochs ORDER BY client_id").all()).toEqual([
      { client_id: "legacy-active" },
      { client_id: "legacy-revoked" },
    ]);
    expect(store.authorizeToken(activeToken, "mission.create")?.clientId).toBe("legacy-active");
    expect(store.authorizeToken(revokedToken)).toBeNull();
    expect((await Bun.file(databasePath).stat()).mode & 0o777).toBe(0o600);
    expect((await Bun.file(privateDirectory).stat()).mode & 0o777).toBe(0o700);
    store.close();
  });

  it("recovers a legacy database with only part of the additive migration already applied", async () => {
    const directory = await newDirectory();
    const databasePath = join(directory, "private", "auth.db");
    mkdirSync(join(directory, "private"), { mode: 0o700 });
    const legacy = new Database(databasePath);
    legacy.exec(legacySchema);
    legacy.exec("ALTER TABLE local_control_clients ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 1");
    const token = makeToken("partial-migration", "C".repeat(43));
    legacy.query(`
      INSERT INTO local_control_clients
        (client_id, token_hash, scopes_json, expires_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)
    `).run("partial-migration", tokenHash(token), '["mission.read"]', Date.now() + 60_000, Date.now());
    legacy.close();

    const recovered = new LocalControlCredentialStore(databasePath);
    expect(recovered.authorizeToken(token, "mission.read")?.clientId).toBe("partial-migration");
    expect(authorityRow(databaseFor(recovered), "partial-migration")).toMatchObject({
      credential_generation: 1,
      authority_epoch: 1,
    });
    expect(highWaterMark(databaseFor(recovered), "partial-migration")).toBe(1);
    recovered.close();
  });

  it("rejects an existing high-water mark below its client epoch without rewriting database state", async () => {
    const directory = await newDirectory();
    const databasePath = join(directory, "private", "auth.db");
    const store = new LocalControlCredentialStore(databasePath);
    store.provision("inconsistent-history", ["mission.read"], Date.now() + 60_000);
    store.provision("inconsistent-history", ["mission.control"], Date.now() + 60_000);
    store.close();

    const tampered = new Database(databasePath);
    tampered.exec("DROP TRIGGER prevent_authority_epochs_update_decrement");
    tampered.query("UPDATE local_control_authority_epochs SET max_epoch = 1 WHERE client_id = ?").run("inconsistent-history");
    const beforeRejectedOpen = authStoreSnapshot(tampered);
    tampered.close();

    let opened: LocalControlCredentialStore | undefined;
    let openError: unknown;
    try {
      opened = new LocalControlCredentialStore(databasePath);
    } catch (error) {
      openError = error;
    }
    opened?.close();

    const afterRejectedOpen = new Database(databasePath);
    const stateAfterRejectedOpen = authStoreSnapshot(afterRejectedOpen);
    afterRejectedOpen.close();

    expect({
      rejection: openError instanceof Error ? openError.message : null,
      stateAfterRejectedOpen,
    }).toEqual({
      rejection: "Local-control authority history is inconsistent",
      stateAfterRejectedOpen: beforeRejectedOpen,
    });
  });

  it("does not recreate a missing high-water record in an already-migrated database", async () => {
    const directory = await newDirectory();
    const databasePath = join(directory, "private", "auth.db");
    const store = new LocalControlCredentialStore(databasePath);
    store.provision("missing-history", ["mission.read"], Date.now() + 60_000);
    store.close();

    const tampered = new Database(databasePath);
    tampered.exec("DROP TRIGGER prevent_authority_epochs_delete");
    tampered.query("DELETE FROM local_control_authority_epochs WHERE client_id = ?").run("missing-history");
    const beforeRejectedOpen = authStoreSnapshot(tampered);
    tampered.close();

    let opened: LocalControlCredentialStore | undefined;
    let openError: unknown;
    try {
      opened = new LocalControlCredentialStore(databasePath);
    } catch (error) {
      openError = error;
    }
    opened?.close();

    const afterRejectedOpen = new Database(databasePath);
    const stateAfterRejectedOpen = authStoreSnapshot(afterRejectedOpen);
    afterRejectedOpen.close();

    expect({
      rejection: openError instanceof Error ? openError.message : null,
      stateAfterRejectedOpen,
    }).toEqual({
      rejection: "Local-control authority history is missing a high-water mark",
      stateAfterRejectedOpen: beforeRejectedOpen,
    });
  });

  it("fails closed and rolls the migration back when legacy scope JSON is corrupt", async () => {
    const directory = await newDirectory();
    mkdirSync(join(directory, "private"), { mode: 0o700 });
    const databasePath = join(directory, "private", "auth.db");
    const legacy = new Database(databasePath);
    legacy.exec(legacySchema);
    legacy.query(`
      INSERT INTO local_control_clients
        (client_id, token_hash, scopes_json, expires_at, revoked_at, created_at)
      VALUES ('corrupt-scopes', ?, 'not-json', ?, NULL, ?)
    `).run("d".repeat(64), Date.now() + 60_000, Date.now());
    legacy.close();

    expect(() => new LocalControlCredentialStore(databasePath)).toThrow("credential scopes are corrupt");
    const afterFailure = new Database(databasePath);
    const columns = afterFailure.query("PRAGMA table_info(local_control_clients)").all() as Array<{ name: string }>;
    expect(columns.some(({ name }) => name === "authority_epoch")).toBe(false);
    expect(columns.some(({ name }) => name === "credential_generation")).toBe(false);
    expect(afterFailure.query("SELECT name FROM sqlite_master WHERE name = 'local_control_authority_epochs'").get()).toBeNull();
    expect(afterFailure.query("SELECT scopes_json FROM local_control_clients WHERE client_id = 'corrupt-scopes'").get()).toEqual({ scopes_json: "not-json" });
    afterFailure.close();
  });

  it("increments credential generation on rotation, advances epochs only for scope-set changes or reprovisioning, and survives restart", async () => {
    const directory = await newDirectory();
    const databasePath = join(directory, "private", "auth.db");
    let store = new LocalControlCredentialStore(databasePath);
    const first = store.provision("operator", ["mission.read", "daemon.admin"], Date.now() + 60_000);
    expect(authorityRow(databaseFor(store), "operator")).toMatchObject({ credential_generation: 1, authority_epoch: 1 });

    const rotated = store.provision("operator", ["daemon.admin", "mission.read"], Date.now() + 60_000);
    expect(authorityRow(databaseFor(store), "operator")).toMatchObject({ credential_generation: 2, authority_epoch: 1 });
    expect(store.authorizeToken(first.token)).toBeNull();
    expect(store.authorizeToken(rotated.token)?.credentialVersion).toEqual(expect.any(String));
    expect(Object.keys(rotated).sort()).toEqual(["clientId", "expiresAt", "scopes", "token"]);

    store.provision("operator", ["mission.read", "daemon.admin", "mission.control"], Date.now() + 60_000);
    expect(authorityRow(databaseFor(store), "operator")).toMatchObject({ credential_generation: 3, authority_epoch: 2 });
    expect(highWaterMark(databaseFor(store), "operator")).toBe(2);

    store.provision("operator", ["mission.read", "daemon.admin"], Date.now() + 60_000);
    expect(authorityRow(databaseFor(store), "operator")).toMatchObject({ credential_generation: 4, authority_epoch: 3 });
    expect(highWaterMark(databaseFor(store), "operator")).toBe(3);

    expect(store.revoke("operator")).toBe(true);
    expect(authorityRow(databaseFor(store), "operator")).toMatchObject({ credential_generation: 4, authority_epoch: 3 });
    expect(store.revoke("operator")).toBe(false);
    const reactivated = store.provision("operator", ["mission.read", "daemon.admin"], Date.now() + 60_000);
    expect(authorityRow(databaseFor(store), "operator")).toMatchObject({ credential_generation: 5, authority_epoch: 4, revoked_at: null });
    expect(highWaterMark(databaseFor(store), "operator")).toBe(4);

    store.close();
    store = new LocalControlCredentialStore(databasePath);
    expect(authorityRow(databaseFor(store), "operator")).toMatchObject({ credential_generation: 5, authority_epoch: 4, revoked_at: null });
    expect(highWaterMark(databaseFor(store), "operator")).toBe(4);
    expect(store.authorizeToken(reactivated.token)?.clientId).toBe("operator");
    store.close();
  });

  it("rejects identity, scope, epoch, deletion, high-water, malformed JSON, and recursive REPLACE mutations", async () => {
    const directory = await newDirectory();
    const databasePath = join(directory, "private", "auth.db");
    const store = new LocalControlCredentialStore(databasePath);
    store.provision("guarded", ["mission.read"], Date.now() + 60_000);
    const database = databaseFor(store);

    expect(() => database.query("UPDATE local_control_clients SET client_id = 'other' WHERE client_id = 'guarded'").run()).toThrow();
    expect(() => database.query("UPDATE local_control_clients SET scopes_json = '[\"mission.control\"]' WHERE client_id = 'guarded'").run()).toThrow();
    expect(() => database.query("UPDATE local_control_clients SET scopes_json = 'not-json' WHERE client_id = 'guarded'").run()).toThrow();
    store.provision("guarded", ["mission.read", "mission.control"], Date.now() + 60_000);
    expect(authorityRow(database, "guarded")).toMatchObject({ credential_generation: 2, authority_epoch: 2 });
    expect(() => database.query("UPDATE local_control_clients SET credential_generation = 1 WHERE client_id = 'guarded'").run()).toThrow();
    expect(() => database.query("UPDATE local_control_clients SET token_hash = ? WHERE client_id = 'guarded'").run("a".repeat(64))).toThrow();
    expect(() => database.query("UPDATE local_control_clients SET authority_epoch = 1 WHERE client_id = 'guarded'").run()).toThrow();
    expect(() => database.query("DELETE FROM local_control_clients WHERE client_id = 'guarded'").run()).toThrow();
    expect(() => database.query("DELETE FROM local_control_authority_epochs WHERE client_id = 'guarded'").run()).toThrow();
    expect(() => database.query("UPDATE local_control_authority_epochs SET max_epoch = max_epoch - 1 WHERE client_id = 'guarded'").run()).toThrow();

    const stored = database.query(`
      SELECT client_id, token_hash, scopes_json, expires_at, revoked_at, created_at,
             credential_generation, authority_epoch
      FROM local_control_clients WHERE client_id = 'guarded'
    `).get();
    expect(() => database.query(`
      INSERT OR REPLACE INTO local_control_clients
        (client_id, token_hash, scopes_json, expires_at, revoked_at, created_at, credential_generation, authority_epoch)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    `).run("guarded", "f".repeat(64), '["mission.read","mission.control"]', Date.now() + 60_000, Date.now(), 3, 2)).toThrow("physical deletion");
    expect(() => database.query(`
      REPLACE INTO local_control_clients
        (client_id, token_hash, scopes_json, expires_at, revoked_at, created_at, credential_generation, authority_epoch)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    `).run("guarded", "f".repeat(64), '["mission.read","mission.control"]', Date.now() + 60_000, Date.now(), 3, 2)).toThrow("physical deletion");
    expect(database.query("SELECT client_id FROM local_control_clients WHERE client_id = 'guarded'").get()).toEqual({ client_id: "guarded" });
    expect(stored).toBeTruthy();
    store.close();
  });

  it("blocks same-epoch REPLACE on an unmanaged connection with recursive triggers off", async () => {
    const directory = await newDirectory();
    const databasePath = join(directory, "private", "auth.db");
    const store = new LocalControlCredentialStore(databasePath);
    const credential = store.provision("replace-target", ["mission.read"], Date.now() + 60_000);
    expect(store.revoke("replace-target")).toBe(true);
    store.close();

    const hostile = new Database(databasePath);
    hostile.exec("PRAGMA recursive_triggers = OFF");
    expect((hostile.query("PRAGMA recursive_triggers").get() as { recursive_triggers: number }).recursive_triggers).toBe(0);
    hostile.exec(`
      CREATE TABLE replace_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TRIGGER replace_probe_delete_guard BEFORE DELETE ON replace_probe
      BEGIN SELECT RAISE(ABORT, 'delete guard reached'); END;
      INSERT INTO replace_probe VALUES ('probe', 'before');
    `);
    hostile.query("INSERT OR REPLACE INTO replace_probe (id, value) VALUES ('probe', 'after')").run();
    expect(hostile.query("SELECT value FROM replace_probe WHERE id = 'probe'").get()).toEqual({ value: "after" });

    expect(() => hostile.query(`
      INSERT OR REPLACE INTO local_control_clients
        (client_id, token_hash, scopes_json, expires_at, revoked_at, created_at, credential_generation, authority_epoch)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    `).run("replace-target", "e".repeat(64), '["mission.read"]', Date.now() + 60_000, Date.now(), 2, 1)).toThrow("historical max_epoch");
    expect(() => hostile.query(`
      REPLACE INTO local_control_clients
        (client_id, token_hash, scopes_json, expires_at, revoked_at, created_at, credential_generation, authority_epoch)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    `).run("replace-target", "e".repeat(64), '["mission.read"]', Date.now() + 60_000, Date.now(), 2, 1)).toThrow("historical max_epoch");
    expect(hostile.query("SELECT revoked_at FROM local_control_clients WHERE client_id = 'replace-target'").get()).toMatchObject({ revoked_at: expect.any(Number) });
    hostile.close();

    const reopened = new LocalControlCredentialStore(databasePath);
    expect(reopened.authorizeToken(credential.token)).toBeNull();
    reopened.close();
  });

  it("uses the permanent high-water mark after a client row is removed outside the managed trust boundary", async () => {
    const directory = await newDirectory();
    const databasePath = join(directory, "private", "auth.db");
    let store = new LocalControlCredentialStore(databasePath);
    const first = store.provision("tombstoned-client", ["mission.read"], Date.now() + 60_000);
    const database = databaseFor(store);
    database.exec("DROP TRIGGER prevent_client_delete");
    database.query("DELETE FROM local_control_clients WHERE client_id = ?").run("tombstoned-client");
    expect(highWaterMark(database, "tombstoned-client")).toBe(1);
    store.close();

    store = new LocalControlCredentialStore(databasePath);
    const reissued = store.provision("tombstoned-client", ["mission.read"], Date.now() + 60_000);
    expect(authorityRow(databaseFor(store), "tombstoned-client")).toMatchObject({
      credential_generation: 1,
      authority_epoch: 2,
    });
    expect(highWaterMark(databaseFor(store), "tombstoned-client")).toBe(2);
    expect(store.authorizeToken(first.token)).toBeNull();
    expect(store.authorizeToken(reissued.token)?.clientId).toBe("tombstoned-client");
    store.close();
  });

  it("rolls back generation, epoch, token hash, and high-water changes when a SQL trigger aborts the write", async () => {
    const directory = await newDirectory();
    const store = new LocalControlCredentialStore(join(directory, "private", "auth.db"));
    const first = store.provision("rollback-client", ["mission.read"], Date.now() + 60_000);
    const database = databaseFor(store);
    const before = database.query(`
      SELECT token_hash, scopes_json, expires_at, revoked_at, created_at,
             credential_generation, authority_epoch
      FROM local_control_clients WHERE client_id = 'rollback-client'
    `).get();
    database.exec(`
      CREATE TRIGGER abort_test_credential_update
      AFTER UPDATE OF credential_generation ON local_control_clients
      WHEN NEW.client_id = 'rollback-client'
      BEGIN SELECT RAISE(ABORT, 'forced AuthStore rollback'); END;
    `);

    expect(() => store.provision("rollback-client", ["mission.control"], Date.now() + 60_000)).toThrow("forced AuthStore rollback");
    expect(database.query(`
      SELECT token_hash, scopes_json, expires_at, revoked_at, created_at,
             credential_generation, authority_epoch
      FROM local_control_clients WHERE client_id = 'rollback-client'
    `).get()).toEqual(before);
    expect(highWaterMark(database, "rollback-client")).toBe(1);
    expect(store.authorizeToken(first.token, "mission.read")?.clientId).toBe("rollback-client");
    expect(store.authorizeToken(first.token, "mission.control")).toBeNull();
    store.close();
  });

  it("fails closed on ordinal overflow instead of wrapping or publishing a partial epoch", async () => {
    const directory = await newDirectory();
    const credentialOverflowPath = join(directory, "credential-overflow", "auth.db");
    let store = new LocalControlCredentialStore(credentialOverflowPath);
    const credential = store.provision("credential-overflow", ["mission.read"], Date.now() + 60_000);
    let database = databaseFor(store);
    database.exec("DROP TRIGGER prevent_client_unauthorized_update");
    database.query("UPDATE local_control_clients SET credential_generation = ? WHERE client_id = ?").run(Number.MAX_SAFE_INTEGER, "credential-overflow");
    store.close();

    store = new LocalControlCredentialStore(credentialOverflowPath);
    expect(() => store.provision("credential-overflow", ["mission.read"], Date.now() + 60_000)).toThrow("CREDENTIAL_GENERATION_OVERFLOW");
    expect(authorityRow(databaseFor(store), "credential-overflow")).toMatchObject({
      credential_generation: Number.MAX_SAFE_INTEGER,
      authority_epoch: 1,
    });
    expect(highWaterMark(databaseFor(store), "credential-overflow")).toBe(1);
    expect(store.authorizeToken(credential.token)?.clientId).toBe("credential-overflow");
    store.close();

    const epochOverflowPath = join(directory, "epoch-overflow", "auth.db");
    store = new LocalControlCredentialStore(epochOverflowPath);
    const epochCredential = store.provision("epoch-overflow", ["mission.read"], Date.now() + 60_000);
    database = databaseFor(store);
    database.exec(`
      DROP TRIGGER prevent_client_unauthorized_update;
      DROP TRIGGER sync_authority_epoch_to_max_on_update;
      DROP TRIGGER prevent_authority_epochs_update_decrement;
    `);
    database.query("UPDATE local_control_clients SET authority_epoch = ? WHERE client_id = ?").run(Number.MAX_SAFE_INTEGER, "epoch-overflow");
    database.query("UPDATE local_control_authority_epochs SET max_epoch = ? WHERE client_id = ?").run(Number.MAX_SAFE_INTEGER, "epoch-overflow");
    store.close();

    store = new LocalControlCredentialStore(epochOverflowPath);
    const pureRotation = store.provision("epoch-overflow", ["mission.read"], Date.now() + 60_000);
    expect(authorityRow(databaseFor(store), "epoch-overflow")).toMatchObject({
      credential_generation: 2,
      authority_epoch: Number.MAX_SAFE_INTEGER,
    });
    expect(() => store.provision("epoch-overflow", ["mission.control"], Date.now() + 60_000)).toThrow("AUTHORITY_EPOCH_OVERFLOW");
    expect(authorityRow(databaseFor(store), "epoch-overflow")).toMatchObject({
      credential_generation: 2,
      authority_epoch: Number.MAX_SAFE_INTEGER,
    });
    expect(highWaterMark(databaseFor(store), "epoch-overflow")).toBe(Number.MAX_SAFE_INTEGER);
    expect(store.authorizeToken(epochCredential.token)).toBeNull();
    expect(store.authorizeToken(pureRotation.token, "mission.read")?.clientId).toBe("epoch-overflow");
    store.close();
  });

  it("refuses to reopen an AuthStore whose persisted authority ordinals are corrupt", async () => {
    const directory = await newDirectory();
    const databasePath = join(directory, "private", "auth.db");
    const store = new LocalControlCredentialStore(databasePath);
    store.provision("corrupt-ordinal", ["mission.read"], Date.now() + 60_000);
    const database = databaseFor(store);
    database.exec("DROP TRIGGER prevent_client_unauthorized_update");
    database.query("UPDATE local_control_clients SET credential_generation = 0 WHERE client_id = ?").run("corrupt-ordinal");
    store.close();

    expect(() => new LocalControlCredentialStore(databasePath)).toThrow("authority ordinals are invalid");
  });

  it("serializes concurrent process rotations without losing credential generations", async () => {
    const directory = await newDirectory();
    const databasePath = join(directory, "private", "auth.db");
    const initialStore = new LocalControlCredentialStore(databasePath);
    initialStore.provision("concurrent-client", ["mission.read"], Date.now() + 120_000);
    initialStore.close();

    const writerPath = fileURLToPath(new URL("./local-control-auth.concurrent-writer.ts", import.meta.url));
    const writers = 6;
    const expiration = String(Date.now() + 120_000);
    const children = Array.from({ length: writers }, () => Bun.spawn([
      process.execPath,
      "run",
      writerPath,
      databasePath,
      "concurrent-client",
      expiration,
    ], { stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(async (child) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    }));
    expect(results.filter(({ exitCode }) => exitCode !== 0)).toEqual([]);
    expect(results.map(({ stdout }) => stdout.trim()).every((value) => value === "rotated")).toBe(true);

    const reopened = new LocalControlCredentialStore(databasePath);
    expect(authorityRow(databaseFor(reopened), "concurrent-client")).toMatchObject({
      credential_generation: writers + 1,
      authority_epoch: 1,
    });
    expect(highWaterMark(databaseFor(reopened), "concurrent-client")).toBe(1);
    reopened.close();
  });

  it("keeps the authentication scope and grant RPC surface unchanged", () => {
    expect(LOCAL_CONTROL_AUTH_SCOPES).toEqual(["mission.read", "mission.control", "mission.create", "daemon.admin"]);
    expect(requiredLocalControlScope("mission.grant_capabilities", {})).toBeNull();
    expect(requiredLocalControlScope("mission.revoke_capability_grant", {})).toBeNull();
    expect(requiredLocalControlScope("mission.list_capability_grants", {})).toBeNull();
  });

  it("does not add authority facts to the authenticated client or provisioned credential contract", async () => {
    const directory = await newDirectory();
    const store = new LocalControlCredentialStore(join(directory, "private", "auth.db"));
    const expiresAt = Date.now() + 60_000;
    const credential = store.provision("contract-client", ["mission.read"], expiresAt);
    const authenticated = store.authorizeToken(credential.token)!;
    expect(typeof authenticated.credentialVersion).toBe("string");
    expect(Object.keys(authenticated).sort()).toEqual(["clientId", "credentialVersion", "scopes"]);
    const authorizer = new LocalControlAuthorizer(store, ["http://localhost:5173"]);
    expect(authorizer.authenticateBearer(`Bearer ${credential.token}`)?.credentialVersion).toBe(authenticated.credentialVersion);
    const browserSession = authorizer.createBrowserSession(`Bearer ${credential.token}`, "http://localhost:5173");
    expect(browserSession).not.toBeNull();
    const cookie = `ouroboros_control_session=${browserSession!.cookie}`;
    expect(authorizer.authorizeBrowserSession(cookie, "http://localhost:5173")?.clientId).toBe("contract-client");
    const rotated = store.provision("contract-client", ["mission.read"], expiresAt);
    expect(store.authorizeToken(credential.token)).toBeNull();
    expect(store.authorizeToken(rotated.token)?.credentialVersion).not.toBe(authenticated.credentialVersion);
    expect(authorizer.authorizeBrowserSession(cookie, "http://localhost:5173")).toBeNull();
    store.close();
  });
});
