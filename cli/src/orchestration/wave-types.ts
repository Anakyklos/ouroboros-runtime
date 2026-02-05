/**
 * 🌊 Wave Types
 * 
 * Tipos para execução paralela de tarefas em waves.
 * Tasks sem dependências executam em paralelo na mesma wave.
 */

import type { OrchestratorTask, TaskResult } from "./types.js";

/**
 * Task com suporte a dependências para wave execution.
 */
export interface WaveTask extends OrchestratorTask {
    /** IDs de tasks que devem completar antes desta */
    dependsOn?: string[];
}

/**
 * Configuração do WaveExecutor.
 */
export interface WaveConfig {
    /** Máximo de tasks simultâneas (default: 3) */
    maxConcurrent: number;
    /** Para tudo se uma task falhar? (default: false) */
    stopOnFirstFailure: boolean;
    /** Verbose logging */
    verbose: boolean;
}

/**
 * Resultado de uma task individual em uma wave.
 */
export interface WaveTaskResult {
    /** ID da task */
    taskId: string;
    /** Resultado da execução */
    result: TaskResult;
    /** Índice da wave em que foi executada */
    waveIndex: number;
}

/**
 * Resultado completo da execução de todas as waves.
 */
export interface WaveExecutionResult {
    /** Resultados agrupados por wave */
    waves: WaveTaskResult[][];
    /** Duração total em ms */
    totalDurationMs: number;
    /** Tasks que falharam */
    failedTasks: string[];
    /** Tasks que sucederam */
    successfulTasks: string[];
    /** Tasks que não foram executadas (devido a dependência falha) */
    skippedTasks: string[];
}

/**
 * Configuração padrão do WaveExecutor.
 */
export const DEFAULT_WAVE_CONFIG: WaveConfig = {
    maxConcurrent: 3,
    stopOnFirstFailure: false,
    verbose: true,
};
