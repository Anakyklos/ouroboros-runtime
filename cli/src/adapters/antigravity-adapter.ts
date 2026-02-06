import { spawn, ChildProcess } from 'child_process';
import { EventBus, globalEventBus } from '../daemon/event-bus.js';
import type {
    AntigravityPort,
    AntigravityConfig,
    AntigravityPrompt,
    AntigravityResult,
    AntigravityState,
} from '../ports/antigravity.port.js';

export class AntigravityAdapter {
    private config: AntigravityConfig;
    private eventBus: EventBus;
    private process: ChildProcess | null = null;
    private sessionId: string;
    private state: AntigravityState;

    constructor(config: Partial<AntigravityConfig> = {}, eventBus: EventBus) {
        this.config = {
            timeoutSeconds: 300,
            workDir: process.cwd(),
            ...config,
        };
        this.eventBus = eventBus;
        this.sessionId = \`agy_\${Date.now()}\`;
        this.state = {
            sessionId: this.sessionId,
            status: 'idle',
        };
        
        this.log('info', \`AntigravityAdapter initialized with session: \${this.sessionId}\`);
    }

    async execute(prompt: AntigravityPrompt): Promise<AntigravityResult> {
        const startTime = Date.now();
        this.state.status = 'running';
        this.state.startedAt = new Date();

        try {
            const content = await this.runAgy(prompt);
            
            this.state.status = 'completed';
            this.state.completedAt = new Date();
            
            return {
                content,
                durationMs: Date.now() - startTime,
                success: true,
            };
        } catch (error) {
            this.state.status = 'error';
            this.state.completedAt = new Date();
            
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log('error', \`Antigravity execution failed: \${errorMsg}\`);
            
            return {
                content,
                durationMs: Date.now() - startTime,
                success: false,
                error: errorMsg,
            };
        }
    }

    async getState(): Promise<AntigravityState | null> {
        return this.state;
    }

    async interrupt(): Promise<void> {
        if (this.process) {
            this.process.kill('SIGTERM');
            this.state.status = 'paused';
            this.log('info', \`Interrupted session \${this.sessionId}\`);
        }
    }

    async initialize(config: AntigravityConfig): Promise<void> {
        this.config = { ...this.config, ...config };
    }

    async shutdown(): Promise<void> {
        if (this.process) {
            this.process.kill('SIGTERM');
        }
        this.state.status = 'completed';
        this.log('info', \`Shutdown session \${this.sessionId}\`);
    }

    private async runAgy(prompt: AntigravityPrompt): Promise<string> {
        return new Promise((resolve, reject) => {
            const isWindows = process.platform === 'win32';
            const command = this.config.binaryPath ?? 'agy';
            const args = [prompt.prompt];

            const env = process.env;
            if (prompt.envVars) {
                Object.assign(env, prompt.envVars);
            }

            this.process = spawn(command, args, {
                cwd: this.config.workDir,
                shell: isWindows,
                env: { ...env, PAGER: 'cat' },
            });

            let stdout = '';
            let stderr = '';

            this.process.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            this.process.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            const timeout = setTimeout(() => {
                this.process?.kill('SIGTERM');
                reject(new Error(\`Timeout after \${this.config.timeoutSeconds}s\`));
            }, this.config.timeoutSeconds! * 1000);

            this.process.on('close', (code) => {
                clearTimeout(timeout);
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error(stderr || \`Exit code: \${code}\`));
                }
            });

            this.process.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        this.eventBus.log(level, message, 'AntigravityAdapter');
    }
}
