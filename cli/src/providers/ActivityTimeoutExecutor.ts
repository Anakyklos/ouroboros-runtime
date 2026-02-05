/**
 * 🔄 ActivityTimeoutExecutor
 * 
 * Executor que monitora atividade do processo via stdout/stderr.
 * Timeout baseado em INATIVIDADE em vez de tempo absoluto.
 * 
 * Se o processo está gerando output → continua vivo (heartbeat)
 * Se o processo não gera output por X segundos → considera travado
 */

import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";

export interface ActivityTimeoutConfig {
    /** Timeout se nenhum output recebido (default: 120s) */
    inactivityTimeoutMs: number;
    /** Timeout absoluto máximo (default: 600s / 10min) */
    absoluteTimeoutMs: number;
    /** Callback quando há atividade (para logging) */
    onActivity?: (chunk: string) => void;
    /** Callback para log de status */
    onStatus?: (message: string) => void;
    /** Padrões que indicam sucesso - processo será encerrado ao detectar */
    successPatterns?: string[];
    /** Tempo de espera após detectar sucesso antes de encerrar (default: 2s) */
    successGracePeriodMs?: number;
}

export interface ExecutionResult {
    success: boolean;
    output: string;
    error?: string;
    durationMs: number;
    timedOutReason?: "inactivity" | "absolute";
    /** Se true, processo foi encerrado por detecção de padrão de sucesso */
    earlyTermination?: boolean;
}

/**
 * Padrões que indicam que o OpenCode completou a tarefa com sucesso.
 * Quando detectados, o processo será encerrado após um breve período de graça.
 */
const DEFAULT_SUCCESS_PATTERNS = [
    "Wrote file successfully",        // OpenCode escreveu arquivo
    "File created",                    // Arquivo criado
    "Successfully created",            // Criação bem sucedida
    "arquivo criado",                  // PT-BR
    "criado com sucesso",              // PT-BR
    "Task completed",                  // Tarefa completada
    "Done!",                           // Concluído
    "✅",                              // Checkmark
];

const DEFAULT_CONFIG: ActivityTimeoutConfig = {
    inactivityTimeoutMs: 120_000,  // 2 minutos sem atividade
    absoluteTimeoutMs: 600_000,    // 10 minutos absoluto
    successPatterns: DEFAULT_SUCCESS_PATTERNS,
    successGracePeriodMs: 2_000,   // 2 segundos de graça após sucesso
};

/**
 * Executa um comando com timeout baseado em atividade.
 * 
 * @example
 * const executor = new ActivityTimeoutExecutor({ 
 *   inactivityTimeoutMs: 60_000,
 *   onActivity: (chunk) => console.log(chunk)
 * });
 * const result = await executor.run('long-running-command', { cwd: '/path' });
 */
export class ActivityTimeoutExecutor {
    private config: ActivityTimeoutConfig;

    constructor(config: Partial<ActivityTimeoutConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Executa comando com monitoramento de atividade.
     */
    async run(
        command: string,
        options: SpawnOptionsWithoutStdio = {}
    ): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            const startTime = Date.now();
            let lastActivityTime = Date.now();
            let output = "";
            let error = "";
            let resolved = false;

            this.log(`🚀 Starting command with activity timeout`);
            this.log(`   Inactivity timeout: ${this.config.inactivityTimeoutMs / 1000}s`);
            this.log(`   Absolute timeout: ${this.config.absoluteTimeoutMs / 1000}s`);

            // Spawn process
            const proc = spawn(command, [], {
                ...options,
                shell: options.shell || "powershell.exe",
            });

            // Timer para encerramento após detectar sucesso
            let successTimer: ReturnType<typeof setTimeout> | null = null;
            let detectedSuccess = false;

            // Função para verificar padrões de sucesso
            const checkSuccessPatterns = (chunk: string) => {
                if (detectedSuccess || !this.config.successPatterns) return;

                const lowerChunk = chunk.toLowerCase();
                for (const pattern of this.config.successPatterns) {
                    if (lowerChunk.includes(pattern.toLowerCase())) {
                        detectedSuccess = true;
                        this.log(`🎯 Success pattern detected: "${pattern}"`);
                        this.log(`   Waiting ${(this.config.successGracePeriodMs || 2000) / 1000}s grace period before terminating...`);

                        // Agendar encerramento após grace period
                        successTimer = setTimeout(() => {
                            this.log(`✅ Grace period complete - terminating process with success`);
                            proc.kill("SIGTERM");
                            cleanup({
                                success: true,
                                output: output.trim(),
                                error: error.trim() || undefined,
                                durationMs: Date.now() - startTime,
                                earlyTermination: true,
                            });
                        }, this.config.successGracePeriodMs || 2000);

                        break;
                    }
                }
            };

            // Heartbeat: registra atividade quando há output
            const recordActivity = (chunk: string, isError = false) => {
                lastActivityTime = Date.now();

                if (isError) {
                    error += chunk;
                } else {
                    output += chunk;
                    // Verificar padrões de sucesso apenas no stdout
                    checkSuccessPatterns(chunk);
                }

                if (this.config.onActivity) {
                    this.config.onActivity(chunk);
                }
            };

            proc.stdout.on("data", (data) => {
                recordActivity(data.toString(), false);
            });

            proc.stderr.on("data", (data) => {
                recordActivity(data.toString(), true);
            });

            // Cleanup function
            const cleanup = (result: ExecutionResult) => {
                if (resolved) return;
                resolved = true;
                clearInterval(activityChecker);
                clearTimeout(absoluteTimer);
                if (successTimer) clearTimeout(successTimer);
                resolve(result);
            };

            // Verificador de inatividade (a cada 10s)
            const activityChecker = setInterval(() => {
                const inactiveFor = Date.now() - lastActivityTime;
                const elapsed = Date.now() - startTime;

                this.log(`⏱️ Elapsed: ${Math.round(elapsed / 1000)}s, Inactive: ${Math.round(inactiveFor / 1000)}s`);

                if (inactiveFor > this.config.inactivityTimeoutMs) {
                    this.log(`⚠️ Inactivity timeout! No output for ${Math.round(inactiveFor / 1000)}s`);
                    proc.kill("SIGTERM");
                    cleanup({
                        success: false,
                        output: output.trim(),
                        error: `Inactivity timeout: no output for ${Math.round(inactiveFor / 1000)}s`,
                        durationMs: Date.now() - startTime,
                        timedOutReason: "inactivity",
                    });
                }
            }, 10_000); // Verifica a cada 10 segundos

            // Timeout absoluto (safety net)
            const absoluteTimer = setTimeout(() => {
                if (!resolved) {
                    this.log(`⚠️ Absolute timeout! Exceeded ${this.config.absoluteTimeoutMs / 1000}s`);
                    proc.kill("SIGTERM");
                    cleanup({
                        success: false,
                        output: output.trim(),
                        error: `Absolute timeout: exceeded ${this.config.absoluteTimeoutMs / 1000}s maximum`,
                        durationMs: Date.now() - startTime,
                        timedOutReason: "absolute",
                    });
                }
            }, this.config.absoluteTimeoutMs);

            // Processo terminou normalmente
            proc.on("close", (code) => {
                this.log(`✅ Process closed with code ${code}`);
                cleanup({
                    success: code === 0,
                    output: output.trim(),
                    error: error.trim() || undefined,
                    durationMs: Date.now() - startTime,
                });
            });

            // Erro ao spawnar
            proc.on("error", (err) => {
                this.log(`❌ Spawn error: ${err.message}`);
                cleanup({
                    success: false,
                    output: "",
                    error: err.message,
                    durationMs: Date.now() - startTime,
                });
            });
        });
    }

    private log(message: string) {
        if (this.config.onStatus) {
            this.config.onStatus(message);
        }
    }
}

/**
 * Factory function para criar executor com config padrão.
 */
export function createActivityExecutor(
    config?: Partial<ActivityTimeoutConfig>
): ActivityTimeoutExecutor {
    return new ActivityTimeoutExecutor(config);
}
