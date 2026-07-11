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
    DAEMON_CAPABILITIES,
    buildMetric,
    unavailableMetric,
} from './daemon-controls.js';

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

    /** Operational mode — backend source of truth (issue #37). */
    private mode: DaemonMode = "running";

    /** True after an emergency brake that left work interrupted; cleared when mode returns to running. */
    private braked = false;

    constructor(storage: StoragePort, eventBus: EventBus, apiKey?: string, config?: SessionManagerConfig) {
        this.storage = storage;
        this.eventBus = eventBus;
        this.apiKey = apiKey;
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

    /** Current operational mode stored in this process. */
    getMode(): DaemonMode {
        return this.mode;
    }

    /**
     * Apply a mode change with validation. Observable: `getMode()` reflects the result.
     * pause → pauses all live orchestrators; running/frenzy from pause → resumes them.
     */
    async setMode(requested: unknown): Promise<SetModeResult> {
        const previousMode = this.mode;
        const timestamp = new Date().toISOString();

        if (!isDaemonMode(requested)) {
            return {
                operation: "rejected_invalid_mode",
                previousMode,
                requestedMode: requested === undefined || requested === null ? null : String(requested),
                resultingMode: previousMode,
                reason: `Unknown mode. Valid modes: running, pause, frenzy.`,
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

        if (previousMode === requested) {
            return {
                operation: "unchanged",
                previousMode,
                requestedMode: requested,
                resultingMode: previousMode,
                reason: "Mode already set to the requested value.",
                timestamp,
            };
        }

        this.mode = requested;

        if (requested === "pause") {
            for (const orchestrator of this.activeOrchestrators.values()) {
                orchestrator.pause();
            }
        } else if (previousMode === "pause" && (requested === "running" || requested === "frenzy")) {
            for (const orchestrator of this.activeOrchestrators.values()) {
                orchestrator.resume();
            }
            this.braked = false;
        } else if (requested === "running" || requested === "frenzy") {
            this.braked = false;
        }

        this.eventBus.log("info", `Daemon mode ${previousMode} → ${requested}`, "SessionManager");
        this.eventBus.emit("daemon", {
            type: "mode_changed",
            previousMode,
            mode: requested,
        });

        return {
            operation: "applied",
            previousMode,
            requestedMode: requested,
            resultingMode: this.mode,
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
        let activeTaskCount = 0;
        for (const taskMap of this.activeTasks.values()) {
            activeTaskCount += taskMap.size;
        }

        let activeWaveCount = 0;
        for (const waves of this.sessionWaves.values()) {
            for (const wave of waves) {
                if (wave.status === "active") activeWaveCount += 1;
            }
        }

        const liveSessions = this.collectLiveSessionIds();
        const mem = process.memoryUsage();

        return {
            processStatus: "alive",
            mode: this.mode,
            uptimeSeconds: process.uptime(),
            activeSessions: buildMetric(liveSessions.size, "count"),
            activeWaves: buildMetric(activeWaveCount, "count"),
            activeTasks: buildMetric(activeTaskCount, "count"),
            tokensUsed: unavailableMetric(
                "No daemon-wide token ledger is wired; field is not simulated as zero."
            ),
            memory: {
                rssBytes: mem.rss,
                heapUsedBytes: mem.heapUsed,
                heapTotalBytes: mem.heapTotal,
            },
            capabilities: DAEMON_CAPABILITIES,
            timestamp: new Date().toISOString(),
        };
    }

    /**
     * Emergency brake: cooperative cancel of live work only.
     * Required steps: orchestrator.cancel(), persist paused, settle task promises (budget).
     * Checkpoint is best-effort and reported via checkpointDegradedCount.
     */
    async emergencyBrake(): Promise<EmergencyBrakeResult> {
        const timestamp = new Date().toISOString();
        const wasBraked = this.braked;
        const TASK_SETTLE_MS = 3_000;

        // Only target live work; never rewrite completed/failed sessions as paused.
        const sessionIds = this.collectLiveSessionIds();

        // Also clear orphan checkpoint timers with no tasks (not "work", but stop noise).
        for (const [sessionId, timer] of [...this.checkpointIntervals.entries()]) {
            if ((this.activeTasks.get(sessionId)?.size ?? 0) === 0) {
                clearInterval(timer);
                this.checkpointIntervals.delete(sessionId);
            }
        }

        if (sessionIds.size === 0) {
            const outcome = wasBraked ? "already_stopped" : "no_active_work";
            this.mode = "pause";
            this.braked = true;
            this.eventBus.emit("daemon", {
                type: "emergency_brake",
                outcome,
                interruptedCount: 0,
                failedCount: 0,
            });
            return {
                outcome,
                complete: true,
                sessions: [],
                interruptedCount: 0,
                failedCount: 0,
                checkpointTimersCleared: 0,
                checkpointDegradedCount: 0,
                mode: this.mode,
                timestamp,
                message:
                    outcome === "already_stopped"
                        ? "Emergency brake already engaged; no live work remains."
                        : "No active sessions, tasks, or checkpoint timers to interrupt.",
            };
        }

        const sessions: EmergencyBrakeSessionResult[] = [];
        let interruptedCount = 0;
        let failedCount = 0;
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
                // Skip if storage already terminal (do not corrupt history).
                const stored = await this.storage.getSession(sessionId).catch(() => null);
                if (stored && SessionManager.TERMINAL_STATUSES.has(stored.status)) {
                    this.releaseSessionRuntime(sessionId);
                    entry.status = "skipped";
                    entry.error = `Session already ${stored.status}`;
                    sessions.push(entry);
                    continue;
                }

                const orchestrator = this.activeOrchestrators.get(sessionId);
                if (orchestrator) {
                    orchestrator.cancel("Emergency brake");
                    entry.cancelApplied = true;
                } else {
                    // No orchestrator but tasks present — still try to settle tasks.
                    entry.cancelApplied = true;
                }

                try {
                    await this.storage.updateSession(sessionId, { status: "paused" });
                    entry.persistOk = true;
                } catch (err) {
                    entry.persistOk = false;
                    entry.error = err instanceof Error ? err.message : String(err);
                }

                try {
                    await this.createCheckpoint(sessionId);
                    entry.checkpointOk = true;
                } catch (err) {
                    entry.checkpointOk = false;
                    checkpointDegradedCount += 1;
                    const message = err instanceof Error ? err.message : String(err);
                    this.eventBus.log(
                        "warn",
                        `Emergency brake checkpoint failed (best-effort) for ${sessionId}: ${message}`,
                        "SessionManager"
                    );
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

                const timer = this.checkpointIntervals.get(sessionId);
                if (timer) {
                    clearInterval(timer);
                    this.checkpointIntervals.delete(sessionId);
                    checkpointTimersCleared += 1;
                }

                // Wait for cooperative cancel to settle tracked promises.
                const taskMap = this.activeTasks.get(sessionId);
                if (taskMap && taskMap.size > 0) {
                    const pending = Array.from(taskMap.values()).map((p) =>
                        p.catch(() => undefined)
                    );
                    const settled = await Promise.race([
                        Promise.all(pending).then(() => true),
                        new Promise<false>((resolve) =>
                            setTimeout(() => resolve(false), TASK_SETTLE_MS)
                        ),
                    ]);
                    entry.tasksSettled = settled;
                } else {
                    entry.tasksSettled = true;
                }

                this.eventBus.emit("task", {
                    type: "progress",
                    sessionId,
                    data: { action: "emergency_brake" },
                });

                const requiredOk =
                    entry.cancelApplied === true &&
                    entry.persistOk === true &&
                    entry.tasksSettled === true;

                if (requiredOk) {
                    entry.status = "interrupted";
                    interruptedCount += 1;
                } else {
                    entry.status = "failed";
                    failedCount += 1;
                    if (!entry.error) {
                        entry.error = !entry.persistOk
                            ? "Failed to persist paused status"
                            : !entry.tasksSettled
                              ? "In-flight tasks did not settle after cancel"
                              : "Cancel not applied";
                    }
                }
                sessions.push(entry);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                entry.status = "failed";
                entry.error = message;
                failedCount += 1;
                sessions.push(entry);
                this.eventBus.log(
                    "error",
                    `Emergency brake failed for ${sessionId}: ${message}`,
                    "SessionManager"
                );
            }
        }

        this.mode = "pause";
        this.braked = true;

        let outcome: EmergencyBrakeResult["outcome"];
        if (failedCount > 0) {
            outcome = "partial";
        } else if (wasBraked) {
            outcome = "already_stopped";
        } else {
            outcome = "all_stopped";
        }

        const complete = failedCount === 0;

        this.eventBus.log(
            complete ? "warn" : "error",
            `Emergency brake outcome=${outcome} interrupted=${interruptedCount} failed=${failedCount} checkpointDegraded=${checkpointDegradedCount}`,
            "SessionManager"
        );
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
            mode: this.mode,
            timestamp,
            message: complete
                ? `Interrupted ${interruptedCount} session(s); mode is pause.${
                      checkpointDegradedCount > 0
                          ? ` (${checkpointDegradedCount} checkpoint(s) degraded, best-effort)`
                          : ""
                  }`
                : `Partial emergency brake: ${interruptedCount} interrupted, ${failedCount} failed.`,
        };
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
        const session = await this.storage.createSession(data);

        const orchestrator = new Orchestrator(
            { verbose: true, skipPhaseValidation: true },
            this.eventBus
        );
        
        if (this.apiKey) {
            orchestrator.initialize(this.apiKey);
        } else {
            this.eventBus.log('warn', 'Orchestrator not initialized: No API Key provided', 'SessionManager');
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

            this.activeOrchestrators.set(id, orchestrator);
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
        const orchestrator = this.activeOrchestrators.get(sessionId);

        if (!orchestrator) {
            throw new Error(`No active orchestrator for session: ${sessionId}`);
        }

        await this.storage.appendLog({
            sessionId,
            type: 'input',
            content: prompt,
        });

        const task = createTask(prompt, PersonaType.DEVELOPER, {
            id: `task_${sessionId}_${Date.now()}`,
        });

        const execution = orchestrator
            .loopUntilSuccess(task)
            .then(async (result) => {
                const isCancelled = result.status === 'CANCELLED';
                await this.storage.appendLog({
                    sessionId,
                    type: result.status === 'SUCCESS' ? 'output' : 'error',
                    content: result.output || result.error || 'No output',
                });

                const nextStatus =
                    result.status === 'SUCCESS'
                        ? 'completed'
                        : result.status === 'NEEDS_HUMAN' || isCancelled
                          ? 'paused'
                          : 'failed';

                await this.updateSession(sessionId, { status: nextStatus });

                if (nextStatus === 'completed' || nextStatus === 'failed') {
                    this.releaseSessionRuntime(sessionId);
                }

                this.eventBus.log('info', `Task ${task.id} finished: ${result.status}`, 'SessionManager');
            })
            .catch(async (err) => {
                const message = err instanceof Error ? err.message : String(err);
                this.eventBus.log('error', `Task ${task.id} crashed: ${message}`, 'SessionManager');
                try {
                    await this.updateSession(sessionId, { status: 'failed' });
                } catch {
                    /* storage may be unavailable */
                }
                this.releaseSessionRuntime(sessionId);
            })
            .finally(() => {
                this.removeTaskPromise(sessionId, task.id);
            });

        this.getOrCreateSessionTasksMap(sessionId).set(task.id, execution);

        this.eventBus.log('info', `Task started for session ${sessionId}: ${task.id}`, 'SessionManager');

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

    async resumeSession(sessionId: string): Promise<void> {
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
