/**
 * 📋 Priority Task Queue
 * 
 * Fila de tasks com prioridade, persistência, timeouts e dedup hash-based.
 * 
 * Inspirado pelo supervisor/queue.py do razzant/ouroboros.
 * ADR-01: Hash-based dedup (não LLM-based) para eficiência.
 * 
 * Features:
 * - Prioridade (1-10, maior = mais urgente)
 * - Timeout por task (soft timeout emite warning, hard timeout cancela)
 * - Dedup via hash de instrução normalizada
 * - Persistência via JSON snapshot
 * - Integração com EventBus
 */

import { createHash } from 'crypto';
import { EventBus, globalEventBus } from '../daemon/event-bus.js';
import { createEventLogger } from '../daemon/event-logger.js';

// ============================================================
// Types
// ============================================================

export interface QueuedTask {
    /** ID único */
    id: string;
    /** Instrução da task */
    instruction: string;
    /** Prioridade (1-10, 10 = highest) */
    priority: number;
    /** Categoria */
    category: TaskCategory;
    /** Hash normalizado da instrução (para dedup) */
    hash: string;
    /** Timestamp de enfileiramento */
    enqueuedAt: Date;
    /** Timeout soft em ms (emite warning) */
    softTimeoutMs: number;
    /** Timeout hard em ms (cancela task) */
    hardTimeoutMs: number;
    /** Status atual */
    status: QueueTaskStatus;
    /** Metadata adicional */
    metadata?: Record<string, unknown>;
    /** ID da task pai (para subtasks) */
    parentId?: string;
}

export type QueueTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export type TaskCategory = 'user' | 'evolution' | 'review' | 'consciousness' | 'system';

export interface QueueConfig {
    /** Tamanho máximo da fila */
    maxSize: number;
    /** Se habilita dedup por hash */
    enableDedup: boolean;
    /** Soft timeout padrão em ms (default: 5 min) */
    defaultSoftTimeoutMs: number;
    /** Hard timeout padrão em ms (default: 15 min) */
    defaultHardTimeoutMs: number;
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
    maxSize: 100,
    enableDedup: true,
    defaultSoftTimeoutMs: 5 * 60 * 1000,
    defaultHardTimeoutMs: 15 * 60 * 1000,
};

export interface QueueSnapshot {
    tasks: QueuedTask[];
    timestamp: string;
    version: number;
}

// ============================================================
// Priority Task Queue
// ============================================================

export class PriorityTaskQueue {
    private queue: QueuedTask[] = [];
    private config: QueueConfig;
    private eventBus: EventBus;
    private log: ReturnType<typeof createEventLogger>;
    private knownHashes: Set<string> = new Set();

    constructor(config?: Partial<QueueConfig>, eventBus?: EventBus) {
        this.config = { ...DEFAULT_QUEUE_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
        this.log = createEventLogger('PriorityTaskQueue', this.eventBus);
    }

    // ============================================================
    // Core Operations
    // ============================================================

    /**
     * Enfileira uma task na posição correta baseado em prioridade.
     * Retorna null se for considerada duplicata.
     */
    enqueue(
        instruction: string,
        priority: number = 5,
        category: TaskCategory = 'user',
        options?: {
            softTimeoutMs?: number;
            hardTimeoutMs?: number;
            metadata?: Record<string, unknown>;
            parentId?: string;
        }
    ): QueuedTask | null {
        // Size check
        if (this.queue.filter(t => t.status === 'pending').length >= this.config.maxSize) {
            this.log('warn', `📋 Queue full (${this.config.maxSize}) — rejecting task`);
            return null;
        }

        // Hash-based dedup
        const hash = this.computeHash(instruction);
        if (this.config.enableDedup && this.knownHashes.has(hash)) {
            this.log('debug', `📋 Duplicate task detected (hash: ${hash.substring(0, 8)}) — skipping`);
            return null;
        }

        const task: QueuedTask = {
            id: `task_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            instruction,
            priority: Math.min(10, Math.max(1, priority)),
            category,
            hash,
            enqueuedAt: new Date(),
            softTimeoutMs: options?.softTimeoutMs ?? this.config.defaultSoftTimeoutMs,
            hardTimeoutMs: options?.hardTimeoutMs ?? this.config.defaultHardTimeoutMs,
            status: 'pending',
            metadata: options?.metadata,
            parentId: options?.parentId,
        };

        this.queue.push(task);
        this.knownHashes.add(hash);
        this.sortQueue();

        this.log('debug', `📋 Task enqueued: ${task.id} (priority: ${priority}, category: ${category})`);
        return task;
    }

    /**
     * Remove e retorna a task de maior prioridade.
     * Retorna null se a fila estiver vazia.
     */
    dequeue(): QueuedTask | null {
        const index = this.queue.findIndex(t => t.status === 'pending');
        if (index === -1) return null;

        this.queue[index].status = 'running';
        return this.queue[index];
    }

    /**
     * Peek na task de maior prioridade sem remover.
     */
    peek(): QueuedTask | null {
        return this.queue.find(t => t.status === 'pending') ?? null;
    }

    /**
     * Marca uma task como completa.
     */
    complete(taskId: string): boolean {
        const task = this.queue.find(t => t.id === taskId);
        if (!task) return false;

        task.status = 'completed';
        return true;
    }

    /**
     * Marca uma task como falha.
     */
    fail(taskId: string): boolean {
        const task = this.queue.find(t => t.id === taskId);
        if (!task) return false;

        task.status = 'failed';
        return true;
    }

    /**
     * Cancela uma task pendente.
     */
    cancel(taskId: string): boolean {
        const task = this.queue.find(t => t.id === taskId && t.status === 'pending');
        if (!task) return false;

        task.status = 'cancelled';
        return true;
    }

    // ============================================================
    // Timeout Enforcement
    // ============================================================

    /**
     * Verifica timeouts em tasks em execução.
     * Retorna tasks que excederam o hard timeout.
     */
    enforceTimeouts(): QueuedTask[] {
        const now = Date.now();
        const timedOut: QueuedTask[] = [];

        for (const task of this.queue.filter(t => t.status === 'running')) {
            const elapsed = now - task.enqueuedAt.getTime();

            if (elapsed >= task.hardTimeoutMs) {
                task.status = 'timed_out';
                timedOut.push(task);
                this.log('warn', `📋 Task hard-timed out: ${task.id} (${elapsed}ms)`);
            } else if (elapsed >= task.softTimeoutMs) {
                this.log('warn', `📋 Task soft-timeout warning: ${task.id} (${elapsed}ms)`);
            }
        }

        return timedOut;
    }

    // ============================================================
    // Query
    // ============================================================

    /** Retorna todas as tasks pendentes */
    get pendingTasks(): QueuedTask[] {
        return this.queue.filter(t => t.status === 'pending');
    }

    /** Retorna tasks em execução */
    get runningTasks(): QueuedTask[] {
        return this.queue.filter(t => t.status === 'running');
    }

    /** Tamanho da fila (pendentes) */
    get size(): number {
        return this.pendingTasks.length;
    }

    /** Total de tasks (todos os status) */
    get totalSize(): number {
        return this.queue.length;
    }

    /** Fila está vazia? */
    get isEmpty(): boolean {
        return this.size === 0;
    }

    /** Fila está cheia? */
    get isFull(): boolean {
        return this.size >= this.config.maxSize;
    }

    /** Busca task por ID */
    getTask(taskId: string): QueuedTask | undefined {
        return this.queue.find(t => t.id === taskId);
    }

    /** Retorna tasks por categoria */
    getByCategory(category: TaskCategory): QueuedTask[] {
        return this.queue.filter(t => t.category === category && t.status === 'pending');
    }

    // ============================================================
    // Persistence
    // ============================================================

    /** Cria um snapshot da fila para persistência */
    createSnapshot(): QueueSnapshot {
        return {
            tasks: this.queue.map(t => ({
                ...t,
                enqueuedAt: t.enqueuedAt, // Keep as Date, serialized later
            })),
            timestamp: new Date().toISOString(),
            version: 1,
        };
    }

    /** Restaura a fila de um snapshot */
    restoreFromSnapshot(snapshot: QueueSnapshot): number {
        this.queue = snapshot.tasks.map(t => ({
            ...t,
            enqueuedAt: new Date(t.enqueuedAt),
        }));

        // Rebuild hash set
        this.knownHashes.clear();
        for (const task of this.queue) {
            this.knownHashes.add(task.hash);
        }

        this.sortQueue();
        this.log('info', `📋 Queue restored: ${this.queue.length} tasks from snapshot`);
        return this.queue.length;
    }

    /** Limpa tasks completas/falhadas (garbage collection) */
    purgeCompleted(): number {
        const before = this.queue.length;
        this.queue = this.queue.filter(t =>
            t.status === 'pending' || t.status === 'running'
        );
        const removed = before - this.queue.length;

        if (removed > 0) {
            this.log('debug', `📋 Purged ${removed} completed/failed tasks`);
        }

        return removed;
    }

    /** Limpa toda a fila */
    clear(): void {
        this.queue = [];
        this.knownHashes.clear();
        this.log('debug', '📋 Queue cleared');
    }

    // ============================================================
    // Internal
    // ============================================================

    private sortQueue(): void {
        // Sort: pending first, then by priority (desc), then by enqueue time (asc)
        this.queue.sort((a, b) => {
            // Pending tasks first
            const statusOrder: Record<QueueTaskStatus, number> = {
                pending: 0, running: 1, completed: 2, failed: 3, cancelled: 4, timed_out: 5,
            };
            const statusDiff = statusOrder[a.status] - statusOrder[b.status];
            if (statusDiff !== 0) return statusDiff;

            // Higher priority first
            const priorityDiff = b.priority - a.priority;
            if (priorityDiff !== 0) return priorityDiff;

            // Earlier enqueue first (FIFO within same priority)
            return a.enqueuedAt.getTime() - b.enqueuedAt.getTime();
        });
    }

    /**
     * Computes normalized hash of instruction for dedup.
     * ADR-01: Hash-based, not LLM-based.
     */
    private computeHash(instruction: string): string {
        const normalized = instruction
            .toLowerCase()
            .trim()
            .replace(/\s+/g, ' ')      // Collapse whitespace
            .replace(/[^\w\s]/g, '');   // Remove punctuation
        return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
    }

    // log is created by createEventLogger in constructor
}

// ============================================================
// Factory
// ============================================================

export function createPriorityTaskQueue(
    config?: Partial<QueueConfig>,
    eventBus?: EventBus,
): PriorityTaskQueue {
    return new PriorityTaskQueue(config, eventBus);
}
