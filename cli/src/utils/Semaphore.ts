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
        if (this.activeCount <= 0) {
            // Log warning in debug mode or if explicitly required
            if (process.env.DEBUG) {
                console.warn("Semaphore.release() called with no active tasks. Logic error suspected.");
            }
            return;
        }

        this.activeCount--;

        const next = this.queue.shift();
        if (next) {
            // Immediately activate the next task (increment was handled by the push logic or we handle it here?)
            // Wait, my acquire logic:
            // if queue push: closure { activeCount++; resolve(); }
            // So if I release, activeCount becomes N-1.
            // If I call next(), the closure runs, activeCount becomes N. Correct.
            // But wait, the closure increments activeCount.
            // So release() decrements, next() increments. Net change 0. Correct.

            // However, the check `if (this.activeCount < this.maxConcurrency)` in acquire relies on `activeCount` being accurate.

            // Let's re-verify the logic.
            // Start: 0/1
            // A: acquire -> 1/1.
            // B: acquire -> push B.
            // A: release -> activeCount=0. next=B. B runs -> activeCount=1.
            // Result: 1/1. Correct.

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
