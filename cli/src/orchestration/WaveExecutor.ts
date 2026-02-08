/**
 * 🌊 WaveExecutor
 * 
 * Executa tarefas em waves paralelas respeitando dependências.
 * 
 * Algoritmo:
 * 1. Agrupa tasks por wave (sem dependência = wave 1)
 * 2. Para cada wave, executa tasks em paralelo (limitado por maxConcurrent)
 * 3. Aguarda wave completar antes de iniciar próxima
 * 
 * @example
 * const executor = new WaveExecutor(orchestrator, config);
 * const result = await executor.execute(tasks);
 */

import { Orchestrator } from "./Orchestrator.js";
import { TaskStatus, PersonaType, type TaskResult, type OrchestratorTask } from "./types.js";
import type {
    WaveTask,
    WaveConfig,
    WaveTaskResult,
    WaveExecutionResult,
} from "./wave-types.js";
import { DEFAULT_WAVE_CONFIG } from "./wave-types.js";
import { globalEventBus } from "../daemon/event-bus.js";

export type { WaveConfig } from "./wave-types.js";
export { DEFAULT_WAVE_CONFIG };

export class WaveExecutor {
    private orchestrator: Orchestrator;
    private config: WaveConfig;

    constructor(orchestrator: Orchestrator, config: Partial<WaveConfig> = {}) {
        this.orchestrator = orchestrator;
        this.config = { ...DEFAULT_WAVE_CONFIG, ...config };
    }

    /**
     * Executa todas as tasks em waves paralelas.
     */
    async execute(tasks: WaveTask[]): Promise<WaveExecutionResult> {
        const startTime = Date.now();
        const waves = this.groupIntoWaves(tasks);
        const results: WaveTaskResult[][] = [];
        const successfulTasks: string[] = [];
        const failedTasks: string[] = [];
        const skippedTasks: string[] = [];

        this.log(`🌊 Starting Wave Execution`);
        this.log(`   Total tasks: ${tasks.length}`);
        this.log(`   Waves: ${waves.length}`);
        this.log(`   Max concurrent: ${this.config.maxConcurrent}`);

        for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
            const wave = waves[waveIndex];
            this.log(`\n━━━ Wave ${waveIndex + 1}/${waves.length} ━━━`);
            this.log(`   Tasks: ${wave.map(t => t.id).join(", ")}`);

            // Emit wave started
            globalEventBus.emit('wave', {
                type: 'wave_started',
                waveId: `wave-${waveIndex}`,
                waveIndex: waveIndex + 1,
                totalWaves: waves.length,
                tasks: wave.map(t => ({ id: t.id, name: t.id, status: 'pending' }))
            });

            // Verificar se alguma dependência falhou
            const executableTasks = wave.filter(task => {
                if (!task.dependsOn?.length) return true;

                const hasFailedDep = task.dependsOn.some(dep =>
                    failedTasks.includes(dep) || skippedTasks.includes(dep)
                );

                if (hasFailedDep) {
                    this.log(`   ⏭️ Skipping ${task.id} (failed dependency)`);
                    skippedTasks.push(task.id);
                    return false;
                }
                return true;
            });

            // Executar wave em paralelo (com limite de concorrência)
            const waveResults = await this.executeWave(executableTasks, waveIndex);
            results.push(waveResults);

            // Emit wave completed
            globalEventBus.emit('wave', {
                type: 'wave_completed',
                waveId: `wave-${waveIndex}`,
                waveIndex: waveIndex + 1,
                totalWaves: waves.length,
                tasks: waveResults.map(r => ({
                    id: r.taskId,
                    name: r.taskId,
                    status: r.result.status === "SUCCESS" ? 'completed' : 'failed'
                }))
            });

            // Atualizar listas de sucesso/falha
            for (const wr of waveResults) {
                if (wr.result.status === "SUCCESS") {
                    successfulTasks.push(wr.taskId);
                } else {
                    failedTasks.push(wr.taskId);

                    if (this.config.stopOnFirstFailure) {
                        this.log(`\n🛑 Stopping on first failure: ${wr.taskId}`);
                        // Marcar tasks restantes como skipped
                        const remaining = tasks.filter(t =>
                            !successfulTasks.includes(t.id) &&
                            !failedTasks.includes(t.id) &&
                            !skippedTasks.includes(t.id)
                        );
                        remaining.forEach(t => skippedTasks.push(t.id));
                        break;
                    }
                }
            }

            if (this.config.stopOnFirstFailure && failedTasks.length > 0) {
                break;
            }
        }

        const totalDurationMs = Date.now() - startTime;

        this.log(`\n🌊 Wave Execution Complete`);
        this.log(`   ✅ Success: ${successfulTasks.length}`);
        this.log(`   ❌ Failed: ${failedTasks.length}`);
        this.log(`   ⏭️ Skipped: ${skippedTasks.length}`);
        this.log(`   ⏱️ Duration: ${(totalDurationMs / 1000).toFixed(1)}s`);

        // Build results map
        const resultsMap = new Map<string, WaveTaskResult>();
        for (const wave of results) {
            for (const r of wave) {
                resultsMap.set(r.taskId, r);
            }
        }

        return {
            success: failedTasks.length === 0,
            waves: results,
            results: resultsMap,
            totalDuration: totalDurationMs,
            completedTasks: successfulTasks,
            successfulTasks,
            failedTasks,
            skippedTasks,
        };
    }

    /**
     * Agrupa tasks em waves baseado em dependências.
     * Tasks sem dependência ficam na wave 1.
     * Tasks com dependência ficam na wave após suas deps.
     *
     * Implementação otimizada usando Kahn's Algorithm (Topological Sort) - O(V+E)
     */
    groupIntoWaves(tasks: WaveTask[]): WaveTask[][] {
        const waves: WaveTask[][] = [];

        // Maps for O(1) lookups
        const taskMap = new Map<string, WaveTask>();
        const taskIndex = new Map<string, number>();
        const inDegree = new Map<string, number>();
        const adjList = new Map<string, string[]>();

        // 1. Build Graph & Initialize Degrees
        for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            taskMap.set(task.id, task);
            taskIndex.set(task.id, i);

            // Ensure every task has an entry in inDegree
            if (!inDegree.has(task.id)) {
                inDegree.set(task.id, 0);
            }

            // Process dependencies
            if (task.dependsOn) {
                for (const depId of task.dependsOn) {
                    if (depId === task.id) {
                         throw new Error(`Task "${task.id}" depends on itself`);
                    }
                    // If dependency doesn't exist in tasks list (yet or ever)
                    // Note: We'll validate strictly in a second pass or rely on lookups failing

                    if (!adjList.has(depId)) {
                        adjList.set(depId, []);
                    }
                    adjList.get(depId)!.push(task.id);
                    inDegree.set(task.id, (inDegree.get(task.id) || 0) + 1);
                }
            }
        }

        // Validate dependencies exist
        for (const task of tasks) {
            if (task.dependsOn) {
                for (const depId of task.dependsOn) {
                    if (!taskMap.has(depId)) {
                        throw new Error(`Task "${task.id}" depends on unknown task "${depId}"`);
                    }
                }
            }
        }

        // 2. Initialize Queue with 0 in-degree tasks
        // Initial sort by original index is implicit if we iterate tasks array
        let queue: WaveTask[] = [];
        for (const task of tasks) {
            if (inDegree.get(task.id) === 0) {
                queue.push(task);
            }
        }

        let processedCount = 0;

        // 3. Process Queue
        while (queue.length > 0) {
            waves.push([...queue]); // Store current wave
            processedCount += queue.length;

            const nextQueue: WaveTask[] = [];

            for (const task of queue) {
                const dependents = adjList.get(task.id);
                if (dependents) {
                    for (const dependentId of dependents) {
                        const currentInDegree = inDegree.get(dependentId)! - 1;
                        inDegree.set(dependentId, currentInDegree);

                        if (currentInDegree === 0) {
                            nextQueue.push(taskMap.get(dependentId)!);
                        }
                    }
                }
            }

            // Sort next wave by original index to ensure stable output order
            nextQueue.sort((a, b) => {
                return (taskIndex.get(a.id)!) - (taskIndex.get(b.id)!);
            });

            queue = nextQueue;
        }

        // 4. Check for cycles
        if (processedCount !== tasks.length) {
            // Find unprocessed tasks for error message
             const unprocessed = tasks
                .filter(t => (inDegree.get(t.id) || 0) > 0)
                .map(t => t.id);
             throw new Error(`Circular dependency detected! Remaining: ${unprocessed.join(", ")}`);
        }

        return waves;
    }

    /**
     * Executa uma wave em paralelo com limite de concorrência.
     */
    private async executeWave(
        tasks: WaveTask[],
        waveIndex: number
    ): Promise<WaveTaskResult[]> {
        const results: WaveTaskResult[] = [];
        const chunks = this.chunkArray(tasks, this.config.maxConcurrent);

        for (const chunk of chunks) {
            const chunkResults = await Promise.all(
                chunk.map(async (task): Promise<WaveTaskResult> => {
                    this.log(`   ▶️ Starting: ${task.id}`);
                    
                    // Emit task started
                    globalEventBus.emit('wave', {
                        type: 'task_update',
                        waveId: `wave-${waveIndex}`,
                        waveIndex: waveIndex + 1,
                        totalWaves: 0, // Ignored in task_update usually, or carry over
                        tasks: [{ id: task.id, name: task.id, status: 'running' }]
                    });

                    let taskResult: TaskResult;

                    const startMs = Date.now();
                    try {
                        // Se task tem execute() customizado, usar ele
                        if (task.execute) {
                            const customResult = await task.execute();
                            taskResult = {
                                status: customResult.success ? TaskStatus.SUCCESS : TaskStatus.FAILURE,
                                output: customResult.output ?? "",
                                retryCount: 0,
                                persona: PersonaType.DEVELOPER,
                                durationMs: Date.now() - startMs,
                                contextHistory: [],
                            };
                        } else if (task.instruction) {
                            // Fallback para orchestrator (se tiver instruction)
                            taskResult = await this.orchestrator.loopUntilSuccess(task as OrchestratorTask);
                        } else {
                            throw new Error('WaveTask must have either execute() or instruction');
                        }
                    } catch (error) {
                        taskResult = {
                            status: TaskStatus.FAILURE,
                            output: error instanceof Error ? error.message : String(error),
                            retryCount: 0,
                            persona: PersonaType.DEVELOPER,
                            durationMs: Date.now() - startMs,
                            contextHistory: [],
                            error: error instanceof Error ? error.message : String(error),
                        };
                    }

                    const emoji = taskResult.status === "SUCCESS" ? "✅" : "❌";
                    this.log(`   ${emoji} Finished: ${task.id}`);

                    // Emit task completed
                    globalEventBus.emit('wave', {
                        type: 'task_update',
                        waveId: `wave-${waveIndex}`,
                        waveIndex: waveIndex + 1,
                        totalWaves: 0,
                        tasks: [{ id: task.id, name: task.id, status: taskResult.status === "SUCCESS" ? 'completed' : 'failed' }]
                    });

                    return {
                        taskId: task.id,
                        result: taskResult,
                        waveIndex,
                    };
                })
            );
            results.push(...chunkResults);
        }

        return results;
    }

    /**
     * Divide array em chunks de tamanho máximo.
     */
    private chunkArray<T>(array: T[], chunkSize: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }

    private log(message: string): void {
        if (this.config.verbose) {
            console.log(`[WaveExecutor] ${message}`);
        }
    }
}

/**
 * Factory function para criar WaveExecutor.
 */
export function createWaveExecutor(
    orchestrator: Orchestrator,
    config?: Partial<WaveConfig>
): WaveExecutor {
    return new WaveExecutor(orchestrator, config);
}
