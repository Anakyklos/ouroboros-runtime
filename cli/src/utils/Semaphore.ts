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
     */
    release(): void {
        this.activeCount = Math.max(0, this.activeCount - 1);

        const next = this.queue.shift();
        if (next) {
            next();
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
