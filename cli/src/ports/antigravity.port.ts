/**
 * 🧠 AntigravityPort
 * 
 * Interface hexagonal para comunicação com Antigravity.
 * Permite trocar implementação sem afetar core.
 */

export interface AntigravityConfig {
    /** Caminho para binário AGY */
    binaryPath?: string;
    /** Diretório de trabalho */
    workDir: string;
    /** Timeout padrão em segundos */
    timeoutSeconds?: number;
    /** Habilita modo verboso */
    verbose?: boolean;
}

export interface AntigravityPrompt {
    /** Prompt principal */
    prompt: string;
    /** Contexto adicional */
    context?: string;
    /** Variáveis de ambiente */
    envVars?: Record<string, string>;
}

export interface AntigravityResult {
    /** Conteúdo gerado */
    content: string;
    /** Duração em ms */
    durationMs: number;
    /** Se completou com sucesso */
    success: boolean;
    /** Erro se houver */
    error?: string;
    /** Tokens consumidos (se disponível) */
    tokensUsed?: number;
}

export interface AntigravityState {
    /** ID da sessão */
    sessionId: string;
    /** Status atual */
    status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
    /** Timestamp de início */
    startedAt?: Date;
    /** Timestamp de término */
    completedAt?: Date;
    /** Metadados da sessão */
    metadata?: Record<string, unknown>;
}

export interface AntigravityPort {
    /**
     * Executa prompt via Antigravity
     */
    execute(prompt: AntigravityPrompt): Promise<AntigravityResult>;
    
    /**
     * Obtém estado atual da sessão
     */
    getState(): Promise<AntigravityState | null>;
    
    /**
     * Interrrompe execução atual
     */
    interrupt(): Promise<void>;
    
    /**
     * Inicializa porta
     */
    initialize(config: AntigravityConfig): Promise<void>;
    
    /**
     * Finaliza porta
     */
    shutdown(): Promise<void>;
}
