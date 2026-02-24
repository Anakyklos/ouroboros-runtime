/**
 * 🛡️ SandboxRunner
 *
 * Sandboxed Python execution environment with resource limits, timeout enforcement,
 * and filesystem confinement. Uses isolated venv for true isolation from the host.
 *
 * @module runtime/SandboxRunner
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { OuroborosEnvironment, createOuroborosEnvironment } from "./OuroborosEnvironment.js";
import {
    validatePath,
    createSandboxPathConfig,
    type PathValidationResult,
    type PathAccessConfig,
} from "./SandboxPathUtils.js";

// ============================================================================
// Types
// ============================================================================

export interface SandboxExecutionResult {
    stdout: string;
    stderr: string;
    success: boolean;
    error?: Error;
    durationMs: number;
    exitCode: number | null;
    resourceUsage?: {
        memoryMb?: number;
        cpuTimeMs?: number;
    };
}

export interface ResourceLimits {
    /** Maximum memory in MB (default: 512) */
    maxMemoryMb?: number;
    /** Maximum CPU time in seconds (default: 30) */
    maxCpuTimeSeconds?: number;
    /** Maximum execution timeout in ms (default: 30000) */
    timeoutMs?: number;
    /** Maximum file size in MB (default: 100) */
    maxFileSizeMb?: number;
    /** Maximum number of processes (default: 1) */
    maxProcesses?: number;
}

export interface SandboxRunnerConfig {
    /** Ouroboros environment instance or config */
    environment?: OuroborosEnvironment | OuroborosEnvironmentConfig;
    /** Resource limits */
    limits?: ResourceLimits;
    /** Auto-restart on crash (default: false for security) */
    autoRestart?: boolean;
    /** Working directory for execution (default: playground) */
    cwd?: string;
    /** Environment variables to pass to sandbox */
    env?: Record<string, string>;
}

export interface OuroborosEnvironmentConfig {
    projectRoot?: string;
    ouroborosDirName?: string;
    venvDirName?: string;
    playgroundDirName?: string;
}

export type SandboxStatus = 'idle' | 'executing' | 'dead' | 'restarting';

export interface SecurityViolation {
    type: 'escape_attempt' | 'resource_limit' | 'path_violation' | 'code_injection';
    message: string;
    detectedAt: Date;
    code?: string;
}

// ============================================================================
// Constants
// ============================================================================

// Sandbox escape detection patterns
const ESCAPE_PATTERNS = [
    /import\s+os\s*[,;]?/i,
    /import\s+sys\s*[,;]?/i,
    /import\s+subprocess/i,
    /import\s+shutil/i,
    /from\s+os\s+import/i,  // Fixed: include "import" keyword
    /__import__\s*\(/i,
    /open\s*\(\s*['"]/i,
    /exec\s*\(/i,
    /eval\s*\(/i,
    /compile\s*\(/i,
    /\.\.\//i,
    /\.\.\\/i,
    /\/etc\//i,
    /C:\\\\/,
    /~\//i,
    /getattr\s*\(/i,
    /setattr\s*\(/i,
    /\.__class__/i,  // Fixed: match __class__ accessed via dot
    /__class__\s*\./i,  // Also match __class__ followed by dot
    /__bases__\s*\./i,
    /__subclasses__\s*\(/i,
];

const SECURITY_KEYWORDS = [
    'permission denied',
    'access violation',
    'security',
    'unauthorized',
    'escape',
    'sandbox',
    'restriction',
];

const DEFAULT_CONFIG: Required<Omit<SandboxRunnerConfig, 'environment'>> & { environment: OuroborosEnvironment } = {
    environment: createOuroborosEnvironment(),
    limits: {
        maxMemoryMb: 512,
        maxCpuTimeSeconds: 30,
        timeoutMs: 30000,
        maxFileSizeMb: 100,
        maxProcesses: 1,
    } as Required<ResourceLimits>,
    autoRestart: false,
    cwd: '',
    env: {},
};

// Python script to set up resource monitoring and sandbox constraints
const SANDBOX_INIT_SCRIPT = `
import sys
import os
import resource
import signal
import json
import time
from datetime import datetime

# Disable buffering for immediate output
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

# Sandbox namespace
_ouroboros_sandbox_vars = {}

# Resource monitoring
_ouroboros_start_time = time.time()
_ouroboros_start_cpu = time.process_time()

def _ouroboros_get_resource_usage():
    """Get current resource usage"""
    try:
        import psutil
        process = psutil.Process()
        return {
            'memory_mb': process.memory_info().rss / 1024 / 1024,
            'cpu_time_ms': (time.process_time() - _ouroboros_start_cpu) * 1000
        }
    except ImportError:
        # Fallback if psutil not available
        return {
            'memory_mb': None,
            'cpu_time_ms': None
        }

def _ouroboros_enforce_limits(max_memory_mb, max_cpu_seconds, max_file_size_mb, max_processes):
    """Enforce CPU, memory, disk, and process limits"""
    try:
        # Set memory limit (if supported)
        if max_memory_mb:
            memory_limit = max_memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (memory_limit, memory_limit))
    except (ValueError, OSError):
        # Some systems don't support RLIMIT_AS
        pass

    try:
        # Set CPU time limit
        if max_cpu_seconds:
            cpu_limit = int(max_cpu_seconds)
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_limit, cpu_limit))
    except (ValueError, OSError):
        pass

    try:
        # Set file size limit (disk limit)
        if max_file_size_mb:
            file_size_limit = max_file_size_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_FSIZE, (file_size_limit, file_size_limit))
    except (ValueError, OSError):
        pass

    try:
        # Set max processes limit
        if max_processes:
            resource.setrlimit(resource.RLIMIT_NPROC, (max_processes, max_processes))
    except (ValueError, OSError):
        pass

def _ouroboros_setup_signal_handlers():
    """Setup signal handlers for cleanup"""
    def timeout_handler(signum, frame):
        raise TimeoutError("Execution time limit exceeded")

    signal.signal(signal.SIGXCPU, timeout_handler)

print("__SANDBOX_INIT_COMPLETE__")
`;

// ============================================================================
// SandboxRunner
// ============================================================================

export class SandboxRunner extends EventEmitter {
    private process: ChildProcess | null = null;
    private environment: OuroborosEnvironment;
    private config: {
        environment: OuroborosEnvironment;
        limits: Required<ResourceLimits>;
        autoRestart: boolean;
        cwd: string;
        env: Record<string, string>;
    };
    private pathConfig: PathAccessConfig;
    private status: SandboxStatus = 'dead';
    private stdoutBuffer: string = '';
    private stderrBuffer: string = '';
    private executionQueue: Array<{
        resolve: (value: SandboxExecutionResult) => void;
        reject: (reason: Error) => void;
        marker: string;
        startTime: number;
        timeoutId?: NodeJS.Timeout;
        code: string;
    }> = [];
    private initialized: boolean = false;
    private currentExecutionStartTime: number = 0;
    private securityViolations: SecurityViolation[] = [];

    constructor(config: SandboxRunnerConfig = {}) {
        super();

        // Normalize environment
        if (config.environment instanceof OuroborosEnvironment) {
            this.environment = config.environment;
        } else {
            this.environment = createOuroborosEnvironment(config.environment);
        }

        // Normalize config with defaults
        const inputLimits = config.limits ?? {};
        this.config = {
            environment: this.environment,
            autoRestart: config.autoRestart ?? DEFAULT_CONFIG.autoRestart,
            cwd: config.cwd || this.environment.playgroundPath,
            env: { ...DEFAULT_CONFIG.env, ...config.env },
            limits: {
                maxMemoryMb: (inputLimits.maxMemoryMb ?? DEFAULT_CONFIG.limits.maxMemoryMb) as number,
                maxCpuTimeSeconds: (inputLimits.maxCpuTimeSeconds ?? DEFAULT_CONFIG.limits.maxCpuTimeSeconds) as number,
                timeoutMs: (inputLimits.timeoutMs ?? DEFAULT_CONFIG.limits.timeoutMs) as number,
                maxFileSizeMb: (inputLimits.maxFileSizeMb ?? DEFAULT_CONFIG.limits.maxFileSizeMb) as number,
                maxProcesses: (inputLimits.maxProcesses ?? DEFAULT_CONFIG.limits.maxProcesses) as number,
            },
        };

        // Set up path confinement configuration
        this.pathConfig = createSandboxPathConfig({
            sandboxDir: this.environment.paths.ouroborosDir,
            playgroundDir: this.environment.playgroundPath,
        });
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /**
     * Start the sandbox process
     */
    async start(): Promise<void> {
        if (this.process && this.status !== 'dead') {
            return; // Already running
        }

        this.status = 'restarting';

        const pythonPath = this.environment.pythonPath;

        this.process = spawn(pythonPath, ['-i', '-u'], {
            cwd: this.config.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ...this.config.env,
                PYTHONUNBUFFERED: '1',
                PYTHONDONTWRITEBYTECODE: '1',
                PYTHONIOENCODING: 'utf-8',
            },
        });

        this.setupListeners();

        // Wait for initialization
        await this.waitForInit();

        // Set up resource limits
        await this.setupResourceLimits();

        this.status = 'idle';
        this.initialized = true;
        this.emit('started');
    }

    /**
     * Stop the sandbox process
     */
    async stop(): Promise<void> {
        if (!this.process) return;

        this.status = 'dead';

        // Try graceful shutdown first
        this.process.kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 200));

        // Force kill if still running
        if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL');
        }

        this.process = null;
        this.initialized = false;
        this.emit('stopped');
    }

    /**
     * Restart the sandbox process
     */
    async restart(): Promise<void> {
        await this.stop();
        await this.start();
        this.emit('restarted');
    }

    // ========================================================================
    // Security & Escape Detection
    // ========================================================================

    /**
     * Detect potential sandbox escape attempts in code
     */
    private detectEscapeAttempt(code: string): SecurityViolation | null {
        for (const pattern of ESCAPE_PATTERNS) {
            if (pattern.test(code)) {
                return {
                    type: 'escape_attempt',
                    message: `Potential escape pattern detected: ${pattern.source}`,
                    detectedAt: new Date(),
                    code,
                };
            }
        }
        return null;
    }

    /**
     * Check output for security-related messages
     */
    private detectSecurityViolation(output: string, error: string): SecurityViolation | null {
        const combined = (output + ' ' + error).toLowerCase();

        for (const keyword of SECURITY_KEYWORDS) {
            if (combined.includes(keyword)) {
                return {
                    type: 'escape_attempt',
                    message: `Security-related message detected: "${keyword}"`,
                    detectedAt: new Date(),
                };
            }
        }

        return null;
    }

    /**
     * Get all security violations recorded
     */
    getSecurityViolations(): SecurityViolation[] {
        return [...this.securityViolations];
    }

    /**
     * Clear security violation history
     */
    clearSecurityViolations(): void {
        this.securityViolations = [];
    }

    /**
     * Check if code is safe to execute
     */
    private validateCodeSafety(code: string): { safe: boolean; violation?: SecurityViolation } {
        const violation = this.detectEscapeAttempt(code);
        if (violation) {
            this.securityViolations.push(violation);
            this.emit('securityViolation', violation);
            return { safe: false, violation };
        }
        return { safe: true };
    }

    // ========================================================================
    // Execution
    // ========================================================================

    /**
     * Execute code in the sandbox with resource limits
     */
    async execute(code: string, timeoutMs?: number): Promise<SandboxExecutionResult> {
        // Security validation - check for escape attempts BEFORE execution
        const safetyCheck = this.validateCodeSafety(code);
        if (!safetyCheck.safe) {
            const violation = safetyCheck.violation!;
            return {
                stdout: '',
                stderr: `Security violation: ${violation.message}`,
                success: false,
                error: new Error(`Sandbox security violation: ${violation.message}`),
                durationMs: 0,
                exitCode: -1,
            };
        }

        if (!this.process || this.status === 'dead') {
            if (this.config.autoRestart) {
                await this.start();
            } else {
                return {
                    stdout: '',
                    stderr: 'Sandbox is not running',
                    success: false,
                    error: new Error('Sandbox not running'),
                    durationMs: 0,
                    exitCode: -1,
                };
            }
        }

        const startTime = Date.now();
        const timeout = timeoutMs ?? this.config.limits.timeoutMs;
        const marker = `__SANDBOX_EXEC_END_${Date.now()}_${Math.random().toString(36).slice(2)}__`;

        return new Promise((resolve, reject) => {
            // Timeout handler
            const timeoutId = setTimeout(() => {
                const idx = this.executionQueue.findIndex(item => item.marker === marker);
                if (idx !== -1) {
                    this.executionQueue.splice(idx, 1);
                }

                // Kill the process to enforce timeout
                this.killCurrentExecution();

                resolve({
                    stdout: this.stdoutBuffer,
                    stderr: this.stderrBuffer + '\nExecution timeout exceeded',
                    success: false,
                    error: new Error(`Timeout after ${timeout}ms`),
                    durationMs: Date.now() - startTime,
                    exitCode: -1,
                });
            }, timeout);

            this.executionQueue.push({ resolve, reject, marker, startTime, timeoutId, code });
            this.currentExecutionStartTime = startTime;

            // Wrap code with resource monitoring and error handling
            const wrappedCode = this.wrapCodeForExecution(code, marker);

            this.status = 'executing';
            this.process?.stdin?.write(wrappedCode + '\n');
        });
    }

    /**
     * Execute code from a file in the sandbox
     */
    async executeFile(filePath: string, timeoutMs?: number): Promise<SandboxExecutionResult> {
        // For relative paths, try resolving against playground first
        let pathToValidate = filePath;

        // If path is not absolute, try it as-is first, then try playground
        const { resolve } = await import('path');
        if (!filePath.startsWith('/')) {
            // Try relative to playground
            const playgroundPath = resolve(this.environment.playgroundPath, filePath);
            const playgroundResult = await validatePath(playgroundPath, this.pathConfig);

            if (playgroundResult.valid) {
                pathToValidate = playgroundPath;
            }
        }

        // Validate file path using SandboxPathUtils
        const validationResult = await validatePath(pathToValidate, this.pathConfig);

        if (!validationResult.valid) {
            return {
                stdout: '',
                stderr: `Security violation: ${validationResult.error}`,
                success: false,
                error: new Error('File access denied'),
                durationMs: 0,
                exitCode: -1,
            };
        }

        const fs = await import('fs/promises');
        try {
            const code = await fs.readFile(validationResult.resolvedPath, 'utf-8');
            return this.execute(code, timeoutMs);
        } catch (error) {
            return {
                stdout: '',
                stderr: `Failed to read file: ${(error as Error).message}`,
                success: false,
                error: error as Error,
                durationMs: 0,
                exitCode: -1,
            };
        }
    }

    // ========================================================================
    // Path Validation
    // ========================================================================

    /**
     * Validate if a path is allowed within the sandbox
     * Uses SandboxPathUtils for comprehensive security checks
     */
    async validatePath(filePath: string): Promise<PathValidationResult> {
        return validatePath(filePath, this.pathConfig);
    }

    /**
     * Check if a path is within allowed directories
     * Quick boolean check without detailed error information
     */
    async isPathAllowed(filePath: string): Promise<boolean> {
        const result = await validatePath(filePath, this.pathConfig);
        return result.valid;
    }

    // ========================================================================
    // State Management
    // ========================================================================

    /**
     * Get a variable from the sandbox namespace
     */
    async getVariable(name: string): Promise<unknown> {
        const result = await this.execute(`
import json
try:
    print(json.dumps(_ouroboros_sandbox_vars.get('${name}', None), default=str))
except Exception as e:
    print(json.dumps({'error': str(e)}))
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
     * Set a variable in the sandbox namespace
     */
    async setVariable(name: string, value: unknown): Promise<void> {
        const jsonValue = JSON.stringify(value);
        const result = await this.execute(`
import json
_ouroboros_sandbox_vars['${name}'] = json.loads('''${jsonValue}''')
`);
        if (!result.success) {
            throw new Error(`Failed to set variable ${name}: ${result.stderr}`);
        }
    }

    /**
     * Clear all sandbox variables
     */
    async clearVariables(): Promise<void> {
        await this.execute('_ouroboros_sandbox_vars.clear()');
    }

    /**
     * List all variables in the sandbox namespace
     */
    async listVariables(): Promise<string[]> {
        const result = await this.execute(`
import json
print(json.dumps(list(_ouroboros_sandbox_vars.keys())))
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

    // ========================================================================
    // Resource Monitoring
    // ========================================================================

    /**
     * Get current resource usage
     */
    async getResourceUsage(): Promise<{ memoryMb?: number; cpuTimeMs?: number } | null> {
        const result = await this.execute(`
import json
try:
    usage = _ouroboros_get_resource_usage()
    print(json.dumps(usage))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`);

        if (!result.success) {
            return null;
        }

        try {
            return JSON.parse(result.stdout.trim());
        } catch {
            return null;
        }
    }

    // ========================================================================
    // Status
    // ========================================================================

    getStatus(): SandboxStatus {
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

    private wrapCodeForExecution(code: string, marker: string): string {
        // Indent code for try/except block - simpler approach without complex escaping
        const indentedCode = code
            .split('\n')
            .map(line => '    ' + line)
            .join('\n');

        return `
try:
${indentedCode}
except Exception as __e:
    import traceback
    print(f"ERROR: {__e}", file=__import__('sys').stderr)
    traceback.print_exc(file=__import__('sys').stderr)
finally:
    print("${marker}")
`;
    }

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

        this.process.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
            this.status = 'dead';
            this.emit('exit', { code, signal });

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
            // No pending execution, just accumulate output
            return;
        }

        const markerIndex = this.stdoutBuffer.indexOf(currentExecution.marker);
        if (markerIndex === -1) {
            // Marker not yet appeared
            return;
        }

        // Extract output before marker
        const output = this.stdoutBuffer.substring(0, markerIndex).trim();

        // Clear buffer after marker
        this.stdoutBuffer = this.stdoutBuffer.substring(
            markerIndex + currentExecution.marker.length
        ).trim();

        // Remove from queue
        this.executionQueue.shift();

        // Clear timeout
        if (currentExecution.timeoutId) {
            clearTimeout(currentExecution.timeoutId);
        }

        const durationMs = Date.now() - currentExecution.startTime;
        const hasError = this.stderrBuffer.includes('ERROR:') ||
            this.stderrBuffer.includes('Traceback');

        // Check for security violations in output
        const securityViolation = this.detectSecurityViolation(output, this.stderrBuffer);
        if (securityViolation) {
            this.securityViolations.push(securityViolation);
            this.emit('securityViolation', securityViolation);
        }

        // Resolve promise
        currentExecution.resolve({
            stdout: output,
            stderr: this.stderrBuffer,
            success: !hasError && !securityViolation,
            error: securityViolation ? new Error(securityViolation.message) : undefined,
            durationMs,
            exitCode: hasError || securityViolation ? 1 : 0,
        });

        // Clear stderr for next execution
        this.stderrBuffer = '';

        // Update status
        this.status = this.executionQueue.length > 0 ? 'executing' : 'idle';
    }

    private waitForInit(): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Sandbox initialization timeout'));
            }, 10000);

            const checkInit = () => {
                if (this.stdoutBuffer.includes('__SANDBOX_INIT_COMPLETE__')) {
                    clearTimeout(timeout);
                    this.stdoutBuffer = this.stdoutBuffer
                        .replace('__SANDBOX_INIT_COMPLETE__', '')
                        .trim();
                    resolve();
                } else {
                    setTimeout(checkInit, 50);
                }
            };

            // Send initialization script
            this.process?.stdin?.write(SANDBOX_INIT_SCRIPT + '\n');
            checkInit();
        });
    }

    /**
     * Setup resource limits for CPU, memory, disk, and processes
     */
    private async setupResourceLimits(): Promise<void> {
        const { maxMemoryMb, maxCpuTimeSeconds, maxFileSizeMb, maxProcesses } = this.config.limits;

        const setupCode = `
_ouroboros_enforce_limits(${maxMemoryMb}, ${maxCpuTimeSeconds}, ${maxFileSizeMb}, ${maxProcesses})
_ouroboros_setup_signal_handlers()
`;

        await this.execute(setupCode, 5000);
    }

    private killCurrentExecution(): void {
        if (this.process) {
            this.process.kill('SIGKILL');
        }
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createSandboxRunner(
    config?: SandboxRunnerConfig
): SandboxRunner {
    return new SandboxRunner(config);
}

export default SandboxRunner;
