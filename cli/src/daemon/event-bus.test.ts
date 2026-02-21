import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventBus } from './event-bus.js';

describe("EventBus", () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  afterEach(() => {
    eventBus.clear();
  });

  it("should emit and receive events", () => {
    const received: unknown[] = [];

    eventBus.on("log", (data) => {
      received.push(data);
    });

    eventBus.log("info", "Test message", "Test");

    expect(received.length).toBe(1);
    expect(received[0]).toMatchObject({
      level: "info",
      message: "Test message",
      source: "Test",
    });
  });

  it("should support wildcard listeners", () => {
    const received: unknown[] = [];

    eventBus.on("*", (data) => {
      received.push(data);
    });

    eventBus.log("info", "Test", "Source");
    eventBus.emit("daemon", { type: "ready" });

    expect(received.length).toBe(2);
  });

  it("should unsubscribe correctly", () => {
    const received: unknown[] = [];

    const unsubscribe = eventBus.on("log", (data) => {
      received.push(data);
    });

    eventBus.log("info", "First", "Test");
    unsubscribe();
    eventBus.log("info", "Second", "Test");

    expect(received.length).toBe(1);
  });
});
