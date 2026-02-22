/**
 * 📋 Session Manager
 * 
 * Gerencia ciclo de vida das sessões.
 * Cada sessão representa uma execução de agente que pode ser pausada/resumida.
 */

import type { StoragePort, Session, SessionSummary } from '../ports/storage.port.js';
import type { EventBus } from './event-bus.js';
import { Orchestrator, createTask } from '../orchestration/index.js';
import { PersonaType } from '../orchestration/types.js';


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
}

export class SessionManager {
    private readonly maxCleanupIterations: number;
    private readonly cleanupTimeoutMs: number;

    private storage: StoragePort;
    private eventBus: EventBus;
    private activeOrchestrators: Map<string, Orchestrator> = new Map();
    // Map<sessionId, Map<taskId, Promise<void>>>
    private activeTasks: Map<string, Map<string, Promise<void>>> = new Map();

    private apiKey?: string;

    constructor(storage: StoragePort, eventBus: EventBus, apiKey?: string, config?: SessionManagerConfig) {
        this.storage = storage;
        this.eventBus = eventBus;
        this.apiKey = apiKey;
        this.maxCleanupIterations = config?.maxCleanupIterations ?? 3;
        this.cleanupTimeoutMs = config?.cleanupTimeoutMs ?? 5000;
    }

    async createSession(data: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Promise<Session> {
        const session = await this.storage.createSession(data);

        // Create orchestrator for this session
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
        this.activeTasks.set(session.id, new Map());

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

        // Ensure orchestrator exists for attached session
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

        if (!this.activeTasks.has(id)) {
            this.activeTasks.set(id, new Map());
        }

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

    async sendInput(sessionId: string, prompt: string): Promise<{ taskId: string }> {
        const orchestrator = this.activeOrchestrators.get(sessionId);

        if (!orchestrator) {
            throw new Error(`No active orchestrator for session: ${sessionId}`);
        }

        // Log input
        await this.storage.appendLog({
            sessionId,
            type: 'input',
            content: prompt,
        });

        // Create task and execute
        const task = createTask(prompt, PersonaType.DEVELOPER, {
            id: `task_${sessionId}_${Date.now()}`,
        });

        // Execute asynchronously
        const execution = orchestrator.loopUntilSuccess(task).then(async (result) => {
            // Log output
            await this.storage.appendLog({
                sessionId,
                type: result.status === 'SUCCESS' ? 'output' : 'error',
                content: result.output || result.error || 'No output',
            });

            // Update session status
            await this.updateSession(sessionId, {
                status: result.status === 'SUCCESS' ? 'completed' :
                    result.status === 'NEEDS_HUMAN' ? 'paused' : 'failed',
            });

            this.eventBus.log('info', `Task ${task.id} finished: ${result.status}`, 'SessionManager');
        });

        if (!this.activeTasks.has(sessionId)) {
            this.activeTasks.set(sessionId, new Map());
        }
        this.activeTasks.get(sessionId)!.set(task.id, execution);

        this.eventBus.log('info', `Task started for session ${sessionId}: ${task.id}`, 'SessionManager');

        return { taskId: task.id };
    }

    async interruptSession(sessionId: string): Promise<void> {
        const orchestrator = this.activeOrchestrators.get(sessionId);

        if (orchestrator) {
            orchestrator.pause();
        }

        await this.storage.updateSession(sessionId, { status: 'paused' });

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

    /**
     * Cleanup resources for a session
     */
    async cleanupSession(sessionId: string): Promise<void> {
        this.activeOrchestrators.delete(sessionId);

        let iterations = 0;

        while (iterations < this.maxCleanupIterations) {
            const sessionTasksMap = this.activeTasks.get(sessionId);

            if (!sessionTasksMap || sessionTasksMap.size === 0) {
                // Remove the empty session map
                this.activeTasks.delete(sessionId);
                break;
            }

            const tasksToCleanup = Array.from(sessionTasksMap.entries());

            const promisesToAwait = tasksToCleanup.map(([_, promise]) =>
                promise.catch(() => { /* ignore errors */ })
            );

            // Wait for all tasks to finish concurrently with a timeout
            const cleanupPromise = Promise.all(promisesToAwait);

            let timeoutId: ReturnType<typeof setTimeout>;
            // Use a unique symbol to distinguish timeout
            const TIMEOUT = Symbol('TIMEOUT');

            const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
                timeoutId = setTimeout(() => resolve(TIMEOUT), this.cleanupTimeoutMs);
            });

            try {
                const result = await Promise.race([cleanupPromise, timeoutPromise]);

                if (result === TIMEOUT) {
                    this.eventBus.log('warn', `cleanupSession iteration ${iterations + 1} timed out after ${this.cleanupTimeoutMs}ms for session ${sessionId}`, 'SessionManager');
                }
            } finally {
                // Ensure timer is cleared if cleanup finishes first
                clearTimeout(timeoutId!);
            }

            // Remove from active tasks map
            for (const [taskId] of tasksToCleanup) {
                sessionTasksMap.delete(taskId);
            }

            iterations++;
        }

        // Final force cleanup verification
        const sessionTasksMap = this.activeTasks.get(sessionId);
        if (sessionTasksMap && sessionTasksMap.size > 0) {
            this.eventBus.log('warn', `Force removing ${sessionTasksMap.size} remaining tasks for session ${sessionId} after max iterations/timeout`, 'SessionManager');
            sessionTasksMap.clear();
            this.activeTasks.delete(sessionId);
        }
    }
}
