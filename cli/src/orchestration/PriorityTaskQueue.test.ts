/**
 * 📋 PriorityTaskQueue Tests
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { PriorityTaskQueue, createPriorityTaskQueue } from './PriorityTaskQueue.js';
import { EventBus } from '../daemon/event-bus.js';

describe('PriorityTaskQueue', () => {
    let queue: PriorityTaskQueue;
    let eventBus: EventBus;

    beforeEach(() => {
        eventBus = new EventBus();
        queue = createPriorityTaskQueue({ maxSize: 10 }, eventBus);
    });

    // ============================================================
    // Enqueue / Dequeue
    // ============================================================

    describe('enqueue/dequeue', () => {
        it('enqueues and dequeues a task', () => {
            const task = queue.enqueue('Build feature X');
            expect(task).not.toBeNull();
            expect(task!.id).toBeTruthy();
            expect(task!.status).toBe('pending');

            const dequeued = queue.dequeue();
            expect(dequeued).not.toBeNull();
            expect(dequeued!.id).toBe(task!.id);
            expect(dequeued!.status).toBe('running');
        });

        it('returns null when queue is empty', () => {
            expect(queue.dequeue()).toBeNull();
        });

        it('respects priority ordering', () => {
            queue.enqueue('Low priority', 1);
            queue.enqueue('High priority', 10);
            queue.enqueue('Medium priority', 5);

            const first = queue.dequeue();
            expect(first!.instruction).toBe('High priority');

            const second = queue.dequeue();
            expect(second!.instruction).toBe('Medium priority');

            const third = queue.dequeue();
            expect(third!.instruction).toBe('Low priority');
        });

        it('FIFO within same priority', () => {
            queue.enqueue('First', 5);
            queue.enqueue('Second', 5);

            const first = queue.dequeue();
            expect(first!.instruction).toBe('First');
        });
    });

    // ============================================================
    // Dedup
    // ============================================================

    describe('hash-based dedup', () => {
        it('rejects duplicate instructions', () => {
            const first = queue.enqueue('Build feature X');
            const duplicate = queue.enqueue('Build feature X');

            expect(first).not.toBeNull();
            expect(duplicate).toBeNull();
            expect(queue.size).toBe(1);
        });

        it('normalizes whitespace for dedup', () => {
            queue.enqueue('Build  feature   X');
            const duplicate = queue.enqueue('Build feature X');

            expect(duplicate).toBeNull();
        });

        it('normalizes case for dedup', () => {
            queue.enqueue('Build Feature X');
            const duplicate = queue.enqueue('build feature x');

            expect(duplicate).toBeNull();
        });

        it('can disable dedup', () => {
            const noDedupQueue = createPriorityTaskQueue({ enableDedup: false }, eventBus);
            const first = noDedupQueue.enqueue('Same task');
            const second = noDedupQueue.enqueue('Same task');

            expect(first).not.toBeNull();
            expect(second).not.toBeNull();
        });
    });

    // ============================================================
    // Size Limits
    // ============================================================

    describe('size limits', () => {
        it('enforces max queue size', () => {
            for (let i = 0; i < 10; i++) {
                queue.enqueue(`Task ${i}`, 5);
            }
            expect(queue.isFull).toBe(true);

            const overflow = queue.enqueue('Overflow task', 10);
            expect(overflow).toBeNull();
        });
    });

    // ============================================================
    // Task Operations
    // ============================================================

    describe('task operations', () => {
        it('completes a task', () => {
            const task = queue.enqueue('Complete me')!;
            queue.dequeue(); // Mark as running

            expect(queue.complete(task.id)).toBe(true);
            expect(queue.getTask(task.id)!.status).toBe('completed');
        });

        it('fails a task', () => {
            const task = queue.enqueue('Fail me')!;
            queue.dequeue();

            expect(queue.fail(task.id)).toBe(true);
            expect(queue.getTask(task.id)!.status).toBe('failed');
        });

        it('cancels a pending task', () => {
            const task = queue.enqueue('Cancel me')!;

            expect(queue.cancel(task.id)).toBe(true);
            expect(queue.getTask(task.id)!.status).toBe('cancelled');
        });

        it('cannot cancel a running task', () => {
            const task = queue.enqueue('Running')!;
            queue.dequeue();

            expect(queue.cancel(task.id)).toBe(false);
        });
    });

    // ============================================================
    // Timeouts
    // ============================================================

    describe('timeouts', () => {
        it('detects hard timeouts', () => {
            const task = queue.enqueue('Slow task', 5, 'user', {
                hardTimeoutMs: 1, // 1ms timeout
            })!;
            queue.dequeue();

            // Backdate the task to ensure timeout is triggered
            (task as any).enqueuedAt = new Date(Date.now() - 100);

            const timedOut = queue.enforceTimeouts();
            expect(timedOut.length).toBe(1);
            expect(timedOut[0].status).toBe('timed_out');
        });
    });

    // ============================================================
    // Query
    // ============================================================

    describe('queries', () => {
        it('returns pending tasks', () => {
            queue.enqueue('A');
            queue.enqueue('B');
            queue.dequeue(); // A is now running

            expect(queue.pendingTasks.length).toBe(1);
            expect(queue.runningTasks.length).toBe(1);
        });

        it('filters by category', () => {
            queue.enqueue('User task', 5, 'user');
            queue.enqueue('System task', 5, 'system');
            queue.enqueue('Evolution task', 5, 'evolution');

            expect(queue.getByCategory('user').length).toBe(1);
            expect(queue.getByCategory('system').length).toBe(1);
        });

        it('reports isEmpty and size', () => {
            expect(queue.isEmpty).toBe(true);
            expect(queue.size).toBe(0);

            queue.enqueue('Task');
            expect(queue.isEmpty).toBe(false);
            expect(queue.size).toBe(1);
        });
    });

    // ============================================================
    // Persistence
    // ============================================================

    describe('persistence', () => {
        it('creates and restores snapshot', () => {
            queue.enqueue('Task A', 8);
            queue.enqueue('Task B', 3);

            const snapshot = queue.createSnapshot();
            expect(snapshot.tasks.length).toBe(2);
            expect(snapshot.version).toBe(1);

            // Restore into a new queue
            const newQueue = createPriorityTaskQueue({ maxSize: 10 }, eventBus);
            const restored = newQueue.restoreFromSnapshot(snapshot);

            expect(restored).toBe(2);
            expect(newQueue.size).toBe(2);

            // Priority preserved
            const first = newQueue.dequeue();
            expect(first!.priority).toBe(8);
        });
    });

    // ============================================================
    // Garbage Collection
    // ============================================================

    describe('garbage collection', () => {
        it('purges completed tasks', () => {
            const task = queue.enqueue('Done')!;
            queue.dequeue();
            queue.complete(task.id);

            queue.enqueue('Pending');
            expect(queue.totalSize).toBe(2);

            const removed = queue.purgeCompleted();
            expect(removed).toBe(1);
            expect(queue.totalSize).toBe(1);
        });

        it('clears entire queue', () => {
            queue.enqueue('A');
            queue.enqueue('B');
            queue.clear();

            expect(queue.totalSize).toBe(0);
            expect(queue.isEmpty).toBe(true);
        });
    });

    // ============================================================
    // Peek
    // ============================================================

    describe('peek', () => {
        it('peeks without dequeuing', () => {
            queue.enqueue('Peek me', 7);

            const peeked = queue.peek();
            expect(peeked).not.toBeNull();
            expect(peeked!.status).toBe('pending');

            // Still in queue
            expect(queue.size).toBe(1);
        });
    });
});
