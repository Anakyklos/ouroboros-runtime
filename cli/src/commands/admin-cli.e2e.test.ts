import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdminCli } from "./admin-cli.js";
import { LocalControlReadClient, LoopbackJsonRpcTransport } from "./local-control-client.js";
import { SqliteMissionStore } from "../mission/sqlite-mission-store.js";
import { EffectClass, InvocationStatus, MissionState, type CapabilityInvocation, type Mission } from "../mission/contracts.js";
import { CancellationSupport, IdempotencyMode, ReconciliationSupport, RetryBackoff } from "../capabilities/contracts.js";
import { EffectClass as CapabilityEffectClass } from "../capabilities/contracts.js";
import { defineCapabilityDescriptor } from "../capabilities/fixtures.js";
import { CapabilityRegistry } from "../capabilities/registry.js";
import { startHeadlessDaemon } from "../daemon/main.js";
import { LocalControlCredentialStore, writeLocalControlClientCredential } from "../daemon/local-control-auth.js";

const NOW = "2026-10-10T12:00:00.000Z";

function missionFixture(): Mission {
  return {
    missionId: "cli-e2e-mission",
    schemaVersion: 1,
    source: "cli",
    originalIntent: "PRIVATE original prompt must never be projected",
    sanitizedOriginalIntent: "PRIVATE sanitized prompt must never be projected",
    originalIntentRef: "sha256:cli-e2e-intent",
    interpretedObjective: "Read a durable invocation projection",
    constraints: [],
    acceptanceCriteria: ["projection is public and bounded"],
    budgetPolicy: {},
    allowedCapabilityScope: {
      capabilityIds: ["example.read-only"],
      allowedEffectClasses: [EffectClass.READ_ONLY],
      allowedRefPrefixes: ["refs/test/"],
    },
    approvalRequirements: [],
    contextRefs: [],
    state: MissionState.COMPLETED,
    currentPlanRevisionId: "cli-e2e-revision",
    invocationRefs: [],
    evidenceRefs: [],
    criterionVerifications: [],
    unresolvedQuestions: [],
    createdAt: NOW,
    updatedAt: NOW,
    recoveryMetadata: { recovered: false, recoveryCount: 0 },
  };
}

function invocationFixture(): CapabilityInvocation {
  return {
    invocationId: "cli-e2e-invocation",
    missionId: "cli-e2e-mission",
    stepId: "cli-e2e-step",
    capabilityId: "example.read-only",
    planRevisionId: "cli-e2e-revision",
    contractVersion: 1,
    moduleOwner: "test-owner",
    effectClass: EffectClass.READ_ONLY,
    requestId: "cli-e2e-request",
    effectFingerprint: "sha256:cli-e2e-effect",
    inputRefs: [],
    idempotency: { mode: IdempotencyMode.IDEMPOTENT, key: "cli-e2e-idempotency" },
    retry: { maxAttempts: 1, attempt: 1, backoff: RetryBackoff.NONE, backoffMs: 0, nextEligibleAt: null },
    attempts: [],
    delivery: { state: "acknowledged", acknowledgedAt: NOW, remoteOperationHandle: "PRIVATE_REMOTE_HANDLE" },
    cancellation: { support: CancellationSupport.UNSUPPORTED, requested: false, state: "not_requested" },
    reconciliation: { support: ReconciliationSupport.NONE, state: "not_required" },
    ownerVerificationState: "verified",
    status: InvocationStatus.COMPLETED,
    completedAt: NOW,
    resultRefs: ["PRIVATE_RESULT_REF"],
    error: "PRIVATE raw provider error",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function unusedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

describe("administrative CLI over authenticated daemon HTTP and temporary SQLite", () => {
  it("reads persisted public invocation projections and enforces mission.read at the daemon", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ouroboros-admin-cli-e2e-"));
    const port = await unusedPort();
    const credentialDir = join(dataDir, "credentials");
    const validFile = join(credentialDir, "reader.json");
    const invalidFile = join(credentialDir, "invalid.json");
    const deniedFile = join(credentialDir, "without-read.json");
    const absentFile = join(credentialDir, "absent.json");
    const revokedFile = join(credentialDir, "revoked.json");
    let stop: (() => Promise<void>) | undefined;

    try {
      const store = new SqliteMissionStore(join(dataDir, "missions.db"));
      await store.initialize();
      await store.createMission(missionFixture());
      await store.saveInvocation(invocationFixture());
      await store.close();

      const authStore = new LocalControlCredentialStore(join(dataDir, "local-control-auth.db"));
      const valid = authStore.provision("cli-e2e-reader", ["mission.read"], Date.now() + 60 * 60_000);
      const denied = authStore.provision("cli-e2e-no-read", ["daemon.admin"], Date.now() + 60 * 60_000);
      const revoked = authStore.provision("cli-e2e-revoked", ["mission.read"], Date.now() + 60 * 60_000);
      authStore.revoke(revoked.clientId);
      authStore.close();
      writeLocalControlClientCredential(validFile, { schemaVersion: 1, clientId: valid.clientId, token: valid.token });
      writeLocalControlClientCredential(invalidFile, { schemaVersion: 1, clientId: valid.clientId, token: "oc1.invalid.invalidtokenvalue" });
      writeLocalControlClientCredential(deniedFile, { schemaVersion: 1, clientId: denied.clientId, token: denied.token });
      writeLocalControlClientCredential(revokedFile, { schemaVersion: 1, clientId: revoked.clientId, token: revoked.token });

      stop = await startHeadlessDaemon({ dataDir, port, forceTerminate: () => {}, setExitCode: () => {}, onDiagnostic: () => {} });

      const run = async (credentialFile: string, args: string[]) => {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const client = new LocalControlReadClient(new LoopbackJsonRpcTransport({
          baseUrl: `http://127.0.0.1:${port}`,
          credentialFile,
        }));
        const code = await runAdminCli(args, {
          client,
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        });
        return { code, stdout: stdout.join(""), stderr: stderr.join("") };
      };

      const listed = await run(validFile, ["invocations"]);
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.stdout)).toMatchObject({
        available: true,
        items: [{ invocationId: "cli-e2e-invocation", missionId: "cli-e2e-mission", status: "completed" }],
        completeness: { liveIncluded: 0, historicalIncluded: 1, truncated: false },
      });
      expect(`${listed.stdout}${listed.stderr}`).not.toMatch(/PRIVATE original prompt|PRIVATE sanitized prompt|PRIVATE_REMOTE_HANDLE|PRIVATE_RESULT_REF|PRIVATE raw provider error/);

      const shown = await run(validFile, ["invocation", "show", "cli-e2e-invocation"]);
      expect(shown.code).toBe(0);
      expect(JSON.parse(shown.stdout)).toMatchObject({ result: "found", invocation: { invocationId: "cli-e2e-invocation" } });
      expect(`${shown.stdout}${shown.stderr}`).not.toMatch(/PRIVATE_REMOTE_HANDLE|PRIVATE_RESULT_REF|PRIVATE raw provider error/);

      const diagnostics = await run(validFile, ["diagnostics"]);
      expect(diagnostics.code).toBe(1);
      expect(JSON.parse(diagnostics.stdout)).toEqual({ available: false, items: [], completeness: { included: 0, omitted: 0, truncated: false } });

      const capabilities = await run(validFile, ["capabilities"]);
      expect(capabilities.code).toBe(0);
      expect(capabilities.stderr).toBe("");
      expect(JSON.parse(capabilities.stdout)).toEqual({ available: true, items: [], truncated: false });

      await stop();
      stop = undefined;
      let fixtureRegistry: CapabilityRegistry | undefined;
      const configureFixtureRegistry = (registry: CapabilityRegistry) => {
        fixtureRegistry = registry;
        for (let index = 0; index < 101; index += 1) {
          registry.register(defineCapabilityDescriptor({
            capabilityId: `fixture.read-only-${String(index).padStart(3, "0")}`,
            moduleOwner: "fixture-owner",
            purpose: "Read one public fixture fact",
            effectClass: CapabilityEffectClass.READ,
            requiresOwnerVerification: true,
            credentialRequirement: { kind: "reference", credentialRef: "PRIVATE_FIXTURE_CREDENTIAL" },
          }));
        }
      };
      stop = await startHeadlessDaemon({
        dataDir,
        port,
        configureCapabilitiesForTests: configureFixtureRegistry,
        forceTerminate: () => {},
        setExitCode: () => {},
        onDiagnostic: () => {},
      });

      const fixtureCapabilities = await run(validFile, ["capabilities"]);
      expect(fixtureCapabilities.code).toBe(0);
      const fixtureProjection = JSON.parse(fixtureCapabilities.stdout) as { available: boolean; items: unknown[]; truncated: boolean };
      expect(fixtureProjection.available).toBe(true);
      expect(fixtureProjection.items[0]).toEqual({
        capabilityId: "fixture.read-only-000",
        moduleOwner: "fixture-owner",
        contractVersion: 1,
        purpose: "Read one public fixture fact",
        effectClass: "read",
        requiresApproval: false,
        requiresOwnerVerification: true,
        ownsStorage: false,
        availability: "available",
      });
      expect(fixtureProjection.items).toHaveLength(100);
      expect(fixtureProjection.truncated).toBe(true);
      expect(fixtureCapabilities.stdout).not.toContain("PRIVATE_FIXTURE_CREDENTIAL");

      const boundedCapabilities = await run(validFile, ["capabilities"]);
      expect(boundedCapabilities.code).toBe(0);
      const boundedProjection = JSON.parse(boundedCapabilities.stdout) as { items: unknown[]; truncated: boolean };
      expect(boundedProjection.items).toHaveLength(100);
      expect(boundedProjection.truncated).toBe(true);
      expect(fixtureRegistry?.listDescriptors()).toHaveLength(101);

      await stop();
      stop = undefined;
      const invocationDb = new Database(join(dataDir, "missions.db"), { readonly: true });
      expect(invocationDb.query("SELECT COUNT(*) AS count FROM mission_invocations").get()).toEqual({ count: 1 });
      invocationDb.close();

      stop = await startHeadlessDaemon({
        dataDir,
        port,
        configureCapabilitiesForTests: configureFixtureRegistry,
        forceTerminate: () => {},
        setExitCode: () => {},
        onDiagnostic: () => {},
      });
      const restartedCapabilities = await run(validFile, ["capabilities"]);
      expect(restartedCapabilities.code).toBe(0);
      expect(JSON.parse(restartedCapabilities.stdout)).toEqual(JSON.parse(fixtureCapabilities.stdout));

      const registryReads = spyOn(fixtureRegistry!, "listDescriptorPage");
      const registryReadsBeforeRejectedClients = registryReads.mock.calls.length;
      for (const credentialFile of [absentFile, invalidFile, deniedFile, revokedFile]) {
        const rejected = await run(credentialFile, ["invocations"]);
        expect(rejected.code).toBe(1);
        expect(rejected.stdout).toBe("");
        expect(rejected.stderr).not.toMatch(/token|oc1\.|PRIVATE/);

        const rejectedCapabilities = await run(credentialFile, ["capabilities"]);
        expect(rejectedCapabilities.code).toBe(1);
        expect(rejectedCapabilities.stdout).toBe("");
        expect(rejectedCapabilities.stderr).not.toMatch(/token|oc1\.|PRIVATE/);
      }
      expect(registryReads).toHaveBeenCalledTimes(registryReadsBeforeRejectedClients);
    } finally {
      await stop?.();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
