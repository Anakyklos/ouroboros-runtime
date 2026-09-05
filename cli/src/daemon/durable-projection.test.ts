import { afterEach, describe, expect, it } from "bun:test";
import {
  CancellationSupport,
  IdempotencyMode,
  ReconciliationSupport,
  RetryBackoff,
} from "../capabilities/contracts.js";
import {
  EffectClass,
  InvocationStatus,
  MissionState,
  type CapabilityInvocation,
  type Mission,
} from "../mission/contracts.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";

const NOW = "2026-09-04T00:00:00.000Z";
const stores: SqliteMissionStore[] = [];

function makeMission(
  missionId: string,
  state: MissionState,
  invocationIds: string[] = [],
): Mission {
  return {
    missionId,
    schemaVersion: 1,
    source: "mission_control",
    originalIntent: "Authorization: Bearer top-secret review prompt",
    sanitizedOriginalIntent: "[REDACTED] review prompt",
    originalIntentRef: "hash-of-original-intent",
    interpretedObjective: "sanitized objective",
    constraints: [],
    acceptanceCriteria: ["review complete"],
    budgetPolicy: {},
    allowedCapabilityScope: {
      capabilityIds: ["runstead.code-review"],
      allowedEffectClasses: [EffectClass.EXECUTION],
      allowedRefPrefixes: ["refs/runstead/"],
    },
    approvalRequirements: [],
    contextRefs: [],
    state,
    currentPlanRevisionId: "revision-1",
    invocationRefs: invocationIds.map((invocationId) => ({
      invocationId,
      missionId,
      stepId: "step-1",
      capabilityId: "runstead.code-review",
      status: InvocationStatus.RUNNING,
      resultRefs: [],
    })),
    evidenceRefs: [],
    criterionVerifications: [],
    unresolvedQuestions: ["Authorization: hidden question"],
    createdAt: NOW,
    updatedAt: NOW,
    recoveryMetadata: { recovered: true, recoveryCount: 2 },
  };
}

function makeInvocation(
  invocationId: string,
  missionId: string,
  status: InvocationStatus = InvocationStatus.RUNNING,
): CapabilityInvocation {
  return {
    invocationId,
    missionId,
    stepId: "step-1",
    capabilityId: "runstead.code-review",
    planRevisionId: "revision-1",
    contractVersion: 1,
    moduleOwner: "runstead",
    effectClass: EffectClass.EXECUTION,
    requestId: `request-${invocationId}`,
    effectFingerprint: `fingerprint-${invocationId}`,
    inputRefs: ["refs/runstead/review"],
    idempotency: { mode: IdempotencyMode.IDEMPOTENT, key: `idempotency-${invocationId}` },
    retry: {
      maxAttempts: 3,
      attempt: 1,
      backoff: RetryBackoff.FIXED,
      backoffMs: 1000,
      nextEligibleAt: null,
    },
    attempts: [{
      attempt: 1,
      correlationId: `correlation-${invocationId}`,
      state: "acknowledged",
      startedAt: NOW,
    }],
    delivery: { state: "running", remoteOperationHandle: "provider-private-handle" },
    cancellation: {
      support: CancellationSupport.UNSUPPORTED,
      requested: false,
      state: "not_requested",
    },
    reconciliation: { support: ReconciliationSupport.NONE, state: "not_required" },
    ownerVerificationState: "pending",
    status,
    resultRefs: [],
    error: "provider response with Authorization: Bearer private",
    dispatchedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function loadProjectionModule(): Promise<Record<string, unknown> | null> {
  return import("./durable-projection.js").catch(() => null);
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe("durable daemon projection", () => {
  it("projects running and waiting Missions without raw intent or questions", async () => {
    const module = await loadProjectionModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const projectMission = module.projectMission as (mission: Mission) => Record<string, unknown>;
    const projected = projectMission(makeMission("mission-waiting", MissionState.WAITING_FOR_PROVIDER));

    expect(projected).toMatchObject({
      missionId: "mission-waiting",
      state: "waiting_for_provider",
      currentPlanRevisionId: "revision-1",
      recoveryCount: 2,
      pendingApprovalCount: 0,
    });
    expect(JSON.stringify(projected)).not.toContain("Authorization");
    expect(JSON.stringify(projected)).not.toContain("hidden question");
    expect(JSON.stringify(projected)).not.toContain("originalIntent");
  });

  it("projects invocation identity and state without provider result or idempotency material", async () => {
    const module = await loadProjectionModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const projectInvocation = module.projectInvocation as (invocation: CapabilityInvocation) => Record<string, unknown>;
    const projected = projectInvocation(makeInvocation("invocation-1", "mission-running"));

    expect(projected).toMatchObject({
      invocationId: "invocation-1",
      missionId: "mission-running",
      status: "running",
      deliveryState: "running",
      ownerVerificationState: "pending",
    });
    expect(JSON.stringify(projected)).not.toContain("provider-private-handle");
    expect(JSON.stringify(projected)).not.toContain("idempotency");
    expect(JSON.stringify(projected)).not.toContain("Authorization");
  });

  it("reads a bounded durable projection from the existing MissionStore", async () => {
    const module = await loadProjectionModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const store = new SqliteMissionStore(":memory:");
    stores.push(store);
    await store.initialize();
    await store.createMission(makeMission("mission-running", MissionState.EXECUTING, ["invocation-1"]));
    await store.createMission(makeMission("mission-budget", MissionState.WAITING_FOR_BUDGET, ["invocation-2"]));
    const invocationOne = makeInvocation("invocation-1", "mission-running");
    const invocationTwo = makeInvocation("invocation-2", "mission-budget", InvocationStatus.PENDING);
    delete invocationOne.error;
    delete invocationTwo.error;
    await store.saveInvocation(invocationOne);
    await store.saveInvocation(invocationTwo);

    const readDurableProjection = module.readDurableProjection as (
      store: SqliteMissionStore,
      limits?: { maxMissions?: number; maxInvocations?: number },
    ) => Promise<{ missions: unknown[]; invocations: unknown[] }>;
    const projected = await readDurableProjection(store, { maxMissions: 1, maxInvocations: 1 });

    expect(projected.missions).toHaveLength(2);
    expect(projected.invocations).toHaveLength(2);
    expect(projected.completeness).toEqual({
      missions: {
        liveIncluded: 2,
        liveOmitted: 0,
        historicalIncluded: 0,
        historicalOmitted: 0,
        truncated: false,
      },
      invocations: {
        liveIncluded: 2,
        liveOmitted: 0,
        historicalIncluded: 0,
        historicalOmitted: 0,
        truncated: false,
      },
    });
    expect(JSON.stringify(projected)).not.toContain("Authorization");
    expect(JSON.stringify(projected)).not.toContain("provider-private-handle");
  });

  it("retains old live entities ahead of historical rows and exposes truncation", async () => {
    const module = await loadProjectionModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const store = new SqliteMissionStore(":memory:");
    stores.push(store);
    await store.initialize();

    const liveMission = {
      ...makeMission("mission-old-live", MissionState.EXECUTING, ["invocation-live"]),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.createMission(liveMission);

    for (let index = 0; index < 3; index += 1) {
      await store.createMission({
        ...makeMission(`mission-history-${index}`, MissionState.COMPLETED),
        createdAt: `2026-09-0${index + 1}T00:00:00.000Z`,
        updatedAt: `2026-09-0${index + 1}T00:00:00.000Z`,
      });
    }

    const liveInvocation = makeInvocation("invocation-live", liveMission.missionId);
    liveInvocation.createdAt = liveMission.createdAt;
    liveInvocation.updatedAt = liveMission.updatedAt;
    delete liveInvocation.error;
    await store.saveInvocation(liveInvocation);

    for (let index = 0; index < 3; index += 1) {
      const historicalInvocation = makeInvocation(
        `invocation-history-${index}`,
        `mission-history-${index}`,
        InvocationStatus.COMPLETED,
      );
      historicalInvocation.createdAt = `2026-09-0${index + 1}T00:00:00.000Z`;
      historicalInvocation.updatedAt = historicalInvocation.createdAt;
      historicalInvocation.completedAt = historicalInvocation.createdAt;
      delete historicalInvocation.error;
      await store.saveInvocation(historicalInvocation);
    }

    const boundedStore = store as SqliteMissionStore & {
      listMissions: () => Promise<never>;
    };
    boundedStore.listMissions = async () => {
      throw new Error("projection must not materialize the full Mission history");
    };

    const readDurableProjection = module.readDurableProjection as (
      store: SqliteMissionStore,
      limits?: { maxMissions?: number; maxInvocations?: number },
    ) => Promise<{
      missions: Array<{ missionId: string }>;
      invocations: Array<{ invocationId: string }>;
      completeness: {
        missions: Record<string, number | boolean>;
        invocations: Record<string, number | boolean>;
      };
    }>;
    const projected = await readDurableProjection(boundedStore, {
      maxMissions: 1,
      maxInvocations: 1,
    });

    expect(projected.missions.map((mission) => mission.missionId)).toContain("mission-old-live");
    expect(projected.invocations.map((invocation) => invocation.invocationId)).toContain("invocation-live");
    expect(projected.completeness).toEqual({
      missions: {
        liveIncluded: 1,
        liveOmitted: 0,
        historicalIncluded: 1,
        historicalOmitted: 2,
        truncated: true,
      },
      invocations: {
        liveIncluded: 1,
        liveOmitted: 0,
        historicalIncluded: 1,
        historicalOmitted: 2,
        truncated: true,
      },
    });
  });
});
