/**
 * 🧠 PersistentAntigravityBridge
 * 
 * Bridge para Antigravity com REPL Python persistente.
 * Mantém o processo Python vivo em background, preservando estado
 * entre execuções. O "Caderno de Laboratório" do agente.
 * 
 * Diferença crítica:
 * - Antes: spawn() → execute → process.kill() (stateless)
 * - Agora: spawn() → keep alive → execute N vezes → state persists
 * 
 * @module bridges/PersistentAntigravityBridge
 */

import { EventEmitter } from "events";
import { PersistentPythonREPL, ExecutionResult } from "../runtime/PersistentPythonREPL.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// Types
// ============================================================================

export interface PersistentAntigravityConfig {
    /** Diretório de trabalho */
    workDir: string;
    /** Caminho para Python (default: python3) */
    pythonPath?: string;
    /** Timeout padrão em segundos */
    timeoutSeconds?: number;
    /** Variáveis de ambiente adicionais */
    envVars?: Record<string, string>;
}

export interface AntigravityExecutionResult {
    success: boolean;
    content: string;
    durationMs: number;
    error?: string;
    /** Variáveis definidas durante esta execução */
    newVariables?: string[];
}

export interface AgentMemory {
    /** Variáveis persistentes no namespace Python */
    variables: Record<string, unknown>;
    /** Histórico de execuções */
    executionHistory: Array<{
        code: string;
        result: string;
        timestamp: Date;
    }>;
    /** Dados do agente */
    agentData: Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<PersistentAntigravityConfig, 'envVars'>> & { envVars: Record<string, string> } = {
    workDir: process.cwd(),
    pythonPath: 'python3',
    timeoutSeconds: 60,
    envVars: {},
};

// ============================================================================
// PersistentAntigravityBridge
// ============================================================================

export class PersistentAntigravityBridge extends EventEmitter {
    private config: Required<PersistentAntigravityConfig>;
    private repl: PersistentPythonREPL;
    private eventBus: EventBus;
    private initialized: boolean = false;
    private executionCount: number = 0;

    constructor(config: Partial<PersistentAntigravityConfig> = {}, eventBus?: EventBus) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config } as Required<PersistentAntigravityConfig>;
        this.eventBus = eventBus ?? globalEventBus;

        this.repl = new PersistentPythonREPL({
            pythonPath: this.config.pythonPath,
            cwd: this.config.workDir,
            defaultTimeoutMs: this.config.timeoutSeconds * 1000,
            autoRestart: true,
            env: this.config.envVars,
        });

        this.setupEventForwarding();
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /**
     * Inicia o REPL Python persistente
     */
    async start(): Promise<void> {
        if (this.initialized) return;

        this.log('info', 'Starting Persistent Antigravity Bridge...');
        await this.repl.start();

        // Inicializa ambiente do agente
        await this.initializeAgentEnvironment();

        this.initialized = true;
        this.log('info', '✓ Persistent Antigravity Bridge ready');
        this.emit('started');
    }

    /**
     * Para o REPL Python
     */
    async stop(): Promise<void> {
        this.log('info', 'Stopping Persistent Antigravity Bridge...');
        await this.repl.stop();
        this.initialized = false;
        this.emit('stopped');
    }

    /**
     * Verifica se está pronto
     */
    isReady(): boolean {
        return this.initialized && this.repl.isAlive();
    }

    // ========================================================================
    // Execution - Compatível com AntigravityBridge original
    // ========================================================================

    /**
     * Executa código Python (compatível com interface original)
     */
    async execute(code: string, options?: {
        timeoutSeconds?: number
    }): Promise<AntigravityExecutionResult> {
        if (!this.initialized) {
            await this.start();
        }

        const timeout = options?.timeoutSeconds
            ? options.timeoutSeconds * 1000
            : this.config.timeoutSeconds * 1000;

        const startTime = Date.now();
        const varsBefore = await this.repl.listVariables();

        try {
            const result = await this.repl.execute(code, timeout);
            const varsAfter = await this.repl.listVariables();
            const newVars = varsAfter.filter(v => !varsBefore.includes(v));

            this.executionCount++;

            return {
                success: result.success,
                content: result.stdout,
                durationMs: Date.now() - startTime,
                error: result.success ? undefined : result.stderr,
                newVariables: newVars,
            };

        } catch (error) {
            return {
                success: false,
                content: '',
                durationMs: Date.now() - startTime,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Executa tarefa com contexto (compatível com AntigravityBridge.task)
     */
    async task(instruction: string, context?: string): Promise<AntigravityExecutionResult> {
        let code = instruction;

        if (context) {
            // Injeta contexto como variável
            await this.setVariable('_task_context', context);
            code = `# Context available in _task_context\n${instruction}`;
        }

        return this.execute(code);
    }

    // ========================================================================
    // Memory & State - NOVO: Capacidades que o bridge original não tinha
    // ========================================================================

    /**
     * Obtém valor de uma variável do namespace Python
     */
    async getVariable(name: string): Promise<unknown> {
        if (!this.initialized) await this.start();
        return this.repl.getVariable(name);
    }

    /**
     * Define variável no namespace Python
     */
    async setVariable(name: string, value: unknown): Promise<void> {
        if (!this.initialized) await this.start();
        await this.repl.setVariable(name, value);
    }

    /**
     * Lista todas as variáveis no namespace
     */
    async listVariables(): Promise<string[]> {
        if (!this.initialized) await this.start();
        return this.repl.listVariables();
    }

    /**
     * Obtém memória completa do agente
     */
    async getMemory(): Promise<AgentMemory> {
        if (!this.initialized) await this.start();

        const variables = await this.repl.listVariables();
        const varsRecord: Record<string, unknown> = {};

        for (const v of variables) {
            try {
                varsRecord[v] = await this.repl.getVariable(v);
            } catch {
                varsRecord[v] = '<unserializable>';
            }
        }

        // Obtém histórico e dados do agente
        let executionHistory: AgentMemory['executionHistory'] = [];
        let agentData: Record<string, unknown> = {};

        try {
            executionHistory = await this.repl.getVariable('_agent_execution_history') as AgentMemory['executionHistory'] ?? [];
        } catch { /* ignora */ }

        try {
            agentData = await this.repl.getVariable('_agent_data') as Record<string, unknown> ?? {};
        } catch { /* ignora */ }

        return {
            variables: varsRecord,
            executionHistory,
            agentData,
        };
    }

    /**
     * Salva dado persistente do agente
     */
    async saveAgentData(key: string, value: unknown): Promise<void> {
        await this.execute(`
if '_agent_data' not in dir():
    _agent_data = {}
_agent_data['${key}'] = ${JSON.stringify(value)}
`);
    }

    /**
     * Carrega dado persistente do agente
     */
    async loadAgentData(key: string): Promise<unknown> {
        const result = await this.execute(`
import json
if '_agent_data' in dir() and '${key}' in _agent_data:
    print(json.dumps(_agent_data['${key}'], default=str))
else:
    print('null')
`);
        try {
            return JSON.parse(result.content);
        } catch {
            return null;
        }
    }

    /**
     * Limpa memória (reinicia namespace mas mantém processo vivo)
     */
    async clearMemory(): Promise<void> {
        // Reinicia variáveis mas mantém processo
        await this.execute(`
# Clear user variables
_vars_to_keep = ['sys', 'os', 'json', 'time', 'datetime', '__builtins__', '__name__', '__doc__']
for _v in list(dir()):
    if not _v.startswith('_') and _v not in _vars_to_keep:
        try:
            exec(f'del {_v}')
        except:
            pass
del _vars_to_keep, _v
`);
        this.log('info', 'Memory cleared (namespace reset)');
    }

    // ========================================================================
    // Status
    // ========================================================================

    /**
     * Retorna estatísticas do bridge
     */
    getStats(): {
        initialized: boolean;
        replStatus: string;
        executionCount: number;
        uptime: number;
    } {
        return {
            initialized: this.initialized,
            replStatus: this.repl.getStatus(),
            executionCount: this.executionCount,
            uptime: process.uptime(),
        };
    }

    /**
     * Verifica se REPL está respondendo
     */
    async healthCheck(): Promise<boolean> {
        return this.repl.ping();
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    private async initializeAgentEnvironment(): Promise<void> {
        // Bootstrap: A "Consciência" do Antigravity
        // Injeta identidade, memória persistente e ferramentas nativas
        await this.execute(`
# ============================================================================
# 🐍 OUROBOROS ANTIGRAVITY - PERSISTENT ENVIRONMENT
# ============================================================================
# Este ambiente persiste enquanto o agente estiver vivo.
# Variáveis, funções e imports ficam disponíveis entre execuções.

import sys
import os
import json
import subprocess
from datetime import datetime
from pathlib import Path

# ============================================================================
# 1. MEMÓRIA DE LONGA DURAÇÃO
# ============================================================================
# Tudo salvo aqui persiste enquanto o agente estiver rodando

_memory = {
    "history": [],           # Histórico de comandos
    "vars": {},              # Variáveis persistentes
    "working_dir": os.getcwd(),
    "session_start": datetime.now().isoformat(),
}

_agent_data = {}             # Dados estruturados do agente
_agent_execution_history = [] # Log de execuções

# ============================================================================
# 2. FERRAMENTAS NATIVAS (Tools)
# ============================================================================

def read_file(path):
    """Lê conteúdo de um arquivo"""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        return f"ERROR: {e}"

def write_file(path, content):
    """Escreve conteúdo em um arquivo"""
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        return f"SUCCESS: Wrote {len(content)} bytes to {path}"
    except Exception as e:
        return f"ERROR: {e}"

def append_file(path, content):
    """Adiciona conteúdo ao final de um arquivo"""
    try:
        with open(path, 'a', encoding='utf-8') as f:
            f.write(content)
        return f"SUCCESS: Appended {len(content)} bytes to {path}"
    except Exception as e:
        return f"ERROR: {e}"

def run_shell(command, cwd=None):
    """Executa comando shell e retorna output"""
    try:
        result = subprocess.run(
            command, 
            shell=True, 
            capture_output=True, 
            text=True,
            cwd=cwd or _memory["working_dir"],
            timeout=30
        )
        output = result.stdout
        if result.stderr:
            output += f"\\nSTDERR: {result.stderr}"
        return output.strip() if output else "(no output)"
    except subprocess.TimeoutExpired:
        return "ERROR: Command timed out after 30s"
    except Exception as e:
        return f"ERROR: {e}"

def list_dir(path="."):
    """Lista arquivos em um diretório"""
    try:
        entries = os.listdir(path)
        return json.dumps(entries, indent=2)
    except Exception as e:
        return f"ERROR: {e}"

def file_exists(path):
    """Verifica se arquivo existe"""
    return os.path.exists(path)

def get_cwd():
    """Retorna diretório atual"""
    return os.getcwd()

def set_cwd(path):
    """Muda diretório de trabalho"""
    try:
        os.chdir(path)
        _memory["working_dir"] = os.getcwd()
        return f"Changed to: {os.getcwd()}"
    except Exception as e:
        return f"ERROR: {e}"

# ============================================================================
# 3. HELPERS DE MEMÓRIA
# ============================================================================

def remember(key, value):
    """Salva valor na memória persistente"""
    _memory["vars"][key] = value
    return f"Remembered: {key}"

def recall(key, default=None):
    """Recupera valor da memória"""
    return _memory["vars"].get(key, default)

def forget(key):
    """Remove valor da memória"""
    if key in _memory["vars"]:
        del _memory["vars"][key]
        return f"Forgot: {key}"
    return f"Key not found: {key}"

def show_memory():
    """Mostra toda a memória"""
    return json.dumps(_memory, indent=2, default=str)

def log_execution(code, result):
    """Registra execução no histórico"""
    _agent_execution_history.append({
        "timestamp": datetime.now().isoformat(),
        "code": code[:200] + "..." if len(code) > 200 else code,
        "result": str(result)[:200] if result else None
    })
    # Mantém últimas 100 execuções
    if len(_agent_execution_history) > 100:
        _agent_execution_history.pop(0)

# ============================================================================
# 4. IDENTIDADE
# ============================================================================

_agent_start_time = datetime.now().isoformat()
_agent_identity = {
    "name": "Antigravity",
    "role": "Persistent Python Runtime for Ouroboros Agent",
    "capabilities": [
        "read_file(path)", 
        "write_file(path, content)",
        "append_file(path, content)",
        "run_shell(command)",
        "list_dir(path)",
        "remember(key, value)",
        "recall(key)",
        "show_memory()"
    ]
}

print("🐍 Antigravity System Online")
print(f"   Session: {_agent_start_time}")
print(f"   Working Dir: {os.getcwd()}")
print(f"   Tools: {len(_agent_identity['capabilities'])} available")
print("   Persistent Context Ready. Waiting for instructions...")
`);
    }

    private setupEventForwarding(): void {
        this.repl.on('exit', (code) => {
            this.log('warn', `Python REPL exited with code ${code}`);
            this.emit('replExit', code);
        });

        this.repl.on('restart', () => {
            this.log('info', 'Python REPL restarted');
            this.emit('replRestart');
        });

        this.repl.on('error', (err) => {
            this.log('error', `Python REPL error: ${err.message}`);
            this.emit('replError', err);
        });
    }

    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        this.eventBus.log(level, message, 'PersistentAntigravityBridge');
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createPersistentAntigravityBridge(
    config?: Partial<PersistentAntigravityConfig>
): PersistentAntigravityBridge {
    return new PersistentAntigravityBridge(config);
}

export default PersistentAntigravityBridge;
