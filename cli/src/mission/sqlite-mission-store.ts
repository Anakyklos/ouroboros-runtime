/**
 * 💾 SQLite Mission Store (Issue #62)
 *
 * Minimal durable persistence for the Mission contract and its current
 * plan revision. Reuses the approved local persistence primitive already
 * in the repository (`bun:sqlite`, same as `cli/src/adapters/budget-tracker.ts`),
 * with WAL mode and prepared statements.
 *
 * Scope discipline: this store persists the Mission contract and the complete
 * sanitized invocation records needed by issue #50 recovery queries. It does
 * not own scheduler behavior, provider state, or private module state.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
    Mission,
    PlanRevision,
    PlanRevisionStatus,
    CapabilityInvocation,
    CapabilityInvocationRef,
    MissionState,
} from "./contracts.js";
import {
    assertValidInvocationIdentity,
    computeEffectFingerprint,
    EffectClass,
    isInvocationUpdateAllowed,
    isInvocationTerminal,
} from "./contracts.js";
import {
    CancellationSupport,
    IdempotencyMode,
    ReconciliationSupport,
    RetryBackoff,
} from "../capabilities/contracts.js";
import type { MissionStore } from "./ports.js";
import { assertNoRawSecrets } from "./sanitize.js";

interface MissionRow {
    mission_id: string;
    schema_version: number;
    source: string;
    sanitized_original_intent: string;
    original_intent_ref: string;
    interpreted_objective: string;
    constraints: string;
    acceptance_criteria: string;
    budget_policy: string;
    allowed_capability_scope: string;
    approval_requirements: string;
    context_refs: string;
    state: string;
    current_plan_revision_id: string | null;
    evidence_refs: string;
    criterion_verifications: string;
    unresolved_questions: string;
    created_at: string;
    updated_at: string;
    recovery_metadata: string;
    pause_metadata: string | null;
}

interface PlanRevisionRow {
    revision_id: string;
    mission_id: string;
    revision_number: number;
    plan_id: string;
    steps: string;
    status: string;
    reason: string;
    accepted_at: string | null;
    replaces_revision_id: string | null;
    rejection_reason: string | null;
    created_at: string;
}

interface InvocationRow {
    invocation_id: string;
    mission_id: string;
    step_id: string;
    capability_id: string;
    plan_revision_id: string | null;
    contract_version: number | null;
    module_owner: string | null;
    effect_class: string | null;
    request_id: string | null;
    effect_fingerprint: string | null;
    input_refs: string | null;
    idempotency: string | null;
    retry: string | null;
    attempts: string | null;
    delivery: string | null;
    cancellation: string | null;
    reconciliation: string | null;
    owner_verification_state: string | null;
    status: string;
    dispatched_at: string | null;
    completed_at: string | null;
    result_refs: string;
    owner_verification: string | null;
    error: string | null;
    created_at: string | null;
    updated_at: string | null;
}

/** Safe JSON parse that never throws. */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
    if (raw === null || raw === undefined) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

const LEGACY_EPOCH = "1970-01-01T00:00:00.000Z";

function uniqueByRef<T extends { refId: string }>(refs: T[]): T[] {
    const seen = new Set<string>();
    return refs.filter((ref) => {
        if (seen.has(ref.refId)) return false;
        seen.add(ref.refId);
        return true;
    });
}

function defaultRetry(): CapabilityInvocation["retry"] {
    return {
        maxAttempts: 0,
        attempt: 0,
        backoff: RetryBackoff.NONE,
        backoffMs: 0,
        nextEligibleAt: null,
    };
}

function assertImmutableInvocationIdentity(
    current: CapabilityInvocation,
    next: CapabilityInvocation,
): void {
    const fields: Array<keyof CapabilityInvocation> = [
        "missionId",
        "stepId",
        "capabilityId",
        "planRevisionId",
        "contractVersion",
        "moduleOwner",
        "effectClass",
        "requestId",
        "effectFingerprint",
        "inputRefs",
        "createdAt",
    ];
    for (const field of fields) {
        if (JSON.stringify(current[field]) !== JSON.stringify(next[field])) {
            throw new Error(`Invocation ${current.invocationId} identity field "${field}" is immutable`);
        }
    }
    if (
        current.idempotency.mode !== next.idempotency.mode
        || current.idempotency.key !== next.idempotency.key
        || current.retry.maxAttempts !== next.retry.maxAttempts
        || current.retry.backoff !== next.retry.backoff
        || current.cancellation.support !== next.cancellation.support
        || current.reconciliation.support !== next.reconciliation.support
    ) {
        throw new Error(`Invocation ${current.invocationId} execution semantics are immutable`);
    }
}

export class SqliteMissionStore implements MissionStore {
    private db: Database | null = null;
    private readonly dbPath: string;
    private readonly statements: Record<string, ReturnType<Database["prepare"]>> = {};
    private transactionQueue: Promise<void> = Promise.resolve();

    constructor(dbPath: string = ".ouroboros/missions.db") {
        this.dbPath = dbPath;
    }

    private ensureDb(): Database {
        if (!this.db) {
            throw new Error("MissionStore not initialized. Call initialize() first.");
        }
        return this.db;
    }

    private stmt(key: string, sql: string): ReturnType<Database["prepare"]> {
        const db = this.ensureDb();
        if (!this.statements[key]) {
            this.statements[key] = db.prepare(sql);
        }
        return this.statements[key];
    }

    async initialize(): Promise<void> {
        if (this.db) return;
        this.db = new Database(this.dbPath);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS missions (
                mission_id TEXT PRIMARY KEY,
                schema_version INTEGER NOT NULL,
                source TEXT NOT NULL,
                sanitized_original_intent TEXT NOT NULL,
                original_intent_ref TEXT NOT NULL,
                interpreted_objective TEXT NOT NULL,
                constraints TEXT NOT NULL DEFAULT '[]',
                acceptance_criteria TEXT NOT NULL DEFAULT '[]',
                budget_policy TEXT NOT NULL DEFAULT '{}',
                allowed_capability_scope TEXT NOT NULL DEFAULT '{}',
                approval_requirements TEXT NOT NULL DEFAULT '[]',
                context_refs TEXT NOT NULL DEFAULT '[]',
                state TEXT NOT NULL,
                current_plan_revision_id TEXT,
                            evidence_refs TEXT NOT NULL DEFAULT '[]',
                criterion_verifications TEXT NOT NULL DEFAULT '[]',
                unresolved_questions TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                recovery_metadata TEXT NOT NULL DEFAULT '{}',
                pause_metadata TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS mission_plan_revisions (
                revision_id TEXT PRIMARY KEY,
                mission_id TEXT NOT NULL,
                revision_number INTEGER NOT NULL,
                plan_id TEXT NOT NULL,
                steps TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'proposed',
                reason TEXT NOT NULL DEFAULT '',
                accepted_at TEXT,
                replaces_revision_id TEXT,
                rejection_reason TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS mission_invocations (
                invocation_id TEXT PRIMARY KEY,
                mission_id TEXT NOT NULL,
                step_id TEXT NOT NULL,
                capability_id TEXT NOT NULL,
                plan_revision_id TEXT NOT NULL DEFAULT '',
                contract_version INTEGER NOT NULL DEFAULT 0,
                module_owner TEXT NOT NULL DEFAULT '',
                effect_class TEXT NOT NULL DEFAULT '',
                request_id TEXT NOT NULL DEFAULT '',
                effect_fingerprint TEXT NOT NULL DEFAULT '',
                input_refs TEXT NOT NULL DEFAULT '[]',
                idempotency TEXT NOT NULL DEFAULT '{"mode":"unknown"}',
                retry TEXT NOT NULL DEFAULT '{"maxAttempts":0,"attempt":0,"backoff":"none","backoffMs":0,"nextEligibleAt":null}',
                attempts TEXT NOT NULL DEFAULT '[]',
                delivery TEXT NOT NULL DEFAULT '{"state":"not_submitted"}',
                cancellation TEXT NOT NULL DEFAULT '{"support":"unsupported","requested":false,"state":"not_requested"}',
                reconciliation TEXT NOT NULL DEFAULT '{"support":"none","state":"unsupported"}',
                owner_verification_state TEXT NOT NULL DEFAULT 'pending',
                status TEXT NOT NULL DEFAULT 'pending',
                dispatched_at TEXT,
                completed_at TEXT,
                result_refs TEXT NOT NULL DEFAULT '[]',
                owner_verification TEXT,
                error TEXT,
                created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
                updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
                FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_plan_revisions_mission ON mission_plan_revisions(mission_id);
            CREATE INDEX IF NOT EXISTS idx_plan_revisions_number ON mission_plan_revisions(mission_id, revision_number);
            CREATE INDEX IF NOT EXISTS idx_invocations_mission ON mission_invocations(mission_id);
        `);
        this.migrateSchema();
    }

    /** Add only known columns missing from a pre-#50 database. */
    private migrateSchema(): void {
        const db = this.ensureDb();
        const columns = (table: string): Set<string> => {
            const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
            return new Set(rows.map((row) => row.name));
        };
        // A pre-#50 database has no delivery column. In that schema the
        // legacy logical status `dispatched` already means that a handoff may
        // have happened, even when dispatched_at was never recorded. A
        // current #50 row, however, can be deliberately prepared as
        // `status=dispatched` with `delivery=not_submitted`, so the distinction
        // must be captured before ALTER TABLE adds the default column.
        const hadDeliveryColumn = columns("mission_invocations").has("delivery");
        const addMissing = (
            table: string,
            definitions: Array<[string, string]>,
        ): void => {
            const existing = columns(table);
            for (const [name, definition] of definitions) {
                if (!existing.has(name)) {
                    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
                    existing.add(name);
                }
            }
        };

        addMissing("missions", [["pause_metadata", "TEXT NOT NULL DEFAULT '{}'"]]);
        addMissing("mission_invocations", [
            ["plan_revision_id", "TEXT NOT NULL DEFAULT ''"],
            ["contract_version", "INTEGER NOT NULL DEFAULT 0"],
            ["module_owner", "TEXT NOT NULL DEFAULT ''"],
            ["effect_class", "TEXT NOT NULL DEFAULT ''"],
            ["request_id", "TEXT NOT NULL DEFAULT ''"],
            ["effect_fingerprint", "TEXT NOT NULL DEFAULT ''"],
            ["input_refs", "TEXT NOT NULL DEFAULT '[]'"],
            ["idempotency", "TEXT NOT NULL DEFAULT '{\"mode\":\"unknown\"}'"],
            ["retry", "TEXT NOT NULL DEFAULT '{\"maxAttempts\":0,\"attempt\":0,\"backoff\":\"none\",\"backoffMs\":0,\"nextEligibleAt\":null}'"],
            ["attempts", "TEXT NOT NULL DEFAULT '[]'"],
            ["delivery", "TEXT NOT NULL DEFAULT '{\"state\":\"not_submitted\"}'"],
            ["cancellation", "TEXT NOT NULL DEFAULT '{\"support\":\"unsupported\",\"requested\":false,\"state\":\"not_requested\"}'"],
            ["reconciliation", "TEXT NOT NULL DEFAULT '{\"support\":\"none\",\"state\":\"unsupported\"}'"],
            ["owner_verification_state", "TEXT NOT NULL DEFAULT 'pending'"],
            ["created_at", `TEXT NOT NULL DEFAULT '${LEGACY_EPOCH}'`],
            ["updated_at", `TEXT NOT NULL DEFAULT '${LEGACY_EPOCH}'`],
        ]);

        // A pre-#50 invocation has no effect fingerprint or plan revision
        // identity. A row with an explicit revision id can be rebound only
        // when that id names a historically accepted revision with one
        // unambiguous, structurally valid step. Without that id, the revision
        // active at the persisted dispatch timestamp may be proven by the
        // complete accepted history. The current Mission pointer is
        // deliberately not provenance: it may point at a later revision with
        // different effect semantics. Rows without this proof retain a replay
        // barrier and are never dispatched blindly.
        const legacyRows = db.query(
            `SELECT invocation_id, mission_id, step_id, capability_id, plan_revision_id, dispatched_at
             FROM mission_invocations
             WHERE effect_fingerprint IS NULL OR effect_fingerprint = ''`,
        ).all() as Array<{
            invocation_id: string;
            mission_id: string;
            step_id: string;
            capability_id: string;
            plan_revision_id: string | null;
            dispatched_at: string | null;
        }>;
        const updateLegacyFingerprint = db.query(
            `UPDATE mission_invocations
             SET effect_fingerprint = ?,
                 plan_revision_id = CASE WHEN ? != '' THEN ? ELSE plan_revision_id END,
                 effect_class = CASE WHEN ? != '' THEN ? ELSE effect_class END
             WHERE invocation_id = ?`,
        );

        type LegacyStep = {
            stepId?: unknown;
            capabilityRequirement?: unknown;
            effectClass?: unknown;
            inputRefs?: unknown;
            desiredOutcome?: unknown;
        };
        type LegacyRevision = {
            revision_id: string;
            mission_id: string;
            status: string;
            accepted_at: string | null;
            steps: string | null;
        };
        type LegacyBinding = {
            revision: LegacyRevision;
            step: LegacyStep;
        };
        type LegacyStepMatch =
            | { kind: "none" }
            | { kind: "ambiguous" }
            | { kind: "different_capability"; step: LegacyStep }
            | { kind: "invalid"; step: LegacyStep }
            | { kind: "valid"; step: LegacyStep };
        const acceptedStatuses = new Set(["accepted", "superseded"]);
        const validAcceptedAt = (value: string | null): value is string => (
            typeof value === "string" && Number.isFinite(Date.parse(value))
        );
        const classifyStep = (
            revision: LegacyRevision,
            legacy: {
                step_id: string;
                capability_id: string;
            },
        ): LegacyStepMatch => {
            if (typeof revision.steps !== "string") return { kind: "ambiguous" };
            let parsedSteps: unknown;
            try {
                parsedSteps = JSON.parse(revision.steps);
            } catch {
                return { kind: "ambiguous" };
            }
            if (
                !Array.isArray(parsedSteps)
                || parsedSteps.some((candidate) => (
                    candidate === null || typeof candidate !== "object" || Array.isArray(candidate)
                ))
            ) {
                return { kind: "ambiguous" };
            }
            const steps = parsedSteps as LegacyStep[];
            const matching = steps.filter((candidate) => candidate.stepId === legacy.step_id);
            if (matching.length === 0) return { kind: "none" };
            if (matching.length !== 1) return { kind: "ambiguous" };
            const step = matching[0];
            if (step.capabilityRequirement !== legacy.capability_id) {
                return { kind: "different_capability", step };
            }
            if (
                typeof step.capabilityRequirement !== "string"
                || typeof step.effectClass !== "string"
                || !Object.values(EffectClass).includes(step.effectClass as EffectClass)
                || typeof step.desiredOutcome !== "string"
                || step.desiredOutcome.length === 0
                || !Array.isArray(step.inputRefs)
                || !step.inputRefs.every((ref) => typeof ref === "string")
            ) {
                return { kind: "invalid", step };
            }
            return { kind: "valid", step };
        };
        const directRevision = (revisionId: string): LegacyRevision | null => (
            db.query(
                `SELECT revision_id, mission_id, status, accepted_at, steps
                 FROM mission_plan_revisions
                 WHERE revision_id = ?`,
            ).get(revisionId) as LegacyRevision | null
        );
        const revisionsForMission = (missionId: string): LegacyRevision[] => (
            db.query(
                `SELECT revision_id, mission_id, status, accepted_at, steps
                 FROM mission_plan_revisions
                 WHERE mission_id = ? AND status IN ('accepted', 'superseded')
                 ORDER BY accepted_at ASC, revision_id ASC`,
            ).all(missionId) as LegacyRevision[]
        );

        for (const legacy of legacyRows) {
            const revisionId = typeof legacy.plan_revision_id === "string"
                ? legacy.plan_revision_id.trim()
                : "";
            let binding: LegacyBinding | null = null;
            if (revisionId) {
                // An explicit persisted revision id is the strongest available
                // provenance. Never fall back to another revision if it is
                // missing, rejected, malformed, or structurally ambiguous.
                const revision = directRevision(revisionId);
                const match = revision
                    && revision.mission_id === legacy.mission_id
                    && acceptedStatuses.has(revision.status)
                    && validAcceptedAt(revision.accepted_at)
                    ? classifyStep(revision, legacy)
                    : { kind: "none" as const };
                if (revision && match.kind === "valid") binding = { revision, step: match.step };
            } else {
                const revisions = revisionsForMission(legacy.mission_id);
                const hasInvalidHistory = revisions.some((revision) => !validAcceptedAt(revision.accepted_at));
                const acceptedAtTimes = revisions
                    .map((revision) => validAcceptedAt(revision.accepted_at) ? Date.parse(revision.accepted_at) : null)
                    .filter((time): time is number => time !== null);
                const hasDuplicateAcceptedAt = new Set(acceptedAtTimes).size !== acceptedAtTimes.length;
                // A dispatch timestamp must select the revision that was
                // active at that instant, even when only an older revision
                // contains the step. A superseding revision that removed the
                // step therefore blocks reconstruction instead of permitting
                // the old revision's effect to be rebound after supersession.
                if (
                    !hasInvalidHistory
                    && !hasDuplicateAcceptedAt
                    && typeof legacy.dispatched_at === "string"
                ) {
                    const dispatchedTime = Date.parse(legacy.dispatched_at);
                    if (Number.isFinite(dispatchedTime)) {
                        let active: LegacyRevision | undefined;
                        let activeTime = Number.NEGATIVE_INFINITY;
                        for (const revision of revisions) {
                            const revisionTime = Date.parse(revision.accepted_at as string);
                            if (revisionTime <= dispatchedTime && revisionTime > activeTime) {
                                active = revision;
                                activeTime = revisionTime;
                            }
                        }
                        if (active && acceptedStatuses.has(active.status)) {
                            const match = classifyStep(active, legacy);
                            if (match.kind === "valid") {
                                binding = { revision: active, step: match.step };
                            }
                        }
                    }
                }
            }

            if (binding) {
                const capabilityId = binding.step.capabilityRequirement as string;
                const effectClass = binding.step.effectClass as EffectClass;
                const inputRefs = binding.step.inputRefs as string[];
                const desiredOutcome = binding.step.desiredOutcome as string;
                const effectFingerprint = computeEffectFingerprint({
                    capabilityId,
                    effectClass,
                    inputRefs,
                    outcome: desiredOutcome,
                });
                updateLegacyFingerprint.run(
                    effectFingerprint,
                    binding.revision.revision_id,
                    binding.revision.revision_id,
                    effectClass,
                    effectClass,
                    legacy.invocation_id,
                );
            } else {
                updateLegacyFingerprint.run(
                    `legacy:${legacy.invocation_id}`,
                    "",
                    "",
                    "",
                    "",
                    legacy.invocation_id,
                );
            }
        }

        // Existing dispatched/running rows have an unknown handoff outcome.
        // They must never become due merely because the new retry column is NULL.
        const legacyDispatchedPredicate = hadDeliveryColumn
            ? "(dispatched_at IS NOT NULL OR status = 'running')"
            : "(dispatched_at IS NOT NULL OR status IN ('running', 'dispatched'))";
        db.exec(`
            UPDATE mission_invocations
            SET delivery = '{"state":"uncertain"}'
            WHERE delivery = '{"state":"not_submitted"}'
              AND ${legacyDispatchedPredicate};
            UPDATE mission_invocations
            SET created_at = COALESCE(dispatched_at, completed_at, '${LEGACY_EPOCH}'),
                updated_at = COALESCE(completed_at, dispatched_at, '${LEGACY_EPOCH}')
            WHERE created_at = '${LEGACY_EPOCH}' AND updated_at = '${LEGACY_EPOCH}';
            UPDATE mission_invocations
            SET owner_verification_state = CASE
                WHEN json_valid(owner_verification) AND json_extract(owner_verification, '$.verified') = 1 THEN 'verified'
                WHEN json_valid(owner_verification) AND json_extract(owner_verification, '$.verified') = 0 THEN 'rejected'
                ELSE owner_verification_state
            END
            WHERE owner_verification IS NOT NULL;
        `);
        const duplicate = db.query(
            `SELECT mission_id, effect_fingerprint, COUNT(*) AS count
             FROM mission_invocations
             WHERE effect_fingerprint IS NOT NULL AND effect_fingerprint != ''
             GROUP BY mission_id, effect_fingerprint
             HAVING COUNT(*) > 1`,
        ).all() as Array<{ mission_id: string; effect_fingerprint: string; count: number }>;
        if (duplicate.length > 0) {
            throw new Error(
                `Mission invocation fingerprint migration refused: duplicate local effect claim for mission "${duplicate[0].mission_id}" and fingerprint "${duplicate[0].effect_fingerprint}"`,
            );
        }
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invocations_mission_effect ON mission_invocations(mission_id, effect_fingerprint)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_invocations_effect ON mission_invocations(effect_fingerprint)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_invocations_due ON mission_invocations(status, delivery, updated_at)");
    }

    async close(): Promise<void> {
        this.db?.close();
        this.db = null;
        for (const key of Object.keys(this.statements)) {
            delete this.statements[key];
        }
    }

    // ------------------------------------------------------------------
    // Missions
    // ------------------------------------------------------------------

    async createMission(mission: Mission): Promise<Mission> {
        // Fail-closed durable boundary: the persisted payload must not
        // contain any raw secret pattern. The raw originalIntent is an
        // in-memory value that is NEVER written; only the sanitized snapshot
        // is persisted, so we assert on the persisted projection.
        assertNoRawSecrets(
            { ...mission, originalIntent: mission.sanitizedOriginalIntent },
            "mission",
        );
        this.stmt(
            "createMission",
            `INSERT INTO missions (
                mission_id, schema_version, source, sanitized_original_intent, original_intent_ref, interpreted_objective,
                constraints, acceptance_criteria, budget_policy, allowed_capability_scope,
                approval_requirements, context_refs, state, current_plan_revision_id,
                evidence_refs, criterion_verifications, unresolved_questions, created_at, updated_at,
                recovery_metadata, pause_metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(mission_id) DO UPDATE SET
                schema_version = excluded.schema_version,
                source = excluded.source,
                sanitized_original_intent = excluded.sanitized_original_intent,
                original_intent_ref = excluded.original_intent_ref,
                interpreted_objective = excluded.interpreted_objective,
                constraints = excluded.constraints,
                acceptance_criteria = excluded.acceptance_criteria,
                budget_policy = excluded.budget_policy,
                allowed_capability_scope = excluded.allowed_capability_scope,
                approval_requirements = excluded.approval_requirements,
                context_refs = excluded.context_refs,
                state = excluded.state,
                current_plan_revision_id = excluded.current_plan_revision_id,
                evidence_refs = excluded.evidence_refs,
                criterion_verifications = excluded.criterion_verifications,
                unresolved_questions = excluded.unresolved_questions,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                recovery_metadata = excluded.recovery_metadata,
                pause_metadata = excluded.pause_metadata`,
        ).run(
            mission.missionId,
            mission.schemaVersion,
            mission.source,
            mission.sanitizedOriginalIntent,
            mission.originalIntentRef,
            mission.interpretedObjective,
            JSON.stringify(mission.constraints),
            JSON.stringify(mission.acceptanceCriteria),
            JSON.stringify(mission.budgetPolicy),
            JSON.stringify(mission.allowedCapabilityScope),
            JSON.stringify(mission.approvalRequirements),
            JSON.stringify(mission.contextRefs),
            mission.state,
            mission.currentPlanRevisionId,
            JSON.stringify(mission.evidenceRefs),
            JSON.stringify(mission.criterionVerifications),
            JSON.stringify(mission.unresolvedQuestions),
            mission.createdAt,
            mission.updatedAt,
            JSON.stringify(mission.recoveryMetadata),
            JSON.stringify(mission.pauseMetadata ?? {}),
        );
        return mission;
    }

    async getMission(missionId: string): Promise<Mission | null> {
        const row = this.stmt(
            "getMission",
            "SELECT * FROM missions WHERE mission_id = ?",
        ).get(missionId) as MissionRow | null;
        if (!row) return null;
        const invocations = this.listInvocationRows(missionId);
        return this.rowToMission(row, invocations);
    }

    async updateMission(missionId: string, updates: Partial<Mission>): Promise<void> {
        const current = await this.getMission(missionId);
        if (!current) {
            throw new Error(`Mission not found: ${missionId}`);
        }
        const merged: Mission = { ...current, ...updates, missionId };
        // Always refresh updatedAt.
        merged.updatedAt = updates.updatedAt ?? new Date().toISOString();
        await this.createMission(merged);
    }

    async listMissions(filter?: { state?: MissionState }): Promise<Mission[]> {
        let rows: MissionRow[];
        if (filter?.state) {
            rows = this.stmt(
                "listMissionsByState",
                "SELECT * FROM missions WHERE state = ? ORDER BY created_at DESC",
            ).all(filter.state) as unknown as MissionRow[];
        } else {
            rows = this.stmt(
                "listMissionsAll",
                "SELECT * FROM missions ORDER BY created_at DESC",
            ).all() as unknown as MissionRow[];
        }
        // Batch-load all invocations to avoid N+1.
        if (rows.length === 0) return [];
        const allInvocations = this.stmt(
            "listAllInvocations",
            "SELECT * FROM mission_invocations ORDER BY mission_id, rowid ASC",
        ).all() as unknown as InvocationRow[];
        const byMission = new Map<string, InvocationRow[]>();
        for (const inv of allInvocations) {
            const list = byMission.get(inv.mission_id);
            if (list) list.push(inv);
            else byMission.set(inv.mission_id, [inv]);
        }
        return rows.map((row) => this.rowToMission(row, byMission.get(row.mission_id) ?? []));
    }

    async deleteMission(missionId: string): Promise<void> {
        this.stmt("deleteMission", "DELETE FROM missions WHERE mission_id = ?").run(missionId);
    }

    // ------------------------------------------------------------------
    // Plan revisions
    // ------------------------------------------------------------------

    async savePlanRevision(revision: PlanRevision): Promise<PlanRevision> {
        // Fail-closed durable boundary: any persisted string (including IDs
        // and refs) containing a raw secret pattern is rejected.
        assertNoRawSecrets(revision, "plan_revision");
        this.stmt(
            "savePlanRevision",
            `INSERT INTO mission_plan_revisions (
                revision_id, mission_id, revision_number, plan_id, steps, status,
                reason, accepted_at, replaces_revision_id, rejection_reason, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            revision.revisionId,
            revision.missionId,
            revision.revisionNumber,
            revision.planId,
            JSON.stringify(revision.steps),
            revision.status,
            revision.reason,
            revision.acceptedAt ?? null,
            revision.replacesRevisionId ?? null,
            revision.rejectionReason ?? null,
            revision.createdAt,
        );
        return revision;
    }

    async getPlanRevision(revisionId: string): Promise<PlanRevision | null> {
        const row = this.stmt(
            "getPlanRevision",
            "SELECT * FROM mission_plan_revisions WHERE revision_id = ?",
        ).get(revisionId) as PlanRevisionRow | null;
        return row ? this.rowToRevision(row) : null;
    }

    async getPlanRevisions(missionId: string): Promise<PlanRevision[]> {
        const rows = this.stmt(
            "getPlanRevisions",
            "SELECT * FROM mission_plan_revisions WHERE mission_id = ? ORDER BY revision_number ASC",
        ).all(missionId) as unknown as PlanRevisionRow[];
        return rows.map((row) => this.rowToRevision(row));
    }

    async updatePlanRevisionStatus(
        revisionId: string,
        status: PlanRevisionStatus,
        reason?: string,
    ): Promise<void> {
        const revision = await this.getPlanRevision(revisionId);
        if (!revision) {
            throw new Error(`Plan revision not found: ${revisionId}`);
        }
        // Fail-closed durable boundary for the rejection reason string.
        if (reason !== undefined) {
            assertNoRawSecrets({ reason }, "plan_revision_status");
        }
        this.stmt(
            "updatePlanRevisionStatus",
            `UPDATE mission_plan_revisions
             SET status = ?, accepted_at = ?, rejection_reason = ?
             WHERE revision_id = ?`,
        ).run(
            status,
            status === "accepted" ? new Date().toISOString() : null,
            status === "rejected" ? (reason ?? null) : null,
            revisionId,
        );
    }

    // ------------------------------------------------------------------
    // Invocation references
    // ------------------------------------------------------------------

    async saveInvocation(invocation: CapabilityInvocation | CapabilityInvocationRef): Promise<CapabilityInvocationRef> {
        assertNoRawSecrets(invocation, "invocation");
        const isFull = "planRevisionId" in invocation;
        const normalized = this.normalizeInvocation(invocation);
        assertValidInvocationIdentity(normalized);
        const current = await this.getInvocation(normalized.invocationId);
        if (current && isInvocationTerminal(current)) {
            return this.toInvocationRef(current);
        }
        if (current && !isFull) {
            // A legacy reference is a projection, not authority over the
            // canonical full identity. Reject a stale/cross-mission
            // projection instead of allowing it to retarget the durable row.
            for (const field of ["missionId", "stepId", "capabilityId"] as const) {
                if (current[field] !== normalized[field]) {
                    throw new Error(`Invocation ${normalized.invocationId} identity field "${field}" is immutable`);
                }
            }
        }
        if (current && isFull) {
            assertImmutableInvocationIdentity(current, normalized);
            if (!isInvocationUpdateAllowed(current, normalized)) {
                throw new Error(
                    `Invocation ${normalized.invocationId} cannot transition from ${current.status} to ${normalized.status}`,
                );
            }
        }
        const effective = current
            ? {
                  ...(isFull ? normalized : current),
                  ...(!isFull
                      ? {
                            status: normalized.status,
                            dispatchedAt: normalized.dispatchedAt,
                            completedAt: normalized.completedAt,
                            ownerVerification: normalized.ownerVerification,
                            error: normalized.error,
                        }
                      : {}),
                  resultRefs: uniqueByRef([
                      ...current.resultRefs,
                      ...normalized.resultRefs,
                  ]),
                  updatedAt: isFull ? normalized.updatedAt : current.updatedAt,
              }
            : normalized;

        this.stmt(
            "saveInvocation",
            `INSERT INTO mission_invocations (
                invocation_id, mission_id, step_id, capability_id, plan_revision_id,
                contract_version, module_owner, effect_class, request_id, effect_fingerprint, input_refs,
                idempotency, retry, attempts, delivery, cancellation, reconciliation,
                owner_verification_state, status, dispatched_at, completed_at, result_refs,
                owner_verification, error, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(invocation_id) DO UPDATE SET
                mission_id = excluded.mission_id,
                step_id = excluded.step_id,
                capability_id = excluded.capability_id,
                plan_revision_id = excluded.plan_revision_id,
                contract_version = excluded.contract_version,
                module_owner = excluded.module_owner,
                effect_class = excluded.effect_class,
                request_id = excluded.request_id,
                effect_fingerprint = excluded.effect_fingerprint,
                input_refs = excluded.input_refs,
                idempotency = excluded.idempotency,
                retry = excluded.retry,
                attempts = excluded.attempts,
                delivery = excluded.delivery,
                cancellation = excluded.cancellation,
                reconciliation = excluded.reconciliation,
                owner_verification_state = excluded.owner_verification_state,
                status = excluded.status,
                dispatched_at = excluded.dispatched_at,
                completed_at = excluded.completed_at,
                result_refs = excluded.result_refs,
                owner_verification = excluded.owner_verification,
                error = excluded.error,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at`,
        ).run(
            effective.invocationId,
            effective.missionId,
            effective.stepId,
            effective.capabilityId,
            effective.planRevisionId,
            effective.contractVersion,
            effective.moduleOwner,
            effective.effectClass ?? "",
            effective.requestId,
            effective.effectFingerprint,
            JSON.stringify(effective.inputRefs),
            JSON.stringify(effective.idempotency),
            JSON.stringify(effective.retry),
            JSON.stringify(effective.attempts),
            JSON.stringify(effective.delivery),
            JSON.stringify(effective.cancellation),
            JSON.stringify(effective.reconciliation),
            effective.ownerVerificationState,
            effective.status,
            effective.dispatchedAt ?? null,
            effective.completedAt ?? null,
            JSON.stringify(effective.resultRefs),
            effective.ownerVerification ? JSON.stringify(effective.ownerVerification) : null,
            effective.error ?? null,
            effective.createdAt,
            effective.updatedAt,
        );
        return this.toInvocationRef(effective);
    }

    async getInvocation(invocationId: string): Promise<CapabilityInvocation | null> {
        const row = this.stmt(
            "getInvocation",
            "SELECT * FROM mission_invocations WHERE invocation_id = ?",
        ).get(invocationId) as InvocationRow | null;
        return row ? this.rowToInvocation(row) : null;
    }

    /** Sync helper used by getMission and listMissions. */
    private listInvocationRows(missionId: string): InvocationRow[] {
        return this.stmt(
            "listInvocations",
            "SELECT * FROM mission_invocations WHERE mission_id = ? ORDER BY rowid ASC",
        ).all(missionId) as unknown as InvocationRow[];
    }

    async listInvocations(missionId: string): Promise<CapabilityInvocation[]> {
        return this.listInvocationRows(missionId).map((row) => this.rowToInvocation(row));
    }

    async updateInvocation(
        invocationId: string,
        updates: Partial<CapabilityInvocation> | Partial<CapabilityInvocationRef>,
    ): Promise<void> {
        const current = await this.getInvocation(invocationId);
        if (!current) {
            throw new Error(`Invocation not found: ${invocationId}`);
        }
        const merged: CapabilityInvocation = {
            ...current,
            ...updates,
            invocationId,
            resultRefs: updates.resultRefs ?? current.resultRefs,
        };
        await this.saveInvocation(merged);
    }

    async listNonTerminalInvocations(limit: number): Promise<CapabilityInvocation[]> {
        if (!Number.isSafeInteger(limit) || limit <= 0) return [];
        const rows = this.stmt(
            "listNonTerminalInvocations",
            `SELECT * FROM mission_invocations
             WHERE status NOT IN ('completed', 'cancelled')
             ORDER BY created_at ASC, invocation_id ASC
             LIMIT ?`,
        ).all(limit) as unknown as InvocationRow[];
        return rows.map((row) => this.rowToInvocation(row));
    }

    async listActionableInvocations(limit: number): Promise<CapabilityInvocation[]> {
        if (!Number.isSafeInteger(limit) || limit <= 0) return [];
        const rows = this.stmt(
            "listActionableInvocations",
            `SELECT * FROM mission_invocations
             WHERE status NOT IN ('completed', 'cancelled')
               AND (
                    (
                        COALESCE(json_extract(cancellation, '$.requested'), 0) = 1
                        AND COALESCE(json_extract(cancellation, '$.state'), '') = 'requested'
                        AND json_extract(delivery, '$.state') != 'not_submitted'
                    )
                    OR (
                        json_extract(delivery, '$.state') != 'not_submitted'
                        AND json_extract(reconciliation, '$.state') = 'pending'
                    )
               )
             ORDER BY
                CASE WHEN COALESCE(json_extract(cancellation, '$.requested'), 0) = 1 THEN 0 ELSE 1 END,
                updated_at ASC,
                created_at ASC,
                invocation_id ASC
             LIMIT ?`,
        ).all(limit) as unknown as InvocationRow[];
        return rows.map((row) => this.rowToInvocation(row));
    }

    async listRecoverableInvocations(limit: number): Promise<CapabilityInvocation[]> {
        if (!Number.isSafeInteger(limit) || limit <= 0) return [];
        const rows = this.stmt(
            "listRecoverableInvocations",
            `SELECT * FROM mission_invocations
             WHERE status IN ('pending', 'failed', 'blocked')
               AND status NOT IN ('completed', 'cancelled')
               AND NOT (status = 'pending' AND dispatched_at IS NULL
                        AND json_extract(retry, '$.attempt') = 0
                        AND json_extract(delivery, '$.state') = 'not_submitted'
                        AND json_extract(retry, '$.nextEligibleAt') IS NULL)
               AND json_extract(delivery, '$.state') != 'uncertain'
               AND json_extract(reconciliation, '$.state') NOT IN ('pending', 'unsupported')
             ORDER BY created_at ASC, invocation_id ASC
             LIMIT ?`,
        ).all(limit) as unknown as InvocationRow[];
        return rows.map((row) => this.rowToInvocation(row));
    }

    async listDueInvocations(now: string, limit: number): Promise<CapabilityInvocation[]> {
        if (!Number.isSafeInteger(limit) || limit <= 0) return [];
        const rows = this.stmt(
            "listDueInvocations",
            `SELECT * FROM mission_invocations
             WHERE status IN ('pending', 'dispatched', 'failed')
               AND status NOT IN ('completed', 'cancelled')
               AND json_extract(delivery, '$.state') IN ('not_submitted', 'failed')
               AND COALESCE(json_extract(cancellation, '$.requested'), 0) = 0
               AND json_extract(reconciliation, '$.state') NOT IN ('pending', 'unsupported')
               AND (json_extract(retry, '$.nextEligibleAt') IS NULL
                    OR json_extract(retry, '$.nextEligibleAt') <= ?)
             ORDER BY
                CASE WHEN json_extract(retry, '$.nextEligibleAt') IS NULL THEN 0 ELSE 1 END ASC,
                json_extract(retry, '$.nextEligibleAt') ASC,
                created_at ASC,
                invocation_id ASC
             LIMIT ?`,
        ).all(now, limit) as unknown as InvocationRow[];
        return rows.map((row) => this.rowToInvocation(row));
    }

    async getNextInvocationWakeAt(now: string): Promise<string | null> {
        const row = this.stmt(
            "getNextInvocationWakeAt",
            `SELECT MIN(json_extract(retry, '$.nextEligibleAt')) AS next_eligible_at
             FROM mission_invocations
             WHERE status IN ('pending', 'dispatched', 'failed')
               AND status NOT IN ('completed', 'cancelled')
               AND json_extract(delivery, '$.state') IN ('not_submitted', 'failed')
               AND COALESCE(json_extract(cancellation, '$.requested'), 0) = 0
               AND json_extract(reconciliation, '$.state') NOT IN ('pending', 'unsupported')
               AND json_extract(retry, '$.nextEligibleAt') IS NOT NULL
               AND json_extract(retry, '$.nextEligibleAt') > ?`,
        ).get(now) as { next_eligible_at: string | null } | null;
        return row?.next_eligible_at ?? null;
    }

    async claimInvocation(invocation: CapabilityInvocation): Promise<boolean> {
        assertNoRawSecrets(invocation, "invocation");
        const normalized = this.normalizeInvocation(invocation);
        assertValidInvocationIdentity(normalized);
        try {
            this.stmt(
                "claimInvocation",
                `INSERT INTO mission_invocations (
                    invocation_id, mission_id, step_id, capability_id, plan_revision_id,
                    contract_version, module_owner, effect_class, request_id, effect_fingerprint, input_refs,
                    idempotency, retry, attempts, delivery, cancellation, reconciliation,
                    owner_verification_state, status, dispatched_at, completed_at, result_refs,
                    owner_verification, error, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ).run(
                normalized.invocationId,
                normalized.missionId,
                normalized.stepId,
                normalized.capabilityId,
                normalized.planRevisionId,
                normalized.contractVersion,
                normalized.moduleOwner,
                normalized.effectClass ?? "",
                normalized.requestId,
                normalized.effectFingerprint,
                JSON.stringify(normalized.inputRefs),
                JSON.stringify(normalized.idempotency),
                JSON.stringify(normalized.retry),
                JSON.stringify(normalized.attempts),
                JSON.stringify(normalized.delivery),
                JSON.stringify(normalized.cancellation),
                JSON.stringify(normalized.reconciliation),
                normalized.ownerVerificationState,
                normalized.status,
                normalized.dispatchedAt ?? null,
                normalized.completedAt ?? null,
                JSON.stringify(normalized.resultRefs),
                normalized.ownerVerification ? JSON.stringify(normalized.ownerVerification) : null,
                normalized.error ?? null,
                normalized.createdAt,
                normalized.updatedAt,
            );
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("UNIQUE constraint failed: mission_invocations.mission_id, mission_invocations.effect_fingerprint")) {
                return false;
            }
            throw error;
        }
    }

    async findInvocationByEffectFingerprint(
        missionId: string,
        effectFingerprint: string,
    ): Promise<CapabilityInvocation | null> {
        const row = this.stmt(
            "findInvocationByEffectFingerprint",
            `SELECT * FROM mission_invocations
             WHERE mission_id = ? AND effect_fingerprint = ?
             ORDER BY CASE WHEN status = 'completed' THEN 0 ELSE 1 END,
                      created_at ASC, invocation_id ASC
             LIMIT 1`,
        ).get(missionId, effectFingerprint) as InvocationRow | null;
        return row ? this.rowToInvocation(row) : null;
    }

    // ------------------------------------------------------------------
    // Row mappers
    // ------------------------------------------------------------------

    private rowToMission(row: MissionRow, invocations: InvocationRow[] = []): Mission {
        return {
            missionId: row.mission_id,
            schemaVersion: row.schema_version,
            source: row.source as Mission["source"],
            // The persisted sanitized snapshot + immutable ref are what
            // survive; the raw original intent is never written to storage.
            originalIntent: row.sanitized_original_intent,
            sanitizedOriginalIntent: row.sanitized_original_intent,
            originalIntentRef: row.original_intent_ref,
            interpretedObjective: row.interpreted_objective,
            constraints: parseJson<string[]>(row.constraints, []),
            acceptanceCriteria: parseJson<string[]>(row.acceptance_criteria, []),
            budgetPolicy: parseJson(row.budget_policy, {}),
            allowedCapabilityScope: parseJson(row.allowed_capability_scope, {
                capabilityIds: [],
                allowedEffectClasses: [],
                allowedRefPrefixes: [],
            }),
            approvalRequirements: parseJson(row.approval_requirements, []),
            contextRefs: parseJson(row.context_refs, []),
            state: row.state as MissionState,
            currentPlanRevisionId: row.current_plan_revision_id,
            // Invocation refs are derived from the canonical mission_invocations table.
            invocationRefs: invocations.map((i) => this.toInvocationRef(this.rowToInvocation(i))),
            evidenceRefs: parseJson(row.evidence_refs, []),
            criterionVerifications: parseJson(row.criterion_verifications, []),
            unresolvedQuestions: parseJson(row.unresolved_questions, []),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            recoveryMetadata: parseJson(row.recovery_metadata, {
                recovered: false,
                recoveryCount: 0,
            }),
            pauseMetadata: (() => {
                const metadata = parseJson<Record<string, unknown>>(row.pause_metadata, {});
                return Object.keys(metadata).length > 0
                    ? metadata as unknown as Mission["pauseMetadata"]
                    : undefined;
            })(),
        };
    }

    private rowToRevision(row: PlanRevisionRow): PlanRevision {
        return {
            revisionId: row.revision_id,
            missionId: row.mission_id,
            revisionNumber: row.revision_number,
            planId: row.plan_id,
            steps: parseJson(row.steps, []),
            status: row.status as PlanRevisionStatus,
            reason: row.reason,
            acceptedAt: row.accepted_at ?? undefined,
            replacesRevisionId: row.replaces_revision_id ?? undefined,
            rejectionReason: row.rejection_reason ?? undefined,
            createdAt: row.created_at,
        };
    }

    private normalizeInvocation(
        invocation: CapabilityInvocation | CapabilityInvocationRef,
    ): CapabilityInvocation {
        if ("planRevisionId" in invocation) {
            return {
                ...invocation,
                inputRefs: [...invocation.inputRefs],
                attempts: [...invocation.attempts],
                resultRefs: uniqueByRef([...invocation.resultRefs]),
            };
        }
        const timestamp = invocation.dispatchedAt ?? invocation.completedAt ?? LEGACY_EPOCH;
        return {
            ...invocation,
            planRevisionId: "",
            contractVersion: 0,
            moduleOwner: "",
            effectClass: undefined,
            requestId: `legacy:${invocation.invocationId}`,
            effectFingerprint: `legacy:${invocation.invocationId}`,
            inputRefs: [],
            idempotency: { mode: IdempotencyMode.UNKNOWN },
            retry: defaultRetry(),
            attempts: [],
            delivery: { state: invocation.dispatchedAt ? "uncertain" : "not_submitted" },
            cancellation: {
                support: CancellationSupport.UNSUPPORTED,
                requested: false,
                state: "not_requested",
            },
            reconciliation: {
                support: ReconciliationSupport.NONE,
                state: "unsupported",
            },
            ownerVerificationState: invocation.ownerVerification
                ? invocation.ownerVerification.verified ? "verified" : "rejected"
                : "pending",
            resultRefs: uniqueByRef([...invocation.resultRefs]),
            createdAt: timestamp,
            updatedAt: timestamp,
        };
    }

    private rowToInvocation(row: InvocationRow): CapabilityInvocation {
        const ownerVerification = row.owner_verification
            ? parseJson<CapabilityInvocation["ownerVerification"]>(row.owner_verification, undefined)
            : undefined;
        const delivery = parseJson<CapabilityInvocation["delivery"]>(
            row.delivery,
            { state: row.dispatched_at ? "uncertain" : "not_submitted" },
        );
        const retry = parseJson<CapabilityInvocation["retry"]>(row.retry, defaultRetry());
        const timestamp = row.created_at ?? row.dispatched_at ?? row.completed_at ?? LEGACY_EPOCH;
        return {
            invocationId: row.invocation_id,
            missionId: row.mission_id,
            stepId: row.step_id,
            capabilityId: row.capability_id,
            planRevisionId: row.plan_revision_id ?? "",
            contractVersion: row.contract_version ?? 0,
            moduleOwner: row.module_owner ?? "",
            effectClass: row.effect_class ? row.effect_class as CapabilityInvocation["effectClass"] : undefined,
            requestId: row.request_id || `legacy:${row.invocation_id}`,
            effectFingerprint: row.effect_fingerprint || `legacy:${row.invocation_id}`,
            inputRefs: parseJson<string[]>(row.input_refs, []),
            idempotency: parseJson(row.idempotency, { mode: IdempotencyMode.UNKNOWN }),
            retry,
            attempts: parseJson(row.attempts, []),
            delivery,
            cancellation: parseJson(row.cancellation, {
                support: CancellationSupport.UNSUPPORTED,
                requested: false,
                state: "not_requested",
            }),
            reconciliation: parseJson(row.reconciliation, {
                support: ReconciliationSupport.NONE,
                state: "unsupported",
            }),
            ownerVerificationState: (row.owner_verification_state
                ?? (ownerVerification ? ownerVerification.verified ? "verified" : "rejected" : "pending")) as CapabilityInvocation["ownerVerificationState"],
            status: row.status as CapabilityInvocationRef["status"],
            dispatchedAt: row.dispatched_at ?? undefined,
            completedAt: row.completed_at ?? undefined,
            resultRefs: uniqueByRef(parseJson(row.result_refs, [])),
            ownerVerification,
            error: row.error ?? undefined,
            createdAt: timestamp,
            updatedAt: row.updated_at ?? row.completed_at ?? row.dispatched_at ?? timestamp,
        };
    }

    private toInvocationRef(invocation: CapabilityInvocation | CapabilityInvocationRef): CapabilityInvocationRef {
        return {
            invocationId: invocation.invocationId,
            missionId: invocation.missionId,
            stepId: invocation.stepId,
            capabilityId: invocation.capabilityId,
            status: invocation.status,
            dispatchedAt: invocation.dispatchedAt,
            completedAt: invocation.completedAt,
            resultRefs: invocation.resultRefs,
            ownerVerification: invocation.ownerVerification,
            error: invocation.error,
        };
    }

    /** Execute a function inside a BEGIN/COMMIT transaction. */
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
        const db = this.ensureDb();
        const previous = this.transactionQueue;
        let release!: () => void;
        this.transactionQueue = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        db.exec("BEGIN");
        try {
            const result = await fn();
            db.exec("COMMIT");
            return result;
        } catch (e) {
            db.exec("ROLLBACK");
            throw e;
        } finally {
            release();
        }
    }

    /** Close and (for tests) reopen to simulate restart. */
    async reopen(): Promise<void> {
        await this.close();
        await this.initialize();
    }
}

/** Convenience factory with a fresh id generator. */
export function createMissionStore(dbPath?: string): SqliteMissionStore {
    return new SqliteMissionStore(dbPath);
}

/** Generate a stable id (exported for deterministic tests). */
export function generateId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
}
