import { Database } from "bun:sqlite";
import { join } from "node:path";
import { LocalControlCredentialStore } from "./local-control-auth.js";
import { EffectClass, type MissionCapabilityGrantInput } from "../mission/contracts.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";

const [mode, dataDir, clientId, missionId] = process.argv.slice(2);
if (!mode || !dataDir || !clientId || !missionId) {
  throw new Error("Cross-store crash fixture arguments are required");
}

const authPath = join(dataDir, "local-control-auth.db");
const missionPath = join(dataDir, "missions.db");

function parkForParentKill(marker: string): Promise<never> {
  process.stdout.write(`${marker}\n`);
  process.stdin.resume();
  return new Promise<never>(() => {});
}

function untrustedLedgerFixtureGrant(): MissionCapabilityGrantInput {
  const now = new Date().toISOString();
  return {
    grantId: "fixture-only-untrusted-ledger-fact",
    missionId,
    capabilityId: "fixture.read",
    allowedEffectClasses: [EffectClass.READ],
    allowedRefPrefixes: ["refs/fixture/"],
    grantorClientId: "fixture-only-untrusted-principal",
    grantorCredentialGeneration: null,
    grantorAuthorityEpoch: null,
    issuedAt: now,
    expiresAt: null,
    createdAt: now,
  };
}

if (mode === "hold-auth-update-before-commit") {
  const database = new Database(authPath);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA recursive_triggers = ON");
  database.exec("BEGIN IMMEDIATE");
  const row = database.query(`
    SELECT limits_json, authority_epoch
    FROM local_control_clients WHERE client_id = ?
  `).get(clientId) as { limits_json: string | null; authority_epoch: number } | null;
  if (!row || row.limits_json === null) throw new Error("Crash fixture requires existing entitlement limits");
  database.query(`
    UPDATE local_control_clients
    SET limits_json = NULL, authority_epoch = authority_epoch + 1
    WHERE client_id = ?
  `).run(clientId);
  await parkForParentKill("AUTH_UPDATE_UNCOMMITTED");
}

if (mode === "commit-auth-entitlement") {
  const store = new LocalControlCredentialStore(authPath);
  if (!store.setEntitlementLimits(clientId, null)) throw new Error("Expected an entitlement authority change");
  await parkForParentKill("AUTH_COMMITTED_BEFORE_MISSION_OPERATION");
}

if (mode === "append-untrusted-ledger-fixture") {
  const store = new SqliteMissionStore(missionPath);
  await store.initialize();
  await store.appendCapabilityGrant(untrustedLedgerFixtureGrant());
  await parkForParentKill("MISSION_LEDGER_COMMITTED_BEFORE_CALLER_ACK");
}

if (
  mode !== "hold-auth-update-before-commit"
  && mode !== "commit-auth-entitlement"
  && mode !== "append-untrusted-ledger-fixture"
) {
  throw new Error("Unknown cross-store crash fixture mode");
}
