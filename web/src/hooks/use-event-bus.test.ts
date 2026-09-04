import { describe, expect, it } from "bun:test";
import type { DaemonEventEnvelope } from "../../../shared/daemon-event-contract";

const envelope: DaemonEventEnvelope = {
  version: 1,
  eventId: "mission-event-1",
  sequence: 1,
  event: "mission",
  data: {
    kind: "created",
    missionId: "mission-1",
    state: "executing",
    source: "mission_control",
    currentPlanRevisionId: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    recoveryCount: 0,
    invocationIds: [],
    pendingApprovalCount: 0,
  },
  timestamp: "2026-09-04T00:00:00.000Z",
};

async function loadHookModule(): Promise<Record<string, unknown> | null> {
  return import("./use-event-bus").catch(() => null);
}

describe("useEventBus event detail", () => {
  it("uses the validated event name and does not infer a legacy type", async () => {
    const module = await loadHookModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const toDaemonEventDetail = module.toDaemonEventDetail as (
      value: DaemonEventEnvelope,
    ) => Record<string, unknown>;
    const detail = toDaemonEventDetail(envelope);

    expect(detail).toEqual({ event: "mission", data: envelope.data, envelope });
    expect(detail.type).toBeUndefined();
  });
});
