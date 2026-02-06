/**
 * 🧠 AntigravityTask
 * 
 * Task especializada para execução via Antigravity Provider.
 * Segue padrão WaveTask mas adiciona suporte a Antigravity.
 */

import type { WaveTask } from './wave-types.js';
import type { AntigravityProvider } from '../providers/antigravity-provider.js';

export interface AntigravityTaskConfig {
    instruction: string;
    provider: AntigravityProvider;
    context?: string;
    timeoutSec?: number;
    workDir?: string;
}

export interface AntigravityTask extends WaveTask {
    /** Provider Antigravity configurado */
    provider: AntigravityProvider;
    /** Configuração específica da task */
    agyConfig?: AntigravityTaskConfig;
}

/**
 * Cria uma WaveTask para execução via Antigravity.
 */
export function createAntigravityTask(
    id: string,
    instruction: string,
    provider: AntigravityProvider,
    options?: Partial<AntigravityTaskConfig>
): AntigravityTask {
    return {
        id,
        instruction,
        provider,
        dependsOn: [],
        agyConfig: {
            instruction,
            provider,
            context: options?.context,
            timeoutSec: options?.timeoutSec,
            workDir: options?.workDir,
        },
        execute: async () => {
            const result = await provider.execute(
                instruction,
                { 
                    context: options?.context,
                    timeoutSec: options?.timeoutSec,
                }
            );
            
            return {
                success: result.success,
                output: result.content,
            };
        },
    };
}
