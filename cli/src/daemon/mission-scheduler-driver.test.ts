import { describe, expect, it, mock } from 'bun:test';
import type { MissionMutation, MissionMutationListener } from '../mission/ports.js';
import type { MissionSchedulerRunReport } from '../mission/mission-scheduler.js';
import { MissionSchedulerDriver } from './mission-scheduler-driver.js';

const report = (nextWakeAt: string | null = null): MissionSchedulerRunReport => ({
    recoveredMissionIds: [],
    reconciledInvocationIds: [],
    dispatchedInvocationIds: [],
    waitingMissionIds: [],
    nextWakeAt,
    idle: true,
});

class FakeTimer {
    currentTime = new Date('2026-10-08T12:00:00.000Z');
    private nextId = 1;
    private timers = new Map<number, { at: number; callback: () => void }>();

    now = (): Date => new Date(this.currentTime);

    setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
        const id = this.nextId++;
        this.timers.set(id, { at: this.currentTime.getTime() + delayMs, callback });
        return id as unknown as ReturnType<typeof setTimeout>;
    };

    clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
        this.timers.delete(handle as unknown as number);
    };

    async advance(ms: number): Promise<void> {
        this.currentTime = new Date(this.currentTime.getTime() + ms);
        const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.currentTime.getTime());
        for (const [id, timer] of due) {
            this.timers.delete(id);
            timer.callback();
        }
        await Promise.resolve();
        await Promise.resolve();
    }

    get pendingTimers(): number { return this.timers.size; }
}

class FakeStore {
    private listeners = new Set<MissionMutationListener>();

    onMutation = (listener: MissionMutationListener): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    publish(mutation: MissionMutation): void {
        for (const listener of [...this.listeners]) listener(mutation);
    }

    get listenerCount(): number { return this.listeners.size; }
}

describe('MissionSchedulerDriver', () => {
    it('runs startup recovery and consumes only a future durable wake with a single timer', async () => {
        const timer = new FakeTimer();
        const store = new FakeStore();
        const runOnce = mock()
            .mockResolvedValueOnce(report('2026-10-08T12:00:05.000Z'))
            .mockResolvedValueOnce(report());
        const driver = new MissionSchedulerDriver({
            scheduler: { runOnce },
            store,
            timer,
        });

        await driver.start();
        expect(runOnce).toHaveBeenCalledTimes(1);
        expect(timer.pendingTimers).toBe(1);
        await timer.advance(4_999);
        expect(runOnce).toHaveBeenCalledTimes(1);
        await timer.advance(1);
        expect(runOnce).toHaveBeenCalledTimes(2);
        expect(timer.pendingTimers).toBe(0);
        await driver.stop();
    });

    it('coalesces concurrent durable changes and never overlaps passes', async () => {
        const timer = new FakeTimer();
        const store = new FakeStore();
        let release!: () => void;
        let active = 0;
        let maxActive = 0;
        const runOnce = mock(async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            if (runOnce.mock.calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
            active--;
            return report();
        });
        const driver = new MissionSchedulerDriver({ scheduler: { runOnce }, store, timer });
        const starting = driver.start();
        await Promise.resolve();
        store.publish({ entity: 'mission', kind: 'created', mission: {} as never });
        store.publish({ entity: 'invocation', kind: 'created', invocation: {} as never });
        store.publish({ entity: 'mission', kind: 'state_changed', mission: {} as never });
        release();
        await starting;

        expect(runOnce).toHaveBeenCalledTimes(2);
        expect(maxActive).toBe(1);
        await driver.stop();
    });

    it('does not spin on an expired wake and removes listeners and timers on stop', async () => {
        const timer = new FakeTimer();
        const store = new FakeStore();
        const runOnce = mock().mockResolvedValue(report('2026-10-08T11:59:59.000Z'));
        const driver = new MissionSchedulerDriver({ scheduler: { runOnce }, store, timer });

        await driver.start();
        expect(runOnce).toHaveBeenCalledTimes(1);
        expect(timer.pendingTimers).toBe(0);
        expect(store.listenerCount).toBe(1);
        await driver.stop();
        expect(store.listenerCount).toBe(0);
        store.publish({ entity: 'mission', kind: 'created', mission: {} as never });
        expect(runOnce).toHaveBeenCalledTimes(1);
    });

    it('reports scheduler failures without leaking exception details or retrying in a loop', async () => {
        const timer = new FakeTimer();
        const store = new FakeStore();
        const diagnostics: unknown[] = [];
        const runOnce = mock().mockRejectedValue(new Error('PRIVATE mission prompt and token'));
        const driver = new MissionSchedulerDriver({
            scheduler: { runOnce },
            store,
            timer,
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        });

        await expect(driver.start()).rejects.toThrow('Mission scheduler pass failed');
        expect(runOnce).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE');
        expect(JSON.stringify(diagnostics)).not.toContain('token');
        store.publish({ entity: 'mission', kind: 'state_changed', mission: {} as never });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(runOnce).toHaveBeenCalledTimes(2);
        await driver.stop();
    });
});
