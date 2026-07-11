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

    it("isolates Orchestrator per parallel task via factory (no shared runAbort)", async () => {
        const created: Orchestrator[] = [];
        const started: string[] = [];
        let release1!: () => void;
        let release2!: () => void;
        const gate1 = new Promise<void>((r) => {
            release1 = r;
        });
        const gate2 = new Promise<void>((r) => {
            release2 = r;
        });

        const isolated = new WaveExecutor(null, { verbose: false, maxConcurrent: 2 }, {
            createOrchestrator: () => {
                const o = {
                    loopUntilSuccess: async () => {
                        throw new Error("instruction path should not run");
                    },
                } as unknown as Orchestrator;
                created.push(o);
                return o;
            },
        });

        const tasks: WaveTask[] = [
            {
                id: "t1",
                execute: async () => {
                    started.push("t1");
                    await gate1;
                    return { success: true, output: "1" };
                },
            },
            {
                id: "t2",
                execute: async () => {
                    started.push("t2");
                    await gate2;
                    return { success: true, output: "2" };
                },
            },
        ];

        const execP = isolated.execute(tasks);
        for (let i = 0; i < 40 && started.length < 2; i++) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(started.sort()).toEqual(["t1", "t2"]);
        // execute() path does not need orchestrator; factory unused — prove factory works on instruction path separately
        release1();
        release2();
        const result = await execP;
        expect(result.successfulTasks.sort()).toEqual(["t1", "t2"]);

        // Instruction path: two parallel tasks → two orchestrators
        let n = 0;
        const withFactory = new WaveExecutor(null, { verbose: false, maxConcurrent: 2 }, {
            createOrchestrator: () => {
                n += 1;
                const id = n;
                return {
                    loopUntilSuccess: async () => {
                        await new Promise((r) => setTimeout(r, 30));
                        return {
                            status: "SUCCESS",
                            output: `ok-${id}`,
                            retryCount: 0,
                            persona: "developer",
                            durationMs: 30,
                            contextHistory: [],
                        };
                    },
                } as unknown as Orchestrator;
            },
        });
        const inst = await withFactory.execute([
            { id: "a", instruction: "do a" },
            { id: "b", instruction: "do b" },
        ] as WaveTask[]);
        expect(n).toBe(2);
        expect(inst.successfulTasks.sort()).toEqual(["a", "b"]);
    });

    it("brake waits for both parallel task inners — no silent CANCELLED race", async () => {
        type OrchLike = {
            cancel: (reason?: string) => void;
            loopUntilSuccess: (task: unknown) => Promise<{
                status: string;
                output: string;
                retryCount: number;
                persona: string;
                durationMs: number;
                contextHistory: unknown[];
            }>;
            hasInFlightExecute: () => boolean;
            _innerRunning: boolean;
            _release: () => void;
        };

        const orchInstances: OrchLike[] = [];
        let releaseAll!: () => void;
        const allReleased = new Promise<void>((r) => {
            releaseAll = r;
        });

        const withFactory = new WaveExecutor(null, { verbose: false, maxConcurrent: 2 }, {
            createOrchestrator: () => {
                let releaseInner!: () => void;
                const innerGate = new Promise<void>((r) => {
                    releaseInner = r;
                });
                const o: OrchLike = {
                    _innerRunning: true,
                    _release: () => releaseInner(),
                    hasInFlightExecute: () => o._innerRunning,
                    cancel: () => {
                        // Signal only — does not finish loopUntilSuccess until inner gate opens
                    },
                    loopUntilSuccess: async () => {
                        await Promise.race([innerGate, allReleased]);
                        o._innerRunning = false;
                        return {
                            status: "CANCELLED",
                            output: "",
                            retryCount: 0,
                            persona: "developer",
                            durationMs: 1,
                            contextHistory: [],
                        };
                    },
                };
                orchInstances.push(o);
                return o as unknown as Orchestrator;
            },
        });

        const execP = withFactory.execute([
            { id: "w1", instruction: "task one" },
            { id: "w2", instruction: "task two" },
        ] as WaveTask[]);

        for (let i = 0; i < 40 && orchInstances.length < 2; i++) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(orchInstances.length).toBe(2);
        expect(orchInstances.every((o) => o.hasInFlightExecute())).toBe(true);

        // Simulate brake: cancel both — neither must be claimed finished yet
        for (const o of orchInstances) o.cancel("emergency");
        const mid = await Promise.race([
            execP.then(() => "done"),
            new Promise<"pending">((r) => setTimeout(() => r("pending"), 60)),
        ]);
        expect(mid).toBe("pending");
        expect(orchInstances.every((o) => o._innerRunning)).toBe(true);

        // Both inners settle after brake signal
        for (const o of orchInstances) o._release();
        releaseAll();
        const result = await execP;
        expect(orchInstances.every((o) => !o._innerRunning)).toBe(true);
        // Both finished as cancelled (not silently dropped)
        expect(result.skippedTasks.sort()).toEqual(["w1", "w2"]);
        expect(result.successfulTasks).toEqual([]);
    });

    it("dependent wave task not started after shouldAbort (zero provider/factory calls)", async () => {
        let aborted = false;
        let factoryCalls = 0;
        let providerCalls = 0;
        let releaseA!: () => void;
        const gateA = new Promise<void>((r) => {
            releaseA = r;
        });

        const executor = new WaveExecutor(null, { verbose: false, maxConcurrent: 1 }, {
            shouldAbort: () => aborted,
            createOrchestrator: () => {
                factoryCalls += 1;
                return {
                    loopUntilSuccess: async (task: { id: string }) => {
                        providerCalls += 1;
                        if (task.id === "A") {
                            await gateA;
                            // Brake fires after A started; B must not start.
                            aborted = true;
                            return {
                                status: "SUCCESS",
                                output: "a-done",
                                retryCount: 0,
                                persona: "developer",
                                durationMs: 1,
                                contextHistory: [],
                            };
                        }
                        // B must never reach provider
                        return {
                            status: "SUCCESS",
                            output: "b-should-not-run",
                            retryCount: 0,
                            persona: "developer",
                            durationMs: 1,
                            contextHistory: [],
                        };
                    },
                } as unknown as Orchestrator;
            },
        });

        const execP = executor.execute([
            { id: "A", instruction: "first" },
            { id: "B", instruction: "depends", dependsOn: ["A"] },
        ] as WaveTask[]);

        for (let i = 0; i < 40 && factoryCalls < 1; i++) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(factoryCalls).toBe(1);
        expect(providerCalls).toBe(1);

        releaseA();
        const result = await execP;

        // A ran; B cancelled/skipped without factory or provider
        expect(result.successfulTasks).toEqual(["A"]);
        expect(result.skippedTasks).toContain("B");
        expect(factoryCalls).toBe(1);
        expect(providerCalls).toBe(1);
    });
});
