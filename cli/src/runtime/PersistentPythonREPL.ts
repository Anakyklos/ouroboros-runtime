/**
 * 🐍 PersistentPythonREPL
 * 
 * REPL Python persistente que mantém o processo vivo e o estado
 * das variáveis entre execuções. Substitui o padrão `spawn → execute → kill`
 * por um modelo `spawn → keep alive → execute N vezes`.
 * 
 * @module runtime/PersistentPythonREPL
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

// ============================================================================
// Types
// ============================================================================

export interface ExecutionResult {
    stdout: string;
    stderr: string;
    success: boolean;
    error?: Error;
    durationMs: number;
}

export interface PythonREPLConfig {
    /** Caminho para Python (default: python3) */
    pythonPath?: string;
    /** Diretório de trabalho */
    cwd?: string;
    /** Timeout padrão em ms por execução */
    defaultTimeoutMs?: number;
    /** Auto-restart em caso de crash */
    autoRestart?: boolean;
    /** Variáveis de ambiente adicionais */
    env?: Record<string, string>;
}

export type REPLStatus = 'idle' | 'executing' | 'dead' | 'restarting';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: Required<PythonREPLConfig> = {
    pythonPath: 'python3',
    cwd: process.cwd(),
    defaultTimeoutMs: 30000, // 30 seconds
    autoRestart: true,
    env: {},
};

// Helper script para inicializar namespace e helpers
const PYTHON_INIT_SCRIPT = `
import sys
import os
import json
import time
from datetime import datetime

# Desabilita buffering para output imediato
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

# Namespace para variáveis do agente
_ouroboros_vars = {}

def _ouroboros_return_json(data):
    """Helper para retornar JSON formatado"""
    print(json.dumps(data, default=str))

def _ouroboros_list_vars():
    """Lista variáveis definidas (exceto internas)"""
    return [k for k in dir() if not k.startswith('_') and k not in ('sys', 'os', 'json', 'time', 'datetime')]

print("__INIT_COMPLETE__")
`;

// ============================================================================
// PersistentPythonREPL
// ============================================================================

export class PersistentPythonREPL extends EventEmitter {
    private process: ChildProcess | null = null;
    private config: Required<PythonREPLConfig>;
    private status: REPLStatus = 'dead';
    private stdoutBuffer: string = '';
    private stderrBuffer: string = '';
    private executionQueue: Array<{
        resolve: (value: ExecutionResult) => void;
        reject: (reason: Error) => void;
        marker: string;
        startTime: number;
        timeoutId?: NodeJS.Timeout;
    }> = [];
    private initialized: boolean = false;

    constructor(config: PythonREPLConfig = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /**
     * Inicia o processo Python e inicializa o namespace
     */
    async start(): Promise<void> {
        if (this.process && this.status !== 'dead') {
            return; // Já está rodando
        }

        this.status = 'restarting';

        this.process = spawn(this.config.pythonPath, ['-i', '-u'], {
            cwd: this.config.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ...this.config.env,
                PYTHONUNBUFFERED: '1',
                PYTHONDONTWRITEBYTECODE: '1',
            },
        });

        this.setupListeners();

        // Aguarda inicialização
        await this.waitForInit();

        this.status = 'idle';
        this.initialized = true;
        this.emit('started');
    }

    /**
     * Para o processo Python
     */
    async stop(): Promise<void> {
        if (!this.process) return;

        this.status = 'dead';
        this.process.kill('SIGTERM');

        // Aguarda um pouco para kill graceful
        await new Promise(resolve => setTimeout(resolve, 100));

        if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL');
        }

        this.process = null;
        this.initialized = false;
        this.emit('stopped');
    }

    /**
     * Reinicia o processo mantendo configuração
     */
    async restart(): Promise<void> {
        await this.stop();
        await this.start();
        this.emit('restarted');
    }

    // ========================================================================
    // Execution
    // ========================================================================

    /**
     * Executa código Python e retorna resultado
     */
    async execute(code: string, timeoutMs?: number): Promise<ExecutionResult> {
        if (!this.process || this.status === 'dead') {
            if (this.config.autoRestart) {
                await this.start();
            } else {
                return {
                    stdout: '',
                    stderr: 'Python REPL is not running',
                    success: false,
                    error: new Error('REPL not running'),
                    durationMs: 0,
                };
            }
        }

        const startTime = Date.now();
        const timeout = timeoutMs ?? this.config.defaultTimeoutMs;
        const marker = `__EXEC_END_${Date.now()}_${Math.random().toString(36).slice(2)}__`;

        return new Promise((resolve, reject) => {
            // Timeout handler
            const timeoutId = setTimeout(() => {
                const idx = this.executionQueue.findIndex(item => item.marker === marker);
                if (idx !== -1) {
                    this.executionQueue.splice(idx, 1);
                }
                resolve({
                    stdout: this.stdoutBuffer,
                    stderr: this.stderrBuffer + '\nExecution timeout',
                    success: false,
                    error: new Error(`Timeout after ${timeout}ms`),
                    durationMs: Date.now() - startTime,
                });
            }, timeout);

            this.executionQueue.push({ resolve, reject, marker, startTime, timeoutId });

            // Wrap code em try/except para capturar erros
            const wrappedCode = `
try:
${code.split('\n').map(line => '    ' + line).join('\n')}
except Exception as __e:
    import traceback
    print(f"ERROR: {__e}", file=__import__('sys').stderr)
    traceback.print_exc(file=__import__('sys').stderr)
finally:
    print("${marker}")
`;

            this.status = 'executing';
            this.process?.stdin?.write(wrappedCode + '\n');
        });
    }

    /**
     * Obtém valor de uma variável do namespace Python
     */
    async getVariable(name: string): Promise<unknown> {
        const result = await this.execute(`
import json
try:
    print(json.dumps(${name}, default=str))
except TypeError:
    print(json.dumps(str(${name})))
`);
        if (!result.success) {
            throw new Error(`Failed to get variable ${name}: ${result.stderr}`);
        }
        try {
            return JSON.parse(result.stdout.trim());
        } catch {
            return result.stdout.trim();
        }
    }

    /**
     * Define variável no namespace Python
     */
    async setVariable(name: string, value: unknown): Promise<void> {
        const jsonValue = JSON.stringify(value);
        const result = await this.execute(`
import json
${name} = json.loads('''${jsonValue}''')
`);
        if (!result.success) {
            throw new Error(`Failed to set variable ${name}: ${result.stderr}`);
        }
    }

    /**
     * Lista variáveis definidas no namespace (exceto internas)
     */
    async listVariables(): Promise<string[]> {
        const result = await this.execute(`
import json
_vars = [k for k in dir() if not k.startswith('_') and k not in ('json', 'sys', 'os', 'time', 'datetime')]
print(json.dumps(_vars))
`);
        if (!result.success) {
            return [];
        }
        try {
            return JSON.parse(result.stdout.trim());
        } catch {
            return [];
        }
    }

    /**
     * Verifica se REPL está vivo e respondendo
     */
    async ping(): Promise<boolean> {
        try {
            const result = await this.execute('print("pong")', 5000);
            return result.success && result.stdout.trim() === 'pong';
        } catch {
            return false;
        }
    }

    // ========================================================================
    // Status
    // ========================================================================

    getStatus(): REPLStatus {
        return this.status;
    }

    isAlive(): boolean {
        return this.process !== null && this.status !== 'dead';
    }

    isIdle(): boolean {
        return this.status === 'idle';
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    private setupListeners(): void {
        if (!this.process) return;

        this.process.stdout?.on('data', (data: Buffer) => {
            const output = data.toString();
            this.stdoutBuffer += output;
            this.processOutput();
        });

        this.process.stderr?.on('data', (data: Buffer) => {
            this.stderrBuffer += data.toString();
        });

        this.process.on('exit', (code: number | null) => {
            this.status = 'dead';
            this.emit('exit', code);

            if (this.config.autoRestart && this.initialized) {
                setTimeout(() => this.restart(), 1000);
            }
        });

        this.process.on('error', (err: Error) => {
            this.status = 'dead';
            this.emit('error', err);
        });
    }

    private processOutput(): void {
        const currentExecution = this.executionQueue[0];
        if (!currentExecution) {
            // Sem execução pendente, apenas acumula output
            return;
        }

        const markerIndex = this.stdoutBuffer.indexOf(currentExecution.marker);
        if (markerIndex === -1) {
            // Marker ainda não apareceu
            return;
        }

        // Extrai output antes do marker
        const output = this.stdoutBuffer.substring(0, markerIndex).trim();

        // Limpa buffer após o marker
        this.stdoutBuffer = this.stdoutBuffer.substring(
            markerIndex + currentExecution.marker.length
        ).trim();

        // Remove da fila
        this.executionQueue.shift();

        // Limpa timeout
        if (currentExecution.timeoutId) {
            clearTimeout(currentExecution.timeoutId);
        }

        const durationMs = Date.now() - currentExecution.startTime;
        const hasError = this.stderrBuffer.includes('ERROR:') ||
            this.stderrBuffer.includes('Traceback');

        // Resolve a promise
        currentExecution.resolve({
            stdout: output,
            stderr: this.stderrBuffer,
            success: !hasError,
            durationMs,
        });

        // Limpa stderr para próxima execução
        this.stderrBuffer = '';

        // Atualiza status
        this.status = this.executionQueue.length > 0 ? 'executing' : 'idle';
    }

    private waitForInit(): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Python REPL initialization timeout'));
            }, 10000);

            const checkInit = () => {
                if (this.stdoutBuffer.includes('__INIT_COMPLETE__')) {
                    clearTimeout(timeout);
                    this.stdoutBuffer = this.stdoutBuffer
                        .replace('__INIT_COMPLETE__', '')
                        .trim();
                    resolve();
                } else {
                    setTimeout(checkInit, 50);
                }
            };

            // Envia script de inicialização
            this.process?.stdin?.write(PYTHON_INIT_SCRIPT + '\n');
            checkInit();
        });
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createPersistentPythonREPL(
    config?: PythonREPLConfig
): PersistentPythonREPL {
    return new PersistentPythonREPL(config);
}

export default PersistentPythonREPL;
