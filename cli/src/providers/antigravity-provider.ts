/**
 * 🚀 AntigravityProvider
 * 
 * Provider nativo para execução via Antigravity AGY.
 * Segue padrões do DirectZAIProvider para consistência.
 */

import { EventBus, globalEventBus } from '../daemon/event-bus.js';
import type {
    AntigravityPort,
    AntigravityConfig,
    AntigravityPrompt,
    AntigravityResult,
    AntigravityState,
} from '../ports/antigravity.port.js';

// ============================================================================
// Types
// ============================================================================

export interface AntigravityProviderConfig {
    apiKey?: string;
    model?: string;
    workDir: string;
    verbose?: boolean;
}

export interface AntigravityMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

// ============================================================================
// AntigravityProvider
// ============================================================================

export class AntigravityProvider {
    private config: AntigravityProviderConfig;
    private port: AntigravityPort | null = null;
    private eventBus: EventBus;
    private activeSession: AntigravityState | null = null;
    
    constructor(
        config: AntigravityProviderConfig,
        port?: AntigravityPort,
        eventBus?: EventBus
    ) {
        this.config = config;
        this.port = port ?? null;
        this.eventBus = eventBus ?? globalEventBus;
    }
    
    /**
     * Executa prompt via Antigravity
     */
    async execute(prompt: string, options: { context?: string; timeoutSec?: number } = {}): Promise<AntigravityResult> {
        if (!this.port) {
            throw new Error('AntigravityProvider not initialized. Call initialize() first.');
        }

        const startTime = Date.now();
        
        this.log('info', `Executing prompt via Antigravity: ${prompt.substring(0, 50)}...`);
        
        try {
            const agyPrompt: AntigravityPrompt = {
                prompt,
                context: options.context,
            };
            
            const result = await this.port!.execute(agyPrompt);
            
            this.log('info', `✅ Antigravity execution completed in ${(result.durationMs / 1000).toFixed(1)}s`);
            
            return {
                content: result.content,
                durationMs: result.durationMs,
                success: result.success,
                error: result.error,
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log('error', `❌ Antigravity execution failed: ${errorMsg}`);
            
            return {
                content: '',
                durationMs: Date.now() - startTime,
                success: false,
                error: errorMsg,
            };
        }
    }
    
    /**
     * Obtém estado atual
     */
    async getState(): Promise<AntigravityState | null> {
        return this.activeSession;
    }
    
    /**
     * Interrompe execução atual
     */
    async interrupt(): Promise<void> {
        if (!this.port) {
            this.log('warn', 'No port available to interrupt');
            return;
        }
        this.log('info', `⏸️ Interrupting Antigravity execution`);
        await this.port.interrupt();
    }
    
    /**
     * Inicializa provider
     */
    async initialize(): Promise<void> {
        if (!this.port) {
            throw new Error('No AntigravityPort provided. Cannot initialize.');
        }

        const agyConfig: AntigravityConfig = {
            binaryPath: this.config.model, // model pode ser caminho customizado
            workDir: this.config.workDir,
            timeoutSeconds: 300, // 5 minutos
            verbose: this.config.verbose,
        };
        
        await this.port.initialize(agyConfig);
        this.activeSession = {
            sessionId: `agy_${Date.now()}`,
            status: 'idle',
            startedAt: new Date(),
        };
        this.log('info', '✅ AntigravityProvider initialized');
    }
    
    /**
     * Finaliza provider
     */
    async shutdown(): Promise<void> {
        if (this.port && this.activeSession !== null) {
            await this.port.shutdown();
            this.activeSession.status = 'completed';
        }
        this.log('info', '🔌 AntigravityProvider shutdown');
    }
    
    // ========================================================================
    // Private Helpers
    // ========================================================================
    
    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        if (this.config.verbose) {
            this.eventBus.log(level, message, 'AntigravityProvider');
        }
    }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a fully configured AntigravityProvider
 */
export function createAntigravityProvider(
    config: AntigravityProviderConfig,
    port?: AntigravityPort
): AntigravityProvider {
    return new AntigravityProvider(config, port);
}
