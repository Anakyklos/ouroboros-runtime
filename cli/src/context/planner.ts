/** Provider-neutral planning coordinator over bounded Context Packs (#78). */

import type { MissionEngine, PlanProposalResult } from "../mission/mission-engine.js";
import type { PlannerPort } from "../mission/ports.js";
import { containsRawSecret, sanitizeText } from "../mission/sanitize.js";
import type { ContextRequest } from "./contracts.js";
import type { ProgressiveContextPackRuntime } from "./progressive.js";

const MAX_REJECTION_REASON_CHARS = 500;

/**
 * Compiles every planner input from durable Mission state, then submits the
 * advisory candidate to MissionEngine for deterministic policy validation.
 * It owns no provider, storage, connector, or authority of its own.
 */
export class ContextPlanningCoordinator {
    constructor(
        private readonly engine: Pick<MissionEngine, "proposePlan">,
        private readonly planner: PlannerPort,
        private readonly contextRuntime: Pick<ProgressiveContextPackRuntime, "compileInitial">,
    ) {}

    /** Compile a fresh initial pack, request a proposal, and validate it. */
    async proposePlan(missionId: string, request: ContextRequest): Promise<PlanProposalResult> {
        const context = await this.contextRuntime.compileInitial(missionId, request);
        const candidate = await this.planner.proposePlan(context);
        return this.engine.proposePlan(missionId, candidate);
    }

    /** Recompile durable state and pass only a sanitized rejection reason. */
    async replan(
        missionId: string,
        request: ContextRequest,
        previousRejection: string,
    ): Promise<PlanProposalResult> {
        const reason = sanitizeText(previousRejection).trim().slice(0, MAX_REJECTION_REASON_CHARS);
        if (!reason || containsRawSecret(reason)) {
            throw new Error("replan rejection reason must be non-empty and sanitized");
        }
        const context = await this.contextRuntime.compileInitial(missionId, request);
        const candidate = await this.planner.replan(context, reason);
        return this.engine.proposePlan(missionId, candidate);
    }
}
