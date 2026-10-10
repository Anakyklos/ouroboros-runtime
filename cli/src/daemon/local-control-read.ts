import type { CapabilityRegistryApi } from "../capabilities/registry.js";
import type { MissionStore } from "../mission/ports.js";
import {
  type DaemonProjectionCompletenessEntry,
  type DaemonStatusProjection,
} from "../../../shared/daemon-event-contract.js";
import {
  LOCAL_CONTROL_MAX_DIAGNOSTICS,
  LOCAL_CONTROL_MAX_ID_LENGTH,
  LOCAL_CONTROL_MAX_INVOCATIONS,
  LOCAL_CONTROL_MAX_MISSIONS,
  LOCAL_CONTROL_MAX_REGISTRY_ITEMS,
  LOCAL_CONTROL_PROTOCOL_VERSION,
  type LocalControlDiagnostic,
  type LocalControlDiagnosticCode,
  type LocalControlProjectionFacts,
  type LocalControlReadResponse,
  type LocalControlRuntimeIdentity,
} from "../../../shared/local-control-read-contract.js";
import {
  emptyDurableProjection,
  projectDaemonStatus,
  projectInvocation,
  projectMission,
  readDurableProjection,
} from "./durable-projection.js";

export interface LocalControlReadServiceDependencies {
  getStatus(): DaemonStatusProjection;
  getRuntimeIdentity(): LocalControlRuntimeIdentity;
  missionStore?: MissionStore;
  capabilityRegistry?: Pick<CapabilityRegistryApi, "listDescriptors" | "listDescriptorPage">;
  readDiagnostics?(limit: number): readonly unknown[];
}

const FAILURE_MESSAGES = {
  INVALID_REQUEST: "The local-control request is invalid",
  PROTOCOL_VERSION_REQUIRED: "A supported protocol version is required",
  PROTOCOL_VERSION_UNSUPPORTED: "The requested protocol version is not supported",
  INVALID_ID: "The requested identity is invalid",
  INVALID_LIMIT: "The requested limit is invalid",
  READ_FAILED: "The requested facts could not be read",
} as const;

const DIAGNOSTIC_CODES = new Set<LocalControlDiagnosticCode>([
  "MISSION_PROJECTION_UNAVAILABLE",
  "INVOCATION_PROJECTION_UNAVAILABLE",
  "CAPABILITY_REGISTRY_UNAVAILABLE",
  "STORAGE_UNAVAILABLE",
  "PROJECTION_TRUNCATED",
]);

const DIAGNOSTIC_SEVERITIES = new Set(["info", "warning", "error"] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: keyof typeof FAILURE_MESSAGES): LocalControlReadResponse {
  return { ok: false, code, message: FAILURE_MESSAGES[code] };
}

function completenessAfterLimit(
  source: DaemonProjectionCompletenessEntry,
  liveIncluded: number,
  historicalIncluded: number,
): DaemonProjectionCompletenessEntry {
  const liveOmitted = source.liveOmitted + source.liveIncluded - liveIncluded;
  const historicalOmitted = source.historicalOmitted + source.historicalIncluded - historicalIncluded;
  return {
    liveIncluded,
    liveOmitted,
    historicalIncluded,
    historicalOmitted,
    truncated: source.truncated || liveOmitted > 0 || historicalOmitted > 0,
  };
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= LOCAL_CONTROL_MAX_ID_LENGTH;
}

function checkedLimit(value: unknown, defaultValue: number, maximum: number): number | null {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) return null;
  return value as number;
}

function projectedDiagnostics(values: readonly unknown[], limit: number) {
  const inspected = values.slice(0, limit + 1);
  const safe = inspected.slice(0, limit).flatMap((value): LocalControlDiagnostic[] => {
    if (!isRecord(value) || !DIAGNOSTIC_CODES.has(value.code as LocalControlDiagnosticCode)) return [];
    if (!DIAGNOSTIC_SEVERITIES.has(value.severity as "info" | "warning" | "error")) return [];
    const timestamp = typeof value.timestamp === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.timestamp) &&
      Number.isFinite(Date.parse(value.timestamp))
      ? value.timestamp
      : undefined;
    return [{
      code: value.code as LocalControlDiagnosticCode,
      severity: value.severity as LocalControlDiagnostic["severity"],
      ...(timestamp === undefined ? {} : { timestamp }),
    }];
  });
  const items = safe.slice(0, limit);
  return {
    available: true,
    items,
    completeness: {
      included: items.length,
      omitted: Math.max(0, values.length - items.length),
      truncated: values.length > items.length,
    },
  } as const;
}

/**
 * Transport-neutral read boundary for authoritative local-control facts.
 * It has no Fastify, WebSocket, JSON-RPC, session, agent, provider, or mutation dependency.
 */
export class LocalControlReadService {
  constructor(private readonly dependencies: LocalControlReadServiceDependencies) {}

  /** Execute one bounded, versioned read request and return only public facts. */
  async read(input: unknown): Promise<LocalControlReadResponse> {
    if (!isRecord(input) || typeof input.operation !== "string") return failure("INVALID_REQUEST");
    if (input.operation === "protocol.negotiate") {
      if (!Array.isArray(input.supportedVersions) || input.supportedVersions.length < 1 || input.supportedVersions.length > 8) {
        return failure("PROTOCOL_VERSION_REQUIRED");
      }
      if (!input.supportedVersions.every((version) => Number.isSafeInteger(version) && (version as number) > 0)) {
        return failure("INVALID_REQUEST");
      }
      if (!input.supportedVersions.includes(LOCAL_CONTROL_PROTOCOL_VERSION)) {
        return failure("PROTOCOL_VERSION_UNSUPPORTED");
      }
      return {
        ok: true,
        protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
        operation: "protocol.negotiate",
        selectedVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
        supportedVersions: [LOCAL_CONTROL_PROTOCOL_VERSION],
      };
    }

    if (input.protocolVersion === undefined) return failure("PROTOCOL_VERSION_REQUIRED");
    if (input.protocolVersion !== LOCAL_CONTROL_PROTOCOL_VERSION) return failure("PROTOCOL_VERSION_UNSUPPORTED");

    try {
      switch (input.operation) {
        case "health": {
          const status = this.getSafeStatus();
          return {
            ok: true,
            protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
            operation: "health",
            data: {
              healthy: status.processStatus === "alive",
              runtime: this.dependencies.getRuntimeIdentity(),
              uptimeSeconds: status.uptimeSeconds,
              timestamp: status.timestamp,
            },
          };
        }
        case "status":
          return {
            ok: true,
            protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
            operation: "status",
            data: this.getSafeStatus(),
          };
        case "mission.list": {
          const limit = checkedLimit(input.limit, LOCAL_CONTROL_MAX_MISSIONS, LOCAL_CONTROL_MAX_MISSIONS);
          if (limit === null) return failure("INVALID_LIMIT");
          if (!this.hasDurableProjection()) {
            return { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: "mission.list", data: { available: false, items: [] } };
          }
          const durable = await readDurableProjection(this.dependencies.missionStore!, {
            maxMissions: LOCAL_CONTROL_MAX_MISSIONS,
            maxInvocations: LOCAL_CONTROL_MAX_INVOCATIONS,
          });
          const source = durable.completeness.missions;
          const liveCount = Math.min(source.liveIncluded, limit);
          const historicalCount = Math.min(source.historicalIncluded, Math.max(0, limit - liveCount));
          return {
            ok: true,
            protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
            operation: "mission.list",
            data: {
              available: true,
              items: [...durable.missions.slice(0, source.liveIncluded).slice(0, liveCount), ...durable.missions.slice(source.liveIncluded, source.liveIncluded + historicalCount)],
              completeness: completenessAfterLimit(source, liveCount, historicalCount),
            },
          };
        }
        case "mission.show": {
          if (!validIdentity(input.missionId)) return failure("INVALID_ID");
          if (!this.dependencies.missionStore) {
            return { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: "mission.show", data: { available: false, item: null } };
          }
          const mission = await this.dependencies.missionStore.getMission(input.missionId);
          return {
            ok: true,
            protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
            operation: "mission.show",
            data: { available: true, item: mission === null ? null : projectMission(mission) },
          };
        }
        case "invocation.list": {
          const limit = checkedLimit(input.limit, LOCAL_CONTROL_MAX_INVOCATIONS, LOCAL_CONTROL_MAX_INVOCATIONS);
          if (limit === null) return failure("INVALID_LIMIT");
          if (!this.hasDurableProjection()) {
            return { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: "invocation.list", data: { available: false, items: [] } };
          }
          const durable = await readDurableProjection(this.dependencies.missionStore!, {
            maxMissions: LOCAL_CONTROL_MAX_MISSIONS,
            maxInvocations: LOCAL_CONTROL_MAX_INVOCATIONS,
          });
          const source = durable.completeness.invocations;
          const liveCount = Math.min(source.liveIncluded, limit);
          const historicalCount = Math.min(source.historicalIncluded, Math.max(0, limit - liveCount));
          return {
            ok: true,
            protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
            operation: "invocation.list",
            data: {
              available: true,
              items: [...durable.invocations.slice(0, source.liveIncluded).slice(0, liveCount), ...durable.invocations.slice(source.liveIncluded, source.liveIncluded + historicalCount)],
              completeness: completenessAfterLimit(source, liveCount, historicalCount),
            },
          };
        }
        case "invocation.show": {
          if (!validIdentity(input.invocationId)) return failure("INVALID_ID");
          if (!this.dependencies.missionStore) {
            return { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: "invocation.show", data: { available: false, item: null } };
          }
          const invocation = await this.dependencies.missionStore.getInvocation(input.invocationId);
          return {
            ok: true,
            protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
            operation: "invocation.show",
            data: { available: true, item: invocation === null ? null : projectInvocation(invocation) },
          };
        }
        case "capability_registry.list": {
          const limit = checkedLimit(input.limit, LOCAL_CONTROL_MAX_REGISTRY_ITEMS, LOCAL_CONTROL_MAX_REGISTRY_ITEMS);
          if (limit === null) return failure("INVALID_LIMIT");
          if (!this.dependencies.capabilityRegistry) {
            return { ok: true, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, operation: "capability_registry.list", data: { available: false, items: [], truncated: false } };
          }
          const registry = this.dependencies.capabilityRegistry;
          const page = registry.listDescriptorPage?.(limit);
          let descriptors;
          let truncated: boolean;
          if (page) {
            descriptors = page.descriptors;
            truncated = page.truncated;
          } else {
            const completeDescriptors = registry.listDescriptors();
            descriptors = completeDescriptors.slice(0, limit);
            truncated = completeDescriptors.length > descriptors.length;
          }
          const items = descriptors.map((descriptor) => ({
            capabilityId: descriptor.capabilityId,
            moduleOwner: descriptor.moduleOwner,
            contractVersion: descriptor.contractVersion,
            purpose: descriptor.purpose,
            effectClass: descriptor.effectClass,
            requiresApproval: descriptor.requiresApproval,
            requiresOwnerVerification: descriptor.requiresOwnerVerification,
            ownsStorage: descriptor.ownsStorage,
            availability: descriptor.availability,
          }));
          return {
            ok: true,
            protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
            operation: "capability_registry.list",
            data: {
              available: true,
              items,
              truncated,
            },
          };
        }
        case "diagnostics.list": {
          const limit = checkedLimit(input.limit, LOCAL_CONTROL_MAX_DIAGNOSTICS, LOCAL_CONTROL_MAX_DIAGNOSTICS);
          if (limit === null) return failure("INVALID_LIMIT");
          if (!this.dependencies.readDiagnostics) {
            return {
              ok: true,
              protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
              operation: "diagnostics.list",
              data: { available: false, items: [], completeness: { included: 0, omitted: 0, truncated: false } },
            };
          }
          return {
            ok: true,
            protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
            operation: "diagnostics.list",
            data: projectedDiagnostics(this.dependencies.readDiagnostics(limit + 1), limit),
          };
        }
        default:
          return failure("INVALID_REQUEST");
      }
    } catch {
      return failure("READ_FAILED");
    }
  }

  /** Sanitized semantic facts consumed by read clients and event adapters. */
  async readProjectionFacts(): Promise<LocalControlProjectionFacts> {
    const status = this.getSafeStatus();
    const durableProjectionAvailable = this.hasDurableProjection();
    const durable = this.hasDurableProjection()
      ? await readDurableProjection(this.dependencies.missionStore!, {
          maxMissions: LOCAL_CONTROL_MAX_MISSIONS,
          maxInvocations: LOCAL_CONTROL_MAX_INVOCATIONS,
        })
      : emptyDurableProjection();
    return {
      status,
      missions: durable.missions,
      invocations: durable.invocations,
      completeness: durable.completeness,
      durableProjectionAvailable,
    };
  }

  private hasDurableProjection(): boolean {
    return typeof this.dependencies.missionStore?.readProjection === "function";
  }

  private getSafeStatus(): DaemonStatusProjection {
    return projectDaemonStatus(this.dependencies.getStatus());
  }
}

/** Construct actual process identity for the current runtime. */
export function currentLocalControlRuntimeIdentity(): LocalControlRuntimeIdentity {
  return {
    processId: process.pid,
    processTitle: process.title,
    runtime: process.versions.bun ? "bun" : "node",
    runtimeVersion: process.versions.bun ?? process.version,
  };
}
