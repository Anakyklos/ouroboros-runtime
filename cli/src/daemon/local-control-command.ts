import type { MissionEngine } from "../mission/mission-engine.js";
import { InvalidStateTransitionError, MissionNotFoundError } from "../mission/mission-engine.js";
import { sanitizeText } from "../mission/sanitize.js";
import {
  LOCAL_CONTROL_COMMAND_OPERATIONS,
  LOCAL_CONTROL_COMMAND_PROTOCOL_VERSION,
  LOCAL_CONTROL_MAX_MISSION_ID_LENGTH,
  LOCAL_CONTROL_MAX_PROVENANCE_LENGTH,
  LOCAL_CONTROL_MAX_REASON_LENGTH,
  type LocalControlCommandFailureCode,
  type LocalControlCommandOperation,
  type LocalControlCommandResponse,
} from "../../../shared/local-control-command-contract.js";
import { projectMission } from "./durable-projection.js";

/** Narrow authoritative mutation surface exposed to the command boundary. */
export type MissionCommandAuthority = Pick<MissionEngine, "pauseMission" | "resumeMission" | "cancelMission">;

const FAILURE_MESSAGES: Record<LocalControlCommandFailureCode, string> = {
  INVALID_REQUEST: "The local-control command is invalid",
  PROTOCOL_VERSION_REQUIRED: "A protocol version is required",
  PROTOCOL_VERSION_UNSUPPORTED: "The requested protocol version is not supported",
  INVALID_ID: "The Mission identity is invalid",
  INVALID_TEXT: "The command text is invalid",
  MISSION_NOT_FOUND: "The requested Mission does not exist",
  INVALID_TRANSITION: "The Mission does not allow this transition",
  AUTHORITY_UNAVAILABLE: "Mission command authority is unavailable",
  COMMAND_FAILED: "The Mission command could not be completed",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: LocalControlCommandFailureCode): LocalControlCommandResponse {
  return { ok: false, code, message: FAILURE_MESSAGES[code] };
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim().length > 0 && value.length <= maxLength;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isOperation(value: string): value is LocalControlCommandOperation {
  return LOCAL_CONTROL_COMMAND_OPERATIONS.some((operation) => operation === value);
}

/** Transport-neutral, versioned boundary for durable Mission control commands. */
export class LocalControlCommandService {
  constructor(private readonly authority: MissionCommandAuthority) {}

  /** Validate, execute once through MissionEngine authority, and return durable public state. */
  async execute(input: unknown): Promise<LocalControlCommandResponse> {
    if (!isRecord(input) || typeof input.operation !== "string" || !isOperation(input.operation)) {
      return failure("INVALID_REQUEST");
    }
    if (input.protocolVersion === undefined) return failure("PROTOCOL_VERSION_REQUIRED");
    if (input.protocolVersion !== LOCAL_CONTROL_COMMAND_PROTOCOL_VERSION) return failure("PROTOCOL_VERSION_UNSUPPORTED");
    if (typeof input.missionId !== "string" || input.missionId.trim().length === 0 || input.missionId.length > LOCAL_CONTROL_MAX_MISSION_ID_LENGTH) {
      return failure("INVALID_ID");
    }

    const operation = input.operation;
    const commonKeys = ["operation", "protocolVersion", "missionId"];
    const allowedKeys = operation === "mission.resume"
      ? commonKeys
      : [...commonKeys, "reason", operation === "mission.pause" ? "pausedBy" : "cancelledBy"];
    if (!exactKeys(input, allowedKeys)) return failure("INVALID_REQUEST");

    let reason: string | undefined;
    let provenance: string | undefined;
    if (operation !== "mission.resume") {
      if (!boundedText(input.reason, LOCAL_CONTROL_MAX_REASON_LENGTH)) return failure("INVALID_TEXT");
      reason = sanitizeText(input.reason);
      const provenanceKey = operation === "mission.pause" ? "pausedBy" : "cancelledBy";
      if (input[provenanceKey] !== undefined) {
        if (!boundedText(input[provenanceKey], LOCAL_CONTROL_MAX_PROVENANCE_LENGTH)) return failure("INVALID_TEXT");
        provenance = sanitizeText(input[provenanceKey] as string);
      }
    }

    try {
      const mission = operation === "mission.pause"
        ? await this.authority.pauseMission(input.missionId, reason!, provenance)
        : operation === "mission.resume"
          ? await this.authority.resumeMission(input.missionId)
          : await this.authority.cancelMission(input.missionId, reason!, provenance);
      return {
        ok: true,
        protocolVersion: LOCAL_CONTROL_COMMAND_PROTOCOL_VERSION,
        operation,
        data: projectMission(mission),
      };
    } catch (error) {
      if (error instanceof MissionNotFoundError) return failure("MISSION_NOT_FOUND");
      if (error instanceof InvalidStateTransitionError) return failure("INVALID_TRANSITION");
      return failure("COMMAND_FAILED");
    }
  }
}
