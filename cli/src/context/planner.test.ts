import { describe, expect, it } from "bun:test";
import type { PlannerPort } from "../mission/ports.js";
import { EffectClass, type PlanCandidate } from "../mission/contracts.js";
import { createSeamHarness } from "./seam-harness.js";
import { makeContextConnector, makeContextDescriptor, makeContextRequest } from "./fixtures.js";
import { SeamBoundContextReader } from "./sources.js";
import { ProgressiveContextPackRuntime } from "./progressive.js";
import { ContextPlanningCoordinator } from "./planner.js";

function candidate(missionId: string, steps: PlanCandidate["steps"] = []): PlanCandidate {
    return { planId: `plan-${missionId}`, missionId, plannerNote: "bounded proposal", steps };
}

function validReadCandidate(missionId: string): PlanCandidate {
    return candidate(missionId, [{
        stepId: "read-planning-context",
        desiredOutcome: "read bounded planning reference",
        dependencyIds: [],
        expectedAcceptance: ["reference read"],
        effectClass: EffectClass.READ,
        capabilityRequirement: "context:planning",
        inputRefs: ["refs/planning/input"],
    }]);
}

function containsFunction(value: unknown): boolean {
    if (typeof value === "function") return true;
    if (!value || typeof value !== "object") return false;
    return Object.values(value).some(containsFunction);
}

describe("ContextPlanningCoordinator", () => {
    it("sends only the sanitized bounded projection to the planner and persists pack accounting", async () => {
        const descriptor = makeContextDescriptor("planning");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const mission = await harness.engine.createMission({
            intent: {
                requestId: "planner-boundary-1",
                source: "cli",
                originalIntent: "Prepare report; api_key=secret-planner-raw-123",
                constraints: ["No destructive effects"],
                acceptanceCriteria: ["Report is ready"],
                contextRefs: [],
            },
            allowedCapabilityScope: { capabilityIds: [descriptor.capabilityId], allowedEffectClasses: [EffectClass.READ], allowedRefPrefixes: ["refs/planning/"] },
        });
        let observed: unknown;
        const planner: PlannerPort = {
            proposePlan: async (input) => {
                observed = input;
                return validReadCandidate(mission.missionId);
            },
            replan: async (input) => {
                observed = input;
                return validReadCandidate(mission.missionId);
            },
        };
        const runtime = new ProgressiveContextPackRuntime({
            store: harness.store,
            reader: new SeamBoundContextReader(harness.engine, harness.seam, harness.registry),
        });
        const coordinator = new ContextPlanningCoordinator(harness.engine, planner, runtime);

        const result = await coordinator.proposePlan(
            mission.missionId,
            makeContextRequest({ missionId: mission.missionId, subject: `mission:${mission.missionId}` }),
        );

        expect(result.ok).toBe(true);
        expect(JSON.stringify(observed)).not.toContain("api_key=secret-planner-raw-123");
        expect(JSON.stringify(observed)).toContain("[REDACTED]");
        expect(JSON.stringify(observed)).not.toMatch(/originalIntent|store|sqlite|transcript|chain.of.thought|credential/i);
        expect(observed).toHaveProperty("mission.sanitizedIntent");
        expect(observed).toHaveProperty("package");
        expect(containsFunction(observed)).toBe(false);
        expect(JSON.parse(JSON.stringify(observed))).toEqual(observed);
        const durable = await harness.store.getMission(mission.missionId);
        expect(durable?.contextAccounting).toBeDefined();
        expect(durable?.contextAccounting?.aggregate.chars).toBeGreaterThan(0);
        await harness.close();
    });

    it("compiles initial planning without calling any connector or owner", async () => {
        const descriptor = makeContextDescriptor("planning");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const mission = await harness.engine.createMission({
            intent: {
                requestId: "planner-no-owner-1",
                source: "cli",
                originalIntent: "Prepare report",
                constraints: [],
                acceptanceCriteria: [],
                contextRefs: [],
            },
            allowedCapabilityScope: { capabilityIds: [descriptor.capabilityId], allowedEffectClasses: [EffectClass.READ], allowedRefPrefixes: ["refs/planning/"] },
        });
        let calls = 0;
        harness.seam.registerConnector(descriptor.capabilityId, {
            ...makeContextConnector(descriptor, { rows: [] }),
            invoke: async (request) => {
                calls++;
                return makeContextConnector(descriptor, { rows: [] }).invoke(request);
            },
        });
        const planner: PlannerPort = {
            proposePlan: async () => validReadCandidate(mission.missionId),
            replan: async () => validReadCandidate(mission.missionId),
        };
        const runtime = new ProgressiveContextPackRuntime({
            store: harness.store,
            reader: new SeamBoundContextReader(harness.engine, harness.seam, harness.registry),
        });
        const coordinator = new ContextPlanningCoordinator(harness.engine, planner, runtime);

        await coordinator.proposePlan(
            mission.missionId,
            makeContextRequest({ missionId: mission.missionId, subject: `mission:${mission.missionId}` }),
        );

        expect(calls).toBe(0);
        await harness.close();
    });

    it("keeps policy authoritative and recompiles durable state for replan with a sanitized reason", async () => {
        const descriptor = makeContextDescriptor("planning");
        const harness = await createSeamHarness({ descriptors: [descriptor] });
        const mission = await harness.engine.createMission({
            intent: {
                requestId: "planner-replan-1",
                source: "cli",
                originalIntent: "Prepare report",
                constraints: [],
                acceptanceCriteria: [],
                contextRefs: [],
            },
            allowedCapabilityScope: { capabilityIds: [descriptor.capabilityId], allowedEffectClasses: [EffectClass.READ], allowedRefPrefixes: ["refs/planning/"] },
        });
        let dispatches = 0;
        harness.seam.registerConnector(descriptor.capabilityId, {
            ...makeContextConnector(descriptor, { rows: [] }),
            invoke: async (request) => {
                dispatches++;
                return makeContextConnector(descriptor, { rows: [] }).invoke(request);
            },
        });
        let calls = 0;
        let observedInput: unknown;
        let observedReason: string | undefined;
        const planner: PlannerPort = {
            proposePlan: async () => candidate(mission.missionId, [{
                stepId: "unauthorized-step",
                desiredOutcome: "write outside mission scope",
                dependencyIds: [],
                expectedAcceptance: [],
                effectClass: "write" as never,
                capabilityRequirement: "external.write",
                inputRefs: [],
            }]),
            replan: async (input, reason) => {
                calls++;
                observedInput = input;
                observedReason = reason;
                return validReadCandidate(mission.missionId);
            },
        };
        const runtime = new ProgressiveContextPackRuntime({
            store: harness.store,
            reader: new SeamBoundContextReader(harness.engine, harness.seam, harness.registry),
        });
        const coordinator = new ContextPlanningCoordinator(harness.engine, planner, runtime);
        const request = makeContextRequest({ missionId: mission.missionId, subject: `mission:${mission.missionId}` });

        const rejected = await coordinator.proposePlan(mission.missionId, request);
        expect(rejected.ok).toBe(false);
        expect(calls).toBe(0);
        await harness.store.updateMission(mission.missionId, { interpretedObjective: "Updated durable objective" });
        const replanned = await coordinator.replan(mission.missionId, request, "rejected: token=private-reason-123");

        expect(replanned.ok).toBe(true);
        expect(calls).toBe(1);
        expect(dispatches).toBe(0);
        expect(observedReason).toContain("token= [REDACTED]");
        expect(observedReason).not.toContain("private-reason-123");
        expect(observedInput).toHaveProperty("mission.objective", "Updated durable objective");
        expect(JSON.stringify(observedInput)).not.toContain("transcript");
        expect(replanned.ok && replanned.revision.steps).toHaveLength(1);
        await harness.close();
    });
});
