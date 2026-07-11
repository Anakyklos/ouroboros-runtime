/**
 * 📋 Session Manager
 * 
 * Gerencia ciclo de vida das sessões.
 * Cada sessão representa uma execução de agente que pode ser pausada/resumida.
 */

import type { StoragePort, Session, SessionSummary, SessionMemory, SessionCheckpoint } from '../ports/storage.port.js';
import type { EventBus } from './event-bus.js';
import { Orchestrator, createTask } from '../orchestration/index.js';
import { PersonaType } from '../orchestration/types.js';
import {
    type DaemonMode,
    type DaemonStatusResult,
    type SetModeResult,
    type EmergencyBrakeResult,
    type EmergencyBrakeSessionResult,
    isDaemonMode,
    canTransitionMode,
    buildMetric,
    unavailableMetric,
} from './daemon-controls.js';
import {
    DaemonExecutionController,
    AdmissionDeniedError,
    type DaemonExecutionControllerOptions,
} from './execution-control.js';

interface WaveState {
    id: string;
    number: number;
    status: 'pending' | 'active' | 'done' | 'failed';
    tasks: Array<{
        id: string;
        title: string;
        phase: string;
        progress: number;
    }>;
}


export interface SessionManagerConfig {
    /**
     * Maximum number of cleanup iterations to perform before giving up.
     * Lower values reduce worst-case shutdown latency if cleanups repeatedly time out.
     */
    maxCleanupIterations?: number;

    /**
     * Timeout in milliseconds for each cleanup iteration.
     * This should be short enough to avoid making shutdown appear hung,
     * but long enough for a typical cleanup task to complete.
     */
    cleanupTimeoutMs?: number;

    /** Interval between automatic session checkpoints (ms). */
    checkpointIntervalMs?: number;

    /** Maximum number of checkpoints retained per session. */
    maxCheckpoints?: number;
}

export const DEFAULT_SESSION_MANAGER_CONFIG: SessionManagerConfig = {
    maxCleanupIterations: 3,
    cleanupTimeoutMs: 5000,
    checkpointIntervalMs: 30000,
    maxCheckpoints: 5,
};

const TIMEOUT_SYMBOL = Symbol('TIMEOUT');

export class SessionManager {
    private readonly maxCleanupIterations: number;
    private readonly cleanupTimeoutMs: number;
    private readonly checkpointIntervalMs: number;
    private readonly maxCheckpoints: number;

    private storage: StoragePort;
    private eventBus: EventBus;
    private activeOrchestrators: Map<string, Orchestrator> = new Map();
    /** sessionId → (taskId → promise) */
    private activeTasks: Map<string, Map<string, Promise<void>>> = new Map();
    private sessionWaves: Map<string, WaveState[]> = new Map();
    private checkpointIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();
    
    private apiKey?: string;

    /** Central admission gate + lease registry (issue #37 control plane). */
    private readonly controller: DaemonExecutionController;

    constructor(
        storage: StoragePort,
        eventBus: EventBus,
        apiKey?: string,
        config?: SessionManagerConfig & DaemonExecutionControllerOptions & {
            controller?: DaemonExecutionController;
        }
    ) {
        this.storage = storage;
        this.eventBus = eventBus;
        this.apiKey = apiKey;
        this.controller =
            config?.controller ??
            new DaemonExecutionController({
                opsStatePath: config?.opsStatePath,
            });
        this.maxCleanupIterations = config?.maxCleanupIterations ?? DEFAULT_SESSION_MANAGER_CONFIG.maxCleanupIterations!;
        this.cleanupTimeoutMs = config?.cleanupTimeoutMs ?? DEFAULT_SESSION_MANAGER_CONFIG.cleanupTimeoutMs!;
        // Reject non-positive / non-finite intervals — setInterval(0) burns CPU and hammers SQLite.
        this.checkpointIntervalMs =
            config?.checkpointIntervalMs !== undefined &&
            Number.isFinite(config.checkpointIntervalMs) &&
            config.checkpointIntervalMs > 0
                ? config.checkpointIntervalMs
                : DEFAULT_SESSION_MANAGER_CONFIG.checkpointIntervalMs!;
        // maxCheckpoints must keep at least one checkpoint when retention is enabled.
        this.maxCheckpoints =
            config?.maxCheckpoints !== undefined &&
            Number.isFinite(config.maxCheckpoints) &&
            config.maxCheckpoints >= 1
                ? Math.floor(config.maxCheckpoints)
                : DEFAULT_SESSION_MANAGER_CONFIG.maxCheckpoints!;
    }

    /** Shared control plane for RPC gateway and session paths. */
    getController(): DaemonExecutionController {
        return this.controller;
    }

    /**
     * Whether the daemon accepts new work (send/resume/delegate).
     */
    acceptsNewWork(): boolean {
        return this.controller.admissionOpen();
    }

    private assertAcceptsNewWork(action: string): void {
        if (!this.controller.admissionOpen()) {
            const kind = this.controller.operationalState.kind;
            throw new Error(
                `Daemon admission closed (state=${kind}); cannot ${action}. Cancelled work is not auto-resumed.`
            );
        }
    }

    /** Current operational mode derived from control-plane state. */
    getMode(): DaemonMode {
        const k = this.controller.operationalState.kind;
        return k === "running" ? "running" : "pause";
    }

    /**
     * Apply a mode change via the atomic control plane.
     * Fail-honest: if persistence fails, operation is not fully applied.
     */
    async setMode(requested: unknown): Promise<SetModeResult> {
        const previousMode = this.getMode();
        const timestamp = new Date().toISOString();

        if (!isDaemonMode(requested)) {
            return {
                operation: "rejected_invalid_mode",
                previousMode,
                requestedMode: requested === undefined || requested === null ? null : String(requested),
                resultingMode: previousMode,
                reason: `Unknown mode. Valid modes: running, pause.`,
                timestamp,
            };
        }

        if (!canTransitionMode(previousMode, requested)) {
            return {
                operation: "rejected_invalid_transition",
                previousMode,
                requestedMode: requested,
                resultingMode: previousMode,
                reason: `Transition ${previousMode} → ${requested} is not allowed.`,
                timestamp,
            };
        }

        if (previousMode === requested && this.controller.operationalState.kind !== "braked") {
            return {
                operation: "unchanged",
                previousMode,
                requestedMode: requested,
                resultingMode: previousMode,
                reason: "Mode already set to the requested value.",
                timestamp,
            };
        }

        if (requested === "pause") {
            const result = await this.controller.pause("setMode(pause)");
            for (const orchestrator of this.activeOrchestrators.values()) {
                orchestrator.pause();
            }
            if (!result.persistence.ok) {
                return {
                    operation: "rejected_invalid_transition",
                    previousMode,
                    requestedMode: requested,
                    resultingMode: this.getMode(),
                    reason: `Pause not fully applied: persist failed (${result.persistence.reason})`,
                    timestamp,
                };
            }
        } else {
            // running — clear brake if needed, then resume admission.
            // Only resume Orchestrators after durable open is confirmed.
            const st = this.controller.operationalState;
            const result =
                st.kind === "braked" || st.kind === "degraded"
                    ? await this.controller.clearBrakeAndRun("setMode(running)")
                    : await this.controller.resume("setMode(running)");
            if (!result.persistence.ok || result.resulting.kind !== "running") {
                return {
                    operation: "rejected_invalid_transition",
                    previousMode,
                    requestedMode: requested,
                    resultingMode: this.getMode(),
                    reason: result.message,
                    timestamp,
                };
            }
            for (const orchestrator of this.activeOrchestrators.values()) {
                orchestrator.resume();
            }
        }

        this.eventBus.log("info", `Daemon mode ${previousMode} → ${this.getMode()}`, "SessionManager");
        this.eventBus.emit("daemon", {
            type: "mode_changed",
            previousMode,
            mode: this.getMode(),
        });

        return {
            operation: "applied",
            previousMode,
            requestedMode: requested,
            resultingMode: this.getMode(),
            timestamp,
        };
    }

    /**
     * Terminal session statuses — excluded from activity metrics and brake targets.
     */
    private static readonly TERMINAL_STATUSES = new Set(["completed", "failed"]);

    /** Sessions with live work: in-flight tasks and/or non-terminal attached orchestrators. */
    private collectLiveSessionIds(): Set<string> {
        const ids = new Set<string>();
        for (const [sessionId, taskMap] of this.activeTasks) {
            if (taskMap.size > 0) ids.add(sessionId);
        }
        for (const sessionId of this.activeOrchestrators.keys()) {
            if ((this.activeTasks.get(sessionId)?.size ?? 0) > 0) {
                ids.add(sessionId);
            }
        }
        for (const sessionId of this.checkpointIntervals.keys()) {
            // Checkpoint timer alone does not mean work is active; only with tasks.
            if ((this.activeTasks.get(sessionId)?.size ?? 0) > 0) {
                ids.add(sessionId);
            }
        }
        return ids;
    }

    /**
     * Drop runtime handles for a session that reached a terminal storage status.
     * Does not delete persistent data.
     */
    private releaseSessionRuntime(sessionId: string): void {
        const timer = this.checkpointIntervals.get(sessionId);
        if (timer) {
            clearInterval(timer);
            this.checkpointIntervals.delete(sessionId);
        }
        this.activeOrchestrators.delete(sessionId);
        const tasks = this.activeTasks.get(sessionId);
        if (tasks && tasks.size === 0) {
            this.activeTasks.delete(sessionId);
        }
    }

    private removeTaskPromise(sessionId: string, taskId: string): void {
        const map = this.activeTasks.get(sessionId);
        if (!map) return;
        map.delete(taskId);
        if (map.size === 0) {
            this.activeTasks.delete(sessionId);
        }
    }

    /**
     * Real activity snapshot for `daemon.status`.
     * Counts only live work — not terminal sessions left attached by accident.
     */
    getStatusSnapshot(): DaemonStatusResult {
        const snap = this.controller.snapshot();
        // Prefer control-plane lease counts (single source of truth for admitted work).
        const activeTaskCount = snap.byKind.session_task;
        const liveSessions = this.collectLiveSessionIds();
        // Waves: only count active waves that still have live session work.
        let activeWaveCount = 0;
        for (const [sessionId, waves] of this.sessionWaves) {
            if (!liveSessions.has(sessionId) && (this.activeTasks.get(sessionId)?.size ?? 0) === 0) {
                continue;
            }
            for (const wave of waves) {
                if (wave.status === "active") activeWaveCount += 1;
            }
        }

        const mem = process.memoryUsage();
        const caps = snap.capabilities;

        return {
            processStatus: "alive",
            mode: this.getMode(),
            uptimeSeconds: snap.uptimeSeconds,
            activeSessions: buildMetric(
                Math.max(liveSessions.size, snap.activeWork > 0 ? liveSessions.size : 0),
                "count"
            ),
            activeWaves: buildMetric(activeWaveCount, "count"),
            activeTasks: buildMetric(
                Math.max(activeTaskCount, [...this.activeTasks.values()].reduce((n, m) => n + m.size, 0)),
                "count"
            ),
            tokensUsed: unavailableMetric(
                "No daemon-wide token ledger is wired; field is not simulated as zero."
            ),
            memory: {
                rssBytes: mem.rss,
                heapUsedBytes: mem.heapUsed,
                heapTotalBytes: mem.heapTotal,
            },
            capabilities: {
                statusMetrics: true,
                modeSwitching: true,
                supportedModes: caps.supportedModes,
                emergencyBrake: true,
                brakeRecoverable: false,
                modePersistence: caps.modePersistence,
                tokenMetrics: false,
            },
            timestamp: snap.timestamp,
            operationalState: snap.state,
            admissionOpen: snap.admissionOpen,
            controlPlane: {
                activeWork: snap.activeWork,
                byKind: snap.byKind,
                persistence: snap.persistence,
            },
        } as DaemonStatusResult;
    }

    /**
     * Emergency brake via atomic control plane (closes admission first),
     * then cancels session orchestrators and settles tasks.
     * Cancel is terminal for the execution (brakeRecoverable=false).
     */
    async emergencyBrake(): Promise<EmergencyBrakeResult> {
        const TASK_SETTLE_MS = 3_000;

        // Atomic: close admission + abort all leases under exclusive lock.
        const plane = await this.controller.emergencyBrake("emergency brake");

        // Session-level cleanup for any remaining live maps (orchestrators/tasks).
        const sessionIds = this.collectLiveSessionIds();
        const sessions: EmergencyBrakeSessionResult[] = [];
        let interruptedCount = plane.works.filter(
            (w) => w.action === "cancelled_confirmed"
        ).length;
        let failedCount = plane.works.filter(
            (w) =>
                w.action === "failed" ||
                w.action === "abort_requested_unconfirmed" ||
                w.action === "detached_remote" ||
                w.action === "unsupported"
        ).length;
        let checkpointTimersCleared = 0;
        let checkpointDegradedCount = 0;

        for (const sessionId of sessionIds) {
            const entry: EmergencyBrakeSessionResult = {
                sessionId,
                status: "failed",
                cancelApplied: false,
                persistOk: false,
                checkpointOk: "skipped",
                tasksSettled: false,
            };
            try {
                const stored = await this.storage.getSession(sessionId).catch(() => null);
                if (stored && SessionManager.TERMINAL_STATUSES.has(stored.status)) {
                    this.releaseSessionRuntime(sessionId);
                    entry.status = "skipped";
                    entry.error = `Session already ${stored.status}`;
                    sessions.push(entry);
                    continue;
                }

                this.activeOrchestrators.get(sessionId)?.cancel("Emergency brake");
                entry.cancelApplied = true;

                try {
                    await this.storage.updateSession(sessionId, { status: "paused" });
                    entry.persistOk = true;
                } catch (err) {
                    entry.persistOk = false;
                    entry.error = err instanceof Error ? err.message : String(err);
                }

                const waves = this.sessionWaves.get(sessionId);
                if (waves) {
                    for (const wave of waves) {
                        if (wave.status === "active") wave.status = "pending";
                        for (const task of wave.tasks) {
                            if (task.phase !== "complete") task.phase = "paused";
                        }
                    }
                }

                try {
                    await this.createCheckpoint(sessionId);
                    entry.checkpointOk = true;
                } catch {
                    entry.checkpointOk = false;
                    checkpointDegradedCount += 1;
                }

                const timer = this.checkpointIntervals.get(sessionId);
                if (timer) {
                    clearInterval(timer);
                    this.checkpointIntervals.delete(sessionId);
                    checkpointTimersCleared += 1;
                }

                const taskMap = this.activeTasks.get(sessionId);
                if (taskMap && taskMap.size > 0) {
                    const pending = Array.from(taskMap.values()).map((p) => p.catch(() => undefined));
                    entry.tasksSettled = await Promise.race([
                        Promise.all(pending).then(() => true),
                        new Promise<false>((r) => setTimeout(() => r(false), TASK_SETTLE_MS)),
                    ]);
                } else {
                    entry.tasksSettled = true;
                }

                if (entry.cancelApplied && entry.persistOk && entry.tasksSettled) {
                    entry.status = "interrupted";
                    interruptedCount += 1;
                } else {
                    entry.status = "failed";
                    failedCount += 1;
                }
                sessions.push(entry);
            } catch (err) {
                entry.status = "failed";
                entry.error = err instanceof Error ? err.message : String(err);
                failedCount += 1;
                sessions.push(entry);
            }
        }

        // Map control-plane outcome; degrade complete if session cleanup failed or persist failed.
        let outcome = plane.outcome;
        if (failedCount > 0 && outcome === "all_stopped") outcome = "partial";
        if (failedCount > 0 && outcome === "no_active_work") outcome = "partial";
        const complete = plane.complete && failedCount === 0;

        this.eventBus.emit("daemon", {
            type: "emergency_brake",
            outcome,
            interruptedCount,
            failedCount,
        });

        return {
            outcome,
            complete,
            sessions,
            interruptedCount,
            failedCount,
            checkpointTimersCleared,
            checkpointDegradedCount,
            mode: "pause",
            timestamp: plane.timestamp,
            message: plane.message,
            works: plane.works,
            operationId: plane.operationId,
            persistence: plane.persistence,
            admissionClosed: true,
            brakeRecoverable: false,
            unresolvedWorkCount: plane.unresolvedWorkCount,
            pendingCategories: plane.pendingCategories,
        } as EmergencyBrakeResult;
    }

    /**
     * Register an in-memory orchestrator for tests / emergency-brake targets
     * without going through full session create.
     */
    protected attachOrchestratorForTest(sessionId: string, orchestrator: Orchestrator): void {
        this.activeOrchestrators.set(sessionId, orchestrator);
    }

    protected getActiveSessionIdsForTest(): string[] {
        return [...this.activeOrchestrators.keys()];
    }

    protected releaseSessionRuntimeForTest(sessionId: string): void {
        this.releaseSessionRuntime(sessionId);
    }

    /**
     * Add a task for testing purposes or internal use.
     */
    protected addTask(sessionId: string, taskId: string, promise: Promise<void>): void {
        this.getOrCreateSessionTasksMap(sessionId).set(taskId, promise);
    }

    async createSession(data: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Promise<Session> {
        // Creating a session is allowed while paused, but the orchestrator starts paused
        // and sendInput remains blocked until mode is running and not braked.
        const session = await this.storage.createSession({
            ...data,
            status: this.acceptsNewWork() ? data.status ?? "active" : "paused",
        } as Omit<Session, "id" | "createdAt" | "updatedAt">);

        const orchestrator = new Orchestrator(
            { verbose: true, skipPhaseValidation: true },
            this.eventBus
        );
        
        if (this.apiKey) {
            orchestrator.initialize(this.apiKey);
        } else {
            this.eventBus.log('warn', 'Orchestrator not initialized: No API Key provided', 'SessionManager');
        }

        if (!this.acceptsNewWork()) {
            orchestrator.pause();
        }

        this.activeOrchestrators.set(session.id, orchestrator);
        this.sessionWaves.set(session.id, []);

        this.startCheckpointTimer(session.id);
        this.getOrCreateSessionTasksMap(session.id);

        this.eventBus.emit('task', {
            type: 'started',
            sessionId: session.id,
            data: { status: session.status },
        });

        this.eventBus.log('info', `Session created: ${session.id}`, 'SessionManager');

        return session;
    }

    async getSession(id: string): Promise<Session | null> {
        return this.storage.getSession(id);
    }

    async listSessions(status?: string): Promise<SessionSummary[]> {
        const filter = status ? { status: status as Session['status'] } : undefined;
        return this.storage.listSessions(filter);
    }

    async attachSession(id: string): Promise<Session> {
        const session = await this.storage.getSession(id);

        if (!session) {
            throw new Error(`Session not found: ${id}`);
        }

        if (session.status === 'completed' || session.status === 'failed') {
            throw new Error(`Cannot attach to ${session.status} session`);
        }

        if (!this.activeOrchestrators.has(id)) {
            const orchestrator = new Orchestrator(
                { verbose: true, skipPhaseValidation: true },
                this.eventBus
            );
            
            if (this.apiKey) {
                orchestrator.initialize(this.apiKey);
            }

            if (!this.acceptsNewWork()) {
                orchestrator.pause();
            }
            this.activeOrchestrators.set(id, orchestrator);
        } else if (!this.acceptsNewWork()) {
            this.activeOrchestrators.get(id)?.pause();
        }

        const waves = await this.storage.listWaves(id);
        this.sessionWaves.set(id, waves.map(w => ({
            id: w.id,
            number: w.waveNumber,
            status: w.status,
            tasks: w.taskData,
        })));

        this.startCheckpointTimer(id);
        this.getOrCreateSessionTasksMap(id);

        this.eventBus.log('info', `Client attached to session: ${id}`, 'SessionManager');

        return session;
    }

    async updateSession(id: string, data: Partial<Session>): Promise<void> {
        await this.storage.updateSession(id, data);

        if (data.status) {
            this.eventBus.emit('task', {
                type: data.status === 'completed' ? 'completed' :
                    data.status === 'failed' ? 'failed' : 'progress',
                sessionId: id,
                data: { status: data.status },
            });
        }
    }

    async saveWaveState(sessionId: string, wave: WaveState): Promise<void> {
        const existingWaves = this.sessionWaves.get(sessionId) || [];
        const existingIndex = existingWaves.findIndex(w => w.number === wave.number);
        
        if (existingIndex >= 0) {
            existingWaves[existingIndex] = wave;
        } else {
            existingWaves.push(wave);
        }
        
        this.sessionWaves.set(sessionId, existingWaves);

        await this.storage.saveWave({
            sessionId,
            waveNumber: wave.number,
            status: wave.status,
            taskCount: wave.tasks.length,
            completedCount: wave.tasks.filter(t => t.phase === 'complete').length,
            taskData: wave.tasks,
        });
    }

    async restoreWaveStates(sessionId: string): Promise<WaveState[]> {
        const waves = await this.storage.listWaves(sessionId);
        const waveStates: WaveState[] = waves.map(w => ({
            id: w.id,
            number: w.waveNumber,
            status: w.status,
            tasks: w.taskData,
        }));
        
        this.sessionWaves.set(sessionId, waveStates);
        return waveStates;
    }

    private startCheckpointTimer(sessionId: string): void {
        const existingTimer = this.checkpointIntervals.get(sessionId);
        if (existingTimer) {
            clearInterval(existingTimer);
        }

        const timer = setInterval(async () => {
            try {
                await this.createCheckpoint(sessionId);
            } catch (error) {
                this.eventBus.log('error', `Checkpoint failed: ${error}`, 'SessionManager');
            }
        }, this.checkpointIntervalMs);

        this.checkpointIntervals.set(sessionId, timer);
    }

    async createCheckpoint(sessionId: string): Promise<SessionCheckpoint> {
        const waves = this.sessionWaves.get(sessionId) || [];
        
        const state: Record<string, unknown> = {
            waves,
            timestamp: new Date().toISOString(),
        };

        const checkpoint = await this.storage.createCheckpoint(sessionId, state);
        
        await this.storage.deleteOldCheckpoints(sessionId, this.maxCheckpoints);

        this.eventBus.log('debug', `Checkpoint created: ${checkpoint.checkpointNumber}`, 'SessionManager');
        
        return checkpoint;
    }

    async restoreFromCheckpoint(sessionId: string): Promise<boolean> {
        const checkpoint = await this.storage.getLatestCheckpoint(sessionId);
        
        if (!checkpoint) {
            this.eventBus.log('warn', 'No checkpoint found for session', 'SessionManager');
            return false;
        }

        const state = checkpoint.state as { waves?: WaveState[] };
        
        if (state.waves) {
            this.sessionWaves.set(sessionId, state.waves);
        }

        this.eventBus.log('info', `Restored from checkpoint #${checkpoint.checkpointNumber}`, 'SessionManager');
        return true;
    }

    async sendInput(sessionId: string, prompt: string): Promise<{ taskId: string }> {
        // Atomic admission: lease is registered before any I/O or provider side effects.
        let lease;
        try {
            lease = await this.controller.acquire({
                kind: "session_task",
                sessionId,
                label: "sendInput",
            });
        } catch (e) {
            if (e instanceof AdmissionDeniedError) throw e;
            throw e;
        }

        const orchestrator = this.activeOrchestrators.get(sessionId);
        if (!orchestrator) {
            lease.fail(new Error("no orchestrator"));
            throw new Error(`No active orchestrator for session: ${sessionId}`);
        }

        // Wire lease abort → orchestrator cancel (provider AbortSignal + loop exit).
        const onLeaseAbort = () => {
            try {
                orchestrator.cancel("lease aborted");
            } catch {
                /* ignore */
            }
        };
        lease.signal.abortSignal.addEventListener("abort", onLeaseAbort, { once: true });
        // Cooperative pause: only claim execution_paused when orchestrator observes it.
        const unsubPause = lease.signal.onPausedChange((paused) => {
            if (paused) orchestrator.pause();
            else if (!orchestrator.isCancelled()) orchestrator.resume();
        });
        if (lease.signal.paused) orchestrator.pause();

        try {
            await this.storage.appendLog({
                sessionId,
                type: "input",
                content: prompt,
            });
        } catch (e) {
            unsubPause();
            lease.fail(e);
            throw e;
        }

        const task = createTask(prompt, PersonaType.DEVELOPER, {
            id: `task_${sessionId}_${Date.now()}`,
        });

        const execution = orchestrator
            .loopUntilSuccess(task)
            .then(async (result) => {
                const isCancelled = result.status === "CANCELLED";
                await this.storage.appendLog({
                    sessionId,
                    type: result.status === "SUCCESS" ? "output" : "error",
                    content: result.output || result.error || "No output",
                });

                const nextStatus =
                    result.status === "SUCCESS"
                        ? "completed"
                        : result.status === "NEEDS_HUMAN"
                          ? "paused"
                          : isCancelled
                            ? "paused"
                            : "failed";

                await this.updateSession(sessionId, { status: nextStatus });

                if (nextStatus === "completed" || nextStatus === "failed") {
                    this.releaseSessionRuntime(sessionId);
                }

                if (isCancelled || lease.signal.aborted) {
                    lease.acknowledgeAbort();
                    lease.fail(new Error("cancelled"));
                } else if (result.status === "SUCCESS") {
                    lease.complete(result);
                } else {
                    lease.fail(result.error ?? result.status);
                }

                this.eventBus.log("info", `Task ${task.id} finished: ${result.status}`, "SessionManager");
            })
            .catch(async (err) => {
                const message = err instanceof Error ? err.message : String(err);
                this.eventBus.log("error", `Task ${task.id} crashed: ${message}`, "SessionManager");
                try {
                    await this.updateSession(sessionId, { status: "failed" });
                } catch {
                    /* storage may be unavailable */
                }
                this.releaseSessionRuntime(sessionId);
                if (lease.signal.aborted) lease.acknowledgeAbort();
                lease.fail(err);
            })
            .finally(() => {
                unsubPause();
                this.removeTaskPromise(sessionId, task.id);
                lease.release();
            });

        // Register promise only after lease exists (brake always sees admitted work).
        this.getOrCreateSessionTasksMap(sessionId).set(task.id, execution);

        this.eventBus.log("info", `Task started for session ${sessionId}: ${task.id}`, "SessionManager");

        return { taskId: task.id };
    }

    async interruptSession(sessionId: string): Promise<void> {
        const orchestrator = this.activeOrchestrators.get(sessionId);

        if (orchestrator) {
            orchestrator.pause();
        }

        await this.storage.updateSession(sessionId, { status: 'paused' });
        await this.createCheckpoint(sessionId);

        this.eventBus.emit('task', {
            type: 'progress',
            sessionId,
            data: { action: 'interrupted' },
        });

        this.eventBus.log('info', `Session interrupted: ${sessionId}`, 'SessionManager');
    }

    /**
     * Allows new work on a session only when the daemon accepts work.
     * Does NOT re-run a cancelled task (brakeRecoverable=false).
     */
    async resumeSession(sessionId: string): Promise<void> {
        this.assertAcceptsNewWork("resumeSession");

        const orchestrator = this.activeOrchestrators.get(sessionId);

        if (orchestrator) {
            orchestrator.resume();
        }

        await this.storage.updateSession(sessionId, { status: 'active' });

        this.eventBus.emit('task', {
            type: 'progress',
            sessionId,
            data: { action: 'resumed' },
        });

        this.eventBus.log('info', `Session resumed: ${sessionId}`, 'SessionManager');
    }

    async saveMemory(sessionId: string, type: SessionMemory['type'], content: string, source?: string): Promise<SessionMemory> {
        return this.storage.saveMemory({
            sessionId,
            type,
            content,
            source,
        });
    }

    async getMemory(sessionId: string, filter?: { type?: SessionMemory['type'] }): Promise<SessionMemory[]> {
        return this.storage.listMemory(sessionId, filter);
    }

    /**
     * Get or create the per-session map of active task promises.
     */
    private getOrCreateSessionTasksMap(sessionId: string): Map<string, Promise<void>> {
        if (!this.activeTasks.has(sessionId)) {
            this.activeTasks.set(sessionId, new Map());
        }
        return this.activeTasks.get(sessionId)!;
    }

    /**
     * Check if a session has active tasks (for testing/diagnostics)
     */
    protected hasActiveTasks(sessionId: string): boolean {
        return (this.activeTasks.get(sessionId)?.size ?? 0) > 0;
    }

    /**
     * Cleanup resources for a session
     */
    async cleanupSession(sessionId: string): Promise<void> {
        const timer = this.checkpointIntervals.get(sessionId);
        if (timer) {
            clearInterval(timer);
            this.checkpointIntervals.delete(sessionId);
        }
        
        this.activeOrchestrators.delete(sessionId);
        this.sessionWaves.delete(sessionId);

        let iterations = 0;

        while (iterations < this.maxCleanupIterations) {
            const sessionTasksMap = this.activeTasks.get(sessionId);

            if (!sessionTasksMap || sessionTasksMap.size === 0) {
                if (sessionTasksMap && this.activeTasks.get(sessionId) === sessionTasksMap) {
                     this.activeTasks.delete(sessionId);
                }
                break;
            }

            const tasksToCleanup = Array.from(sessionTasksMap.entries());

            const promisesToAwait = tasksToCleanup.map(([_, promise]) =>
                promise.catch((err) => {
                    const message = err instanceof Error ? err.stack ?? err.message : String(err);
                    this.eventBus.log('debug', `Task cleanup error: ${message}`, 'SessionManager');
                })
            );

            const cleanupPromise = Promise.all(promisesToAwait);

            let timeoutId: ReturnType<typeof setTimeout> | undefined;

            const timeoutPromise = new Promise<typeof TIMEOUT_SYMBOL>((resolve) => {
                timeoutId = setTimeout(() => resolve(TIMEOUT_SYMBOL), this.cleanupTimeoutMs);
            });

            try {
                const result = await Promise.race([cleanupPromise, timeoutPromise]);

                if (result === TIMEOUT_SYMBOL) {
                    this.eventBus.log('warn', `cleanupSession iteration ${iterations + 1} timed out after ${this.cleanupTimeoutMs}ms for session ${sessionId}`, 'SessionManager');
                }
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
            }

            if (this.activeTasks.get(sessionId) === sessionTasksMap) {
                for (const [taskId] of tasksToCleanup) {
                    sessionTasksMap.delete(taskId);
                }
                if (sessionTasksMap.size === 0) {
                    this.activeTasks.delete(sessionId);
                }
            }

            iterations++;
        }

        const finalMap = this.activeTasks.get(sessionId);
        if (finalMap && finalMap.size > 0) {
            this.eventBus.log('warn', `Force removing ${finalMap.size} remaining tasks for session ${sessionId} after max iterations/timeout`, 'SessionManager');
            finalMap.clear();
            this.activeTasks.delete(sessionId);
        }
    }
}
