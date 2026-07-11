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

    constructor(storage: StoragePort, eventBus: EventBus, apiKey?: string, config?: SessionManagerConfig) {
        this.storage = storage;
        this.eventBus = eventBus;
        this.apiKey = apiKey;
        this.maxCleanupIterations = config?.maxCleanupIterations ?? DEFAULT_SESSION_MANAGER_CONFIG.maxCleanupIterations!;
        this.cleanupTimeoutMs = config?.cleanupTimeoutMs ?? DEFAULT_SESSION_MANAGER_CONFIG.cleanupTimeoutMs!;
        this.checkpointIntervalMs = config?.checkpointIntervalMs ?? DEFAULT_SESSION_MANAGER_CONFIG.checkpointIntervalMs!;
        this.maxCheckpoints = config?.maxCheckpoints ?? DEFAULT_SESSION_MANAGER_CONFIG.maxCheckpoints!;
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

        const execution = orchestrator.loopUntilSuccess(task).then(async (result) => {
            await this.storage.appendLog({
                sessionId,
                type: result.status === 'SUCCESS' ? 'output' : 'error',
                content: result.output || result.error || 'No output',
            });

            await this.updateSession(sessionId, {
                status: result.status === 'SUCCESS' ? 'completed' :
                    result.status === 'NEEDS_HUMAN' ? 'paused' : 'failed',
            });

            this.eventBus.log('info', `Task ${task.id} finished: ${result.status}`, 'SessionManager');
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
