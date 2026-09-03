/**
 * Durable Mission scheduler (Issue #50).
 *
 * This is intentionally a one-shot coordinator. It reads authoritative
 * Mission/CapabilityInvocation rows, performs bounded work, and returns the
 * next durable wakeup instead of owning a resident polling timer.
 */

import type { ClockService, MissionStore } from "./ports.js";
import {
    MissionEngine,
} from "./mission-engine.js";
import {
    MissionState,
    TERMINAL_STATES,
    InvocationStatus,
    computeEffectFingerprint,
} from "./contracts.js";
import {
    CapabilityUnavailableError,
    ConnectorDispatchSeam,
    ConnectorNotRegisteredError,
} from "../capabilities/dispatch-seam.js";

export interface MissionSchedulerOptions {
    engine: MissionEngine;
    store: MissionStore;
    seam: ConnectorDispatchSeam;
    clock?: ClockService;
    maxInFlight?: number;
    recoveryBatchSize?: number;
}

export interface MissionRecoveryReport {
    recoveredMissionIds: string[];
    reconciledInvocationIds: string[];
}

export interface MissionSchedulerRunReport extends MissionRecoveryReport {
    dispatchedInvocationIds: string[];
    waitingMissionIds: string[];
    nextWakeAt: string | null;
    idle: boolean;
}

export class MissionScheduler {
    private readonly engine: MissionEngine;
    private readonly store: MissionStore;
    private readonly seam: ConnectorDispatchSeam;
    private readonly clock: ClockService;
    private readonly maxInFlight: number;
    private readonly recoveryBatchSize: number;
    private recoveryComplete = false;
    private recoveryInProgress: Promise<MissionRecoveryReport> | null = null;
    private runInProgress: Promise<MissionSchedulerRunReport> | null = null;

    constructor(options: MissionSchedulerOptions) {
        this.engine = options.engine;
        this.store = options.store;
        this.seam = options.seam;
        this.clock = options.clock ?? {
            now: () => new Date(),
            isoNow: () => new Date().toISOString(),
        };
        this.maxInFlight = Number.isSafeInteger(options.maxInFlight) && (options.maxInFlight ?? 0) > 0
            ? options.maxInFlight!
            : 1;
        this.recoveryBatchSize = Number.isSafeInteger(options.recoveryBatchSize)
            && (options.recoveryBatchSize ?? 0) > 0
            ? options.recoveryBatchSize!
            : 64;
    }

    /** Recover non-terminal Missions without resuming any effect. */
    async recover(): Promise<MissionRecoveryReport> {
        if (this.recoveryComplete) {
            return { recoveredMissionIds: [], reconciledInvocationIds: [] };
        }
        if (this.recoveryInProgress) return this.recoveryInProgress;
        const recovery = this.recoverInternal();
        this.recoveryInProgress = recovery;
        try {
            return await recovery;
        } finally {
            if (this.recoveryInProgress === recovery) this.recoveryInProgress = null;
        }
    }

    private async recoverInternal(): Promise<MissionRecoveryReport> {
        const missions = await this.store.listMissions();
        const recoveredMissionIds: string[] = [];
        for (const mission of missions) {
            if (TERMINAL_STATES.has(mission.state)) continue;
            await this.engine.recoverMission(mission.missionId);
            recoveredMissionIds.push(mission.missionId);
        }
        this.recoveryComplete = true;
        return { recoveredMissionIds, reconciledInvocationIds: [] };
    }

    /**
     * Run one bounded scheduling pass. The scheduler owns no resident timer
     * and never sleeps. Every external operation is selected from durable
     * state, while `nextWakeAt` lets its caller arrange a single future wake.
     * Concurrent calls on this runtime instance share one pass; cross-process
     * exactly-once coordination remains deliberately out of scope.
     */
    async runOnce(): Promise<MissionSchedulerRunReport> {
        if (this.runInProgress) return this.runInProgress;
        const run = this.runOnceInternal();
        this.runInProgress = run;
        try {
            return await run;
        } finally {
            if (this.runInProgress === run) this.runInProgress = null;
        }
    }

    private async runOnceInternal(): Promise<MissionSchedulerRunReport> {
        const recovery = await this.recover();
        const dispatchedInvocationIds: string[] = [];
        const reconciledInvocationIds: string[] = [];
        const waitingMissionIds: string[] = [];
        const suppressedMissions = new Set<string>();
        let dispatchSlots = this.maxInFlight;
        const now = this.clock.isoNow();

        // First resolve facts about work that already crossed the connector
        // boundary. This pass can call reconcile/cancel, but it never calls
        // invoke for an existing row.
        const recoverable = await this.store.listNonTerminalInvocations(this.recoveryBatchSize);
        for (const invocation of recoverable) {
            let current = invocation;
            try {
                if (
                    current.cancellation.requested
                    && current.cancellation.state === "requested"
                    && current.delivery.state !== "not_submitted"
                ) {
                    await this.seam.cancelInvocation(current.invocationId);
                    current = await this.requireInvocation(current.invocationId);
                }
                if (
                    current.delivery.state !== "not_submitted"
                    && current.reconciliation.state === "pending"
                ) {
                    const reconciled = await this.seam.reconcileInvocation(current.invocationId);
                    reconciledInvocationIds.push(current.invocationId);
                    if (
                        (reconciled.recordedStatus === InvocationStatus.COMPLETED
                            || reconciled.recordedStatus === InvocationStatus.FAILED)
                    ) {
                        const mission = await this.engine.getMission(current.missionId);
                        if (mission.state === MissionState.WAITING_FOR_CAPABILITY) {
                            await this.engine.restoreWaitingToReady(current.missionId);
                        }
                    }
                }
            } catch (error) {
                // Recovery is isolated per invocation. A missing or unavailable
                // connector cannot prevent unrelated Missions from progressing.
                if (error instanceof CapabilityUnavailableError || error instanceof ConnectorNotRegisteredError) {
                    try {
                        const mission = await this.engine.getMission(current.missionId);
                        // An unavailable connector may explain READY/EXECUTING
                        // work, or an existing capability wait, but it must not
                        // overwrite an approval/context/provider/budget wait
                        // that requires its own explicit owner action.
                        const canEnterCapabilityWait = mission.state === MissionState.READY
                            || mission.state === MissionState.EXECUTING
                            || mission.state === MissionState.WAITING_FOR_CAPABILITY;
                        if (canEnterCapabilityWait) {
                            await this.engine.setWaiting(
                                mission.missionId,
                                MissionState.WAITING_FOR_CAPABILITY,
                                error.message,
                            );
                            waitingMissionIds.push(mission.missionId);
                        }
                    } catch {
                        // The invocation may have been finalized concurrently.
                    }
                }
            }
        }

        // Retry only rows that are due and definitely not submitted. A FAILED
        // row must first cross the explicit engine retry transition, which
        // preserves the failed attempt and stable invocation identity.
        const dueInvocations = await this.store.listDueInvocations(now, this.recoveryBatchSize);
        for (const candidate of dueInvocations) {
            if (dispatchSlots <= 0) break;
            if (suppressedMissions.has(candidate.missionId)) continue;
            let mission = await this.store.getMission(candidate.missionId);
            if (!mission || TERMINAL_STATES.has(mission.state) || mission.state === MissionState.PAUSED) continue;
            if (mission.state === MissionState.WAITING_FOR_CAPABILITY) {
                try {
                    await this.engine.restoreWaitingToReady(mission.missionId);
                    mission = await this.store.getMission(candidate.missionId);
                } catch {
                    continue;
                }
            }
            if (!mission) continue;
            if (
                mission.state !== MissionState.READY
                && mission.state !== MissionState.EXECUTING
            ) continue;
            if (candidate.cancellation.requested) continue;

            let prepared = candidate;
            if (candidate.status === InvocationStatus.FAILED) {
                try {
                    prepared = await this.engine.prepareInvocationRetry(candidate.invocationId);
                } catch {
                    // Non-idempotent, exhausted, uncertain, or otherwise
                    // ineligible failures remain durable without a replay.
                    continue;
                }
            }
            if (
                prepared.delivery.state !== "not_submitted"
                || (prepared.status !== InvocationStatus.PENDING && prepared.status !== InvocationStatus.DISPATCHED)
            ) continue;
            try {
                await this.seam.dispatchPersistedInvocation(prepared.invocationId);
                dispatchedInvocationIds.push(prepared.invocationId);
                dispatchSlots--;
            } catch (error) {
                await this.handleDispatchError(
                    prepared.missionId,
                    error,
                    waitingMissionIds,
                );
                if (waitingMissionIds.includes(candidate.missionId)) {
                    suppressedMissions.add(candidate.missionId);
                }
            }
        }

        const missions = await this.store.listMissions();
        for (const mission of missions) {
            if (dispatchSlots <= 0) break;
            if (TERMINAL_STATES.has(mission.state) || mission.state === MissionState.PAUSED) continue;
            // Capability waits are retried only as a fresh authorization check
            // in this pass. Approval/context/provider/budget waits are never
            // auto-promoted by the scheduler.
            const capabilityWaiting = mission.state === MissionState.WAITING_FOR_CAPABILITY;
            if (!capabilityWaiting && mission.state !== MissionState.READY && mission.state !== MissionState.EXECUTING) continue;
            if (!mission.currentPlanRevisionId) continue;
            const revision = await this.engine.getPlanRevision(mission.currentPlanRevisionId);
            if (!revision) continue;
            const invocations = await this.store.listInvocations(mission.missionId);
            const completedEffects = new Set(
                invocations
                    .filter((invocation) => invocation.status === InvocationStatus.COMPLETED)
                    .map((invocation) => invocation.effectFingerprint),
            );
            const effectByStep = new Map(
                revision.steps.map((step) => [
                    step.stepId,
                    computeEffectFingerprint({
                        capabilityId: step.capabilityRequirement,
                        effectClass: step.effectClass,
                        inputRefs: step.inputRefs,
                        outcome: step.desiredOutcome,
                    }),
                ]),
            );
            const isReadyStep = (step: typeof revision.steps[number]): boolean => {
                const effectFingerprint = effectByStep.get(step.stepId)!;
                if (invocations.some((invocation) => invocation.effectFingerprint === effectFingerprint)) return false;
                if (step.dependencyIds.some((dependencyId) => {
                    const dependencyEffect = effectByStep.get(dependencyId);
                    return dependencyEffect === undefined || !completedEffects.has(dependencyEffect);
                })) return false;
                return true;
            };
            if (capabilityWaiting) {
                if (!revision.steps.some(isReadyStep)) continue;
                try {
                    await this.engine.restoreWaitingToReady(mission.missionId);
                } catch {
                    continue;
                }
                const restored = await this.store.getMission(mission.missionId);
                if (!restored || (
                    restored.state !== MissionState.READY
                    && restored.state !== MissionState.EXECUTING
                )) continue;
            }
            // Dispatch directly while scanning the durable plan. This avoids
            // building an unbounded in-memory candidate queue; at most
            // `maxInFlight` connector calls can be active in this pass.
            for (const step of revision.steps) {
                if (dispatchSlots <= 0 || suppressedMissions.has(mission.missionId)) break;
                if (!isReadyStep(step)) continue;
                try {
                    const outcome = await this.seam.dispatchThroughSeam(mission.missionId, step.stepId);
                    dispatchedInvocationIds.push(outcome.invocation.invocationId);
                    dispatchSlots--;
                } catch (error) {
                    await this.handleDispatchError(mission.missionId, error, waitingMissionIds);
                    if (waitingMissionIds.includes(mission.missionId)) {
                        suppressedMissions.add(mission.missionId);
                    }
                }
            }
        }

        const futureWakeups = (await this.store.listNonTerminalInvocations(this.recoveryBatchSize))
            .map((invocation) => invocation.retry.nextEligibleAt)
            .filter((nextEligibleAt): nextEligibleAt is string => nextEligibleAt !== null)
            .filter((nextEligibleAt) => Date.parse(nextEligibleAt) > this.clock.now().getTime())
            .sort();
        return {
            recoveredMissionIds: recovery.recoveredMissionIds,
            reconciledInvocationIds,
            dispatchedInvocationIds,
            waitingMissionIds: [...new Set(waitingMissionIds)],
            nextWakeAt: futureWakeups[0] ?? null,
            idle: dispatchedInvocationIds.length === 0,
        };
    }

    private async requireInvocation(invocationId: string) {
        const invocation = await this.store.getInvocation(invocationId);
        if (!invocation) throw new Error(`Invocation not found: ${invocationId}`);
        return invocation;
    }

    private async handleDispatchError(
        missionId: string,
        error: unknown,
        waitingMissionIds: string[],
    ): Promise<void> {
        if (error instanceof CapabilityUnavailableError || error instanceof ConnectorNotRegisteredError) {
            const mission = await this.engine.getMission(missionId);
            if (!TERMINAL_STATES.has(mission.state) && mission.state !== MissionState.PAUSED) {
                await this.engine.setWaiting(
                    missionId,
                    MissionState.WAITING_FOR_CAPABILITY,
                    error instanceof Error ? error.message : String(error),
                );
                waitingMissionIds.push(missionId);
            }
            return;
        }
        // A post-handoff seam exception is already durable on its invocation.
        // Blocking only the affected Mission keeps recovery/reconciliation
        // local and prevents one connector from stopping unrelated work.
        const mission = await this.engine.getMission(missionId);
        if (!TERMINAL_STATES.has(mission.state) && mission.state !== MissionState.PAUSED) {
            await this.engine.blockMission(
                missionId,
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}

/** Compatibility name for callers that describe the component by purpose. */
export { MissionScheduler as DurableMissionScheduler };
