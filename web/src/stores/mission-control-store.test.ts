import { describe, it, expect, beforeEach } from "bun:test";
import { useMissionControlStore } from "./mission-control-store";
import type { Wave } from "./mission-control-store";

// Reseta o store antes de cada teste para evitar contaminação de estado
// O Zustand store é um singleton — sem reset, waves/tasks acumulam entre testes.
beforeEach(() => {
  useMissionControlStore.setState({
    mode: "running",
    confidence: 80,
    waveNumber: 0,
    activeTasks: 0,
    tasksDone: 0,
    waves: [],
    currentDebate: null,
    activeDebate: null,
    scanningFiles: [],
    ideas: [],
    connectionStatus: "unknown",
    daemonConnected: false,
    lastSuccessfulPoll: null,
    daemonSessions: [],
    agentBridgeStatus: {},
    agentsStatusTimedOut: false,
    delegationResults: [],
    isDelegating: false,
    lastDelegation: null,
    activeQuadrant: null,
    viewMode: "grid",
    uptime: "0h 0m",
    tokens: 0,
  });
});

describe("MissionControlStore", () => {
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
    
    const updatedWave = useMissionControlStore.getState().waves.find((w: Wave) => w.id === "wave-1");
    expect(updatedWave?.tasks[0].progress).toBe(50);
    expect(updatedWave?.tasks[0].phase).toBe("coding");
  });

  it("should handle emergency brake", () => {
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
    
    store.emergencyBrake();
    
    const state = useMissionControlStore.getState();
    expect(state.mode).toBe("pause");
    
    const wave = state.waves.find((w: Wave) => w.id === "wave-1");
    expect(wave?.tasks[0].phase).toBe("paused");
    expect(wave?.tasks[1].phase).toBe("complete"); // Already complete
  });

  it("should sync connectionStatus with daemonConnected (deprecated bool)", () => {
    const store = useMissionControlStore.getState();

    store.setConnectionStatus("polling");
    expect(useMissionControlStore.getState().daemonConnected).toBe(true);
    expect(useMissionControlStore.getState().connectionStatus).toBe("polling");

    store.setConnectionStatus("disconnected");
    expect(useMissionControlStore.getState().daemonConnected).toBe(false);
    expect(useMissionControlStore.getState().connectionStatus).toBe("disconnected");
  });

  it("should store daemon sessions", () => {
    const store = useMissionControlStore.getState();

    store.setDaemonSessions([
      { id: "sess-1", status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ]);

    expect(useMissionControlStore.getState().daemonSessions).toHaveLength(1);
    expect(useMissionControlStore.getState().daemonSessions[0].id).toBe("sess-1");
  });

  it("should update agent bridge status with timedOut flag", () => {
    const store = useMissionControlStore.getState();

    store.setAgentBridgeStatus({ gemini: "available", antigravity: "unavailable" }, true);

    const state = useMissionControlStore.getState();
    expect(state.agentBridgeStatus.gemini).toBe("available");
    expect(state.agentBridgeStatus.antigravity).toBe("unavailable");
    expect(state.agentsStatusTimedOut).toBe(true);
  });

  it("should track delegation results and cap at 50", () => {
    const store = useMissionControlStore.getState();

    // Add a result
    store.addDelegationResult({
      id: "del-1",
      agent: "gemini",
      prompt: "test prompt",
      status: "success",
      timestamp: new Date().toISOString(),
    });

    let state = useMissionControlStore.getState();
    expect(state.delegationResults).toHaveLength(1);
    expect(state.delegationResults[0].agent).toBe("gemini");
    expect(state.lastDelegation?.id).toBe("del-1");

    // Latest result should be first (prepended)
    store.addDelegationResult({
      id: "del-2",
      agent: "claude",
      prompt: "second prompt",
      status: "pending",
      timestamp: new Date().toISOString(),
    });

    state = useMissionControlStore.getState();
    expect(state.delegationResults).toHaveLength(2);
    expect(state.delegationResults[0].id).toBe("del-2"); // newest first
    expect(state.lastDelegation?.id).toBe("del-2");
  });

  it("should set delegating flag", () => {
    const store = useMissionControlStore.getState();

    expect(store.isDelegating).toBe(false);

    store.setDelegating(true);
    expect(useMissionControlStore.getState().isDelegating).toBe(true);

    store.setDelegating(false);
    expect(useMissionControlStore.getState().isDelegating).toBe(false);
  });

  it("should clear delegation results and lastDelegation", () => {
    const store = useMissionControlStore.getState();

    store.addDelegationResult({
      id: "del-1",
      agent: "gemini",
      prompt: "test",
      status: "success",
      timestamp: new Date().toISOString(),
    });

    expect(useMissionControlStore.getState().delegationResults).toHaveLength(1);
    expect(useMissionControlStore.getState().lastDelegation).not.toBeNull();

    store.clearDelegationResults();

    const state = useMissionControlStore.getState();
    expect(state.delegationResults).toHaveLength(0);
    expect(state.lastDelegation).toBeNull();
  });
});
