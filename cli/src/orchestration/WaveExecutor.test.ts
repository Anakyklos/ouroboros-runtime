import { describe, it, expect } from "bun:test";
import { WaveExecutor } from "./WaveExecutor.js";
import { Orchestrator } from "./Orchestrator.js";
import { WaveTask } from "./wave-types.js";

describe("WaveExecutor", () => {
    // Mock Orchestrator since we only test groupIntoWaves logic
    const mockOrchestrator = {} as Orchestrator;
    const executor = new WaveExecutor(mockOrchestrator, { verbose: false });

    it("should handle empty input", () => {
        const waves = executor.groupIntoWaves([]);
        expect(waves).toEqual([]);
    });

    it("should handle single task", () => {
        const task: WaveTask = { id: "A" };
        const waves = executor.groupIntoWaves([task]);
        expect(waves.length).toBe(1);
        expect(waves[0]).toHaveLength(1);
        expect(waves[0][0].id).toBe("A");
    });

    it("should group independent tasks in a single wave", () => {
        const tasks: WaveTask[] = [
            { id: "A" },
            { id: "B" },
            { id: "C" }
        ];
        const waves = executor.groupIntoWaves(tasks);
        expect(waves.length).toBe(1);
        expect(waves[0].map(t => t.id)).toEqual(["A", "B", "C"]);
    });

    it("should handle linear dependencies", () => {
        const tasks: WaveTask[] = [
            { id: "A" },
            { id: "B", dependsOn: ["A"] },
            { id: "C", dependsOn: ["B"] }
        ];
        // Expected: [A] -> [B] -> [C]
        const waves = executor.groupIntoWaves(tasks);
        expect(waves.length).toBe(3);
        expect(waves[0].map(t => t.id)).toEqual(["A"]);
        expect(waves[1].map(t => t.id)).toEqual(["B"]);
        expect(waves[2].map(t => t.id)).toEqual(["C"]);
    });

    it("should handle diamond dependencies", () => {
        const tasks: WaveTask[] = [
            { id: "A" },
            { id: "B", dependsOn: ["A"] },
            { id: "C", dependsOn: ["A"] },
            { id: "D", dependsOn: ["B", "C"] }
        ];
        // Expected: [A] -> [B, C] -> [D]
        const waves = executor.groupIntoWaves(tasks);
        expect(waves.length).toBe(3);
        expect(waves[0].map(t => t.id)).toEqual(["A"]);
        // B and C are in wave 1. Order should be preserved if possible, but they are parallel.
        const wave1Ids = waves[1].map(t => t.id);
        expect(wave1Ids).toContain("B");
        expect(wave1Ids).toContain("C");
        expect(waves[2].map(t => t.id)).toEqual(["D"]);
    });

    it("should throw on circular dependencies", () => {
        const tasks: WaveTask[] = [
            { id: "A", dependsOn: ["B"] },
            { id: "B", dependsOn: ["A"] }
        ];
        expect(() => executor.groupIntoWaves(tasks)).toThrow();
    });

    it("should throw on self dependency", () => {
         const tasks: WaveTask[] = [
            { id: "A", dependsOn: ["A"] }
        ];
        expect(() => executor.groupIntoWaves(tasks)).toThrow();
    });

    it("should throw on unknown dependency", () => {
        const tasks: WaveTask[] = [
            { id: "A", dependsOn: ["UNKNOWN"] }
        ];
        expect(() => executor.groupIntoWaves(tasks)).toThrow();
    });

    it("should preserve relative order for independent tasks in the same wave", () => {
        const tasks: WaveTask[] = [
            { id: "A" },
            { id: "B", dependsOn: ["A"] },
            { id: "C" }, // Independent, should be wave 0 with A
            { id: "D", dependsOn: ["A"] }
        ];
        // Expected: Wave 0: [A, C], Wave 1: [B, D]
        const waves = executor.groupIntoWaves(tasks);

        expect(waves.length).toBe(2);
        expect(waves[0].map(t => t.id)).toEqual(["A", "C"]);
        expect(waves[1].map(t => t.id)).toEqual(["B", "D"]);
    });

    it("should process 10,000 serial tasks efficiently", () => {
        const tasks: WaveTask[] = [];
        for (let i = 0; i < 10000; i++) {
            tasks.push({
                id: `task_${i}`,
                dependsOn: i > 0 ? [`task_${i - 1}`] : []
            });
        }

        const start = performance.now();
        const waves = executor.groupIntoWaves(tasks);
        const end = performance.now();

        expect(waves.length).toBe(10000);
        // This assertion might fail before optimization, serving as a baseline check or failure indicator
        // We will assert < 500ms as requested.
        expect(end - start).toBeLessThan(500);
    });
});
