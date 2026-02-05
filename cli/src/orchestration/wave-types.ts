/**
 * 🌊 Wave Types
 * 
 * Tipos para execução paralela de tarefas em waves.
 * Tasks sem dependências executam em paralelo na mesma wave.
 */

import type { OrchestratorTask, TaskResult } from "./types.js";

/**
 * Task com suporte a dependências para wave execution.
 * Pode ter um execute() customizado OU usar instruction/persona para orchestrator.
 */
export interface WaveTask extends Partial<OrchestratorTask> {
    /** ID único da task (obrigatório) */
    id: string;
    /** Nome legível (opcional) */
    name?: string;
    /** Descrição da task (opcional) */
    description?: string;
    /** IDs de tasks que devem completar antes desta */
    dependsOn?: string[];
    /** Função de execução customizada (se não usar orchestrator) */
    execute?: () => Promise<{ success: boolean; output?: string }>;
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
    /** Se todas as tasks completaram com sucesso */
    success: boolean;
    /** Resultados agrupados por wave */
    waves: WaveTaskResult[][];
    /** Resultados indexados por task ID */
    results: Map<string, WaveTaskResult>;
    /** Duração total em ms */
    totalDuration: number;
    /** Tasks que completaram com sucesso */
    completedTasks: string[];
    /** Tasks que falharam */
    failedTasks: string[];
    /** Tasks que sucederam (alias de completedTasks) */
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
