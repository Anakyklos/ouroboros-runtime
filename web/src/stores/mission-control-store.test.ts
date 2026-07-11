/**
 * Mission Control store tests (issue #37).
 * Unquarantined when store contracts match real daemon semantics.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  useMissionControlStore,
  DEFAULT_CAPABILITIES,
} from "./mission-control-store";
import type { Wave } from "./mission-control-store";

describe("MissionControlStore", () => {
  beforeEach(() => {
    // Reset store between tests (zustand singleton)
    useMissionControlStore.setState({
      mode: "running",
      confidence: 80,
      waveNumber: 0,
      activeTasks: 0,
      tasksDone: 0,
      uptime: "0h 0m",
      tokens: null,
      waves: [],
      currentDebate: null,
      daemonConnected: false,
      capabilities: { ...DEFAULT_CAPABILITIES },
      lastControlError: null,
      lastBrakeOutcome: null,
      activeQuadrant: null,
      viewMode: "grid",
    });
  });

  it("should update mode", () => {
    const store = useMissionControlStore.getState();

    expect(store.mode).toBe("running");

    store.setMode("pause");
    expect(useMissionControlStore.getState().mode).toBe("pause");

    store.setMode("frenzy");
    expect(useMissionControlStore.getState().mode).toBe("frenzy");
  });

  it("should update confidence", () => {
    const store = useMissionControlStore.getState();

    store.setConfidence(90);
    expect(useMissionControlStore.getState().confidence).toBe(90);
  });

  it("should update waves", () => {
    const store = useMissionControlStore.getState();

    const wave = {
      id: "wave-1",
      number: 1,
      status: "pending" as const,
      tasks: [],
    };

    store.addWave(wave);
    expect(useMissionControlStore.getState().waves.length).toBe(1);
    expect(useMissionControlStore.getState().waves[0].id).toBe("wave-1");
  });

  it("should update tasks within waves", () => {
    const store = useMissionControlStore.getState();

    const wave = {
      id: "wave-1",
      number: 1,
      status: "active" as const,
      tasks: [
        { id: "task-1", title: "Test", progress: 0, phase: "planning" as const },
      ],
    };

    store.addWave(wave);
    store.updateTask("wave-1", "task-1", { progress: 50, phase: "coding" });

    const updatedWave = useMissionControlStore
      .getState()
      .waves.find((w: Wave) => w.id === "wave-1");
    expect(updatedWave?.tasks[0].progress).toBe(50);
    expect(updatedWave?.tasks[0].phase).toBe("coding");
  });

  it("should apply emergency brake locally only after confirmation path", () => {
    const store = useMissionControlStore.getState();

    store.addWave({
      id: "wave-1",
      number: 1,
      status: "active" as const,
      tasks: [
        { id: "task-1", title: "Test", progress: 50, phase: "coding" as const },
        { id: "task-2", title: "Done", progress: 100, phase: "complete" as const },
      ],
    });

    store.applyEmergencyBrakeLocally();

    const state = useMissionControlStore.getState();
    expect(state.mode).toBe("pause");

    const wave = state.waves.find((w: Wave) => w.id === "wave-1");
    expect(wave?.tasks[0].phase).toBe("paused");
    expect(wave?.tasks[1].phase).toBe("complete");
  });

  it("defaults capabilities to disabled until daemon status arrives", () => {
    const caps = useMissionControlStore.getState().capabilities;
    expect(caps.modeSwitching).toBe(false);
    expect(caps.emergencyBrake).toBe(false);
    expect(caps.tokenMetrics).toBe(false);
  });

  it("stores backend capabilities and metrics without inventing tokens", () => {
    const store = useMissionControlStore.getState();
    store.setCapabilities({
      statusMetrics: true,
      modeSwitching: true,
      emergencyBrake: true,
      tokenMetrics: false,
    });
    store.applyDaemonMetrics({
      mode: "pause",
      activeTasks: 0,
      activeWaves: 0,
      uptimeSeconds: 125,
      tokens: null,
    });

    const state = useMissionControlStore.getState();
    expect(state.capabilities.modeSwitching).toBe(true);
    expect(state.mode).toBe("pause");
    expect(state.activeTasks).toBe(0);
    expect(state.tokens).toBeNull();
    expect(state.uptime).toBe("0h 2m");
  });
});
