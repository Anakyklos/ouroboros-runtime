import type { MissionMutation, MissionStore } from '../mission/ports.js';
import type { MissionScheduler, MissionSchedulerRunReport } from '../mission/mission-scheduler.js';

export interface MissionSchedulerDriverTimer {
    now(): Date;
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface MissionSchedulerDriverOptions {
    scheduler: Pick<MissionScheduler, 'runOnce'>;
    store: Pick<MissionStore, 'onMutation'>;
    timer?: MissionSchedulerDriverTimer;
    onDiagnostic?: (outcome: 'failed') => void;
}

const MAX_TIMER_DELAY_MS = 2_147_000_000;

const systemTimer: MissionSchedulerDriverTimer = {
    now: () => new Date(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
};

/** Owns resident wakeups for the one-shot durable Mission scheduler. */
export class MissionSchedulerDriver {
    private readonly scheduler: Pick<MissionScheduler, 'runOnce'>;
    private readonly store: Pick<MissionStore, 'onMutation'>;
    private readonly timer: MissionSchedulerDriverTimer;
    private readonly onDiagnostic?: (outcome: 'failed') => void;
    private unsubscribe: (() => void) | null = null;
    private wakeTimer: ReturnType<typeof setTimeout> | null = null;
    private drainPromise: Promise<void> | null = null;
    private startPromise: Promise<void> | null = null;
    private wakePending = false;
    private started = false;
    private stopping = false;

    constructor(options: MissionSchedulerDriverOptions) {
        this.scheduler = options.scheduler;
        this.store = options.store;
        this.timer = options.timer ?? systemTimer;
        this.onDiagnostic = options.onDiagnostic;
    }

    /** Subscribe to durable changes and finish the initial recovery pass. */
    start(): Promise<void> {
        if (this.startPromise) return this.startPromise;
        if (this.stopping) return Promise.resolve();
        this.started = true;
        this.unsubscribe = this.store.onMutation?.((mutation) => this.onMutation(mutation)) ?? null;
        this.startPromise = this.requestWake();
        return this.startPromise;
    }

    /** Stop admission, cancel the timer, remove observers, and drain the pass. */
    async stop(): Promise<void> {
        if (this.stopping) {
            await this.drainPromise?.catch(() => {});
            return;
        }
        this.stopping = true;
        this.wakePending = false;
        this.clearWakeTimer();
        this.unsubscribe?.();
        this.unsubscribe = null;
        await this.drainPromise?.catch(() => {});
    }

    private onMutation(mutation: MissionMutation): void {
        if (!this.started || this.stopping || !isSchedulingMutation(mutation)) return;
        void this.requestWake().catch(() => {});
    }

    private requestWake(): Promise<void> {
        if (this.stopping) return Promise.resolve();
        this.clearWakeTimer();
        this.wakePending = true;
        if (!this.drainPromise) {
            const wrapped = Promise.resolve().then(() => this.drain()).finally(() => {
                if (this.drainPromise === wrapped) {
                    this.drainPromise = null;
                    if (this.wakePending && !this.stopping) {
                        void this.requestWake().catch(() => {});
                    }
                }
            });
            this.drainPromise = wrapped;
        }
        return this.drainPromise;
    }

    private async drain(): Promise<void> {
        while (this.wakePending && !this.stopping) {
            this.wakePending = false;
            let report: MissionSchedulerRunReport;
            try {
                report = await this.scheduler.runOnce();
            } catch {
                this.wakePending = false;
                this.reportFailure();
                throw new Error('Mission scheduler pass failed');
            }
            if (this.wakePending || this.stopping) continue;
            this.scheduleWake(report.nextWakeAt);
        }
    }

    private scheduleWake(nextWakeAt: string | null): void {
        if (this.stopping || !nextWakeAt) return;
        const wakeAt = Date.parse(nextWakeAt);
        const now = this.timer.now().getTime();
        if (!Number.isFinite(wakeAt) || wakeAt <= now) return;
        const delayMs = Math.min(wakeAt - now, MAX_TIMER_DELAY_MS);
        this.wakeTimer = this.timer.setTimeout(() => {
            this.wakeTimer = null;
            void this.requestWake().catch(() => {});
        }, delayMs);
    }

    private clearWakeTimer(): void {
        if (this.wakeTimer === null) return;
        this.timer.clearTimeout(this.wakeTimer);
        this.wakeTimer = null;
    }

    private reportFailure(): void {
        try {
            this.onDiagnostic?.('failed');
        } catch {
            // Diagnostics never change Mission state or scheduling authority.
        }
    }
}

function isSchedulingMutation(mutation: MissionMutation): boolean {
    if (mutation.entity === 'mission') {
        return mutation.kind === 'created' || mutation.kind === 'state_changed';
    }
    return mutation.kind === 'created' || mutation.invocation.status === 'completed';
}
