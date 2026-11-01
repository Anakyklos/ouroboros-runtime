import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    EffectClass,
    type CapabilityContract,
    type MissionCapabilityGrantInput,
    type MissionCapabilityRevocationInput,
} from "./contracts.js";
import {
    capabilityGrantAuthorityKey,
    capabilityRevocationAuthorityKey,
    reduceCapabilityGrantLedger,
    validateCapabilityGrantCoverage,
} from "./capability-grants.js";
import { SqliteMissionStore } from "./sqlite-mission-store.js";

const TIME = "2026-11-01T12:00:00.000Z";
const tempDirs: string[] = [];

function makeDatabasePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "mission-capability-grants-"));
    tempDirs.push(dir);
    return join(dir, "missions.db");
}

function insertMission(dbPath: string, missionId: string): void {
    const db = new Database(dbPath);
    db.query(`
        INSERT INTO missions (
            mission_id, schema_version, source, sanitized_original_intent, original_intent_ref,
            interpreted_objective, state, created_at, updated_at
        ) VALUES (?, 1, 'operator', 'legacy-safe', 'sha256-ref', 'objective', 'created', ?, ?)
    `).run(missionId, TIME, TIME);
    db.close();
}

function makeGrant(
    grantId: string,
    missionId = "mission-a",
    overrides: Partial<MissionCapabilityGrantInput> = {},
): MissionCapabilityGrantInput {
    return {
        grantId,
        missionId,
        capabilityId: "lifeos.journal.read",
        allowedEffectClasses: [EffectClass.READ],
        allowedRefPrefixes: ["refs/lifeos/journal/"],
        grantorClientId: "operator-one",
        grantorCredentialGeneration: null,
        grantorAuthorityEpoch: null,
        issuedAt: TIME,
        expiresAt: null,
        createdAt: TIME,
        ...overrides,
    };
}

function makeRevocation(
    revocationId: string,
    grantId: string,
    missionId = "mission-a",
    overrides: Partial<MissionCapabilityRevocationInput> = {},
): MissionCapabilityRevocationInput {
    return {
        revocationId,
        missionId,
        grantId,
        revokerClientId: "operator-one",
        revokerCredentialGeneration: null,
        revokerAuthorityEpoch: null,
        revokedAt: TIME,
        createdAt: TIME,
        ...overrides,
    };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve: () => resolve() };
}

afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("SQLite Capability Grant ledger", () => {
    it("creates an additive schema in an empty WAL database and initializes idempotently", async () => {
        const dbPath = makeDatabasePath();
        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        await store.initialize();
        const db = new Database(dbPath);
        expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
        expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(0);
        expect((db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?)").all(
            "mission_capability_grants",
            "mission_capability_revocations",
        ) as Array<{ name: string }>).map(({ name }) => name).sort()).toEqual([
            "mission_capability_grants",
            "mission_capability_revocations",
        ]);
        expect((db.query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_mission_capability_%'").all() as unknown[]).length)
            .toBeGreaterThanOrEqual(2);
        db.close();
        await store.close();
    });

    it("upgrades a legacy Mission database without synthetic grants or Mission rewrites", async () => {
        const dbPath = makeDatabasePath();
        const legacy = new Database(dbPath);
        legacy.exec(`
            CREATE TABLE missions (
                mission_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, source TEXT NOT NULL,
                sanitized_original_intent TEXT NOT NULL, original_intent_ref TEXT NOT NULL,
                interpreted_objective TEXT NOT NULL, constraints TEXT NOT NULL, acceptance_criteria TEXT NOT NULL,
                budget_policy TEXT NOT NULL, allowed_capability_scope TEXT NOT NULL, approval_requirements TEXT NOT NULL,
                context_refs TEXT NOT NULL, state TEXT NOT NULL, current_plan_revision_id TEXT,
                evidence_refs TEXT NOT NULL, criterion_verifications TEXT NOT NULL, unresolved_questions TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, recovery_metadata TEXT NOT NULL
            );
            CREATE TABLE mission_invocations (
                invocation_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, step_id TEXT NOT NULL,
                capability_id TEXT NOT NULL, status TEXT NOT NULL, dispatched_at TEXT, completed_at TEXT,
                result_refs TEXT NOT NULL, owner_verification TEXT, error TEXT
            );
        `);
        legacy.query("INSERT INTO missions VALUES (?, 1, 'cli', 'keep-me', 'legacy-ref', 'legacy objective', '[]', '[]', '{}', '{}', '[]', '[]', 'ready', NULL, '[\"evidence-1\"]', '[]', '[]', ?, ?, '{}')")
            .run("legacy-mission", TIME, TIME);
        legacy.query("INSERT INTO mission_invocations VALUES (?, ?, ?, ?, ?, NULL, NULL, '[]', NULL, NULL)")
            .run("legacy-invocation", "legacy-mission", "step-1", "lifeos.journal.read", "completed");
        legacy.query("UPDATE missions SET created_at = ?, updated_at = ? WHERE mission_id = 'legacy-mission'").run(TIME, TIME);
        legacy.close();

        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        await store.close();
        const reopened = new SqliteMissionStore(dbPath);
        await reopened.initialize();
        await reopened.initialize();
        const db = new Database(dbPath);
        expect((db.query("SELECT COUNT(*) AS count FROM mission_capability_grants").get() as { count: number }).count).toBe(0);
        expect((db.query("SELECT COUNT(*) AS count FROM mission_capability_revocations").get() as { count: number }).count).toBe(0);
        expect((db.query("SELECT sanitized_original_intent, evidence_refs FROM missions WHERE mission_id = ?")
            .get("legacy-mission") as { sanitized_original_intent: string; evidence_refs: string })).toEqual({
            sanitized_original_intent: "keep-me",
            evidence_refs: '["evidence-1"]',
        });
        expect((db.query("SELECT invocation_id FROM mission_invocations WHERE mission_id = ?")
            .get("legacy-mission") as { invocation_id: string }).invocation_id).toBe("legacy-invocation");
        db.close();
        await reopened.close();
    });

    it("persists grants and revocations across restart without changing grant facts", async () => {
        const dbPath = makeDatabasePath();
        const first = new SqliteMissionStore(dbPath);
        await first.initialize();
        insertMission(dbPath, "mission-a");
        const grant = await first.appendCapabilityGrant(makeGrant("grant-a", "mission-a", {
            grantorCredentialGeneration: 2,
            grantorAuthorityEpoch: 4,
        }));
        const revocation = await first.appendCapabilityRevocation(makeRevocation("revoke-a", "grant-a", "mission-a", {
            revokerCredentialGeneration: 2,
            revokerAuthorityEpoch: 4,
        }));
        await first.close();

        const reopened = new SqliteMissionStore(dbPath);
        await reopened.initialize();
        const grants = await reopened.listCapabilityGrants("mission-a");
        const revocations = await reopened.listCapabilityRevocations("mission-a");
        expect(grants).toEqual([grant]);
        expect(revocations).toEqual([revocation]);
        const revocationAuthority = new Set([
            capabilityRevocationAuthorityKey("mission-a", "revoke-a"),
        ]);
        expect(reduceCapabilityGrantLedger({
            grants,
            revocations,
            evaluatedAt: TIME,
            authorityValidatedRevocationKeys: revocationAuthority,
        })).toEqual([
            { missionId: "mission-a", grantId: "grant-a", state: "revoked" },
        ]);
        const contract: CapabilityContract = {
            capabilityId: "lifeos.journal.read",
            moduleOwner: "lifeos",
            effectClass: EffectClass.READ,
            requiresApproval: false,
            requiresOwnerVerification: false,
            allowedInputRefPrefixes: ["refs/lifeos/journal/"],
            ownsStorage: false,
        };
        expect(validateCapabilityGrantCoverage({
            missionId: "mission-a",
            capabilityId: contract.capabilityId,
            effectClass: EffectClass.READ,
            inputRefs: ["refs/lifeos/journal/2026-08"],
            capabilityContract: contract,
            grants,
            revocations,
            evaluatedAt: TIME,
            authorityValidatedGrantKeys: new Set([capabilityGrantAuthorityKey("mission-a", "grant-a")]),
            authorityValidatedRevocationKeys: revocationAuthority,
        }).valid).toBe(false);
        await reopened.close();
    });

    it("is idempotent for identical events and fails on identity/content collisions", async () => {
        const dbPath = makeDatabasePath();
        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        insertMission(dbPath, "mission-a");
        insertMission(dbPath, "mission-b");
        const grant = makeGrant("grant-a");
        const first = await store.appendCapabilityGrant(grant);
        const replay = await store.appendCapabilityGrant(grant);
        expect(replay).toEqual(first);
        await expect(store.appendCapabilityGrant(makeGrant("grant-a", "mission-a", { capabilityId: "lifeos.journal.write" })))
            .rejects.toThrow(/conflict/i);
        await store.appendCapabilityGrant(makeGrant("grant-a", "mission-b"));
        expect(await store.listCapabilityGrants("mission-a")).toHaveLength(1);
        expect(await store.listCapabilityGrants("mission-b")).toHaveLength(1);
        await expect(store.appendCapabilityRevocation(makeRevocation("revoke-a", "grant-a")))
            .resolves.toBeDefined();
        await expect(store.appendCapabilityRevocation(makeRevocation("revoke-a", "grant-a", "mission-a", {
            revokedAt: "2026-11-01T12:01:00.000Z",
        }))).rejects.toThrow(/conflict/i);
        await store.close();
    });

    it("serializes concurrent identical writers and leaves one durable fact", async () => {
        const dbPath = makeDatabasePath();
        const store = new SqliteMissionStore(dbPath);
        const secondStore = new SqliteMissionStore(dbPath);
        await Promise.all([store.initialize(), secondStore.initialize()]);
        insertMission(dbPath, "mission-a");
        const grant = makeGrant("grant-concurrent");
        const results = await Promise.all([
            store.appendCapabilityGrant(grant),
            secondStore.appendCapabilityGrant(grant),
        ]);
        expect(new Set(results.map(({ fingerprint }) => fingerprint)).size).toBe(1);
        expect(await store.listCapabilityGrants("mission-a")).toHaveLength(1);
        const collision = await Promise.allSettled([
            store.appendCapabilityGrant(makeGrant("grant-race-collision", "mission-a", { capabilityId: "lifeos.journal.read" })),
            secondStore.appendCapabilityGrant(makeGrant("grant-race-collision", "mission-a", { capabilityId: "lifeos.journal.write" })),
        ]);
        expect(collision.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        expect(collision.filter(({ status }) => status === "rejected")).toHaveLength(1);
        expect(await store.listCapabilityGrants("mission-a")).toHaveLength(2);
        await store.close();
        await secondStore.close();
    });

    it("does not report an independent grant append committed inside another transaction", async () => {
        const dbPath = makeDatabasePath();
        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        insertMission(dbPath, "mission-a");
        const observed: unknown[] = [];
        store.onMutation((event) => observed.push(event));
        const started = createDeferred();
        const release = createDeferred();
        const transaction = store.withTransaction(async () => {
            await store.appendCapabilityGrant(makeGrant("grant-rolled-back"));
            started.resolve();
            await release.promise;
            throw new Error("rollback outer grant transaction");
        });
        await started.promise;

        let appendReportedSuccess = false;
        const independentAppend = store.appendCapabilityGrant(makeGrant("grant-independent"))
            .then((grant) => {
                appendReportedSuccess = true;
                return grant;
            });
        await Promise.resolve();
        expect(appendReportedSuccess).toBe(false);

        release.resolve();
        await expect(transaction).rejects.toThrow("rollback outer grant transaction");
        const returnedGrant = await independentAppend;
        expect(returnedGrant.grantId).toBe("grant-independent");
        expect((await store.listCapabilityGrants("mission-a")).map(({ grantId }) => grantId)).toEqual([
            "grant-independent",
        ]);
        expect(observed).toEqual([]);
        await store.close();
    });

    it("does not report an independent revocation append committed inside another transaction", async () => {
        const dbPath = makeDatabasePath();
        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        insertMission(dbPath, "mission-a");
        await store.appendCapabilityGrant(makeGrant("grant-revocation-target"));
        const observed: unknown[] = [];
        store.onMutation((event) => observed.push(event));
        const started = createDeferred();
        const release = createDeferred();
        const transaction = store.withTransaction(async () => {
            await store.appendCapabilityRevocation(makeRevocation("revoke-rolled-back", "grant-revocation-target"));
            started.resolve();
            await release.promise;
            throw new Error("rollback outer revocation transaction");
        });
        await started.promise;

        let appendReportedSuccess = false;
        const independentAppend = store.appendCapabilityRevocation(
            makeRevocation("revoke-independent", "grant-revocation-target"),
        ).then((revocation) => {
            appendReportedSuccess = true;
            return revocation;
        });
        await Promise.resolve();
        expect(appendReportedSuccess).toBe(false);

        release.resolve();
        await expect(transaction).rejects.toThrow("rollback outer revocation transaction");
        const returnedRevocation = await independentAppend;
        expect(returnedRevocation.revocationId).toBe("revoke-independent");
        expect((await store.listCapabilityRevocations("mission-a")).map(({ revocationId }) => revocationId)).toEqual([
            "revoke-independent",
        ]);
        expect(observed).toEqual([]);
        await store.close();
    });

    it("rolls back ledger writes and never publishes a pre-commit mutation", async () => {
        const dbPath = makeDatabasePath();
        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        insertMission(dbPath, "mission-a");
        const observed: unknown[] = [];
        store.onMutation((event) => observed.push(event));
        await expect(store.withTransaction(async () => {
            await store.appendCapabilityGrant(makeGrant("grant-rollback"));
            await store.appendCapabilityRevocation(makeRevocation("revoke-rollback", "grant-rollback"));
            throw new Error("force rollback");
        })).rejects.toThrow("force rollback");
        expect(await store.listCapabilityGrants("mission-a")).toEqual([]);
        expect(await store.listCapabilityRevocations("mission-a")).toEqual([]);
        expect(observed).toEqual([]);
        await store.appendCapabilityGrant(makeGrant("grant-committed"));
        expect(observed).toEqual([]);
        await store.close();
    });

    it("enforces append-only, mission ownership, and orphan integrity with foreign keys off", async () => {
        const dbPath = makeDatabasePath();
        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        insertMission(dbPath, "mission-a");
        await store.appendCapabilityGrant(makeGrant("grant-a"));
        await store.appendCapabilityRevocation(makeRevocation("revoke-a", "grant-a"));

        const db = new Database(dbPath);
        db.exec("PRAGMA foreign_keys = OFF; PRAGMA recursive_triggers = OFF;");
        expect(() => db.query("UPDATE mission_capability_grants SET capability_id = ? WHERE mission_id = ? AND grant_id = ?")
            .run("lifeos.journal.write", "mission-a", "grant-a")).toThrow();
        expect(() => db.query("DELETE FROM mission_capability_grants WHERE mission_id = ? AND grant_id = ?")
            .run("mission-a", "grant-a")).toThrow();
        expect(() => db.query(`
            INSERT OR REPLACE INTO mission_capability_grants (
                grant_id, mission_id, capability_id, allowed_effect_classes, allowed_ref_prefixes,
                grantor_client_id, grantor_credential_generation, grantor_authority_epoch,
                issued_at, expires_at, created_at, fingerprint
            ) VALUES ('grant-a', 'mission-a', 'lifeos.journal.write', '["read"]', '["refs/lifeos/journal/"]',
                'operator-one', NULL, NULL, ?, NULL, ?, printf('%064d', 0))
        `).run(TIME, TIME)).toThrow();
        expect(() => db.query("DELETE FROM mission_capability_revocations WHERE mission_id = ? AND revocation_id = ?")
            .run("mission-a", "revoke-a")).toThrow();
        expect(() => db.query("UPDATE mission_capability_revocations SET revoked_at = ? WHERE mission_id = ? AND revocation_id = ?")
            .run("2026-11-01T13:00:00.000Z", "mission-a", "revoke-a")).toThrow();
        expect(() => db.query("UPDATE missions SET mission_id = ? WHERE mission_id = ?")
            .run("mission-renamed", "mission-a")).toThrow();
        expect(() => db.query("DELETE FROM missions WHERE mission_id = ?").run("mission-a")).toThrow();
        expect(() => db.query(`
            INSERT OR REPLACE INTO missions (
                mission_id, schema_version, source, sanitized_original_intent, original_intent_ref,
                interpreted_objective, state, created_at, updated_at
            ) VALUES ('mission-a', 1, 'operator', 'replace', 'replace-ref', 'replace', 'created', ?, ?)
        `).run(TIME, TIME)).toThrow();
        expect(() => db.query(`
            INSERT INTO mission_capability_grants (
                grant_id, mission_id, capability_id, allowed_effect_classes, allowed_ref_prefixes,
                grantor_client_id, grantor_credential_generation, grantor_authority_epoch,
                issued_at, expires_at, created_at, fingerprint
            ) VALUES ('orphan', 'missing-mission', 'lifeos.journal.read', '["read"]', '[]',
                'operator-one', NULL, NULL, ?, NULL, ?, 'fingerprint')
        `).run(TIME, TIME)).toThrow();
        expect((db.query(`
            SELECT COUNT(*) AS count FROM mission_capability_grants AS grant_row
            LEFT JOIN missions ON missions.mission_id = grant_row.mission_id
            WHERE missions.mission_id IS NULL
        `).get() as { count: number }).count).toBe(0);
        expect((db.query(`
            SELECT COUNT(*) AS count FROM mission_capability_revocations AS revocation
            LEFT JOIN mission_capability_grants AS grant_row
              ON grant_row.mission_id = revocation.mission_id AND grant_row.grant_id = revocation.grant_id
            WHERE grant_row.grant_id IS NULL
        `).get() as { count: number }).count).toBe(0);
        expect(() => db.query(`
            INSERT INTO mission_capability_revocations (
                revocation_id, mission_id, grant_id, revoker_client_id,
                revoker_credential_generation, revoker_authority_epoch, revoked_at, created_at, fingerprint
            ) VALUES ('orphan-revoke', 'mission-a', 'missing-grant', 'operator-one', NULL, NULL, ?, ?, 'fingerprint')
        `).run(TIME, TIME)).toThrow();
        const grantTables = ["mission_capability_grants", "mission_capability_revocations"];
        for (const table of grantTables) {
            const names = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
            expect(names).not.toContain("token_hash");
            expect(names).not.toContain("credential_version");
        }
        db.close();
        await store.close();
    });

    it("fails closed when SQLite contents are corrupted before recovery", async () => {
        const dbPath = makeDatabasePath();
        const first = new SqliteMissionStore(dbPath);
        await first.initialize();
        insertMission(dbPath, "mission-a");
        await first.appendCapabilityGrant(makeGrant("grant-corrupt"));
        const raw = new Database(dbPath);
        raw.exec("DROP TRIGGER prevent_mission_capability_grant_update");
        raw.query("UPDATE mission_capability_grants SET allowed_effect_classes = '[\"write\"]' WHERE mission_id = ? AND grant_id = ?")
            .run("mission-a", "grant-corrupt");
        raw.close();
        await first.close();

        const recovered = new SqliteMissionStore(dbPath);
        await recovered.initialize();
        await expect(recovered.listCapabilityGrants("mission-a")).rejects.toThrow(/corrupt.*fingerprint/i);
        await recovered.close();
    });

    it("does not return an orphan as an idempotent replay and cleans up failed recovery", async () => {
        const dbPath = makeDatabasePath();
        const first = new SqliteMissionStore(dbPath);
        await first.initialize();
        insertMission(dbPath, "mission-a");
        const input = makeGrant("grant-orphan");
        await first.appendCapabilityGrant(input);
        const raw = new Database(dbPath);
        raw.exec("PRAGMA foreign_keys = OFF; DROP TRIGGER prevent_mission_delete_with_grants;");
        raw.query("DELETE FROM missions WHERE mission_id = ?").run("mission-a");
        raw.close();

        await expect(first.appendCapabilityGrant(input)).rejects.toThrow(/missing Mission/i);
        await first.close();

        const recovered = new SqliteMissionStore(dbPath);
        await expect(recovered.initialize()).rejects.toThrow(/orphaned rows/i);
        await expect(recovered.listCapabilityGrants("mission-a")).rejects.toThrow(/not initialized/i);
        await expect(recovered.initialize()).rejects.toThrow(/orphaned rows/i);
        await recovered.close();
    });

    it("does not return a revocation replay whose grant target became orphaned", async () => {
        const dbPath = makeDatabasePath();
        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        insertMission(dbPath, "mission-a");
        await store.appendCapabilityGrant(makeGrant("grant-revocation-target"));
        const input = makeRevocation("revoke-orphan", "grant-revocation-target");
        await store.appendCapabilityRevocation(input);
        const raw = new Database(dbPath);
        raw.exec("DROP TRIGGER prevent_mission_capability_grant_delete;");
        raw.query("DELETE FROM mission_capability_grants WHERE mission_id = ? AND grant_id = ?")
            .run("mission-a", "grant-revocation-target");
        raw.close();

        await expect(store.appendCapabilityRevocation(input)).rejects.toThrow(/missing grant/i);
        await expect(store.listCapabilityRevocations("mission-a")).rejects.toThrow(/orphan/i);
        await store.close();
    });

    it("rejects secret-bearing provenance and leaves legacy Missions ungranted", async () => {
        const dbPath = makeDatabasePath();
        const store = new SqliteMissionStore(dbPath);
        await store.initialize();
        insertMission(dbPath, "mission-a");
        await expect(store.appendCapabilityGrant(makeGrant("grant-secret", "mission-a", {
            grantorClientId: "operator token=secret-value",
        }))).rejects.toThrow(/secret/i);
        await expect(store.appendCapabilityGrant(makeGrant("grant-no-mission", "missing-mission")))
            .rejects.toThrow();
        expect(await store.listCapabilityGrants("mission-a")).toEqual([]);
        await store.close();
    });
});
