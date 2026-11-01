import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import {
  LOCAL_CONTROL_AUTH_SCOPES,
  LOCAL_CONTROL_BROWSER_SESSION_SECONDS,
  LOCAL_CONTROL_MAX_CLIENT_ID_LENGTH,
  type LocalControlAuthScope,
  type LocalControlAuthenticatedClient,
  type LocalControlClientCredential,
} from "../../../shared/local-control-auth-contract.js";

const TOKEN_PREFIX = "oc1";
const TOKEN_SECRET_BYTES = 32;
const TOKEN_SECRET_LENGTH = 43;
const MAX_CREDENTIAL_FILE_BYTES = 1_024;
const BROWSER_SESSION_COOKIE = "ouroboros_control_session";
const MAX_AUTHORITY_ORDINAL = Number.MAX_SAFE_INTEGER;

export function defaultLocalControlClientCredentialPath(clientId = "operator-cli"): string {
  const configDir = process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config");
  return resolve(configDir, "ouroboros", "local-control", `${clientId}.json`);
}

interface ClientRow {
  client_id: string;
  token_hash: string;
  scopes_json: string;
  expires_at: number;
  revoked_at: number | null;
}

interface BrowserSession {
  clientId: string;
  credentialVersion: string;
  origin: string;
  expiresAt: number;
}

export interface LocalControlAuthorizationPort {
  hasActiveClients(): boolean;
  authenticateBearer(authorization: string | undefined): LocalControlAuthenticatedClient | null;
  authorizeBearer(authorization: string | undefined, requiredScope: LocalControlAuthScope): LocalControlAuthenticatedClient | null;
  authenticateBrowserSession(cookieHeader: string | undefined, origin: string | undefined): LocalControlAuthenticatedClient | null;
  authorizeBrowserSession(cookieHeader: string | undefined, origin: string | undefined): LocalControlAuthenticatedClient | null;
  isClientStillAuthorized(client: LocalControlAuthenticatedClient, requiredScope: LocalControlAuthScope): boolean;
  isAllowedOrigin(origin: string): boolean;
  createBrowserSession(authorization: string | undefined, origin: string | undefined): { cookie: string; maxAge: number } | null;
  close(): void;
}

export interface ProvisionedLocalControlCredential {
  clientId: string;
  token: string;
  scopes: readonly LocalControlAuthScope[];
  expiresAt: number;
}

/** Secure local credential registry. The database stores only token hashes. */
export class LocalControlCredentialStore {
  private readonly db: Database;

  constructor(readonly databasePath: string) {
    securePrivateDirectory(dirname(databasePath));
    assertPrivateRegularFileOrMissing(databasePath);
    this.db = new Database(databasePath);
    try {
      chmodSync(databasePath, 0o600);
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA recursive_triggers = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Provision or rotate one explicitly scoped client. */
  provision(clientId: string, scopes: readonly LocalControlAuthScope[], expiresAt: number): ProvisionedLocalControlCredential {
    validateClientId(clientId);
    const normalizedScopes = validateScopes(scopes);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error("Credential expiry must be in the future");
    const secret = randomBytes(TOKEN_SECRET_BYTES).toString("base64url");
    const token = `${TOKEN_PREFIX}.${Buffer.from(clientId).toString("base64url")}.${secret}`;
    const tokenHash = hashTokenSecret(secret);
    this.db.query(`
      INSERT INTO local_control_clients (
        client_id, token_hash, scopes_json, expires_at, revoked_at, created_at,
        authority_epoch, credential_generation
      )
      VALUES (
        ?, ?, ?, ?, NULL, ?,
        COALESCE((
          SELECT CASE
            WHEN existing.revoked_at IS NOT NULL
              OR ${canonicalScopeSetSql("existing.scopes_json")} IS NOT ${canonicalScopeSetSql("?")}
            THEN existing.authority_epoch + 1
            ELSE existing.authority_epoch
          END
          FROM local_control_clients AS existing WHERE existing.client_id = ?
        ), COALESCE((
          SELECT max_epoch + 1 FROM local_control_authority_epochs WHERE client_id = ?
        ), 1)),
        COALESCE((
          SELECT credential_generation + 1 FROM local_control_clients WHERE client_id = ?
        ), 1)
      )
      ON CONFLICT(client_id) DO UPDATE SET
        token_hash = excluded.token_hash,
        scopes_json = excluded.scopes_json,
        expires_at = excluded.expires_at,
        authority_epoch = excluded.authority_epoch,
        credential_generation = excluded.credential_generation,
        revoked_at = NULL,
        created_at = excluded.created_at
    `).run(
      clientId,
      tokenHash,
      JSON.stringify(normalizedScopes),
      expiresAt,
      Date.now(),
      JSON.stringify(normalizedScopes),
      clientId,
      clientId,
      clientId,
    );
    return { clientId, token, scopes: normalizedScopes, expiresAt };
  }

  /** Revoke a client without relying on its local credential file. */
  revoke(clientId: string): boolean {
    validateClientId(clientId);
    const result = this.db.query(`
      UPDATE local_control_clients SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL
    `).run(Date.now(), clientId);
    return result.changes > 0;
  }

  /** Check whether startup has at least one unexpired, non-revoked credential. */
  hasActiveClients(now = Date.now()): boolean {
    const row = this.db.query(`
      SELECT 1 AS active FROM local_control_clients
      WHERE revoked_at IS NULL AND expires_at > ? LIMIT 1
    `).get(now) as { active?: number } | null;
    return row?.active === 1;
  }

  /** Authenticate a bearer value and return server-owned identity and grants. */
  authorizeToken(token: string | undefined, requiredScope?: LocalControlAuthScope): LocalControlAuthenticatedClient | null {
    const parsed = parseToken(token);
    if (!parsed) return null;
    const row = this.clientRow(parsed.clientId);
    if (!row || row.revoked_at !== null || row.expires_at <= Date.now()) return null;
    if (!constantTimeHexEqual(hashTokenSecret(parsed.secret), row.token_hash)) return null;
    const scopes = parseStoredScopes(row.scopes_json);
    if (!scopes || (requiredScope && !scopes.includes(requiredScope))) return null;
    return { clientId: row.client_id, credentialVersion: row.token_hash, scopes };
  }

  /** Revalidate a previously authenticated identity after revocation/rotation. */
  isClientStillAuthorized(client: LocalControlAuthenticatedClient, requiredScope: LocalControlAuthScope): boolean {
    const row = this.clientRow(client.clientId);
    if (!row || row.revoked_at !== null || row.expires_at <= Date.now()) return false;
    if (!constantTimeHexEqual(row.token_hash, client.credentialVersion)) return false;
    const scopes = parseStoredScopes(row.scopes_json);
    return scopes?.includes(requiredScope) === true;
  }

  /** Revalidate a browser session against the current server-side grant row. */
  authorizeTokenForVersion(
    clientId: string,
    credentialVersion: string,
    requiredScope: LocalControlAuthScope,
  ): LocalControlAuthenticatedClient | null {
    validateClientId(clientId);
    const row = this.clientRow(clientId);
    if (!row || row.revoked_at !== null || row.expires_at <= Date.now() || !constantTimeHexEqual(row.token_hash, credentialVersion)) return null;
    const scopes = parseStoredScopes(row.scopes_json);
    if (!scopes?.includes(requiredScope)) return null;
    return { clientId, credentialVersion: row.token_hash, scopes };
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS local_control_clients (
          client_id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL,
          scopes_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER,
          created_at INTEGER NOT NULL
        )
      `);

      const columns = this.db.query("PRAGMA table_info(local_control_clients)").all() as Array<{ name: string }>;
      const names = new Set(columns.map(({ name }) => name));
      if (!names.has("authority_epoch")) {
        this.db.exec("ALTER TABLE local_control_clients ADD COLUMN authority_epoch INTEGER NOT NULL DEFAULT 1");
      }
      if (!names.has("credential_generation")) {
        this.db.exec("ALTER TABLE local_control_clients ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 1");
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS local_control_authority_epochs (
          client_id TEXT PRIMARY KEY,
          max_epoch INTEGER NOT NULL CHECK (
            typeof(max_epoch) = 'integer' AND max_epoch >= 1 AND max_epoch <= ${MAX_AUTHORITY_ORDINAL}
          )
        )
      `);

      this.assertValidStoredAuthorityState();
      this.db.exec(`
        INSERT INTO local_control_authority_epochs (client_id, max_epoch)
        SELECT client_id, authority_epoch FROM local_control_clients AS clients
        WHERE NOT EXISTS (
          SELECT 1 FROM local_control_authority_epochs AS epochs WHERE epochs.client_id = clients.client_id
        )
      `);
      this.db.exec(`
        UPDATE local_control_authority_epochs
        SET max_epoch = (
          SELECT authority_epoch FROM local_control_clients
          WHERE local_control_clients.client_id = local_control_authority_epochs.client_id
        )
        WHERE EXISTS (
          SELECT 1 FROM local_control_clients
          WHERE local_control_clients.client_id = local_control_authority_epochs.client_id
            AND local_control_authority_epochs.max_epoch < local_control_clients.authority_epoch
        )
      `);
      const inconsistentHistory = this.db.query(`
        SELECT clients.client_id FROM local_control_clients AS clients
        JOIN local_control_authority_epochs AS epochs ON epochs.client_id = clients.client_id
        WHERE epochs.max_epoch > clients.authority_epoch LIMIT 1
      `).get() as { client_id: string } | null;
      if (inconsistentHistory) throw new Error("Local-control authority history is inconsistent");

      this.installIntegrityTriggers();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertValidStoredAuthorityState(): void {
    const invalidOrdinals = this.db.query(`
      SELECT client_id FROM local_control_clients
      WHERE typeof(authority_epoch) != 'integer' OR authority_epoch < 1 OR authority_epoch > ${MAX_AUTHORITY_ORDINAL}
         OR typeof(credential_generation) != 'integer' OR credential_generation < 1
         OR credential_generation > ${MAX_AUTHORITY_ORDINAL}
      LIMIT 1
    `).get() as { client_id: string } | null;
    if (invalidOrdinals) throw new Error("Local-control credential authority ordinals are invalid");

    const invalidScopes = this.db.query(`
      SELECT client_id FROM local_control_clients
      WHERE json_valid(scopes_json) = 0 LIMIT 1
    `).get() as { client_id: string } | null;
    if (invalidScopes) throw new Error("Local-control credential scopes are corrupt");

    const malformedScopes = this.db.query(`
      SELECT clients.client_id FROM local_control_clients AS clients
      WHERE json_type(clients.scopes_json) != 'array'
         OR NOT EXISTS (SELECT 1 FROM json_each(clients.scopes_json) LIMIT 1)
         OR EXISTS (SELECT 1 FROM json_each(clients.scopes_json) WHERE type != 'text')
      LIMIT 1
    `).get() as { client_id: string } | null;
    if (malformedScopes) throw new Error("Local-control credential scopes are corrupt");

    const invalidHighWaterMark = this.db.query(`
      SELECT client_id FROM local_control_authority_epochs
      WHERE typeof(max_epoch) != 'integer' OR max_epoch < 1 OR max_epoch > ${MAX_AUTHORITY_ORDINAL}
      LIMIT 1
    `).get() as { client_id: string } | null;
    if (invalidHighWaterMark) throw new Error("Local-control authority high-water mark is corrupt");
  }

  private installIntegrityTriggers(): void {
    const maxOrdinal = MAX_AUTHORITY_ORDINAL;
    const oldScopes = canonicalScopeSetSql("OLD.scopes_json");
    const newScopes = canonicalScopeSetSql("NEW.scopes_json");
    const insertedScopes = canonicalScopeSetSql("NEW.scopes_json");
    const existingScopes = canonicalScopeSetSql("existing.scopes_json");

    this.db.exec(`
      DROP TRIGGER IF EXISTS prevent_client_delete;
      DROP TRIGGER IF EXISTS enforce_client_authority_epoch_insert_monotonicity;
      DROP TRIGGER IF EXISTS prevent_client_unauthorized_update;
      DROP TRIGGER IF EXISTS prevent_authority_epochs_delete;
      DROP TRIGGER IF EXISTS prevent_authority_epochs_update_decrement;
      DROP TRIGGER IF EXISTS enforce_authority_epoch_high_water_insert;
      DROP TRIGGER IF EXISTS sync_authority_epoch_to_max_on_insert;
      DROP TRIGGER IF EXISTS sync_authority_epoch_to_max_on_update;

      CREATE TRIGGER prevent_client_delete
      BEFORE DELETE ON local_control_clients
      BEGIN
        SELECT RAISE(ABORT, 'physical deletion of local_control_clients is forbidden');
      END;

      CREATE TRIGGER enforce_client_authority_epoch_insert_monotonicity
      BEFORE INSERT ON local_control_clients
      BEGIN
        SELECT CASE
          WHEN json_valid(NEW.scopes_json) = 0 OR json_type(NEW.scopes_json) != 'array'
          THEN RAISE(ABORT, 'scopes_json must be a valid JSON array')
        END;
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM json_each(NEW.scopes_json) WHERE type != 'text')
            OR NOT EXISTS (SELECT 1 FROM json_each(NEW.scopes_json) LIMIT 1)
          THEN RAISE(ABORT, 'scopes_json must contain at least one text scope')
        END;
        SELECT CASE
          WHEN typeof(NEW.credential_generation) != 'integer' OR NEW.credential_generation < 1
          THEN RAISE(ABORT, 'CREDENTIAL_GENERATION_INVALID')
          WHEN NEW.credential_generation > ${maxOrdinal}
          THEN RAISE(ABORT, 'CREDENTIAL_GENERATION_OVERFLOW')
          WHEN typeof(NEW.authority_epoch) != 'integer' OR NEW.authority_epoch < 1
          THEN RAISE(ABORT, 'AUTHORITY_EPOCH_INVALID')
          WHEN NEW.authority_epoch > ${maxOrdinal}
          THEN RAISE(ABORT, 'AUTHORITY_EPOCH_OVERFLOW')
        END;
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM local_control_authority_epochs WHERE client_id = NEW.client_id
          ) AND NEW.authority_epoch != 1
          THEN RAISE(ABORT, 'AUTHORITY_EPOCH_MUST_START_AT_ONE')
          WHEN EXISTS (
            SELECT 1 FROM local_control_authority_epochs WHERE client_id = NEW.client_id
          ) AND NEW.authority_epoch > (
            SELECT max_epoch + 1 FROM local_control_authority_epochs WHERE client_id = NEW.client_id
          )
          THEN RAISE(ABORT, 'AUTHORITY_EPOCH_STEP_INVALID')
        END;
        SELECT CASE
          WHEN EXISTS (
            SELECT 1 FROM local_control_authority_epochs AS epochs WHERE epochs.client_id = NEW.client_id
              AND NEW.authority_epoch <= epochs.max_epoch
          ) AND NOT EXISTS (
            SELECT 1 FROM local_control_clients AS existing
            JOIN local_control_authority_epochs AS epochs ON epochs.client_id = existing.client_id
            WHERE existing.client_id = NEW.client_id
              AND existing.revoked_at IS NULL
              AND existing.authority_epoch = epochs.max_epoch
              AND NEW.authority_epoch = existing.authority_epoch
              AND existing.credential_generation < ${maxOrdinal}
              AND NEW.credential_generation = existing.credential_generation + 1
              AND NEW.token_hash IS NOT existing.token_hash
              AND ${insertedScopes} IS ${existingScopes}
          )
          THEN RAISE(ABORT, 'authority_epoch must exceed historical max_epoch')
        END;
      END;

      CREATE TRIGGER prevent_client_unauthorized_update
      BEFORE UPDATE ON local_control_clients
      BEGIN
        SELECT CASE
          WHEN json_valid(NEW.scopes_json) = 0 OR json_type(NEW.scopes_json) != 'array'
          THEN RAISE(ABORT, 'scopes_json must be a valid JSON array')
        END;
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM json_each(NEW.scopes_json) WHERE type != 'text')
            OR NOT EXISTS (SELECT 1 FROM json_each(NEW.scopes_json) LIMIT 1)
          THEN RAISE(ABORT, 'scopes_json must contain at least one text scope')
          WHEN NEW.client_id IS NOT OLD.client_id
          THEN RAISE(ABORT, 'client_id identity is immutable')
        END;
        SELECT CASE
          WHEN typeof(NEW.credential_generation) != 'integer' OR NEW.credential_generation < 1
          THEN RAISE(ABORT, 'CREDENTIAL_GENERATION_INVALID')
          WHEN NEW.credential_generation > ${maxOrdinal}
             OR (NEW.token_hash IS NOT OLD.token_hash AND OLD.credential_generation >= ${maxOrdinal})
          THEN RAISE(ABORT, 'CREDENTIAL_GENERATION_OVERFLOW')
          WHEN NEW.token_hash IS NOT OLD.token_hash
             AND NEW.credential_generation != OLD.credential_generation + 1
          THEN RAISE(ABORT, 'CREDENTIAL_GENERATION_STEP_INVALID')
          WHEN NEW.token_hash IS OLD.token_hash
             AND NEW.credential_generation != OLD.credential_generation
          THEN RAISE(ABORT, 'CREDENTIAL_GENERATION_REQUIRES_SECRET_ROTATION')
        END;
        SELECT CASE
          WHEN typeof(NEW.authority_epoch) != 'integer' OR NEW.authority_epoch < 1
          THEN RAISE(ABORT, 'AUTHORITY_EPOCH_INVALID')
          WHEN NEW.authority_epoch > ${maxOrdinal}
          THEN RAISE(ABORT, 'AUTHORITY_EPOCH_OVERFLOW')
          WHEN NEW.authority_epoch < OLD.authority_epoch
          THEN RAISE(ABORT, 'authority_epoch cannot decrease')
          WHEN NEW.authority_epoch > OLD.authority_epoch AND NEW.authority_epoch != OLD.authority_epoch + 1
          THEN RAISE(ABORT, 'AUTHORITY_EPOCH_STEP_INVALID')
          WHEN NEW.authority_epoch < COALESCE((
            SELECT max_epoch FROM local_control_authority_epochs WHERE client_id = OLD.client_id
          ), 0)
          THEN RAISE(ABORT, 'authority_epoch cannot be lower than historical max_epoch')
          WHEN ${newScopes} IS NOT ${oldScopes} AND NEW.authority_epoch <= OLD.authority_epoch
          THEN RAISE(ABORT, 'changing the effective scope set requires advancing authority_epoch')
          WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL
             AND (NEW.authority_epoch <= OLD.authority_epoch OR NEW.token_hash IS OLD.token_hash)
          THEN RAISE(ABORT, 'reactivating a revoked client requires a new secret and authority_epoch')
        END;
      END;

      CREATE TRIGGER prevent_authority_epochs_delete
      BEFORE DELETE ON local_control_authority_epochs
      BEGIN
        SELECT RAISE(ABORT, 'deleting local_control_authority_epochs is forbidden');
      END;

      CREATE TRIGGER enforce_authority_epoch_high_water_insert
      BEFORE INSERT ON local_control_authority_epochs
      BEGIN
        SELECT CASE
          WHEN typeof(NEW.max_epoch) != 'integer' OR NEW.max_epoch < 1
          THEN RAISE(ABORT, 'AUTHORITY_EPOCH_HIGH_WATER_INVALID')
          WHEN NEW.max_epoch > ${maxOrdinal}
          THEN RAISE(ABORT, 'AUTHORITY_EPOCH_OVERFLOW')
          WHEN EXISTS (
            SELECT 1 FROM local_control_authority_epochs AS existing WHERE existing.client_id = NEW.client_id
          ) AND NEW.max_epoch <= (
            SELECT max_epoch FROM local_control_authority_epochs WHERE client_id = NEW.client_id
          )
          THEN RAISE(ABORT, 'authority high-water mark cannot be reused or decreased')
          WHEN NOT EXISTS (
            SELECT 1 FROM local_control_authority_epochs AS existing WHERE existing.client_id = NEW.client_id
          ) AND NEW.max_epoch != 1
          THEN RAISE(ABORT, 'authority high-water mark must start at one')
          WHEN EXISTS (
            SELECT 1 FROM local_control_authority_epochs AS existing WHERE existing.client_id = NEW.client_id
          ) AND NEW.max_epoch != (
            SELECT max_epoch + 1 FROM local_control_authority_epochs WHERE client_id = NEW.client_id
          )
          THEN RAISE(ABORT, 'authority high-water mark must advance one ordinal at a time')
        END;
      END;

      CREATE TRIGGER prevent_authority_epochs_update_decrement
      BEFORE UPDATE ON local_control_authority_epochs
      BEGIN
        SELECT CASE
          WHEN NEW.client_id IS NOT OLD.client_id
          THEN RAISE(ABORT, 'authority high-water identity is immutable')
          WHEN typeof(NEW.max_epoch) != 'integer' OR NEW.max_epoch < 1
          THEN RAISE(ABORT, 'AUTHORITY_EPOCH_HIGH_WATER_INVALID')
          WHEN NEW.max_epoch > ${maxOrdinal}
          THEN RAISE(ABORT, 'AUTHORITY_EPOCH_OVERFLOW')
          WHEN NEW.max_epoch < OLD.max_epoch
          THEN RAISE(ABORT, 'decrementing authority high-water mark is forbidden')
          WHEN NEW.max_epoch > OLD.max_epoch AND NEW.max_epoch != OLD.max_epoch + 1
          THEN RAISE(ABORT, 'authority high-water mark must advance one ordinal at a time')
        END;
      END;

      CREATE TRIGGER sync_authority_epoch_to_max_on_insert
      AFTER INSERT ON local_control_clients
      BEGIN
        INSERT INTO local_control_authority_epochs (client_id, max_epoch)
        VALUES (NEW.client_id, NEW.authority_epoch)
        ON CONFLICT(client_id) DO UPDATE SET
          max_epoch = MAX(local_control_authority_epochs.max_epoch, excluded.max_epoch);
      END;

      CREATE TRIGGER sync_authority_epoch_to_max_on_update
      AFTER UPDATE OF authority_epoch ON local_control_clients
      WHEN NEW.authority_epoch > OLD.authority_epoch
      BEGIN
        INSERT INTO local_control_authority_epochs (client_id, max_epoch)
        VALUES (NEW.client_id, NEW.authority_epoch)
        ON CONFLICT(client_id) DO UPDATE SET
          max_epoch = MAX(local_control_authority_epochs.max_epoch, excluded.max_epoch);
      END;
    `);
  }

  private clientRow(clientId: string): ClientRow | null {
    return this.db.query(`
      SELECT client_id, token_hash, scopes_json, expires_at, revoked_at
      FROM local_control_clients WHERE client_id = ?
    `).get(clientId) as ClientRow | null;
  }
}

/** Authenticates transport requests and owns short-lived browser stream sessions. */
export class LocalControlAuthorizer implements LocalControlAuthorizationPort {
  private readonly browserSessions = new Map<string, BrowserSession>();
  private readonly origins: ReadonlySet<string>;

  constructor(
    private readonly credentials: LocalControlCredentialStore,
    allowedOrigins: readonly string[] = [],
  ) {
    this.origins = new Set(allowedOrigins.map(validateOrigin));
  }

  hasActiveClients(): boolean {
    return this.credentials.hasActiveClients();
  }

  close(): void {
    this.browserSessions.clear();
  }

  authorizeBearer(authorization: string | undefined, requiredScope: LocalControlAuthScope): LocalControlAuthenticatedClient | null {
    const client = this.authenticateBearer(authorization);
    return client?.scopes.includes(requiredScope) ? client : null;
  }

  authenticateBearer(authorization: string | undefined): LocalControlAuthenticatedClient | null {
    const match = typeof authorization === "string" && authorization.length <= 512
      ? /^Bearer (oc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43})$/.exec(authorization)
      : null;
    return this.credentials.authorizeToken(match?.[1]);
  }

  authorizeBrowserSession(cookieHeader: string | undefined, origin: string | undefined): LocalControlAuthenticatedClient | null {
    const client = this.authenticateBrowserSession(cookieHeader, origin);
    return client?.scopes.includes("mission.read") ? client : null;
  }

  authenticateBrowserSession(cookieHeader: string | undefined, origin: string | undefined): LocalControlAuthenticatedClient | null {
    const cookie = readCookie(cookieHeader, BROWSER_SESSION_COOKIE);
    if (!cookie || !origin || !this.isAllowedOrigin(origin)) return null;
    const session = this.browserSessions.get(hashOpaqueSecret(cookie));
    if (!session || session.expiresAt <= Date.now() || session.origin !== origin) return null;
    const client = this.credentials.authorizeTokenForVersion(session.clientId, session.credentialVersion, "mission.read");
    return client ? { ...client, scopes: ["mission.read"], expiresAt: session.expiresAt } : null;
  }

  isClientStillAuthorized(client: LocalControlAuthenticatedClient, requiredScope: LocalControlAuthScope): boolean {
    if (client.expiresAt !== undefined && client.expiresAt <= Date.now()) return false;
    return this.credentials.isClientStillAuthorized(client, requiredScope);
  }

  isAllowedOrigin(origin: string): boolean {
    return this.origins.has(origin);
  }

  createBrowserSession(authorization: string | undefined, origin: string | undefined): { cookie: string; maxAge: number } | null {
    if (!origin || !this.isAllowedOrigin(origin)) return null;
    const client = this.authorizeBearer(authorization, "mission.read");
    if (!client) return null;
    const cookie = randomBytes(TOKEN_SECRET_BYTES).toString("base64url");
    const expiresAt = Date.now() + LOCAL_CONTROL_BROWSER_SESSION_SECONDS * 1_000;
    for (const [hash, session] of this.browserSessions) {
      if (session.expiresAt <= Date.now()) this.browserSessions.delete(hash);
    }
    this.browserSessions.set(hashOpaqueSecret(cookie), {
      clientId: client.clientId,
      credentialVersion: client.credentialVersion,
      origin,
      expiresAt,
    });
    return { cookie, maxAge: LOCAL_CONTROL_BROWSER_SESSION_SECONDS };
  }
}

/** Read the operator-provisioned client file after verifying ownership and mode. */
export function readLocalControlClientCredential(filePath: string): LocalControlClientCredential {
  const absolutePath = resolve(filePath);
  const stat = lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || !isCurrentUser(stat.uid)) {
    throw new Error("Client credential file permissions are invalid");
  }
  if (stat.size < 2 || stat.size > MAX_CREDENTIAL_FILE_BYTES) throw new Error("Client credential file size is invalid");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  } catch {
    throw new Error("Client credential file is invalid");
  }
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "clientId,schemaVersion,token" ||
      value.schemaVersion !== 1 || typeof value.clientId !== "string" || !isValidClientId(value.clientId) ||
      typeof value.token !== "string" || parseToken(value.token)?.clientId !== value.clientId) {
    throw new Error("Client credential file is invalid");
  }
  return value as unknown as LocalControlClientCredential;
}

/** Atomically write a client secret with private directory and file permissions. */
export function writeLocalControlClientCredential(filePath: string, credential: LocalControlClientCredential): void {
  const absolutePath = resolve(filePath);
  securePrivateDirectory(dirname(absolutePath));
  assertPrivateRegularFileOrMissing(absolutePath);
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const content = `${JSON.stringify(credential)}\n`;
  const fd = openSync(temporaryPath, "wx", 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || !isCurrentUser(stat.uid)) {
      throw new Error("Could not create a private client credential file");
    }
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, absolutePath);
  chmodSync(absolutePath, 0o600);
}

/** Remove only a regular credential file owned by this operator. */
export function removeLocalControlClientCredential(filePath: string): void {
  const absolutePath = resolve(filePath);
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Could not inspect the client credential file");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || !isCurrentUser(stat.uid)) {
    throw new Error("Refusing to remove a non-owned client credential file");
  }
  unlinkSync(absolutePath);
}

/** Default per-user credential directory. */
export function defaultLocalControlCredentialPath(clientId = "operator-cli"): string {
  validateClientId(clientId);
  const configHome = process.env.XDG_CONFIG_HOME || `${process.env.HOME || process.cwd()}/.config`;
  return resolve(configHome, "ouroboros", "local-control", `${clientId}.json`);
}

/** Default local registry path used by daemon and offline provisioning CLI. */
export function defaultLocalControlAuthDatabasePath(dataDir = process.env.OUROBOROS_DATA_DIR || ".ouroboros"): string {
  return resolve(dataDir, "local-control-auth.db");
}

/** Secure an operator-owned private directory (not an isolation boundary from the same UID). */
export function securePrivateDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isCurrentUser(stat.uid)) {
    throw new Error("Local-control directory ownership is invalid");
  }
  chmodSync(directoryPath, 0o700);
}

/** Stable operation-to-scope mapping; unclassified or malformed requests are denied. */
export function requiredLocalControlScope(method: unknown, params: unknown): LocalControlAuthScope | null {
  if (typeof method !== "string" || !isRecord(params)) return null;
  switch (method) {
    case "local_control.read":
      return [
        "protocol.negotiate", "health", "status", "mission.list", "mission.show",
        "invocation.list", "invocation.show", "capability_registry.list", "diagnostics.list",
      ].includes(String(params.operation)) ? "mission.read" : null;
    case "session.list":
    case "session.get":
    case "daemon.status":
    case "system.health":
    case "system.version":
      return "mission.read";
    case "local_control.command":
      return ["mission.pause", "mission.resume", "mission.cancel"].includes(String(params.operation))
        ? "mission.control"
        : null;
    case "local_control.admit":
      return "mission.create";
    case "daemon.setMode":
    case "daemon.emergencyBrake":
    case "system.shutdown":
      return "daemon.admin";
    default:
      return null;
  }
}

export function getBrowserSessionCookieName(): string {
  return BROWSER_SESSION_COOKIE;
}

function parseToken(token: string | undefined): { clientId: string; secret: string } | null {
  if (typeof token !== "string" || token.length > 256) return null;
  const match = /^oc1\.([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  let clientId: string;
  try { clientId = Buffer.from(match[1], "base64url").toString("utf8"); } catch { return null; }
  if (!isValidClientId(clientId) || Buffer.from(clientId).toString("base64url") !== match[1]) return null;
  return { clientId, secret: match[2] };
}

function hashTokenSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function hashOpaqueSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function canonicalScopeSetSql(jsonExpression: string): string {
  return `(SELECT json_group_array(scope_value) FROM (
    SELECT DISTINCT value AS scope_value FROM json_each(${jsonExpression}) ORDER BY value
  ))`;
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validateClientId(clientId: string): void {
  if (!isValidClientId(clientId)) throw new Error("Client id is invalid");
}

function isValidClientId(clientId: string): boolean {
  return clientId.length > 0 && clientId.length <= LOCAL_CONTROL_MAX_CLIENT_ID_LENGTH && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(clientId);
}

function validateScopes(scopes: readonly LocalControlAuthScope[]): LocalControlAuthScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((scope) => LOCAL_CONTROL_AUTH_SCOPES.includes(scope))) {
    throw new Error("At least one supported authorization scope is required");
  }
  const unique = [...new Set(scopes)];
  if (unique.length !== scopes.length) throw new Error("Authorization scopes must not repeat");
  return unique;
}

function parseStoredScopes(value: string): LocalControlAuthScope[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((scope) => LOCAL_CONTROL_AUTH_SCOPES.includes(scope))) return null;
    return [...parsed] as LocalControlAuthScope[];
  } catch {
    return null;
  }
}

function validateOrigin(origin: string): string {
  if (origin.length > 512 || origin === "null") throw new Error("Browser Origin is invalid");
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error("Browser Origin is invalid"); }
  if (parsed.origin !== origin || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error("Browser Origin is invalid");
  }
  return origin;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header || header.length > 8_192) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }
  return found && /^[A-Za-z0-9_-]{43}$/.test(found) ? found : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function assertPrivateRegularFileOrMissing(filePath: string): void {
  let stat;
  try { stat = lstatSync(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Local-control credential registry cannot be inspected");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || !isCurrentUser(stat.uid)) {
    throw new Error("Local-control credential registry ownership is invalid");
  }
  chmodSync(filePath, 0o600);
}
