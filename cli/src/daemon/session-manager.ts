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

export class SessionManager {
    private storage: StoragePort;
    private eventBus: EventBus;
    private activeOrchestrators: Map<string, Orchestrator> = new Map();
    private activeTasks: Map<string, Promise<void>> = new Map();

    private apiKey?: string;

    constructor(storage: StoragePort, eventBus: EventBus, apiKey?: string) {
        this.storage = storage;
        this.eventBus = eventBus;
        this.apiKey = apiKey;
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

        this.activeTasks.set(task.id, execution);

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

        // Loop to catch any tasks added concurrently
        // We limit iterations to prevent infinite loops if tasks keep being scheduled
        let iterations = 0;
        const maxIterations = 5;

        while (iterations < maxIterations) {
            // Collect all tasks to cleanup
            // Note: This iterates the entire activeTasks map, but expected volume is low per session
            // and total active tasks across all sessions should remain manageable.
            const tasksToCleanup = Array.from(this.activeTasks.entries())
                .filter(([taskId]) => taskId.includes(sessionId));

            if (tasksToCleanup.length === 0) {
                break;
            }

            const promisesToAwait = tasksToCleanup.map(([_, promise]) =>
                promise.catch(() => { /* ignore errors */ })
            );

            // Wait for all tasks to finish concurrently
            await Promise.all(promisesToAwait);

            // Remove from active tasks map
            for (const [taskId] of tasksToCleanup) {
                this.activeTasks.delete(taskId);
            }

            iterations++;
        }

        if (iterations >= maxIterations) {
            this.eventBus.log('warn', `cleanupSession reached max iterations (${maxIterations}) for session ${sessionId}`, 'SessionManager');
        }
    }

}
