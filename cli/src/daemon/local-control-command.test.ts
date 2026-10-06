import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LOCAL_CONTROL_COMMAND_PROTOCOL_VERSION as VERSION } from "../../../shared/local-control-command-contract.js";
import { LOCAL_CONTROL_MAX_REASON_LENGTH, LOCAL_CONTROL_MAX_PROVENANCE_LENGTH } from "../../../shared/local-control-command-contract.js";
import { LocalControlCommandService } from "./local-control-command.js";
import { MissionEngine } from "../mission/mission-engine.js";
import { PlanPolicyValidator } from "../mission/policy.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import { FakeCapabilityResolver, FakeClock, FakeIdGenerator, makeDefaultCapabilityCatalog } from "../mission/testing.js";
import { EffectClass, InvocationStatus } from "../mission/contracts.js";
import { CancellationSupport, IdempotencyMode, ReconciliationSupport, RetryBackoff } from "../capabilities/contracts.js";
import { RpcGateway } from "./rpc-gateway.js";
import { EventBus } from "./event-bus.js";

const stores: SqliteMissionStore[] = [];

async function harness() {
  const store = new SqliteMissionStore(":memory:");
  stores.push(store);
  await store.initialize();
  const resolver = new FakeCapabilityResolver();
  resolver.registerMany(makeDefaultCapabilityCatalog());
  const engine = new MissionEngine({
    store,
    policy: new PlanPolicyValidator(resolver),
    clock: new FakeClock("2026-10-06T00:00:00.000Z"),
    ids: new FakeIdGenerator("mission-command"),
    interpreter: (intent) => intent.originalIntent,
  });
  return {
    store,
    engine,
    service: new LocalControlCommandService(engine),
  };
}

async function createMission(engine: MissionEngine, originalIntent = "safe intent") {
  return engine.createMission({
    intent: {
      requestId: "request-command",
      source: "cli",
      originalIntent,
      constraints: [],
      acceptanceCriteria: [],
    },
    allowedCapabilityScope: { capabilityIds: [], allowedEffectClasses: [], allowedRefPrefixes: [] },
    budgetPolicy: {},
  });
}

async function createDispatchedInvocation(engine: MissionEngine, requestId: string) {
  const mission = await engine.createMission({
    intent: { requestId, source: "cli", originalIntent: "Review PR", constraints: [], acceptanceCriteria: ["review"] },
    allowedCapabilityScope: { capabilityIds: ["runstead.code-review"], allowedEffectClasses: [EffectClass.EXECUTION], allowedRefPrefixes: ["refs/runstead/"] },
  });
  const proposal = await engine.proposePlan(mission.missionId, {
    planId: `plan-${requestId}`, missionId: mission.missionId, plannerNote: "review",
    steps: [{ stepId: "review", desiredOutcome: "Review", dependencyIds: [], capabilityRequirement: "runstead.code-review", inputRefs: ["refs/runstead/pr/1"], expectedAcceptance: ["review"], effectClass: EffectClass.EXECUTION }],
  });
  if (!proposal.ok) throw new Error("Expected deterministic test plan to pass policy");
  await engine.acceptPlan(mission.missionId, proposal.revision.revisionId);
  const invocation = await engine.dispatchStep(mission.missionId, "review", { descriptor: {
    contractVersion: 1, moduleOwner: "runstead",
    idempotency: { mode: IdempotencyMode.IDEMPOTENT, keyScope: "request" },
    retry: { maxAttempts: 2, backoff: RetryBackoff.FIXED },
    cancellationSupport: CancellationSupport.COOPERATIVE,
    reconciliationSupport: ReconciliationSupport.STATUS_REPLAY,
  } });
  return { mission, invocation };
}

function createRuntime(store: SqliteMissionStore) {
  const resolver = new FakeCapabilityResolver();
  resolver.registerMany(makeDefaultCapabilityCatalog());
  return new MissionEngine({
    store,
    policy: new PlanPolicyValidator(resolver),
    clock: new FakeClock("2026-10-06T00:00:00.000Z"),
    ids: new FakeIdGenerator("mission-restart"),
    interpreter: (intent) => intent.originalIntent,
  });
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("local-control command contract", () => {
  it("exposes an explicit protocol version and three exact operation discriminators", async () => {
    const { service } = await harness();
    const missionId = "mission-valid";
    const cases = [
      { operation: "mission.pause", protocolVersion: VERSION, missionId, reason: "hold" },
      { operation: "mission.resume", protocolVersion: VERSION, missionId },
      { operation: "mission.cancel", protocolVersion: VERSION, missionId, reason: "stop" },
    ];
    for (const request of cases) expect((await service.execute(request)).code).not.toBe("INVALID_REQUEST");
  });

  it("rejects missing, empty, oversized identities, unknown operations and unexpected keys", async () => {
    const { service } = await harness();
    const invalid = [
      { operation: "mission.pause", protocolVersion: VERSION, reason: "hold" },
      { operation: "mission.pause", protocolVersion: VERSION, missionId: "", reason: "hold" },
      { operation: "mission.pause", protocolVersion: VERSION, missionId: "m".repeat(257), reason: "hold" },
      { operation: "mission.delete", protocolVersion: VERSION, missionId: "x" },
      { operation: "mission.pause", protocolVersion: VERSION, missionId: "x", reason: "hold", extra: true },
      null,
      [],
    ];
    for (const request of invalid) expect((await service.execute(request)).ok).toBe(false);
  });

  it("rejects incompatible or absent protocol versions", async () => {
    const { service } = await harness();
    expect(await service.execute({ operation: "mission.pause", missionId: "x", reason: "hold" })).toMatchObject({ ok: false, code: "PROTOCOL_VERSION_REQUIRED" });
    expect(await service.execute({ operation: "mission.pause", protocolVersion: VERSION + 1, missionId: "x", reason: "hold" })).toMatchObject({ ok: false, code: "PROTOCOL_VERSION_UNSUPPORTED" });
  });

  it("bounds reason and provenance text", async () => {
    const { service } = await harness();
    expect((await service.execute({ operation: "mission.pause", protocolVersion: VERSION, missionId: "x", reason: "r".repeat(LOCAL_CONTROL_MAX_REASON_LENGTH + 1) })).code).toBe("INVALID_TEXT");
    expect((await service.execute({ operation: "mission.cancel", protocolVersion: VERSION, missionId: "x", reason: "stop", cancelledBy: "p".repeat(LOCAL_CONTROL_MAX_PROVENANCE_LENGTH + 1) })).code).toBe("INVALID_TEXT");
  });
});

describe("LocalControlCommandService", () => {
  it("pauses idempotently and reports the durable public projection", async () => {
    const { engine, service } = await harness();
    const mission = await createMission(engine, "Authorization: Bearer secret-123");
    const request = { operation: "mission.pause", protocolVersion: VERSION, missionId: mission.missionId, reason: "operator hold", pausedBy: "operator-7" };
    const first = await service.execute(request);
    const repeated = await service.execute(request);
    expect(first).toMatchObject({ ok: true, operation: "mission.pause", data: { missionId: mission.missionId, state: "paused" } });
    expect(repeated).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("secret-123");
    expect(JSON.stringify(first)).not.toContain("originalIntent");
    expect(JSON.stringify(first)).not.toContain("pauseMetadata");
  });

  it("resumes only a paused Mission and rejects replay after the transition", async () => {
    const { engine, service } = await harness();
    const mission = await createMission(engine);
    const request = { operation: "mission.resume", protocolVersion: VERSION, missionId: mission.missionId };
    expect(await service.execute(request)).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    await service.execute({ operation: "mission.pause", protocolVersion: VERSION, missionId: mission.missionId, reason: "hold" });
    expect(await service.execute(request)).toMatchObject({ ok: true, data: { state: "created" } });
    expect(await service.execute(request)).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
  });

  it("maps missing and terminal Missions to typed failures without leaking internal errors", async () => {
    const { engine, service } = await harness();
    expect(await service.execute({ operation: "mission.pause", protocolVersion: VERSION, missionId: "missing", reason: "hold" })).toMatchObject({ ok: false, code: "MISSION_NOT_FOUND" });
    const mission = await createMission(engine);
    await service.execute({ operation: "mission.cancel", protocolVersion: VERSION, missionId: mission.missionId, reason: "stop" });
    expect(await service.execute({ operation: "mission.cancel", protocolVersion: VERSION, missionId: mission.missionId, reason: "stop" })).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    const failure = await service.execute({ operation: "mission.cancel", protocolVersion: VERSION, missionId: "unknown-secret", reason: "api_key=bad" });
    expect(JSON.stringify(failure)).not.toContain("unknown-secret");
    expect(JSON.stringify(failure)).not.toContain("bad");
  });

  it("sanitizes reason and provenance before durable persistence", async () => {
    const { engine, service, store } = await harness();
    const mission = await createMission(engine);
    await service.execute({ operation: "mission.cancel", protocolVersion: VERSION, missionId: mission.missionId, reason: "api_key=secret", cancelledBy: "token=private" });
    const saved = await store.getMission(mission.missionId);
    expect(saved?.unresolvedQuestions.join(" ")).toContain("[REDACTED]");
    expect(saved?.unresolvedQuestions.join(" ")).not.toContain("secret");
    const paused = await createMission(engine);
    await service.execute({ operation: "mission.pause", protocolVersion: VERSION, missionId: paused.missionId, reason: "token=private", pausedBy: "password=private" });
    const pausedSaved = await store.getMission(paused.missionId);
    expect(pausedSaved?.pauseMetadata?.reason).toContain("[REDACTED]");
    expect(pausedSaved?.pauseMetadata?.pausedBy).toContain("[REDACTED]");
    expect(JSON.stringify(pausedSaved?.pauseMetadata)).not.toContain("private");
    expect(JSON.stringify(await service.execute({ operation: "mission.pause", protocolVersion: VERSION, missionId: "missing", reason: "password=secret" }))).not.toContain("secret");
  });

  it("sanitizes unexpected authority failures without returning raw errors", async () => {
    const service = new LocalControlCommandService({
      pauseMission: async () => { throw new Error("PRIVATE PROMPT api_key=secret"); },
      resumeMission: async () => { throw new Error("PRIVATE PROMPT api_key=secret"); },
      cancelMission: async () => { throw new Error("PRIVATE PROMPT api_key=secret"); },
    } as unknown as MissionEngine);
    const failure = await service.execute({ operation: "mission.pause", protocolVersion: VERSION, missionId: "mission-safe", reason: "hold" });
    expect(failure).toMatchObject({ ok: false, code: "COMMAND_FAILED", message: "The Mission command could not be completed" });
    expect(JSON.stringify(failure)).not.toContain("PRIVATE");
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("routes one command through the authority port and leaves local_control.read compatible", async () => {
    const { engine, store } = await harness();
    const mission = await createMission(engine, "PRIVATE PROMPT password=hunter2");
    const authority = {
      pauseMission: mock(engine.pauseMission.bind(engine)),
      resumeMission: engine.resumeMission.bind(engine),
      cancelMission: engine.cancelMission.bind(engine),
    };
    const gateway = new RpcGateway({} as never, new EventBus(), store, undefined, authority);
    const command = await gateway.handleRequest({
      jsonrpc: "2.0", id: "cmd", method: "local_control.command",
      params: { operation: "mission.pause", protocolVersion: VERSION, missionId: mission.missionId, reason: "hold" },
    });
    const incompatible = await gateway.handleRequest({
      jsonrpc: "2.0", id: "version", method: "local_control.command",
      params: { operation: "mission.pause", protocolVersion: VERSION + 1, missionId: mission.missionId, reason: "hold" },
    });
    const read = await gateway.handleRequest({
      jsonrpc: "2.0", id: "read", method: "local_control.read",
      params: { operation: "mission.show", protocolVersion: 1, missionId: mission.missionId },
    });
    expect(authority.pauseMission).toHaveBeenCalledTimes(1);
    expect(command.error).toBeUndefined();
    expect(command.result).toMatchObject({ ok: true, data: { state: "paused" } });
    expect(incompatible.result).toMatchObject({ ok: false, code: "PROTOCOL_VERSION_UNSUPPORTED" });
    expect(read.result).toMatchObject({ ok: true, operation: "mission.show", data: { item: { state: "paused" } } });
    expect(JSON.stringify([command.result, read.result])).not.toContain("PRIVATE");
    expect(JSON.stringify([command.result, read.result])).not.toContain("hunter2");
  });

  it("fails closed when the daemon has no Mission authority", async () => {
    const gateway = new RpcGateway({} as never, new EventBus());
    const response = await gateway.handleRequest({
      jsonrpc: "2.0", id: "no-authority", method: "local_control.command",
      params: { operation: "mission.pause", protocolVersion: VERSION, missionId: "mission-safe", reason: "hold" },
    });
    expect(response.result).toEqual({ ok: false, code: "AUTHORITY_UNAVAILABLE", message: "Mission command authority is unavailable" });
  });

  it("cancels not-submitted work locally and keeps running active work reconcilable", async () => {
    const { engine, service, store } = await harness();
    const notSubmitted = await createDispatchedInvocation(engine, "request-not-submitted");
    await service.execute({ operation: "mission.cancel", protocolVersion: VERSION, missionId: notSubmitted.mission.missionId, reason: "stop before handoff" });
    expect(await store.getInvocation(notSubmitted.invocation.invocationId)).toMatchObject({
      status: InvocationStatus.CANCELLED,
      delivery: { state: "not_submitted" },
      cancellation: { requested: true, state: "acknowledged" },
    });

    const active = await createDispatchedInvocation(engine, "request-active");
    await engine.markInvocationHandoff(active.invocation.invocationId, { deliveryState: "running" });
    await service.execute({ operation: "mission.cancel", protocolVersion: VERSION, missionId: active.mission.missionId, reason: "stop active" });
    const saved = await store.getInvocation(active.invocation.invocationId);
    expect(saved).toMatchObject({
      status: InvocationStatus.RUNNING,
      delivery: { state: "running" },
      cancellation: { requested: true, state: "requested" },
      reconciliation: { state: "pending" },
    });
    expect(saved?.completedAt).toBeUndefined();
    expect(await store.listDueInvocations("2026-10-07T00:00:00.000Z", 10)).toEqual([]);
  });

  it("persists pause, cancellation intent and uncertain invocation across runtime reconstruction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-control-command-"));
    const dbPath = join(directory, "missions.db");
    try {
      const firstStore = new SqliteMissionStore(dbPath);
      stores.push(firstStore);
      await firstStore.initialize();
      const firstEngine = createRuntime(firstStore);
      const service = new LocalControlCommandService(firstEngine);
      const paused = await createMission(firstEngine);
      await service.execute({ operation: "mission.pause", protocolVersion: VERSION, missionId: paused.missionId, reason: "hold" });

      const { mission: active, invocation } = await createDispatchedInvocation(firstEngine, "req-active");
      await firstEngine.markInvocationHandoff(invocation.invocationId, { deliveryState: "uncertain", remoteOperationHandle: "remote-1" });
      await service.execute({ operation: "mission.cancel", protocolVersion: VERSION, missionId: active.missionId, reason: "stop" });
      await firstStore.close();
      stores.splice(stores.indexOf(firstStore), 1);

      const recoveredStore = new SqliteMissionStore(dbPath);
      stores.push(recoveredStore);
      await recoveredStore.initialize();
      const recoveredEngine = createRuntime(recoveredStore);
      const recoveredService = new LocalControlCommandService(recoveredEngine);
      expect((await recoveredService.execute({ operation: "mission.pause", protocolVersion: VERSION, missionId: paused.missionId, reason: "changed reason" }))).toMatchObject({ ok: true, data: { state: "paused" } });
      expect((await recoveredStore.getMission(paused.missionId))?.state).toBe("paused");
      expect((await recoveredStore.getMission(active.missionId))?.state).toBe("cancelled");
      expect(await recoveredService.execute({ operation: "mission.cancel", protocolVersion: VERSION, missionId: active.missionId, reason: "duplicate stop" })).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
      const recoveredInvocation = await recoveredStore.getInvocation(invocation.invocationId);
      expect(recoveredInvocation).toMatchObject({
        status: InvocationStatus.DISPATCHED,
        delivery: { state: "uncertain" },
        cancellation: { requested: true, state: "requested" },
        reconciliation: { state: "pending" },
      });
      expect(recoveredInvocation?.result).toBeUndefined();
      expect(recoveredInvocation?.completedAt).toBeUndefined();
      expect(await recoveredStore.listDueInvocations("2026-10-07T00:00:00.000Z", 10)).toEqual([]);
    } finally {
      await Promise.all(stores.splice(0).map((store) => store.close()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
