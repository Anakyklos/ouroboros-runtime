import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalControlAdmissionService } from "./local-control-admission.js";
import { MissionEngine } from "../mission/mission-engine.js";
import { PlanPolicyValidator } from "../mission/policy.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import { FakeCapabilityResolver, FakeClock, FakeIdGenerator } from "../mission/testing.js";
import type { LocalControlAuthenticatedClient } from "../../../shared/local-control-auth-contract.js";

const stores: SqliteMissionStore[] = [];

async function harness(clientId = "client-a") {
  const dir = mkdtempSync(join(tmpdir(), "ouroboros-admission-"));
  const store = new SqliteMissionStore(join(dir, "missions.db"));
  stores.push(store);
  await store.initialize();
  const resolver = new FakeCapabilityResolver();
  const engine = new MissionEngine({
    store,
    policy: new PlanPolicyValidator(resolver),
    clock: new FakeClock("2026-10-29T00:00:00.000Z"),
    ids: new FakeIdGenerator("mission-admission"),
    interpreter: (intent) => intent.originalIntent,
  });
  const service = new LocalControlAdmissionService(engine, store);
  const client: LocalControlAuthenticatedClient = { clientId, credentialVersion: "v1", scopes: ["mission.create"] };
  return { dir, store, engine, service, client };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    operation: "mission.admit",
    requestId: "req-1",
    originalIntent: "Admit a mission",
    constraints: ["c1"],
    acceptanceCriteria: ["a1"],
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    void store.close();
  }
});

describe("LocalControlAdmissionService", () => {
  it("admits a valid MissionIntent and returns the public projection", async () => {
    const { service, client } = await harness();
    const response = await service.admit(request(), client);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.state).toBe("created");
    expect(response.data.invocationIds).toEqual([]);
  });

  it("rejects invalid protocol versions and missing fields", async () => {
    const { service, client } = await harness();
    expect((await service.admit({ ...request(), protocolVersion: 2 }, client)).ok).toBe(false);
    expect((await service.admit({ operation: "mission.admit", requestId: "r", originalIntent: "x", constraints: [], acceptanceCriteria: [] }, client)).ok).toBe(false);
  });

  it("rejects unknown fields and injected authority", async () => {
    const { service, client } = await harness();
    const injected = request({ allowedCapabilityScope: { capabilityIds: ["x"], allowedEffectClasses: [], allowedRefPrefixes: [] } });
    expect((await service.admit(injected, client)).ok).toBe(false);
    const sourceInjected = request({ source: "cli" });
    expect((await service.admit(sourceInjected, client)).ok).toBe(false);
  });

  it("replays the same Mission for an equivalent retry", async () => {
    const { service, client } = await harness();
    const first = await service.admit(request(), client);
    const second = await service.admit(request(), client);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.data.missionId).toBe(first.data.missionId);
    }
  });

  it("rejects conflicting payloads for the same request id", async () => {
    const { service, client } = await harness();
    const first = await service.admit(request(), client);
    expect(first.ok).toBe(true);
    const conflict = await service.admit(request({ originalIntent: "different" }), client);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("ADMISSION_CONFLICT");
  });

  it("isolates admissions by client", async () => {
    const { store, engine } = await harness();
    const service = new LocalControlAdmissionService(engine, store);
    const clientA: LocalControlAuthenticatedClient = { clientId: "a", credentialVersion: "v", scopes: ["mission.create"] };
    const clientB: LocalControlAuthenticatedClient = { clientId: "b", credentialVersion: "v", scopes: ["mission.create"] };
    const first = await service.admit(request(), clientA);
    const second = await service.admit(request(), clientB);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.data.missionId).not.toBe(first.data.missionId);
    }
  });

  it("does not create a duplicate under concurrent equivalent requests", async () => {
    const { service, client } = await harness();
    const [a, b] = await Promise.all([service.admit(request(), client), service.admit(request(), client)]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.data.missionId).toBe(b.data.missionId);
    }
  });
});
