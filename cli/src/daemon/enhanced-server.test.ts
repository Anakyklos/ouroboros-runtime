import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { DaemonServer } from './server.js';
import { EventBus } from './event-bus.js';
import type { StoragePort } from "../ports/storage.port.js";

// Mock StoragePort to bypass better-sqlite3 in Bun tests
class MockStorage implements StoragePort {
  async initialize() { }
  async close() { }
  async store(key: string, value: any) { }
  async get(key: string) { return null; }
  async delete(key: string) { }
  async list() { return []; }
  async clear() { }
}

describe("DaemonServer", () => {
  let server: DaemonServer;
  let storage: StoragePort;
  const TEST_PORT = 17777;

  beforeAll(async () => {
    storage = new MockStorage();
    // await storage.initialize();

    server = new DaemonServer(storage, {
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
  });

  it("should handle JSON-RPC requests", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "system.health",
      }),
    });

    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe("1");
    expect(data.result).toBeDefined();
  });

  it("should reject invalid JSON-RPC", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/rpc`, {
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
