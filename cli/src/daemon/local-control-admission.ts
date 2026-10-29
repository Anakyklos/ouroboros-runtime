import { createHash } from "node:crypto";
import type { MissionEngine } from "../mission/mission-engine.js";
import type { Mission, AllowedCapabilityScope } from "../mission/contracts.js";
import type { MissionStore, MissionAdmissionStore, MissionAdmissionRecord } from "../mission/ports.js";
import { sanitizeText, sanitizeStringArray, containsRawSecret } from "../mission/sanitize.js";
import {
  LOCAL_CONTROL_ADMISSION_OPERATION,
  LOCAL_CONTROL_ADMISSION_PROTOCOL_VERSION,
  LOCAL_CONTROL_ADMISSION_MAX_REQUEST_ID_LENGTH,
  LOCAL_CONTROL_ADMISSION_MAX_INTENT_LENGTH,
  LOCAL_CONTROL_ADMISSION_MAX_TEXT_ITEM_LENGTH,
  LOCAL_CONTROL_ADMISSION_MAX_ARRAY_ITEMS,
  LOCAL_CONTROL_ADMISSION_MAX_TOTAL_TEXT_LENGTH,
  type LocalControlAdmissionFailureCode,
  type LocalControlAdmissionResponse,
} from "../../../shared/local-control-admission-contract.js";
import { projectMission } from "./durable-projection.js";
import type { LocalControlAuthenticatedClient } from "../../../shared/local-control-auth-contract.js";

export interface MissionAdmissionAuthority {
  admit(input: unknown, client: LocalControlAuthenticatedClient): Promise<LocalControlAdmissionResponse>;
}

const EMPTY_SCOPE: AllowedCapabilityScope = {
  capabilityIds: [],
  allowedEffectClasses: [],
  allowedRefPrefixes: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: LocalControlAdmissionFailureCode): LocalControlAdmissionResponse {
  const messages: Record<LocalControlAdmissionFailureCode, string> = {
    INVALID_REQUEST: "The Mission admission request is invalid",
    PROTOCOL_VERSION_REQUIRED: "A protocol version is required",
    PROTOCOL_VERSION_UNSUPPORTED: "The requested protocol version is not supported",
    INVALID_ID: "The request identity is invalid",
    INVALID_TEXT: "Mission admission text is invalid",
    INVALID_PAYLOAD: "Mission admission payload is invalid",
    ADMISSION_CONFLICT: "Mission admission conflicts with an existing request",
    AUTHORITY_UNAVAILABLE: "Mission admission authority is unavailable",
    ADMISSION_FAILED: "Mission admission failed",
  };
  return { ok: false, code, message: messages[code] };
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim().length > 0 && value.length <= maxLength;
}

function stringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && item.length >= 0 && item.length <= maxLength);
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message) || /constraint failed/i.test(message);
}

export class LocalControlAdmissionService implements MissionAdmissionAuthority {
  private readonly engine: MissionEngine;
  private readonly store: MissionStore & MissionAdmissionStore;
  private readonly clock: { isoNow(): string };

  constructor(
    engineOrDeps: MissionEngine | { engine: MissionEngine; store: MissionStore & MissionAdmissionStore; clock?: { isoNow(): string } },
    store?: MissionStore & MissionAdmissionStore,
    clock?: { isoNow(): string },
  ) {
    if (typeof engineOrDeps === "object" && engineOrDeps !== null && "engine" in engineOrDeps) {
      const deps = engineOrDeps as { engine: MissionEngine; store: MissionStore & MissionAdmissionStore; clock?: { isoNow(): string } };
      this.engine = deps.engine;
      this.store = deps.store;
      this.clock = deps.clock ?? { isoNow: () => new Date().toISOString() };
    } else {
      this.engine = engineOrDeps as MissionEngine;
      this.store = store as MissionStore & MissionAdmissionStore;
      this.clock = clock ?? { isoNow: () => new Date().toISOString() };
    }
  }

  async admit(input: unknown, client: LocalControlAuthenticatedClient): Promise<LocalControlAdmissionResponse> {
    if (!isRecord(input)) return failure("INVALID_REQUEST");
    if (input.protocolVersion === undefined) return failure("PROTOCOL_VERSION_REQUIRED");
    if (input.protocolVersion !== LOCAL_CONTROL_ADMISSION_PROTOCOL_VERSION) return failure("PROTOCOL_VERSION_UNSUPPORTED");
    if (input.operation !== LOCAL_CONTROL_ADMISSION_OPERATION) return failure("INVALID_REQUEST");

    const allowedKeys = [
      "protocolVersion",
      "operation",
      "requestId",
      "originalIntent",
      "constraints",
      "acceptanceCriteria",
    ];
    if (!allowedKeys.every((key) => Object.prototype.hasOwnProperty.call(input, key))) return failure("INVALID_REQUEST");
    if (Object.keys(input).some((key) => !allowedKeys.includes(key))) return failure("INVALID_REQUEST");

    if (!boundedText(input.requestId, LOCAL_CONTROL_ADMISSION_MAX_REQUEST_ID_LENGTH)) return failure("INVALID_ID");
    if (containsRawSecret(input.requestId as string)) return failure("INVALID_ID");
    if (!boundedText(input.originalIntent, LOCAL_CONTROL_ADMISSION_MAX_INTENT_LENGTH)) return failure("INVALID_TEXT");
    if (!stringArray(input.constraints, LOCAL_CONTROL_ADMISSION_MAX_ARRAY_ITEMS, LOCAL_CONTROL_ADMISSION_MAX_TEXT_ITEM_LENGTH)) return failure("INVALID_PAYLOAD");
    if (!stringArray(input.acceptanceCriteria, LOCAL_CONTROL_ADMISSION_MAX_ARRAY_ITEMS, LOCAL_CONTROL_ADMISSION_MAX_TEXT_ITEM_LENGTH)) return failure("INVALID_PAYLOAD");

    const totalTextLength =
      input.originalIntent.length +
      (input.constraints as string[]).reduce((sum, item) => sum + item.length, 0) +
      (input.acceptanceCriteria as string[]).reduce((sum, item) => sum + item.length, 0);
    if (totalTextLength > LOCAL_CONTROL_ADMISSION_MAX_TOTAL_TEXT_LENGTH) return failure("INVALID_PAYLOAD");

    const requestId = input.requestId as string;
    const originalIntent = input.originalIntent as string;
    const constraints = input.constraints as string[];
    const acceptanceCriteria = input.acceptanceCriteria as string[];

    const fingerprint = createHash("sha256")
      .update(JSON.stringify({
        requestId,
        originalIntent,
        constraints,
        acceptanceCriteria,
      }))
      .digest("hex");

    const clientId = client.clientId;

    let mission: Mission | null = null;
    let replay = false;
    try {
      const result = await this.store.withTransaction(async () => {
        const existing = await this.store.getMissionAdmission(clientId, requestId);
        if (existing) {
          if (existing.payloadFingerprint !== fingerprint) {
            throw new AdmissionConflictError();
          }
          const found = await this.store.getMission(existing.missionId);
          if (!found) throw new Error("Admission record references a missing Mission");
          return { mission: found, replay: true };
        }
        const created = await this.engine.createMission({
          intent: {
            requestId,
            source: "operator",
            originalIntent,
            constraints,
            acceptanceCriteria,
          },
          allowedCapabilityScope: EMPTY_SCOPE,
        });
        await this.store.createMissionAdmission({
          clientId,
          requestId,
          missionId: created.missionId,
          payloadFingerprint: fingerprint,
          createdAt: this.clock.isoNow(),
        });
        return { mission: created, replay: false };
      });
      mission = result.mission;
      replay = result.replay;
    } catch (error) {
      if (error instanceof AdmissionConflictError) {
        return failure("ADMISSION_CONFLICT");
      }
      if (isUniqueConstraintError(error)) {
        const existing = await this.store.getMissionAdmission(clientId, requestId);
        if (existing) {
          if (existing.payloadFingerprint !== fingerprint) {
            return failure("ADMISSION_CONFLICT");
          }
          const found = await this.store.getMission(existing.missionId);
          if (found) {
            mission = found;
            replay = true;
          } else {
            return failure("ADMISSION_FAILED");
          }
        } else {
          return failure("ADMISSION_FAILED");
        }
      } else {
        return failure("ADMISSION_FAILED");
      }
    }

    if (!mission) return failure("ADMISSION_FAILED");

    const projection = projectMission(mission);
    // ensure only public projection
    return {
      ok: true,
      protocolVersion: LOCAL_CONTROL_ADMISSION_PROTOCOL_VERSION,
      operation: LOCAL_CONTROL_ADMISSION_OPERATION,
      data: projection,
    };
  }
}

export class AdmissionConflictError extends Error {
  constructor() {
    super("Mission admission conflicts with an existing request");
    this.name = "AdmissionConflictError";
  }
}

