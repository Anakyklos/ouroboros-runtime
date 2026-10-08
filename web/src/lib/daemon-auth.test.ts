import { afterEach, describe, expect, it } from "bun:test";
import { normalizeDaemonWebSocketUrl, waitForDaemonSnapshot } from "./daemon-auth";

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousWebSocket = globalThis.WebSocket;

afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
  globalThis.WebSocket = previousWebSocket;
});

describe("daemon browser transport", () => {
  it("normalizes the settings default used by Test Connection to the daemon WS route", () => {
    expect(normalizeDaemonWebSocketUrl("ws://localhost:7777", "http://localhost:3000/"))
      .toBe("ws://localhost:7777/ws");
    expect(normalizeDaemonWebSocketUrl("wss://control.example/ws", "https://ui.example/"))
      .toBe("wss://control.example/ws");
  });

  it("rejects URLs that could carry secrets or point away from the WS route", () => {
    expect(() => normalizeDaemonWebSocketUrl("http://localhost:7777/ws", "http://localhost:3000/")).toThrow();
    expect(() => normalizeDaemonWebSocketUrl("ws://user:secret@localhost:7777", "http://localhost:3000/")).toThrow();
    expect(() => normalizeDaemonWebSocketUrl("ws://localhost:7777/ws?token=secret", "http://localhost:3000/")).toThrow();
    expect(() => normalizeDaemonWebSocketUrl("ws://localhost:7777/other", "http://localhost:3000/")).toThrow();
  });

  it("marks the Test Connection successful only after a versioned snapshot arrives", async () => {
    const openedUrls: string[] = [];
    class SnapshotSocket {
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(url: string) {
        openedUrls.push(url);
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ event: "snapshot", data: { protocolVersion: 1 } }) }));
      }
      close(): void {}
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "http://localhost:3000/" } } });
    globalThis.WebSocket = SnapshotSocket as unknown as typeof WebSocket;

    await waitForDaemonSnapshot("ws://localhost:7777");

    expect(openedUrls).toEqual(["ws://localhost:7777/ws"]);
  });
});
