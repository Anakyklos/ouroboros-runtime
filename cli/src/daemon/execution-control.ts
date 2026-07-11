/**
 * Execution control plane (issue #37 — architectural round).
 *
 * Atomic admission + lease registry so pause/brake cannot race with new work.
 * Fail-honest: never claim success without an observable effect.
 *
 * Settlement rule: AbortSignal alone is never cancelled_confirmed. Local abortable
 * work must reach a terminal settlement (or time out as unconfirmed).
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
    | "failed"
    /** Remote/unconfirmed work after brake — may still be running outside the daemon. */
    | "detached";

/**
 * Progress of a stop attempt. Firing AbortSignal is only `abort_requested`.
 * `execution_settled` is required for cancelled_confirmed on local work.
 */
export type StopProgress =
    | "abort_not_requested"
    | "abort_requested"
    | "abort_acknowledged"
    | "execution_settled"
    | "detached_remote"
    | "unsupported";

/** How stop/brake can interact with a given work kind. */
export type StopCapability =
    | { kind: "abortable"; acknowledgement: "requires_settlement" }
    | { kind: "request_only"; acknowledgement: "unconfirmed" }
    | { kind: "detached_remote"; remoteMayContinue: true }
    | { kind: "unsupported" };

export function stopCapabilityFor(kind: WorkKind): StopCapability {
    switch (kind) {
        case "session_task":
        case "delegate_glm":
        case "delegate_glm_wave":
            // Abortable only after real settlement (provider/loop/tool terminal).
            return { kind: "abortable", acknowledgement: "requires_settlement" };
        case "delegate_gemini":
        case "delegate_antigravity":
            return { kind: "request_only", acknowledgement: "unconfirmed" };
        case "delegate_jules":
            return { kind: "detached_remote", remoteMayContinue: true };
        default:
            return { kind: "unsupported" };
    }
}

/** How pause can interact with a given work kind. */
export type PauseCapability =
    | { kind: "cooperative_local" }
    | { kind: "admission_only" }
    | { kind: "remote_uncontrolled" };

export function pauseCapabilityFor(kind: WorkKind): PauseCapability {
    switch (kind) {
        case "session_task":
        case "delegate_glm":
        case "delegate_glm_wave":
            // Cooperative only when the executor observes lease pause (wired at call sites).
            return { kind: "cooperative_local" };
        case "delegate_gemini":
        case "delegate_antigravity":
            return { kind: "admission_only" };
        case "delegate_jules":
            return { kind: "remote_uncontrolled" };
        default:
            return { kind: "admission_only" };
    }
}

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
    /** Subscribe to pause flag changes (for wiring Orchestrator.pause/resume). */
    onPausedChange(listener: (paused: boolean) => void): () => void;
}

export type SettlementStatus = "completed" | "failed" | "cancelled";

export type SettlementWaitResult =
    | { status: SettlementStatus }
    | { status: "timeout" };

export interface ExecutionLease {
    readonly workId: string;
    readonly kind: WorkKind;
    readonly sessionId?: string;
    readonly signal: ExecutionControlSignal;
    /** Mark that provider/tool side effects have not started for this step (safe point). */
    markSafePoint(meta?: Record<string, unknown>): void;
    /**
     * Controlled component saw the abort (provider rejected AbortError, loop exited on cancel, etc.).
     * Required for requestAbort.acknowledged = true.
     */
    acknowledgeAbort(): void;
    complete(result?: unknown): void;
    fail(error: unknown): void;
    /**
     * Wait until this lease reaches a terminal settlement, or timeout.
     * Timeout does NOT force cancel — caller reports unconfirmed.
     */
    waitForSettlement(options?: { timeoutMs?: number }): Promise<SettlementWaitResult>;
    /** Idempotent release: settles as completed if still non-terminal. */
    release(): void;
}

export type DaemonOperationalState =
    | { kind: "running" }
    | { kind: "paused"; reason?: string }
    | { kind: "braking"; operationId: string; reason: string }
    | {
          kind: "braked";
          operationId: string;
          completeness: "complete" | "partial";
          reason: string;
          unresolvedWorkCount: number;
          /** Non-sensitive categories only (e.g. detached_remote, abort_unconfirmed). */
          pendingCategories?: string[];
      }
    | { kind: "degraded"; reason: string; fromBrake?: boolean; completeness?: "partial" };

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

export type WorkControlAction =
    | "paused"
    | "admission_paused"
    | "cancelled_confirmed"
    | "abort_requested_unconfirmed"
    | "detached_remote"
    | "already_safe"
    | "unsupported"
    | "failed";

export interface WorkControlResult {
    workId: string;
    kind: WorkKind;
    sessionId?: string;
    previousState: WorkState;
    resultingState: WorkState;
    action: WorkControlAction;
    recoverable: boolean;
    stopCapability: StopCapability;
    stopProgress: StopProgress;
    requestAbort: { attempted: boolean; acknowledged: boolean; settled: boolean };
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
    unresolvedWorkCount: number;
    pendingCategories?: string[];
    timestamp: string;
    message: string;
}

export interface DaemonOperationalSnapshot {
    state: DaemonOperationalState;
    /** Convenience: accepts new work? */
    admissionOpen: boolean;
    activeWork: number;
    /** Work possibly still running remotely after unconfirmed/detached brake. */
    detachedOrUnknownWork: number;
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

/** Default max wait for local work to settle after abort during brake. */
export const DEFAULT_BRAKE_SETTLEMENT_TIMEOUT_MS = 2_000;

// ── Control signal implementation ─────────────────────────────────────────

class ControlSignalImpl implements ExecutionControlSignal {
    private _paused = false;
    private readonly abort = new AbortController();
    private pauseWaiters: Array<() => void> = [];
    private pauseListeners: Array<(paused: boolean) => void> = [];

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
        if (this._paused === paused) return;
        this._paused = paused;
        if (!paused) {
            const waiters = this.pauseWaiters;
            this.pauseWaiters = [];
            for (const w of waiters) w();
        }
        for (const l of this.pauseListeners) {
            try {
                l(paused);
            } catch {
                /* ignore listener errors */
            }
        }
    }

    onPausedChange(listener: (paused: boolean) => void): () => void {
        this.pauseListeners.push(listener);
        return () => {
            this.pauseListeners = this.pauseListeners.filter((l) => l !== listener);
        };
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
    abortAcknowledged: boolean;
    stopProgress: StopProgress;
    settlement?: { status: SettlementStatus };
    settlementWaiters: Array<(result: SettlementWaitResult) => void>;
}

class LeaseHandle implements ExecutionLease {
    constructor(
        private readonly record: InternalLease,
        private readonly onSettled: (id: string, status: SettlementStatus) => void
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

    acknowledgeAbort(): void {
        this.record.abortAcknowledged = true;
        if (
            this.record.stopProgress === "abort_requested" ||
            this.record.stopProgress === "abort_not_requested"
        ) {
            this.record.stopProgress = "abort_acknowledged";
        }
    }

    complete(_result?: unknown): void {
        this.settle(this.record.control.aborted ? "cancelled" : "completed");
    }

    fail(_error: unknown): void {
        // AbortError / cancel path still settles the execution.
        if (this.record.control.aborted || this.record.state === "cancelling") {
            this.settle("cancelled");
        } else {
            this.settle("failed");
        }
    }

    waitForSettlement(options?: { timeoutMs?: number }): Promise<SettlementWaitResult> {
        if (this.record.settlement) {
            return Promise.resolve({ status: this.record.settlement.status });
        }
        const timeoutMs = options?.timeoutMs ?? DEFAULT_BRAKE_SETTLEMENT_TIMEOUT_MS;
        return new Promise((resolve) => {
            let done = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (result: SettlementWaitResult) => {
                if (done) return;
                done = true;
                if (timer !== undefined) clearTimeout(timer);
                this.record.settlementWaiters = this.record.settlementWaiters.filter(
                    (w) => w !== finish
                );
                resolve(result);
            };
            this.record.settlementWaiters.push(finish);
            if (timeoutMs > 0) {
                timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
            }
        });
    }

    release(): void {
        if (this.isTerminal()) return;
        // Idempotent: mark completed if still open (normal path after success).
        this.settle(this.record.control.aborted ? "cancelled" : "completed");
    }

    private settle(status: SettlementStatus): void {
        if (this.isTerminal()) return;
        this.record.settlement = { status };
        this.record.state =
            status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "completed";
        this.record.stopProgress = "execution_settled";
        const waiters = this.record.settlementWaiters;
        this.record.settlementWaiters = [];
        for (const w of waiters) w({ status });
        this.onSettled(this.record.workId, status);
    }

    private isTerminal(): boolean {
        return (
            this.record.state === "completed" ||
            this.record.state === "failed" ||
            this.record.state === "cancelled" ||
            this.record.settlement !== undefined
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

export interface PersistedOpsV1 {
    schemaVersion: 1;
    revision: number;
    state: DaemonOperationalState;
    updatedAt: string;
    /** Non-sensitive summary of last brake (no prompts/secrets). */
    lastBrake?: {
        operationId: string;
        completeness: "complete" | "partial";
        unresolvedWorkCount: number;
        pendingCategories?: string[];
        worksSummary?: Array<{ kind: WorkKind; action: WorkControlAction }>;
    };
}

export interface DaemonExecutionControllerOptions {
    opsStatePath?: string;
    /** Injected for tests. */
    now?: () => Date;
    /** Override persistence (tests: inject failures). */
    persistFn?: (payload: PersistedOpsV1) => PersistenceResult;
    /** Max wait for abortable work to settle during brake. */
    settlementTimeoutMs?: number;
    /**
     * Test hook: runs inside exclusive acquire after admission check,
     * before the lease is registered — enables real acquire×brake races.
     */
    beforeRegisterLease?: () => Promise<void> | void;
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
    private readonly settlementTimeoutMs: number;
    private readonly persistFn?: (payload: PersistedOpsV1) => PersistenceResult;
    private readonly beforeRegisterLease?: () => Promise<void> | void;
    /** Last brake summary for already_stopped responses (no sensitive data). */
    private lastBrakeSummary?: PersistedOpsV1["lastBrake"];

    constructor(options: DaemonExecutionControllerOptions = {}) {
        this.opsStatePath =
            options.opsStatePath ??
            process.env.OUROBOROS_OPS_PATH ??
            join(process.cwd(), ".ouroboros", "daemon-ops.json");
        this.now = options.now ?? (() => new Date());
        this.settlementTimeoutMs = options.settlementTimeoutMs ?? DEFAULT_BRAKE_SETTLEMENT_TIMEOUT_MS;
        this.persistFn = options.persistFn;
        this.beforeRegisterLease = options.beforeRegisterLease;
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
        let detached = 0;
        for (const lease of this.leases.values()) {
            byKind[lease.kind] += 1;
            if (lease.state === "detached" || lease.state === "cancelling") {
                // cancelling past timeout = unknown; count as detached/unknown for honesty
                detached += 1;
            } else if (
                lease.state === "admitted" ||
                lease.state === "running" ||
                lease.state === "paused"
            ) {
                active += 1;
            }
        }
        return {
            state: this.state,
            admissionOpen: this.admissionOpen(),
            activeWork: active,
            detachedOrUnknownWork: detached,
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

    private countUnresolved(): number {
        let n = 0;
        for (const lease of this.leases.values()) {
            if (
                lease.state === "detached" ||
                lease.state === "cancelling" ||
                lease.state === "running" ||
                lease.state === "admitted" ||
                lease.state === "paused"
            ) {
                n += 1;
            }
        }
        return n;
    }

    private pendingCategoriesFromLeases(): string[] {
        const cats = new Set<string>();
        for (const lease of this.leases.values()) {
            if (lease.state === "detached") {
                const cap = stopCapabilityFor(lease.kind);
                if (cap.kind === "detached_remote") cats.add("detached_remote");
                else cats.add("abort_unconfirmed");
            } else if (lease.state === "cancelling") {
                cats.add("abort_unconfirmed");
            } else if (
                lease.state === "running" ||
                lease.state === "admitted" ||
                lease.state === "paused"
            ) {
                cats.add("still_active");
            }
        }
        return [...cats];
    }

    /**
     * Atomic admission: under exclusive lock, reject if closed, else register lease
     * before returning so brake can always see it.
     */
    acquire(request: WorkAdmissionRequest): Promise<ExecutionLease> {
        return this.exclusive(async () => {
            if (!this.admissionOpen()) {
                throw new AdmissionDeniedError(
                    `Admission closed (state=${this.state.kind}); cannot start ${request.kind}`
                );
            }

            // Test hook: yield after admission check so brake can queue and close.
            if (this.beforeRegisterLease) {
                await this.beforeRegisterLease();
            }

            // Re-check after yield (real race).
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
                abortAcknowledged: false,
                stopProgress: "abort_not_requested",
                settlementWaiters: [],
            };
            this.leases.set(workId, record);
            record.state = "running";

            return new LeaseHandle(record, (id, _status) => {
                const rec = this.leases.get(id);
                if (!rec) return;
                // Drop terminal leases from registry (including detached that finally settled).
                if (
                    rec.state === "completed" ||
                    rec.state === "failed" ||
                    rec.state === "cancelled"
                ) {
                    this.leases.delete(id);
                }
                // Live unresolved may drop after detached remote returns — snapshot reflects it.
                // Do not rewrite historical lastBrake.completeness.
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
                    persistence: {
                        ok: true,
                        revision: this.revision,
                        persistedAt: this.now().toISOString(),
                    },
                    timestamp: this.now().toISOString(),
                    message: "Already paused.",
                };
            }
            if (previous.kind === "braked" || previous.kind === "braking") {
                return {
                    operationId,
                    previous,
                    resulting: previous,
                    persistence: {
                        ok: true,
                        revision: this.revision,
                        persistedAt: this.now().toISOString(),
                    },
                    timestamp: this.now().toISOString(),
                    message: "Daemon is braked; pause is already implied.",
                };
            }

            // Close admission first, then pause only work that supports cooperative pause.
            this.state = { kind: "paused", reason };
            const reach: string[] = ["admission_closed"];
            for (const lease of this.leases.values()) {
                if (lease.state !== "running" && lease.state !== "admitted") continue;
                const cap = pauseCapabilityFor(lease.kind);
                if (cap.kind === "cooperative_local") {
                    lease.control.setPaused(true);
                    lease.state = "paused";
                    reach.push(`${lease.kind}:execution_paused`);
                } else if (cap.kind === "admission_only") {
                    // Cannot prove provider pause; leave state running but admission blocks new work.
                    reach.push(`${lease.kind}:pause_unconfirmed`);
                } else {
                    reach.push(`${lease.kind}:remote_uncontrolled`);
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
                    ? `Admission closed. Reach: ${reach.join("; ")}. Pause is not cancel.`
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
                    persistence: {
                        ok: true,
                        revision: this.revision,
                        persistedAt: this.now().toISOString(),
                    },
                    timestamp: this.now().toISOString(),
                    message: "Already running.",
                };
            }

            // Persist running intent BEFORE unpausing any lease.
            this.state = { kind: "running" };
            const persistence = this.persist();
            if (!persistence.ok) {
                this.state = {
                    kind: "paused",
                    reason: `persist failed on resume: ${persistence.reason}`,
                };
                return {
                    operationId,
                    previous,
                    resulting: this.state,
                    persistence,
                    timestamp: this.now().toISOString(),
                    message: `Resume aborted: could not persist running state (${persistence.reason}). Leases left paused.`,
                };
            }
            for (const lease of this.leases.values()) {
                if (lease.state === "paused") {
                    lease.control.setPaused(false);
                    lease.state = "running";
                }
            }
            return {
                operationId,
                previous,
                resulting: this.state,
                persistence,
                timestamp: this.now().toISOString(),
                message: `Admission reopened${reason ? ` (${reason})` : ""}.`,
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

            // Phase 1: persist intent to run BEFORE releasing any work.
            const pending: DaemonOperationalState = { kind: "running" };
            const previousState = this.state;
            this.state = pending;
            const persistence = this.persist();
            if (!persistence.ok) {
                this.state = previousState;
                // Ensure any paused leases remain paused.
                for (const lease of this.leases.values()) {
                    if (lease.state === "paused") {
                        lease.control.setPaused(true);
                    }
                }
                return {
                    operationId,
                    previous,
                    resulting: this.state,
                    persistence,
                    timestamp: this.now().toISOString(),
                    message: `Cannot clear brake: persist failed (${persistence.reason}). Leases left untouched.`,
                };
            }

            // Phase 2: only after durable running, unpause cooperative leases.
            // Detached remote work is not "resumed" — only local pause flags clear.
            for (const lease of this.leases.values()) {
                if (lease.state === "paused") {
                    lease.control.setPaused(false);
                    lease.state = "running";
                }
            }

            this.lastBrakeSummary = undefined;

            return {
                operationId,
                previous,
                resulting: this.state,
                persistence,
                timestamp: this.now().toISOString(),
                message: `Brake cleared; admission open. Cancelled/detached work is not auto-resumed. (${reason})`,
            };
        });
    }

    emergencyBrake(reason = "emergency brake"): Promise<EmergencyBrakeResultV2> {
        return this.exclusive(async () => {
            const operationId = randomUUID();
            const timestamp = this.now().toISOString();

            // Already braked / degraded-from-brake: preserve completeness, never invent success.
            if (this.state.kind === "braked") {
                const unresolved = this.countUnresolved();
                const categories =
                    this.state.pendingCategories ?? this.pendingCategoriesFromLeases();
                // complete only if original brake was complete AND nothing still unresolved.
                const complete =
                    this.state.completeness === "complete" &&
                    unresolved === 0 &&
                    this.lastPersistOk;
                const works = (this.lastBrakeSummary?.worksSummary ?? []).map((w, i) => ({
                    workId: `prior-${i}`,
                    kind: w.kind,
                    previousState: "detached" as WorkState,
                    resultingState: "detached" as WorkState,
                    action: w.action,
                    recoverable: false,
                    stopCapability: stopCapabilityFor(w.kind),
                    stopProgress:
                        w.action === "detached_remote"
                            ? ("detached_remote" as StopProgress)
                            : w.action === "cancelled_confirmed"
                              ? ("execution_settled" as StopProgress)
                              : ("abort_requested" as StopProgress),
                    requestAbort: {
                        attempted: w.action !== "detached_remote",
                        acknowledged: w.action === "cancelled_confirmed",
                        settled: w.action === "cancelled_confirmed",
                    },
                }));
                const persistence: PersistenceResult = this.lastPersistOk
                    ? { ok: true, revision: this.revision, persistedAt: timestamp }
                    : {
                          ok: false,
                          reason: this.lastPersistError ?? "previous persist failed",
                      };
                return {
                    operationId: this.state.operationId,
                    outcome: "already_stopped",
                    complete,
                    works,
                    admissionClosed: true,
                    persistence,
                    mode: "pause",
                    brakeRecoverable: false,
                    unresolvedWorkCount: unresolved,
                    pendingCategories: categories,
                    timestamp,
                    message: complete
                        ? "Already braked; admission remains closed. No unresolved work."
                        : `Already braked with unresolved/detached work (count=${unresolved}${
                              categories.length ? `; ${categories.join(",")}` : ""
                          }). Admission remains closed. Partial does not mean the gate failed — only that not every execution settled.`,
                };
            }

            if (this.state.kind === "degraded" && this.state.fromBrake) {
                const unresolved = this.countUnresolved();
                const persistence: PersistenceResult = {
                    ok: false,
                    reason: this.state.reason,
                };
                return {
                    operationId,
                    outcome: "already_stopped",
                    complete: false,
                    works: [],
                    admissionClosed: true,
                    persistence,
                    mode: "pause",
                    brakeRecoverable: false,
                    unresolvedWorkCount: unresolved,
                    pendingCategories: this.pendingCategoriesFromLeases(),
                    timestamp,
                    message: `Already closed after degraded brake (${this.state.reason}). Not claiming complete success.`,
                };
            }

            // Phase 1: close admission in memory + persist braking intent BEFORE external effects.
            this.state = { kind: "braking", operationId, reason };
            const intentPersist = this.persist();
            if (!intentPersist.ok) {
                this.state = {
                    kind: "degraded",
                    reason: `braking intent not persisted: ${intentPersist.reason}`,
                    fromBrake: true,
                    completeness: "partial",
                };
                return {
                    operationId,
                    outcome: "partial",
                    complete: false,
                    works: [],
                    admissionClosed: true,
                    persistence: intentPersist,
                    mode: "pause",
                    brakeRecoverable: false,
                    unresolvedWorkCount: this.countUnresolved(),
                    timestamp,
                    message: `Admission closed in-memory but braking intent not durable (${intentPersist.reason}). Restart safety not guaranteed. No external aborts applied.`,
                };
            }

            const works: WorkControlResult[] = [];
            const snapshot = [...this.leases.values()];

            if (snapshot.length === 0) {
                this.state = {
                    kind: "braked",
                    operationId,
                    completeness: "complete",
                    reason,
                    unresolvedWorkCount: 0,
                };
                const finalPersist = this.persist();
                const complete = finalPersist.ok;
                if (!finalPersist.ok) {
                    this.state = {
                        kind: "degraded",
                        reason: finalPersist.reason,
                        fromBrake: true,
                        completeness: "partial",
                    };
                }
                this.lastBrakeSummary = {
                    operationId,
                    completeness: complete ? "complete" : "partial",
                    unresolvedWorkCount: 0,
                    worksSummary: [],
                };
                return {
                    operationId,
                    outcome: "no_active_work",
                    complete,
                    works: [],
                    admissionClosed: true,
                    persistence: finalPersist,
                    mode: "pause",
                    brakeRecoverable: false,
                    unresolvedWorkCount: 0,
                    timestamp,
                    message: complete
                        ? "No active work. Admission closed until setMode(running). Cancel is terminal (not recoverable)."
                        : `Admission closed but final braked persist failed: ${finalPersist.reason}`,
                };
            }

            // Phase 2: apply stop policy per WorkKind (honest actions + settlement wait).
            let unconfirmed = 0;
            let failed = 0;

            // Fire aborts first for all abortable, then wait for settlements in parallel.
            type PendingAbortable = {
                lease: InternalLease;
                previousState: WorkState;
                cap: StopCapability;
                handle: LeaseHandle;
            };
            const pendingAbortable: PendingAbortable[] = [];

            for (const lease of snapshot) {
                const previousState = lease.state;
                const cap = stopCapabilityFor(lease.kind);
                try {
                    if (cap.kind === "abortable") {
                        lease.state = "cancelling";
                        lease.stopProgress = "abort_requested";
                        lease.control.abortNow(reason);
                        // Synthetic handle for waitForSettlement on internal record
                        const handle = new LeaseHandle(lease, (id, status) => {
                            const rec = this.leases.get(id);
                            if (!rec) return;
                            if (
                                rec.state === "completed" ||
                                rec.state === "failed" ||
                                rec.state === "cancelled"
                            ) {
                                this.leases.delete(id);
                            }
                            void status;
                        });
                        pendingAbortable.push({ lease, previousState, cap, handle });
                    } else if (cap.kind === "request_only") {
                        lease.control.abortNow(reason);
                        lease.state = "detached";
                        lease.stopProgress = "abort_requested";
                        unconfirmed += 1;
                        works.push({
                            workId: lease.workId,
                            kind: lease.kind,
                            sessionId: lease.sessionId,
                            previousState,
                            resultingState: "detached",
                            action: "abort_requested_unconfirmed",
                            recoverable: false,
                            stopCapability: cap,
                            stopProgress: "abort_requested",
                            requestAbort: {
                                attempted: true,
                                acknowledged: false,
                                settled: false,
                            },
                        });
                        // Keep lease for detached/unknown metrics.
                    } else if (cap.kind === "detached_remote") {
                        lease.state = "detached";
                        lease.stopProgress = "detached_remote";
                        unconfirmed += 1;
                        works.push({
                            workId: lease.workId,
                            kind: lease.kind,
                            sessionId: lease.sessionId,
                            previousState,
                            resultingState: "detached",
                            action: "detached_remote",
                            recoverable: false,
                            stopCapability: cap,
                            stopProgress: "detached_remote",
                            requestAbort: {
                                attempted: false,
                                acknowledged: false,
                                settled: false,
                            },
                        });
                    } else {
                        unconfirmed += 1;
                        lease.stopProgress = "unsupported";
                        works.push({
                            workId: lease.workId,
                            kind: lease.kind,
                            sessionId: lease.sessionId,
                            previousState,
                            resultingState: previousState,
                            action: "unsupported",
                            recoverable: false,
                            stopCapability: cap,
                            stopProgress: "unsupported",
                            requestAbort: {
                                attempted: false,
                                acknowledged: false,
                                settled: false,
                            },
                        });
                    }
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
                        stopCapability: cap,
                        stopProgress: lease.stopProgress,
                        requestAbort: {
                            attempted: true,
                            acknowledged: false,
                            settled: false,
                        },
                        error: { code: "cancel_failed", message },
                    });
                }
            }

            // Wait for abortable settlements (bounded). Timeout ≠ auto-cancel.
            await Promise.all(
                pendingAbortable.map(async ({ lease, previousState, cap, handle }) => {
                    const wait = await handle.waitForSettlement({
                        timeoutMs: this.settlementTimeoutMs,
                    });
                    if (wait.status === "timeout") {
                        // Leave as cancelling — not removed, not confirmed.
                        unconfirmed += 1;
                        works.push({
                            workId: lease.workId,
                            kind: lease.kind,
                            sessionId: lease.sessionId,
                            previousState,
                            resultingState: "cancelling",
                            action: "abort_requested_unconfirmed",
                            recoverable: false,
                            stopCapability: cap,
                            stopProgress: lease.abortAcknowledged
                                ? "abort_acknowledged"
                                : "abort_requested",
                            requestAbort: {
                                attempted: true,
                                acknowledged: lease.abortAcknowledged,
                                settled: false,
                            },
                        });
                        return;
                    }

                    // Terminal settlement after abort request.
                    const settledConfirmed =
                        lease.abortAcknowledged ||
                        wait.status === "cancelled" ||
                        lease.settlement !== undefined;

                    if (settledConfirmed) {
                        // Ensure state is cancelled if worker used complete/fail after abort.
                        if (!lease.settlement) {
                            lease.settlement = { status: wait.status };
                            lease.state =
                                wait.status === "failed"
                                    ? "failed"
                                    : wait.status === "completed"
                                      ? "completed"
                                      : "cancelled";
                            lease.stopProgress = "execution_settled";
                        }
                        // Remove confirmed work from registry.
                        this.leases.delete(lease.workId);
                        works.push({
                            workId: lease.workId,
                            kind: lease.kind,
                            sessionId: lease.sessionId,
                            previousState,
                            resultingState: "cancelled",
                            action: "cancelled_confirmed",
                            recoverable: false,
                            stopCapability: cap,
                            stopProgress: "execution_settled",
                            requestAbort: {
                                attempted: true,
                                acknowledged: lease.abortAcknowledged || wait.status === "cancelled",
                                settled: true,
                            },
                        });
                    } else {
                        unconfirmed += 1;
                        works.push({
                            workId: lease.workId,
                            kind: lease.kind,
                            sessionId: lease.sessionId,
                            previousState,
                            resultingState: lease.state,
                            action: "abort_requested_unconfirmed",
                            recoverable: false,
                            stopCapability: cap,
                            stopProgress: "abort_requested",
                            requestAbort: {
                                attempted: true,
                                acknowledged: false,
                                settled: false,
                            },
                        });
                    }
                })
            );

            const unresolvedWorkCount = this.countUnresolved();
            const pendingCategories = this.pendingCategoriesFromLeases();
            const completeness =
                failed === 0 && unconfirmed === 0 && unresolvedWorkCount === 0
                    ? "complete"
                    : "partial";

            this.state = {
                kind: "braked",
                operationId,
                completeness,
                reason,
                unresolvedWorkCount,
                pendingCategories,
            };
            const finalPersist = this.persist();
            if (!finalPersist.ok) {
                this.state = {
                    kind: "degraded",
                    reason: finalPersist.reason,
                    fromBrake: true,
                    completeness: "partial",
                };
            }

            this.lastBrakeSummary = {
                operationId,
                completeness,
                unresolvedWorkCount,
                pendingCategories,
                worksSummary: works.map((w) => ({ kind: w.kind, action: w.action })),
            };

            const outcome: EmergencyBrakeResultV2["outcome"] =
                failed > 0 || unconfirmed > 0 || unresolvedWorkCount > 0
                    ? "partial"
                    : "all_stopped";
            // complete only when every work settled confirmed AND durable braked.
            const complete =
                failed === 0 &&
                unconfirmed === 0 &&
                unresolvedWorkCount === 0 &&
                finalPersist.ok;

            return {
                operationId,
                outcome,
                complete,
                works,
                admissionClosed: true,
                persistence: finalPersist,
                mode: "pause",
                brakeRecoverable: false,
                unresolvedWorkCount,
                pendingCategories,
                timestamp,
                message: complete
                    ? `Confirmed settlement of ${works.length} local work item(s); admission closed.`
                    : `Brake partial: admission closed. Settled cancels may exist, but unconfirmed/detached=${unconfirmed}, failed=${failed}, unresolved=${unresolvedWorkCount}, persistOk=${finalPersist.ok}. Partial ≠ gate failure — remote/tools may still run.`,
            };
        });
    }

    private persist(): PersistenceResult {
        const persistedAt = this.now().toISOString();
        this.revision += 1;
        const payload: PersistedOpsV1 = {
            schemaVersion: 1,
            revision: this.revision,
            state: this.state,
            updatedAt: persistedAt,
            lastBrake: this.lastBrakeSummary,
        };

        if (this.persistFn) {
            try {
                const result = this.persistFn(payload);
                this.lastPersistOk = result.ok;
                this.lastPersistError = result.ok ? undefined : result.reason;
                if (!result.ok) {
                    // roll back revision bump on failure for stable numbers
                    this.revision -= 1;
                }
                return result;
            } catch (e) {
                this.revision -= 1;
                const reason = e instanceof Error ? e.message : String(e);
                this.lastPersistOk = false;
                this.lastPersistError = reason;
                return { ok: false, reason };
            }
        }

        try {
            const dir = dirname(this.opsStatePath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const tmp = `${this.opsStatePath}.${process.pid}.${Date.now()}.tmp`;
            writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
            renameSync(tmp, this.opsStatePath);
            this.lastPersistOk = true;
            this.lastPersistError = undefined;
            return { ok: true, revision: this.revision, persistedAt };
        } catch (e) {
            this.revision -= 1;
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
                        unresolvedWorkCount: 0,
                        pendingCategories: ["recovered_mid_brake"],
                    };
                }
                // Normalize older braked payloads without unresolvedWorkCount.
                if (this.state.kind === "braked" && typeof this.state.unresolvedWorkCount !== "number") {
                    this.state = {
                        ...this.state,
                        unresolvedWorkCount: this.state.completeness === "partial" ? 1 : 0,
                    };
                }
            }
            if (raw.lastBrake) {
                this.lastBrakeSummary = raw.lastBrake;
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
