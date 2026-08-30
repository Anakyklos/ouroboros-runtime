/**
 * 💾 SQLite Mission Store (Issue #62)
 *
 * Minimal durable persistence for the Mission contract and its current
 * plan revision. Reuses the approved local persistence primitive already
 * in the repository (`bun:sqlite`, same as `cli/src/adapters/budget-tracker.ts`),
 * with WAL mode and prepared statements.
 *
 * Scope discipline: this store persists ONLY the Mission contract —
 * no scheduler state, no provider state, no private module state.
 * Durable scheduler (#50), reconciliation, cooldowns and retry engines
 * are explicitly NOT implemented here.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
    Mission,
    PlanRevision,
    PlanRevisionStatus,
    CapabilityInvocationRef,
    MissionState,
} from "./contracts.js";
import type { MissionStore } from "./ports.js";

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
    status: string;
    dispatched_at: string | null;
    completed_at: string | null;
    result_refs: string;
    owner_verification: string | null;
    error: string | null;
}

/** Safe JSON parse that never throws. */
function parseJson<T>(raw: string, fallback: T): T {
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

export class SqliteMissionStore implements MissionStore {
    private db: Database | null = null;
    private readonly dbPath: string;
    private readonly statements: Record<string, ReturnType<Database["prepare"]>> = {};

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
                recovery_metadata TEXT NOT NULL DEFAULT '{}'
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
                status TEXT NOT NULL DEFAULT 'pending',
                dispatched_at TEXT,
                completed_at TEXT,
                result_refs TEXT NOT NULL DEFAULT '[]',
                owner_verification TEXT,
                error TEXT,
                FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_plan_revisions_mission ON mission_plan_revisions(mission_id);
            CREATE INDEX IF NOT EXISTS idx_plan_revisions_number ON mission_plan_revisions(mission_id, revision_number);
            CREATE INDEX IF NOT EXISTS idx_invocations_mission ON mission_invocations(mission_id);
        `);
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
        this.stmt(
            "createMission",
            `INSERT INTO missions (
                mission_id, schema_version, source, sanitized_original_intent, original_intent_ref, interpreted_objective,
                constraints, acceptance_criteria, budget_policy, allowed_capability_scope,
                approval_requirements, context_refs, state, current_plan_revision_id,
                evidence_refs, criterion_verifications, unresolved_questions, created_at, updated_at,
                recovery_metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                recovery_metadata = excluded.recovery_metadata`,
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

    async saveInvocation(invocation: CapabilityInvocationRef): Promise<CapabilityInvocationRef> {
        this.stmt(
            "saveInvocation",
            `INSERT INTO mission_invocations (
                invocation_id, mission_id, step_id, capability_id, status,
                dispatched_at, completed_at, result_refs, owner_verification, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(invocation_id) DO UPDATE SET
                mission_id = excluded.mission_id,
                step_id = excluded.step_id,
                capability_id = excluded.capability_id,
                status = excluded.status,
                dispatched_at = excluded.dispatched_at,
                completed_at = excluded.completed_at,
                result_refs = excluded.result_refs,
                owner_verification = excluded.owner_verification,
                error = excluded.error`,
        ).run(
            invocation.invocationId,
            invocation.missionId,
            invocation.stepId,
            invocation.capabilityId,
            invocation.status,
            invocation.dispatchedAt ?? null,
            invocation.completedAt ?? null,
            JSON.stringify(invocation.resultRefs),
            invocation.ownerVerification ? JSON.stringify(invocation.ownerVerification) : null,
            invocation.error ?? null,
        );
        return invocation;
    }

    async getInvocation(invocationId: string): Promise<CapabilityInvocationRef | null> {
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

    async listInvocations(missionId: string): Promise<CapabilityInvocationRef[]> {
        return this.listInvocationRows(missionId).map((row) => this.rowToInvocation(row));
    }

    async updateInvocation(
        invocationId: string,
        updates: Partial<CapabilityInvocationRef>,
    ): Promise<void> {
        const current = await this.getInvocation(invocationId);
        if (!current) {
            throw new Error(`Invocation not found: ${invocationId}`);
        }
        const merged: CapabilityInvocationRef = { ...current, ...updates, invocationId };
        await this.saveInvocation(merged);
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
            invocationRefs: invocations.map((i) => this.rowToInvocation(i)),
            evidenceRefs: parseJson(row.evidence_refs, []),
            criterionVerifications: parseJson(row.criterion_verifications, []),
            unresolvedQuestions: parseJson(row.unresolved_questions, []),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            recoveryMetadata: parseJson(row.recovery_metadata, {
                recovered: false,
                recoveryCount: 0,
            }),
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

    private rowToInvocation(row: InvocationRow): CapabilityInvocationRef {
        return {
            invocationId: row.invocation_id,
            missionId: row.mission_id,
            stepId: row.step_id,
            capabilityId: row.capability_id,
            status: row.status as CapabilityInvocationRef["status"],
            dispatchedAt: row.dispatched_at ?? undefined,
            completedAt: row.completed_at ?? undefined,
            resultRefs: parseJson(row.result_refs, []),
            ownerVerification: row.owner_verification
                ? parseJson(row.owner_verification, undefined)
                : undefined,
            error: row.error ?? undefined,
        };
    }

    /** Execute a function inside a BEGIN/COMMIT transaction. */
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
        const db = this.ensureDb();
        db.exec("BEGIN");
        try {
            const result = await fn();
            db.exec("COMMIT");
            return result;
        } catch (e) {
            db.exec("ROLLBACK");
            throw e;
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
