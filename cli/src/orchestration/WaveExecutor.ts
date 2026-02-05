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
     */
    groupIntoWaves(tasks: WaveTask[]): WaveTask[][] {
        const waves: WaveTask[][] = [];
        const completed = new Set<string>();
        let remaining = [...tasks];
        const taskMap = new Map(tasks.map(t => [t.id, t]));

        // Validar que todas as dependências existem
        for (const task of tasks) {
            for (const dep of task.dependsOn || []) {
                if (!taskMap.has(dep)) {
                    throw new Error(`Task "${task.id}" depends on unknown task "${dep}"`);
                }
            }
        }

        while (remaining.length > 0) {
            // Encontrar tasks cujas dependências já foram completadas
            const readyTasks = remaining.filter(t =>
                !t.dependsOn?.length ||
                t.dependsOn.every(dep => completed.has(dep))
            );

            if (readyTasks.length === 0) {
                const ids = remaining.map(t => t.id);
                throw new Error(`Circular dependency detected! Remaining: ${ids.join(", ")}`);
            }

            waves.push(readyTasks);

            for (const task of readyTasks) {
                completed.add(task.id);
            }
            remaining = remaining.filter(t => !completed.has(t.id));
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
