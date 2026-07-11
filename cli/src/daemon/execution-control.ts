/**
 * Execution control plane (issue #37 — architectural round).
 *
 * Atomic admission + lease registry so pause/brake cannot race with new work.
 * Fail-honest: never claim success without an observable effect.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// ── Work kinds / capabilities ─────────────────────────────────────────────

export type WorkKind =
    | "session_task"
    | "delegate_gemini"
    | "delegate_antigravity"
    | "delegate_jules"
    | "delegate_glm"
    | "delegate_glm_wave";

export type WorkState =
    | "admitted"
    | "running"
    | "paused"
    | "cancelling"
    | "cancelled"
    | "completed"
    | "failed";

export interface WorkAdmissionRequest {
    kind: WorkKind;
    sessionId?: string;
    /** Optional label for diagnostics (never secrets/prompts). */
    label?: string;
}

/** Cooperative pause + terminal abort. Pause ≠ cancel. */
export interface ExecutionControlSignal {
    readonly aborted: boolean;
    readonly paused: boolean;
    readonly abortSignal: AbortSignal;
    waitUntilRunnable(): Promise<void>;
    throwIfAborted(): void;
}

export interface ExecutionLease {
    readonly workId: string;
    readonly kind: WorkKind;
    readonly sessionId?: string;
    readonly signal: ExecutionControlSignal;
    /** Mark that provider/tool side effects have not started for this step (safe point). */
    markSafePoint(meta?: Record<string, unknown>): void;
    complete(result?: unknown): void;
    fail(error: unknown): void;
    release(): void;
}

export type DaemonOperationalState =
    | { kind: "running" }
    | { kind: "paused"; reason?: string }
    | { kind: "braking"; operationId: string; reason: string }
    | { kind: "braked"; operationId: string; completeness: "complete" | "partial"; reason: string }
    | { kind: "degraded"; reason: string };

export type PersistenceResult =
    | { ok: true; revision: number; persistedAt: string }
    | { ok: false; reason: string };

export interface ControlOperationResult {
    operationId: string;
    previous: DaemonOperationalState;
    resulting: DaemonOperationalState;
    persistence: PersistenceResult;
    timestamp: string;
    message: string;
}

export interface WorkControlResult {
    workId: string;
    kind: WorkKind;
    sessionId?: string;
    previousState: WorkState;
    resultingState: WorkState;
    action: "paused" | "cancelled" | "already_safe" | "unsupported" | "failed";
    recoverable: boolean;
    requestAbort: { attempted: boolean; acknowledged: boolean };
    error?: { code: string; message: string };
}

export interface EmergencyBrakeResultV2 {
    operationId: string;
    outcome: "no_active_work" | "all_stopped" | "partial" | "already_stopped";
    complete: boolean;
    works: WorkControlResult[];
    admissionClosed: true;
    persistence: PersistenceResult;
    mode: "pause";
    /** Global recoverable pause is not supported for all work kinds. */
    brakeRecoverable: false;
    timestamp: string;
    message: string;
}

export interface DaemonOperationalSnapshot {
    state: DaemonOperationalState;
    /** Convenience: accepts new work? */
    admissionOpen: boolean;
    activeWork: number;
    byKind: Record<WorkKind, number>;
    uptimeSeconds: number;
    persistence: {
        healthy: boolean;
        revision: number | null;
        lastError?: string;
    };
    capabilities: DaemonControlCapabilities;
    timestamp: string;
}

export interface DaemonControlCapabilities {
    statusMetrics: true;
    admissionPause: true;
    emergencyStop: true;
    terminalCancel: true;
    modeSwitching: true;
    supportedModes: readonly ["running", "pause"];
    /** Per-kind recoverability after pause/brake. */
    recoverablePause: {
        sessionTask: false;
        directDelegate: false;
        wave: false;
    };
    /** True only when last persist succeeded; snapshot also carries health. */
    modePersistence: boolean;
    tokenMetrics: false;
}

export const WORK_KINDS: WorkKind[] = [
    "session_task",
    "delegate_gemini",
    "delegate_antigravity",
    "delegate_jules",
    "delegate_glm",
    "delegate_glm_wave",
];

// ── Control signal implementation ─────────────────────────────────────────

class ControlSignalImpl implements ExecutionControlSignal {
    private _paused = false;
    private readonly abort = new AbortController();
    private pauseWaiters: Array<() => void> = [];

    get aborted(): boolean {
        return this.abort.signal.aborted;
    }

    get paused(): boolean {
        return this._paused;
    }

    get abortSignal(): AbortSignal {
        return this.abort.signal;
    }

    setPaused(paused: boolean): void {
        this._paused = paused;
        if (!paused) {
            const waiters = this.pauseWaiters;
            this.pauseWaiters = [];
            for (const w of waiters) w();
        }
    }

    abortNow(reason?: string): void {
        try {
            this.abort.abort(reason);
        } catch {
            /* ignore */
        }
        // Unblock pause waiters so they can see aborted.
        const waiters = this.pauseWaiters;
        this.pauseWaiters = [];
        for (const w of waiters) w();
    }

    waitUntilRunnable(): Promise<void> {
        if (this.aborted) {
            return Promise.reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        }
        if (!this._paused) return Promise.resolve();
        return new Promise((resolve, reject) => {
            this.pauseWaiters.push(() => {
                if (this.aborted) {
                    reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
                } else {
                    resolve();
                }
            });
        });
    }

    throwIfAborted(): void {
        if (this.aborted) {
            const err = new Error("Execution aborted");
            err.name = "AbortError";
            throw err;
        }
    }
}

// ── Lease ─────────────────────────────────────────────────────────────────

interface InternalLease {
    workId: string;
    kind: WorkKind;
    sessionId?: string;
    label?: string;
    state: WorkState;
    control: ControlSignalImpl;
    safePoint?: Record<string, unknown>;
    createdAt: string;
}

class LeaseHandle implements ExecutionLease {
    constructor(
        private readonly record: InternalLease,
        private readonly onTerminal: (id: string, state: WorkState) => void
    ) {}

    get workId(): string {
        return this.record.workId;
    }
    get kind(): WorkKind {
        return this.record.kind;
    }
    get sessionId(): string | undefined {
        return this.record.sessionId;
    }
    get signal(): ExecutionControlSignal {
        return this.record.control;
    }

    markSafePoint(meta?: Record<string, unknown>): void {
        this.record.safePoint = { ...(meta ?? {}), at: new Date().toISOString() };
    }

    complete(_result?: unknown): void {
        if (this.isTerminal()) return;
        this.record.state = "completed";
        this.onTerminal(this.record.workId, "completed");
    }

    fail(_error: unknown): void {
        if (this.isTerminal()) return;
        this.record.state = "failed";
        this.onTerminal(this.record.workId, "failed");
    }

    release(): void {
        if (!this.isTerminal()) {
            this.record.state = "completed";
            this.onTerminal(this.record.workId, "completed");
        }
    }

    private isTerminal(): boolean {
        return (
            this.record.state === "completed" ||
            this.record.state === "failed" ||
            this.record.state === "cancelled"
        );
    }
}

// ── Controller ────────────────────────────────────────────────────────────

export class AdmissionDeniedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AdmissionDeniedError";
    }
}

export interface DaemonExecutionControllerOptions {
    opsStatePath?: string;
    /** Injected for tests. */
    now?: () => Date;
}

interface PersistedOpsV1 {
    schemaVersion: 1;
    revision: number;
    state: DaemonOperationalState;
    updatedAt: string;
}

export class DaemonExecutionController {
    private state: DaemonOperationalState = { kind: "running" };
    private readonly leases = new Map<string, InternalLease>();
    /** Tail of the exclusive control chain (admission + control ops). */
    private chain: Promise<unknown> = Promise.resolve();
    private revision = 0;
    private lastPersistError?: string;
    private lastPersistOk = true;
    private readonly opsStatePath: string;
    private readonly now: () => Date;
    private readonly startedAt = Date.now();

    constructor(options: DaemonExecutionControllerOptions = {}) {
        this.opsStatePath =
            options.opsStatePath ??
            process.env.OUROBOROS_OPS_PATH ??
            join(process.cwd(), ".ouroboros", "daemon-ops.json");
        this.now = options.now ?? (() => new Date());
        this.load();
    }

    /** Serialize control-plane critical sections. */
    private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
        const run = this.chain.then(() => fn());
        // Keep chain alive even if run rejects.
        this.chain = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    get operationalState(): DaemonOperationalState {
        return this.state;
    }

    admissionOpen(): boolean {
        return this.state.kind === "running";
    }

    capabilities(): DaemonControlCapabilities {
        return {
            statusMetrics: true,
            admissionPause: true,
            emergencyStop: true,
            terminalCancel: true,
            modeSwitching: true,
            supportedModes: ["running", "pause"],
            recoverablePause: {
                sessionTask: false,
                directDelegate: false,
                wave: false,
            },
            modePersistence: this.lastPersistOk,
            tokenMetrics: false,
        };
    }

    snapshot(): DaemonOperationalSnapshot {
        const byKind = Object.fromEntries(WORK_KINDS.map((k) => [k, 0])) as Record<
            WorkKind,
            number
        >;
        let active = 0;
        for (const lease of this.leases.values()) {
            if (
                lease.state === "admitted" ||
                lease.state === "running" ||
                lease.state === "paused" ||
                lease.state === "cancelling"
            ) {
                active += 1;
                byKind[lease.kind] += 1;
            }
        }
        return {
            state: this.state,
            admissionOpen: this.admissionOpen(),
            activeWork: active,
            byKind,
            uptimeSeconds: (Date.now() - this.startedAt) / 1000,
            persistence: {
                healthy: this.lastPersistOk,
                revision: this.lastPersistOk ? this.revision : null,
                lastError: this.lastPersistError,
            },
            capabilities: this.capabilities(),
            timestamp: this.now().toISOString(),
        };
    }

    /**
     * Atomic admission: under exclusive lock, reject if closed, else register lease
     * before returning so brake can always see it.
     */
    acquire(request: WorkAdmissionRequest): Promise<ExecutionLease> {
        return this.exclusive(() => {
            if (!this.admissionOpen()) {
                throw new AdmissionDeniedError(
                    `Admission closed (state=${this.state.kind}); cannot start ${request.kind}`
                );
            }
            // Serialize one session_task per session.
            if (request.kind === "session_task" && request.sessionId) {
                for (const l of this.leases.values()) {
                    if (
                        l.kind === "session_task" &&
                        l.sessionId === request.sessionId &&
                        (l.state === "admitted" ||
                            l.state === "running" ||
                            l.state === "paused" ||
                            l.state === "cancelling")
                    ) {
                        throw new AdmissionDeniedError(
                            `Session ${request.sessionId} already has active work`
                        );
                    }
                }
            }

            const workId = randomUUID();
            const control = new ControlSignalImpl();
            const record: InternalLease = {
                workId,
                kind: request.kind,
                sessionId: request.sessionId,
                label: request.label,
                state: "admitted",
                control,
                createdAt: this.now().toISOString(),
            };
            this.leases.set(workId, record);
            record.state = "running";

            return new LeaseHandle(record, (id, state) => {
                const rec = this.leases.get(id);
                if (rec) {
                    rec.state = state;
                    // Keep cancelled/failed/completed briefly for metrics; drop completed/failed after release path.
                    if (state === "completed" || state === "failed" || state === "cancelled") {
                        // deferred delete — release() already set state; remove from active map
                        this.leases.delete(id);
                    }
                }
            });
        });
    }

    pause(reason = "pause"): Promise<ControlOperationResult> {
        return this.exclusive(async () => {
            const operationId = randomUUID();
            const previous = this.state;
            if (previous.kind === "paused") {
                return {
                    operationId,
                    previous,
                    resulting: previous,
                    persistence: { ok: true, revision: this.revision, persistedAt: this.now().toISOString() },
                    timestamp: this.now().toISOString(),
                    message: "Already paused.",
                };
            }
            if (previous.kind === "braked" || previous.kind === "braking") {
                return {
                    operationId,
                    previous,
                    resulting: previous,
                    persistence: { ok: true, revision: this.revision, persistedAt: this.now().toISOString() },
                    timestamp: this.now().toISOString(),
                    message: "Daemon is braked; pause is already implied.",
                };
            }

            // Close admission first, then signal pause on leases (not abort).
            this.state = { kind: "paused", reason };
            for (const lease of this.leases.values()) {
                if (lease.state === "running" || lease.state === "admitted") {
                    lease.control.setPaused(true);
                    lease.state = "paused";
                }
            }
            const persistence = this.persist();
            if (!persistence.ok) {
                this.state = { kind: "degraded", reason: persistence.reason };
            }
            return {
                operationId,
                previous,
                resulting: this.state,
                persistence,
                timestamp: this.now().toISOString(),
                message: persistence.ok
                    ? "Admission closed; active work paused at safe points (not cancelled)."
                    : `Paused in-memory but persist failed: ${persistence.reason}`,
            };
        });
    }

    resume(reason?: string): Promise<ControlOperationResult> {
        return this.exclusive(async () => {
            const operationId = randomUUID();
            const previous = this.state;
            if (previous.kind === "braked" || previous.kind === "braking") {
                throw new AdmissionDeniedError(
                    "Cannot resume while braked; use setMode/running only after explicit clear via resume from braked with setMode path"
                );
            }
            // Allow resume from paused or degraded-if-was-pause
            if (previous.kind === "running") {
                return {
                    operationId,
                    previous,
                    resulting: previous,
                    persistence: { ok: true, revision: this.revision, persistedAt: this.now().toISOString() },
                    timestamp: this.now().toISOString(),
                    message: "Already running.",
                };
            }

            this.state = { kind: "running" };
            for (const lease of this.leases.values()) {
                if (lease.state === "paused") {
                    lease.control.setPaused(false);
                    lease.state = "running";
                }
            }
            const persistence = this.persist();
            if (!persistence.ok) {
                // Fail-honest: do not claim open admission if we cannot persist
                this.state = { kind: "paused", reason: `persist failed on resume: ${persistence.reason}` };
                for (const lease of this.leases.values()) {
                    if (lease.state === "running") {
                        lease.control.setPaused(true);
                        lease.state = "paused";
                    }
                }
            }
            return {
                operationId,
                previous,
                resulting: this.state,
                persistence,
                timestamp: this.now().toISOString(),
                message: persistence.ok
                    ? `Admission reopened${reason ? ` (${reason})` : ""}.`
                    : `Resume aborted: could not persist running state (${persistence.reason})`,
            };
        });
    }

    /**
     * Clear braked state and open admission (explicit operator action after emergency brake).
     * Does not resume cancelled work (recoverablePause.sessionTask=false).
     */
    clearBrakeAndRun(reason = "operator clear brake"): Promise<ControlOperationResult> {
        return this.exclusive(async () => {
            const operationId = randomUUID();
            const previous = this.state;
            this.state = { kind: "running" };
            for (const lease of this.leases.values()) {
                if (lease.state === "paused") {
                    lease.control.setPaused(false);
                    lease.state = "running";
                }
            }
            const persistence = this.persist();
            if (!persistence.ok) {
                this.state = previous;
                return {
                    operationId,
                    previous,
                    resulting: this.state,
                    persistence,
                    timestamp: this.now().toISOString(),
                    message: `Cannot clear brake: persist failed (${persistence.reason})`,
                };
            }
            return {
                operationId,
                previous,
                resulting: this.state,
                persistence,
                timestamp: this.now().toISOString(),
                message: `Brake cleared; admission open. Cancelled work is not auto-resumed. (${reason})`,
            };
        });
    }

    emergencyBrake(reason = "emergency brake"): Promise<EmergencyBrakeResultV2> {
        return this.exclusive(async () => {
            const operationId = randomUUID();
            const timestamp = this.now().toISOString();

            if (this.state.kind === "braked") {
                const persistence = this.persist();
                return {
                    operationId,
                    outcome: "already_stopped",
                    complete: true,
                    works: [],
                    admissionClosed: true,
                    persistence,
                    mode: "pause",
                    brakeRecoverable: false,
                    timestamp,
                    message:
                        "Already braked; admission remains closed. New work requires clearBrakeAndRun / setMode(running).",
                };
            }

            // 1) Close admission immediately (atomic under exclusive lock).
            this.state = { kind: "braking", operationId, reason };

            const works: WorkControlResult[] = [];
            const snapshot = [...this.leases.values()];

            if (snapshot.length === 0) {
                this.state = {
                    kind: "braked",
                    operationId,
                    completeness: "complete",
                    reason,
                };
                const persistence = this.persist();
                const complete = persistence.ok;
                if (!persistence.ok) {
                    this.state = { kind: "degraded", reason: persistence.reason };
                }
                return {
                    operationId,
                    outcome: "no_active_work",
                    complete,
                    works: [],
                    admissionClosed: true,
                    persistence,
                    mode: "pause",
                    brakeRecoverable: false,
                    timestamp,
                    message: complete
                        ? "No active work. Admission closed until setMode(running). Cancel is terminal (not recoverable)."
                        : `Admission closed in-memory but persist failed: ${persistence.reason}`,
                };
            }

            let failed = 0;
            for (const lease of snapshot) {
                const previousState = lease.state;
                try {
                    lease.state = "cancelling";
                    lease.control.abortNow(reason);
                    lease.state = "cancelled";
                    works.push({
                        workId: lease.workId,
                        kind: lease.kind,
                        sessionId: lease.sessionId,
                        previousState,
                        resultingState: "cancelled",
                        action: "cancelled",
                        recoverable: false,
                        requestAbort: { attempted: true, acknowledged: true },
                    });
                    this.leases.delete(lease.workId);
                } catch (e) {
                    failed += 1;
                    const message = e instanceof Error ? e.message : String(e);
                    works.push({
                        workId: lease.workId,
                        kind: lease.kind,
                        sessionId: lease.sessionId,
                        previousState,
                        resultingState: lease.state,
                        action: "failed",
                        recoverable: false,
                        requestAbort: { attempted: true, acknowledged: false },
                        error: { code: "cancel_failed", message },
                    });
                }
            }

            const completeness = failed === 0 ? "complete" : "partial";
            this.state = {
                kind: "braked",
                operationId,
                completeness,
                reason,
            };
            const persistence = this.persist();
            if (!persistence.ok) {
                this.state = { kind: "degraded", reason: persistence.reason };
            }

            const outcome =
                failed > 0 ? "partial" : completeness === "complete" ? "all_stopped" : "partial";
            const complete = failed === 0 && persistence.ok;

            return {
                operationId,
                outcome: outcome as EmergencyBrakeResultV2["outcome"],
                complete,
                works,
                admissionClosed: true,
                persistence,
                mode: "pause",
                brakeRecoverable: false,
                timestamp,
                message: complete
                    ? `Cancelled ${works.length} work item(s); admission closed. Not recoverable.`
                    : `Brake partial/degraded: failed=${failed}, persistOk=${persistence.ok}`,
            };
        });
    }

    private persist(): PersistenceResult {
        const persistedAt = this.now().toISOString();
        try {
            const dir = dirname(this.opsStatePath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            this.revision += 1;
            const payload: PersistedOpsV1 = {
                schemaVersion: 1,
                revision: this.revision,
                state: this.state,
                updatedAt: persistedAt,
            };
            const tmp = `${this.opsStatePath}.${process.pid}.${Date.now()}.tmp`;
            writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
            renameSync(tmp, this.opsStatePath);
            this.lastPersistOk = true;
            this.lastPersistError = undefined;
            return { ok: true, revision: this.revision, persistedAt };
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            this.lastPersistOk = false;
            this.lastPersistError = reason;
            return { ok: false, reason };
        }
    }

    private load(): void {
        try {
            if (!existsSync(this.opsStatePath)) return;
            const raw = JSON.parse(readFileSync(this.opsStatePath, "utf-8")) as PersistedOpsV1;
            if (raw.schemaVersion !== 1) {
                this.lastPersistOk = false;
                this.lastPersistError = `Unknown schemaVersion: ${String(raw.schemaVersion)}`;
                this.state = { kind: "degraded", reason: this.lastPersistError };
                return;
            }
            if (raw.state && typeof raw.state === "object" && "kind" in raw.state) {
                this.state = raw.state;
                // Never load as "running" mid-braking.
                if (this.state.kind === "braking") {
                    this.state = {
                        kind: "braked",
                        operationId: this.state.operationId,
                        completeness: "partial",
                        reason: "recovered from crash during braking",
                    };
                }
            }
            this.revision = typeof raw.revision === "number" ? raw.revision : 0;
            this.lastPersistOk = true;
        } catch (e) {
            this.lastPersistOk = false;
            this.lastPersistError = e instanceof Error ? e.message : String(e);
            this.state = { kind: "degraded", reason: `corrupt ops state: ${this.lastPersistError}` };
        }
    }
}
