/**
 * Durable Mission scheduler (Issue #50).
 *
 * This is intentionally a one-shot coordinator. It reads authoritative
 * Mission/CapabilityInvocation rows, performs bounded work, and returns the
 * next durable wakeup instead of owning a resident polling timer.
 */

import type { ClockService, MissionPageCursor, MissionStore } from "./ports.js";
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
import { UnknownCapabilityError } from "../capabilities/registry.js";

export interface MissionSchedulerOptions {
    engine: MissionEngine;
    store: MissionStore;
    seam: ConnectorDispatchSeam;
    clock?: ClockService;
    maxInFlight?: number;
    recoveryBatchSize?: number;
    missionPageSize?: number;
    /**
     * Optional cap for each report ID list. Omit it to retain complete reports
     * for direct callers. The resident daemon sets this to zero because its
     * driver consumes only `nextWakeAt`.
     */
    reportIdLimit?: number;
}

export interface MissionRecoveryReport {
    recoveredMissionIds: string[];
    reconciledInvocationIds: string[];
}

export interface MissionSchedulerRunReport extends MissionRecoveryReport {
    dispatchedInvocationIds: string[];
    waitingMissionIds: string[];
    nextWakeAt: string | null;
    /** True only when this pass performed no successful dispatch, independent of ID capture. */
    idle: boolean;
}

export class MissionScheduler {
    private readonly engine: MissionEngine;
    private readonly store: MissionStore;
    private readonly seam: ConnectorDispatchSeam;
    private readonly clock: ClockService;
    private readonly maxInFlight: number;
    private readonly recoveryBatchSize: number;
    private readonly missionPageSize: number;
    private readonly reportIdLimit: number | undefined;
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
        this.missionPageSize = Number.isSafeInteger(options.missionPageSize)
            && (options.missionPageSize ?? 0) > 0
            && options.missionPageSize! <= 1024
            ? options.missionPageSize!
            : 64;
        if (options.reportIdLimit !== undefined
            && (!Number.isSafeInteger(options.reportIdLimit) || options.reportIdLimit < 0)) {
            throw new RangeError("reportIdLimit must be a non-negative safe integer");
        }
        this.reportIdLimit = options.reportIdLimit;
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
        const recoveredMissionIds: string[] = [];
        let cursor: MissionPageCursor | null = null;
        do {
            const page = await this.store.listMissionSchedulingPage({
                limit: this.missionPageSize,
                cursor: cursor ?? undefined,
                excludeStates: [...TERMINAL_STATES],
            });
            for (const mission of page.missions) {
                await this.engine.recordMissionRecovery(mission.missionId);
                appendReportId(recoveredMissionIds, mission.missionId, this.reportIdLimit);
            }
            cursor = page.nextCursor;
        } while (cursor);
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
        let didDispatch = false;
        const boundedWaitingMissionIds = this.reportIdLimit === undefined
            ? undefined
            : new Set<string>();
        const recordWaitingMissionId = (missionId: string): void => {
            if (boundedWaitingMissionIds) {
                if (boundedWaitingMissionIds.has(missionId)
                    || boundedWaitingMissionIds.size >= this.reportIdLimit!) return;
                boundedWaitingMissionIds.add(missionId);
            }
            appendReportId(waitingMissionIds, missionId, this.reportIdLimit);
        };
        let dispatchSlots = this.maxInFlight;
        const now = this.clock.isoNow();

        // First resolve facts about work that already crossed the connector
        // boundary. This pass can call reconcile/cancel, but it never calls
        // invoke for an existing row.
        const recoverable = await this.store.listActionableInvocations(this.recoveryBatchSize);
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
                    appendReportId(reconciledInvocationIds, current.invocationId, this.reportIdLimit);
                    if (
                        (reconciled.recordedStatus === InvocationStatus.COMPLETED
                            || reconciled.recordedStatus === InvocationStatus.FAILED)
                    ) {
                        const mission = await this.store.getMissionSchedulingRecord(current.missionId);
                        if (mission?.state === MissionState.WAITING_FOR_CAPABILITY) {
                            await this.engine.restoreWaitingToReady(current.missionId);
                        }
                    }
                }
            } catch (error) {
                // Recovery is isolated per invocation. A missing or unavailable
                // connector cannot prevent unrelated Missions from progressing.
                if (
                    error instanceof CapabilityUnavailableError
                    || error instanceof ConnectorNotRegisteredError
                    || error instanceof UnknownCapabilityError
                ) {
                    try {
                        const mission = await this.store.getMissionSchedulingRecord(current.missionId);
                        // An unavailable connector may explain READY/EXECUTING
                        // work, or an existing capability wait, but it must not
                        // overwrite an approval/context/provider/budget wait
                        // that requires its own explicit owner action.
                        const canEnterCapabilityWait = mission !== null && (
                            mission.state === MissionState.READY
                            || mission.state === MissionState.EXECUTING
                            || mission.state === MissionState.WAITING_FOR_CAPABILITY
                        );
                        if (canEnterCapabilityWait && mission) {
                            await this.engine.setWaiting(
                                mission.missionId,
                                MissionState.WAITING_FOR_CAPABILITY,
                                error.message,
                            );
                            recordWaitingMissionId(mission.missionId);
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
            let mission = await this.store.getMissionSchedulingRecord(candidate.missionId);
            if (!mission || TERMINAL_STATES.has(mission.state) || mission.state === MissionState.PAUSED) continue;
            if (mission.state === MissionState.WAITING_FOR_CAPABILITY) {
                if (!this.seam.canDispatchCapability(candidate.capabilityId)) continue;
                try {
                    await this.engine.restoreWaitingToReady(mission.missionId);
                    mission = await this.store.getMissionSchedulingRecord(candidate.missionId);
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
                didDispatch = true;
                appendReportId(dispatchedInvocationIds, prepared.invocationId, this.reportIdLimit);
                dispatchSlots--;
            } catch (error) {
                await this.handleDispatchError(
                    prepared.missionId,
                    error,
                    recordWaitingMissionId,
                );
            }
        }

        const schedulableStates = [
            MissionState.READY,
            MissionState.EXECUTING,
            MissionState.WAITING_FOR_CAPABILITY,
        ] as const;
        let missionCursor: MissionPageCursor | null = null;
        do {
            if (dispatchSlots <= 0) break;
            const page = await this.store.listMissionSchedulingPage({
                limit: this.missionPageSize,
                cursor: missionCursor ?? undefined,
                states: schedulableStates,
            });
            for (const mission of page.missions) {
                if (dispatchSlots <= 0) break;
                // Capability waits are retried only as a fresh authorization check
                // in this pass. Approval/context/provider/budget waits are never
                // auto-promoted by the scheduler.
                const capabilityWaiting = mission.state === MissionState.WAITING_FOR_CAPABILITY;
                if (!capabilityWaiting && mission.state !== MissionState.READY && mission.state !== MissionState.EXECUTING) continue;
                if (!mission.currentPlanRevisionId) continue;
                const revision = await this.engine.getPlanRevision(mission.currentPlanRevisionId);
                if (!revision) continue;
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
                const schedulingFacts = await this.store.getInvocationSchedulingFacts(
                    mission.missionId,
                    revision.steps.map((step) => ({
                        stepId: step.stepId,
                        effectFingerprint: effectByStep.get(step.stepId)!,
                    })),
                );
                const factsByStep = new Map(schedulingFacts.map((fact) => [fact.stepId, fact]));
                const completedEffects = new Set(
                    schedulingFacts
                        .filter((fact) => fact.hasCompletedEffect)
                        .map((fact) => fact.effectFingerprint),
                );
                const isReadyStep = (step: typeof revision.steps[number]): boolean => {
                    const effectFingerprint = effectByStep.get(step.stepId)!;
                    const fact = factsByStep.get(step.stepId)!;
                    if (fact.hasEffectClaim || fact.hasLegacyReplayBarrier) return false;
                    if (step.dependencyIds.some((dependencyId) => {
                        const dependencyEffect = effectByStep.get(dependencyId);
                        return dependencyEffect === undefined || !completedEffects.has(dependencyEffect);
                    })) return false;
                    return true;
                };
                const readySteps = revision.steps.filter(isReadyStep);
                const dispatchableSteps = readySteps.filter((step) =>
                    this.seam.canDispatchCapability(step.capabilityRequirement),
                );
                const hasUnavailableReadyStep = dispatchableSteps.length < readySteps.length;
                if (capabilityWaiting) {
                    if (dispatchableSteps.length === 0) continue;
                    try {
                        await this.engine.restoreWaitingToReady(mission.missionId);
                    } catch {
                        continue;
                    }
                    const restored = await this.store.getMissionSchedulingRecord(mission.missionId);
                    if (!restored || (
                        restored.state !== MissionState.READY
                        && restored.state !== MissionState.EXECUTING
                    )) continue;
                }
                if (!capabilityWaiting && readySteps.length > 0 && dispatchableSteps.length === 0) {
                    await this.engine.setWaiting(
                        mission.missionId,
                        MissionState.WAITING_FOR_CAPABILITY,
                        'No ready capability currently has both a registered descriptor and connector',
                    );
                    recordWaitingMissionId(mission.missionId);
                    continue;
                }
                // Dispatch directly while scanning the durable plan. This avoids
                // building an unbounded in-memory candidate queue; at most
                // `maxInFlight` connector calls can be active in this pass.
                let becameUnavailable = false;
                for (const step of dispatchableSteps) {
                    if (dispatchSlots <= 0) break;
                    try {
                        const outcome = await this.seam.dispatchThroughSeam(mission.missionId, step.stepId);
                        didDispatch = true;
                        appendReportId(dispatchedInvocationIds, outcome.invocation.invocationId, this.reportIdLimit);
                        dispatchSlots--;
                    } catch (error) {
                        if (isCapabilityWaitError(error)) {
                            becameUnavailable = true;
                            continue;
                        }
                        await this.handleDispatchError(mission.missionId, error, recordWaitingMissionId);
                        break;
                    }
                }
                if (hasUnavailableReadyStep || becameUnavailable) {
                    const latest = await this.store.getMissionSchedulingRecord(mission.missionId);
                    if (latest && canWaitForCapability(latest.state)) {
                        if (latest.state !== MissionState.WAITING_FOR_CAPABILITY) {
                            await this.engine.setWaiting(
                                mission.missionId,
                                MissionState.WAITING_FOR_CAPABILITY,
                                'At least one ready capability is not currently dispatchable',
                            );
                        }
                        recordWaitingMissionId(mission.missionId);
                    }
                }
            }
            missionCursor = page.nextCursor;
        } while (missionCursor && dispatchSlots > 0);

        // This is intentionally independent of the bounded recovery query.
        // Old unsupported rows cannot hide a later eligible wakeup, and the
        // database returns only the single minimum timestamp.
        const nextWakeAt = await this.store.getNextInvocationWakeAt(now);
        return {
            recoveredMissionIds: recovery.recoveredMissionIds,
            reconciledInvocationIds,
            dispatchedInvocationIds,
            waitingMissionIds: [...new Set(waitingMissionIds)],
            nextWakeAt,
            idle: !didDispatch,
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
        recordWaitingMissionId: (missionId: string) => void,
    ): Promise<void> {
        if (isCapabilityWaitError(error)) {
            const mission = await this.store.getMissionSchedulingRecord(missionId);
            if (mission && canWaitForCapability(mission.state)) {
                if (mission.state !== MissionState.WAITING_FOR_CAPABILITY) {
                    await this.engine.setWaiting(
                        missionId,
                        MissionState.WAITING_FOR_CAPABILITY,
                        error instanceof Error ? error.message : String(error),
                    );
                }
                recordWaitingMissionId(missionId);
            }
            return;
        }
        // A post-handoff seam exception is already durable on its invocation.
        // Blocking only the affected Mission keeps recovery/reconciliation
        // local and prevents one connector from stopping unrelated work.
        const mission = await this.store.getMissionSchedulingRecord(missionId);
        if (mission && !TERMINAL_STATES.has(mission.state) && mission.state !== MissionState.PAUSED) {
            await this.engine.blockMission(
                missionId,
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}

function appendReportId(ids: string[], id: string, limit: number | undefined): void {
    if (limit !== undefined && ids.length >= limit) return;
    ids.push(id);
}

function isCapabilityWaitError(error: unknown): error is
    CapabilityUnavailableError | ConnectorNotRegisteredError | UnknownCapabilityError {
    return error instanceof CapabilityUnavailableError
        || error instanceof ConnectorNotRegisteredError
        || error instanceof UnknownCapabilityError;
}

function canWaitForCapability(state: MissionState): boolean {
    return state === MissionState.READY
        || state === MissionState.EXECUTING
        || state === MissionState.WAITING_FOR_CAPABILITY;
}

/** Compatibility name for callers that describe the component by purpose. */
export { MissionScheduler as DurableMissionScheduler };
