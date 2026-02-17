import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { EnhancedDaemonServer } from "../cli/src/daemon/enhanced-server.js";
import { SqliteAdapter } from "../cli/src/adapters/sqlite.adapter.js";
import type { StoragePort } from "../cli/src/ports/storage.port.js";

describe("EnhancedDaemonServer", () => {
  let server: EnhancedDaemonServer;
  let storage: StoragePort;
  const TEST_PORT = 17777;

  beforeAll(async () => {
    storage = new SqliteAdapter(":memory:");
    await storage.initialize();

    server = new EnhancedDaemonServer(storage, {
      port: TEST_PORT,
      host: "127.0.0.1",
      enableWebUI: false,
    });

    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("should respond to health check", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.version).toBe("1.0.0");
  });

  it("should respond to daemon status", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/status`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("running");
    expect(data.uptime).toBeGreaterThan(0);
  });

  it("should handle JSON-RPC requests", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "daemon.status",
      }),
    });

    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe(1);
    expect(data.result).toBeDefined();
  });

  it("should reject invalid JSON-RPC", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: 1,
        method: "daemon.status",
      }),
    });

    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(-32600);
  });
});
