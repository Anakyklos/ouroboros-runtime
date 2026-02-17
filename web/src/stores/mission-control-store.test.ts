import { describe, it, expect } from "bun:test";
import { useMissionControlStore } from "./mission-control-store";
import type { Wave } from "./mission-control-store";

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
});
