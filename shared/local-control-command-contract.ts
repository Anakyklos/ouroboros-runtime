import type { DaemonMissionProjection } from "./daemon-event-contract.js";

/** Protocol version for transport-neutral local Mission commands. */
export const LOCAL_CONTROL_COMMAND_PROTOCOL_VERSION = 1 as const;
export const LOCAL_CONTROL_MAX_MISSION_ID_LENGTH = 256;
export const LOCAL_CONTROL_MAX_REASON_LENGTH = 1024;
export const LOCAL_CONTROL_MAX_PROVENANCE_LENGTH = 256;
export const LOCAL_CONTROL_COMMAND_OPERATIONS = [
  "mission.pause",
  "mission.resume",
  "mission.cancel",
] as const;
export type LocalControlCommandOperation = (typeof LOCAL_CONTROL_COMMAND_OPERATIONS)[number];

interface VersionedCommandRequest {
  protocolVersion: number;
  missionId: string;
}

export type LocalControlCommandRequest =
  | (VersionedCommandRequest & { operation: "mission.pause"; reason: string; pausedBy?: string })
  | (VersionedCommandRequest & { operation: "mission.resume" })
  | (VersionedCommandRequest & { operation: "mission.cancel"; reason: string; cancelledBy?: string });

export type LocalControlCommandFailureCode =
  | "INVALID_REQUEST"
  | "PROTOCOL_VERSION_REQUIRED"
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "INVALID_ID"
  | "INVALID_TEXT"
  | "MISSION_NOT_FOUND"
  | "INVALID_TRANSITION"
  | "AUTHORITY_UNAVAILABLE"
  | "COMMAND_FAILED";

export type LocalControlCommandResponse =
  | { ok: false; code: LocalControlCommandFailureCode; message: string }
  | {
      ok: true;
      protocolVersion: typeof LOCAL_CONTROL_COMMAND_PROTOCOL_VERSION;
      operation: LocalControlCommandOperation;
      data: DaemonMissionProjection;
    };
