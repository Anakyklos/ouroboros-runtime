import { describe, expect, it } from "bun:test";
import { SESSION_RPC_CONTRACT_VERSION, SESSION_RPC_MAX_ITEMS } from "../../../shared/session-rpc-contract.js";
import { projectSessionGetResult, projectSessionListResult } from "./session-rpc-projection.js";

function rawSession(id: string) {
  return {
    id,
    status: "active",
    createdAt: new Date("2026-10-08T12:00:00.000Z"),
    updatedAt: new Date("2026-10-08T12:01:00.000Z"),
    contextSnapshot: "private-context",
    metadata: { arbitrary: "private-metadata" },
  };
}

describe("session RPC projection contract", () => {
  it("allowlists only operational fields and versions session.get", () => {
    const result = projectSessionGetResult({ session: rawSession("session-safe-id"), privateDiagnostic: "drop-me" });

    expect(result).toEqual({
      contractVersion: SESSION_RPC_CONTRACT_VERSION,
      session: {
        id: "session-safe-id",
        status: "active",
        createdAt: "2026-10-08T12:00:00.000Z",
        updatedAt: "2026-10-08T12:01:00.000Z",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-context");
    expect(JSON.stringify(result)).not.toContain("private-metadata");
  });

  it("bounds session.list and reports when the projection is truncated", () => {
    const source = Array.from({ length: SESSION_RPC_MAX_ITEMS + 3 }, (_, index) => rawSession(`session-${index}`));
    const result = projectSessionListResult({ sessions: source, privateDiagnostic: "drop-me" });

    expect(result.contractVersion).toBe(SESSION_RPC_CONTRACT_VERSION);
    expect(result.sessions).toHaveLength(SESSION_RPC_MAX_ITEMS);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-context");
    expect(JSON.stringify(result)).not.toContain("private-metadata");
  });

  it("rejects malformed internal shapes without copying their fields", () => {
    expect(() => projectSessionGetResult({ session: { id: "bad", status: "unknown", secret: "private" } })).toThrow();
    expect(() => projectSessionListResult({ sessions: "private" })).toThrow();
  });
});
