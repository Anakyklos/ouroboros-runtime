import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  EffectClass,
  MissionState,
  type Mission,
  type PlanRevision,
} from "../cli/src/mission/contracts.js";
import { SqliteMissionStore } from "../cli/src/mission/sqlite-mission-store.js";

function makeMission(id: string, state: MissionState): Mission {
  const intent = `Synthetic lifecycle fixture ${id}`;
  return {
    missionId: id,
    schemaVersion: 1,
    source: "operator",
    originalIntent: intent,
    sanitizedOriginalIntent: intent,
    originalIntentRef: createHash("sha256").update(intent).digest("hex"),
    interpretedObjective: "Measure daemon lifecycle with synthetic state.",
    constraints: [],
    acceptanceCriteria: ["fixture remains durable"],
    budgetPolicy: {},
    allowedCapabilityScope: {
      capabilityIds: ["fixture.read"],
      allowedEffectClasses: [EffectClass.READ],
      allowedRefPrefixes: ["refs/fixture/"],
    },
    approvalRequirements: [],
    contextRefs: [],
    state,
    currentPlanRevisionId: `revision-${id}`,
    invocationRefs: [],
    evidenceRefs: [],
    criterionVerifications: [],
    unresolvedQuestions: [],
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
    recoveryMetadata: { recovered: false, recoveryCount: 0 },
  };
}

async function main(): Promise<void> {
  const [dbArgument, fixtureMode = "recovery"] = process.argv.slice(2);
  if (!dbArgument || !["idle", "recovery", "inspect"].includes(fixtureMode)) {
    throw new Error("Usage: bun run scripts/headless-lifecycle-fixtures.ts <db-path> <idle|recovery|inspect>");
  }

  const dbPath = resolve(dbArgument);
  await mkdir(dirname(dbPath), { recursive: true });
  const store = new SqliteMissionStore(dbPath);
  await store.initialize();

  if (fixtureMode === "inspect") {
    try {
      const missions = await store.listMissions();
      console.log(JSON.stringify({
        missionIds: missions.map((mission) => mission.missionId).sort(),
        states: Object.fromEntries(missions.map((mission) => [mission.missionId, mission.state])),
      }));
    } finally {
      await store.close();
    }
    return;
  }

  const fixtureStates = fixtureMode === "idle"
    ? [["fixture-waiting", MissionState.WAITING_FOR_PROVIDER] as const]
    : [
        ["fixture-waiting", MissionState.WAITING_FOR_PROVIDER] as const,
        ["fixture-ready", MissionState.READY] as const,
      ];

  try {
    for (const [id, state] of fixtureStates) {
      const mission = makeMission(id, state);
      const revision: PlanRevision = {
        revisionId: `revision-${id}`,
        revisionNumber: 1,
        planId: `plan-${id}`,
        missionId: id,
        steps: [{
          stepId: "synthetic-read",
          desiredOutcome: "Retain synthetic fixture state.",
          dependencyIds: [],
          capabilityRequirement: "fixture.read",
          inputRefs: ["refs/fixture/lifecycle"],
          expectedAcceptance: ["fixture remains durable"],
          effectClass: EffectClass.READ,
        }],
        status: "accepted",
        reason: "Synthetic lifecycle baseline fixture.",
        acceptedAt: "2026-10-07T00:00:00.000Z",
        createdAt: "2026-10-07T00:00:00.000Z",
      };
      await store.createMission(mission);
      await store.savePlanRevision(revision);
    }
    console.log(JSON.stringify({
      database: dbPath,
      fixtureMode,
      missionIds: fixtureStates.map(([id]) => id),
      states: fixtureStates.map(([, state]) => state),
    }));
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
