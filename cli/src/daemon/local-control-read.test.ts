import { describe, expect, it, mock } from "bun:test";
import { LocalControlReadService } from "./local-control-read.js";
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  LOCAL_CONTROL_READ_OPERATIONS,
} from "../../../shared/local-control-read-contract.js";
import type { DaemonStatusProjection } from "../../../shared/daemon-event-contract.js";
import type { Mission, CapabilityInvocation } from "../mission/contracts.js";
import type { MissionStore, MissionProjectionRead } from "../mission/ports.js";

const status: DaemonStatusProjection = {
  processStatus: "alive",
  mode: "running",
  uptimeSeconds: 12,
  activeSessions: { available: true, value: 0, unit: "count" },
  activeWaves: { available: true, value: 0, unit: "count" },
  activeTasks: { available: true, value: 0, unit: "count" },
  tokensUsed: { available: false, reason: "not_available" },
  memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1 },
  capabilities: {
    statusMetrics: true,
    modeSwitching: true,
    supportedModes: ["running", "pause"],
    emergencyBrake: true,
    brakeRecoverable: false,
    modePersistence: true,
    tokenMetrics: false,
  },
  timestamp: "2026-10-06T00:00:00.000Z",
};

function mission(missionId: string): Mission {
  return {
    missionId,
    state: "ready",
    source: "cli",
    originalIntent: "PRIVATE PROMPT",
    sanitizedIntent: "PRIVATE INTENT",
    constraints: ["PRIVATE CONSTRAINT"],
    acceptanceCriteria: ["PRIVATE ACCEPTANCE"],
    contextRefs: [{ ref: "private://context", content: "PRIVATE CONTEXT" }],
    currentPlanRevisionId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    recoveryMetadata: { recoveryCount: 0 },
    invocationRefs: [],
    approvalRequirements: [],
  } as unknown as Mission;
}

function invocation(invocationId: string): CapabilityInvocation {
  return {
    invocationId,
    missionId: "mission-1",
    stepId: "step-1",
    capabilityId: "capability.read",
    moduleOwner: "owner",
    planRevisionId: "revision-1",
    status: "completed",
    delivery: { state: "acknowledged" },
    ownerVerificationState: "verified",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    result: { body: "PRIVATE RESULT" },
    error: "PRIVATE ERROR",
    idempotencyKey: "PRIVATE IDEMPOTENCY",
  } as unknown as CapabilityInvocation;
}

function storeWith(read: MissionProjectionRead): MissionStore {
  return {
    readProjection: mock(async () => read),
    getMission: mock(async (id: string) => [...read.liveMissions, ...read.historicalMissions].find((value) => value.missionId === id) ?? null),
    getInvocation: mock(async (id: string) => [...read.liveInvocations, ...read.historicalInvocations].find((value) => value.invocationId === id) ?? null),
  } as unknown as MissionStore;
}

function emptyRead(): MissionProjectionRead {
  return {
    liveMissions: [],
    historicalMissions: [],
    liveInvocations: [],
    historicalInvocations: [],
    liveMissionCount: 0,
    historicalMissionCount: 0,
    liveInvocationCount: 0,
    historicalInvocationCount: 0,
  };
}

function service(overrides: Partial<ConstructorParameters<typeof LocalControlReadService>[0]> = {}) {
  return new LocalControlReadService({
    getStatus: () => status,
    getRuntimeIdentity: () => ({
      processId: process.pid,
      processTitle: process.title,
      runtime: process.versions.bun ? "bun" : "node",
      runtimeVersion: process.versions.bun ?? process.version,
    }),
    missionStore: storeWith(emptyRead()),
    ...overrides,
  });
}

describe("LocalControlReadService", () => {
  it("negotiates the supported protocol version", async () => {
    const result = await service().read({ operation: "protocol.negotiate", supportedVersions: [1, 2] });
    expect(result).toEqual({
      ok: true,
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      operation: "protocol.negotiate",
      selectedVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      supportedVersions: [LOCAL_CONTROL_PROTOCOL_VERSION],
    });
  });

  it("fails closed for a missing or incompatible request version", async () => {
    const current = service();
    await expect(current.read({ operation: "protocol.negotiate" })).resolves.toEqual({
      ok: false,
      code: "PROTOCOL_VERSION_REQUIRED",
      message: "A supported protocol version is required",
    });
    await expect(current.read({ operation: "protocol.negotiate", supportedVersions: [99] })).resolves.toEqual({
      ok: false,
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      message: "The requested protocol version is not supported",
    });
    await expect(current.read({ operation: "status" })).resolves.toEqual({
      ok: false,
      code: "PROTOCOL_VERSION_REQUIRED",
      message: "A supported protocol version is required",
    });
    await expect(current.read({ operation: "status", protocolVersion: 900 })).resolves.toEqual({
      ok: false,
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      message: "The requested protocol version is not supported",
    });
  });

  it("reports real process identity and sanitized health", async () => {
    const result = await service().read({ operation: "health", protocolVersion: 1 });
    expect(result).toMatchObject({
      ok: true,
      operation: "health",
      data: {
        healthy: true,
        runtime: {
          processId: process.pid,
          processTitle: process.title,
          runtimeVersion: process.versions.bun ?? process.version,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("returns the sanitized operational status projection", async () => {
    const result = await service().read({ operation: "status", protocolVersion: 1 });
    expect(result).toMatchObject({ ok: true, operation: "status", data: status });
    expect(JSON.stringify(result)).not.toContain("sessionId");
  });

  it("reprojects status fields and drops unexpected sensitive properties", async () => {
    const result = await service({
      getStatus: () => ({ ...status, internalError: "PRIVATE RAW ERROR" }) as DaemonStatusProjection,
    }).read({ operation: "status", protocolVersion: 1 });
    expect(result).toMatchObject({ ok: true, operation: "status", data: status });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("bounds Mission lists and preserves completeness when the response truncates", async () => {
    const read = emptyRead();
    read.liveMissions = [mission("live-1"), mission("live-2")];
    read.historicalMissions = [mission("history-1"), mission("history-2")];
    read.liveMissionCount = 2;
    read.historicalMissionCount = 5;
    const result = await service({ missionStore: storeWith(read) }).read({
      operation: "mission.list",
      protocolVersion: 1,
      limit: 2,
    });
    expect(result).toMatchObject({
      ok: true,
      operation: "mission.list",
      data: {
        items: [{ missionId: "live-1" }, { missionId: "live-2" }],
        completeness: { liveIncluded: 2, historicalOmitted: 5, truncated: true },
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("shows an exact existing Mission through its public projection", async () => {
    const result = await service({
      missionStore: storeWith({ ...emptyRead(), liveMissions: [mission("mission-1")], liveMissionCount: 1 }),
    }).read({ operation: "mission.show", protocolVersion: 1, missionId: "mission-1" });
    expect(result).toMatchObject({ ok: true, operation: "mission.show", data: { item: { missionId: "mission-1" } } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("returns a null Mission for an exact ID that does not exist", async () => {
    const result = await service().read({ operation: "mission.show", protocolVersion: 1, missionId: "absent" });
    expect(result).toMatchObject({ ok: true, operation: "mission.show", data: { item: null } });
  });

  it("does not return raw durable read errors", async () => {
    const store = {
      ...storeWith(emptyRead()),
      getMission: mock(async () => { throw new Error("PRIVATE RAW ERROR"); }),
    } as unknown as MissionStore;
    const result = await service({ missionStore: store }).read({
      operation: "mission.show",
      protocolVersion: 1,
      missionId: "mission-1",
    });
    expect(result).toEqual({ ok: false, code: "READ_FAILED", message: "The requested facts could not be read" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("shows an exact Mission even when it is outside the bounded list projection", async () => {
    const read = emptyRead();
    const store = storeWith(read);
    (store.getMission as unknown as ReturnType<typeof mock>).mockImplementation(async (id: string) =>
      id === "old-mission" ? mission(id) : null,
    );
    const result = await service({ missionStore: store }).read({
      operation: "mission.show",
      protocolVersion: 1,
      missionId: "old-mission",
    });
    expect(result).toMatchObject({ ok: true, operation: "mission.show", data: { available: true, item: { missionId: "old-mission" } } });
    expect(store.getMission).toHaveBeenCalledWith("old-mission");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("bounds Invocation lists and shows sanitized exact Invocation projections", async () => {
    const read = emptyRead();
    read.liveInvocations = [invocation("invocation-1"), invocation("invocation-2")];
    read.liveInvocationCount = 2;
    read.historicalInvocationCount = 8;
    const current = service({ missionStore: storeWith(read) });
    const list = await current.read({ operation: "invocation.list", protocolVersion: 1, limit: 1 });
    expect(list).toMatchObject({
      ok: true,
      operation: "invocation.list",
      data: { items: [{ invocationId: "invocation-1" }], completeness: { truncated: true } },
    });
    const show = await current.read({ operation: "invocation.show", protocolVersion: 1, invocationId: "invocation-1" });
    expect(show).toMatchObject({ ok: true, operation: "invocation.show", data: { item: { invocationId: "invocation-1" } } });
    const absent = await current.read({ operation: "invocation.show", protocolVersion: 1, invocationId: "absent" });
    expect(absent).toMatchObject({ ok: true, operation: "invocation.show", data: { item: null } });
    expect(JSON.stringify([list, show, absent])).not.toContain("PRIVATE");
  });

  it("rejects malformed IDs without echoing them", async () => {
    const current = service();
    for (const id of ["", "  ", "x".repeat(257), 17, null]) {
      const result = await current.read({ operation: "mission.show", protocolVersion: 1, missionId: id });
      expect(result).toEqual({ ok: false, code: "INVALID_ID", message: "The requested identity is invalid" });
      expect(JSON.stringify(result)).not.toContain("x".repeat(20));
    }
    await expect(current.read({ operation: "mission.list", protocolVersion: 1, limit: 100000 })).resolves.toEqual({
      ok: false,
      code: "INVALID_LIMIT",
      message: "The requested limit is invalid",
    });
  });

  it("projects only safe registry fields when a registry is composed", async () => {
    const registry = {
      listDescriptors: () => [{
        capabilityId: "capability.read",
        moduleOwner: "owner",
        contractVersion: 1,
        purpose: "Read public facts",
        effectClass: "read_only",
        requiresApproval: false,
        requiresOwnerVerification: false,
        ownsStorage: false,
        availability: "available",
        credentialRequirement: { credentialRef: "PRIVATE CREDENTIAL" },
        allowedInputRefPrefixes: ["private://"],
        schemas: { input: { private: "PRIVATE SCHEMA" } },
      }, {
        capabilityId: "capability.other",
        moduleOwner: "owner",
        contractVersion: 1,
        purpose: "Another read",
        effectClass: "read_only",
        requiresApproval: false,
        requiresOwnerVerification: false,
        ownsStorage: false,
        availability: "available",
      }],
    };
    const result = await service({ capabilityRegistry: registry as never }).read({
      operation: "capability_registry.list",
      protocolVersion: 1,
      limit: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      operation: "capability_registry.list",
      data: { available: true, items: [{ capabilityId: "capability.read", purpose: "Read public facts" }], truncated: true },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).not.toContain("credential");
  });

  it("says when the authoritative registry is not present", async () => {
    const result = await service().read({ operation: "capability_registry.list", protocolVersion: 1 });
    expect(result).toMatchObject({ ok: true, operation: "capability_registry.list", data: { available: false } });
  });

  it("reports Mission reads unavailable when no authoritative store is composed", async () => {
    const current = service({ missionStore: undefined });
    await expect(current.read({ operation: "mission.list", protocolVersion: 1 })).resolves.toMatchObject({
      ok: true,
      operation: "mission.list",
      data: { available: false, items: [] },
    });
    await expect(current.read({ operation: "mission.show", protocolVersion: 1, missionId: "mission-1" })).resolves.toMatchObject({
      ok: true,
      operation: "mission.show",
      data: { available: false, item: null },
    });
  });

  it("returns bounded diagnostics and explicit unavailability when not composed", async () => {
    const result = await service().read({ operation: "diagnostics.list", protocolVersion: 1, limit: 1 });
    expect(result).toMatchObject({ ok: true, operation: "diagnostics.list", data: { available: false } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("bounds and sanitizes composed diagnostics", async () => {
    let requestedLimit = 0;
    const result = await service({
      readDiagnostics: (limit) => {
        requestedLimit = limit;
        return [
        { code: "PROJECTION_TRUNCATED", severity: "warning", timestamp: "2026-10-01T00:00:00.000Z", message: "PRIVATE RAW ERROR" },
        { code: "STORAGE_UNAVAILABLE", severity: "error", detail: "PRIVATE PATH" },
        { code: "PRIVATE PROMPT", severity: "error", message: "PRIVATE" },
        ];
      },
    }).read({ operation: "diagnostics.list", protocolVersion: 1, limit: 1 });
    expect(result).toEqual({
      ok: true,
      protocolVersion: 1,
      operation: "diagnostics.list",
      data: {
        available: true,
        items: [{ code: "PROJECTION_TRUNCATED", severity: "warning", timestamp: "2026-10-01T00:00:00.000Z" }],
        completeness: { included: 1, omitted: 2, truncated: true },
      },
    });
    expect(requestedLimit).toBe(2);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("keeps the public read contract free of legacy authority methods and JSON serializable", async () => {
    const current = service();
    const names = ["health", "status", "mission.list", "mission.show", "invocation.list", "invocation.show", "capability_registry.list", "diagnostics.list"];
    const results = await Promise.all(names.map((operation) => current.read({ operation, protocolVersion: 1 })));
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain("daemon.delegate");
    expect(serialized).not.toContain("agent.");
    expect(serialized).not.toContain("session.");
    expect(serialized).not.toContain("provider.");
    expect(serialized).not.toContain("operation\":\"pause");
    expect(serialized).not.toContain("operation\":\"resume");
    expect(serialized).not.toContain("operation\":\"cancel");
    expect(LOCAL_CONTROL_READ_OPERATIONS).toEqual([
      "protocol.negotiate", "snapshot", "health", "status", "mission.list", "mission.show",
      "invocation.list", "invocation.show", "capability_registry.list", "diagnostics.list",
    ]);
    expect(LOCAL_CONTROL_READ_OPERATIONS.some((operation) => /^(agent|session|daemon\.delegate|provider)\./.test(operation))).toBe(false);
    expect(JSON.parse(serialized)).toEqual(results);
  });
});
