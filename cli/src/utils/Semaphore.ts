/**
 * A simple semaphore implementation for concurrency control.
 */
export class Semaphore {
    private maxConcurrency: number;
    private activeCount = 0;
    private queue: Array<() => void> = [];

    constructor(maxConcurrency: number) {
        if (!Number.isFinite(maxConcurrency) || maxConcurrency <= 0) {
            throw new Error(`Semaphore maxConcurrency must be > 0, got ${maxConcurrency}`);
        }
        this.maxConcurrency = maxConcurrency;
    }

    /**
     * Acquires a slot in the semaphore.
     * Returns a promise that resolves when a slot is available.
     */
    async acquire(): Promise<void> {
        if (this.activeCount < this.maxConcurrency) {
            this.activeCount++;
            return;
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
    async runWithPermit<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
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
