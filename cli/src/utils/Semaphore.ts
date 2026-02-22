/**
 * A simple semaphore implementation for concurrency control.
 */
export class Semaphore {
    private maxConcurrency: number;
    private maxQueueSize: number;
    private activeCount = 0;
    private queue: Array<() => void> = [];

    /**
     * @param maxConcurrency Maximum number of concurrent tasks allowed (must be > 0).
     * @param maxQueueSize Maximum number of tasks allowed in the waiting queue (default: Infinity).
     */
    constructor(maxConcurrency: number, maxQueueSize: number = Infinity) {
        if (!Number.isFinite(maxConcurrency) || maxConcurrency <= 0) {
            throw new Error(`Semaphore maxConcurrency must be > 0, got ${maxConcurrency}`);
        }
        if (
            (Number.isFinite(maxQueueSize) && maxQueueSize < 0) ||
            (!Number.isFinite(maxQueueSize) && maxQueueSize !== Infinity)
        ) {
            throw new Error(
                `Semaphore maxQueueSize must be a finite number >= 0 or Infinity, got ${maxQueueSize}`,
            );
        }
        this.maxConcurrency = maxConcurrency;
        this.maxQueueSize = maxQueueSize;
    }

    /**
     * Acquires a slot in the semaphore.
     * Returns a promise that resolves when a slot is available.
     * Throws if the queue is full.
     */
    async acquire(): Promise<void> {
        if (this.activeCount < this.maxConcurrency) {
            this.activeCount++;
            return;
        }

        if (this.queue.length >= this.maxQueueSize) {
            throw new Error(`Semaphore queue is full (max size: ${this.maxQueueSize})`);
        }

        await new Promise<void>((resolve) => {
            this.queue.push(() => {
                this.activeCount++;
                resolve();
            });
        });
    }

    /**
     * Releases a slot in the semaphore, allowing the next queued task to proceed.
     * Throws an error if called when no tasks are active.
     */
    release(): void {
        if (this.activeCount <= 0) {
            throw new Error("Semaphore.release() called with no active tasks. This indicates a logic error where release() is called more times than acquire().");
        }

        this.activeCount--;

        const next = this.queue.shift();
        if (next) {
            next();
        }
    }

    /**
     * Executes a function with a semaphore permit.
     * Automatically handles acquisition and release.
     */
    async runWithPermit<T>(fn: () => T | Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await Promise.resolve(fn());
        } finally {
            this.release();
        }
    }

    /**
     * Returns the number of currently active tasks.
     */
    getActiveCount(): number {
        return this.activeCount;
    }

    /**
     * Returns the number of tasks waiting in the queue.
     */
    getQueueLength(): number {
        return this.queue.length;
    }
}
