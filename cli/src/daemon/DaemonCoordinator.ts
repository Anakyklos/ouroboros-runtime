/**
 * 🔄 Daemon Coordinator
 * 
 * Coordena o ciclo de vida de todos os subsistemas daemon:
 * - BudgetTracker, BackgroundConsciousness, EvolutionScheduler, PriorityTaskQueue
 * 
 * Responsabilidades:
 * 1. **Startup ordenado**: inicializa componentes na sequência correta
 * 2. **Graceful shutdown**: salva estado, fecha DBs, cancela timers
 * 3. **Restart recovery**: restaura estado de snapshots persistidos
 * 4. **Signal handling**: SIGINT/SIGTERM/SIGHUP
 * 5. **Health monitoring**: detecta componentes degradados
 * 
 * Segue o padrão Composition Root — injeta dependências em todos os subsistemas.
 */

import { EventBus, globalEventBus } from './event-bus.js';
import { createEventLogger } from './event-logger.js';
import { BackgroundConsciousness, type ConsciousnessConfig } from './BackgroundConsciousness.js';
import { EvolutionScheduler, type EvolutionConfig } from './EvolutionScheduler.js';
import { BudgetTracker } from '../adapters/budget-tracker.js';
import { PriorityTaskQueue, type QueueSnapshot } from '../orchestration/PriorityTaskQueue.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Types
// ============================================================

export interface DaemonConfig {
    /** Diretório raiz do projeto */
    projectRoot: string;
    /** Diretório para estado persistente (default: .ouroboros) */
    stateDir: string;
    /** Budget limit em USD (0 = ilimitado) */
    budgetLimitUsd: number;
    /** Configuração de consciência */
    consciousness: Partial<ConsciousnessConfig>;
    /** Configuração de evolução */
    evolution: Partial<EvolutionConfig>;
    /** Se registra signal handlers (SIGINT/SIGTERM) */
    registerSignalHandlers: boolean;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
    projectRoot: process.cwd(),
    stateDir: '.ouroboros',
    budgetLimitUsd: 10.0,
    consciousness: {},
    evolution: { enabled: false },
    registerSignalHandlers: true,
};

export type DaemonStatus = 'uninitialized' | 'starting' | 'running' | 'shutting_down' | 'stopped' | 'error';

export interface DaemonHealth {
    status: DaemonStatus;
    uptime: number;
    components: {
        budgetTracker: boolean;
        consciousness: string;
        evolution: string;
        taskQueue: number;
        eventBus: boolean;
    };
    lastCheckAt: Date;
}

// State file names
const QUEUE_STATE_FILE = 'queue-state.json';

// ============================================================
// DaemonCoordinator
// ============================================================

export class DaemonCoordinator {
    private config: DaemonConfig;
    private eventBus: EventBus;
    private log: ReturnType<typeof createEventLogger>;
    private status: DaemonStatus = 'uninitialized';
    private startTime: number = 0;

    // Components (lazy-init)
    private _budgetTracker?: BudgetTracker;
    private _consciousness?: BackgroundConsciousness;
    private _evolution?: EvolutionScheduler;
    private _taskQueue?: PriorityTaskQueue;

    // Signal handler refs for cleanup
    private signalHandlers: Array<{ signal: string; handler: () => void }> = [];

    constructor(config?: Partial<DaemonConfig>, eventBus?: EventBus) {
        this.config = { ...DEFAULT_DAEMON_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
        this.log = createEventLogger('DaemonCoordinator', this.eventBus);
    }

    // ============================================================
    // Lifecycle: Start
    // ============================================================

    /**
     * Inicializa todos os componentes na ordem correta:
     * 1. State dir
     * 2. BudgetTracker (DB)
     * 3. TaskQueue (restore snapshot)
     * 4. BackgroundConsciousness
     * 5. EvolutionScheduler
     * 6. Signal handlers
     */
    async start(): Promise<void> {
        if (this.status === 'running') {
            this.log('warn', '🔄 Daemon already running');
            return;
        }

        this.status = 'starting';
        this.startTime = Date.now();
        this.log('info', '🔄 Daemon starting...');

        try {
            // 1. Ensure state directory
            this.ensureStateDir();

            // 2. BudgetTracker
            const dbPath = path.join(this.config.projectRoot, this.config.stateDir, 'budget.db');
            this._budgetTracker = new BudgetTracker(dbPath, this.config.budgetLimitUsd, this.eventBus);
            await this._budgetTracker.initialize();
            this.log('info', '  ✅ BudgetTracker initialized');

            // 3. TaskQueue + restore
            this._taskQueue = new PriorityTaskQueue({}, this.eventBus);
            await this.restoreQueueState();
            this.log('info', `  ✅ TaskQueue initialized (${this._taskQueue.size} pending tasks)`);

            // 4. BackgroundConsciousness
            this._consciousness = new BackgroundConsciousness(
                { ...this.config.consciousness, projectRoot: this.config.projectRoot },
                this.eventBus,
                this._budgetTracker,
            );
            this._consciousness.start();
            this.log('info', `  ✅ Consciousness ${this._consciousness.isRunning ? 'started' : 'disabled'}`);

            // 5. EvolutionScheduler
            this._evolution = new EvolutionScheduler(
                { ...this.config.evolution, projectRoot: this.config.projectRoot },
                this.eventBus,
                this._budgetTracker,
            );
            this._evolution.start();
            this.log('info', `  ✅ Evolution ${this._evolution.currentState !== 'idle' ? this._evolution.currentState : 'ready'}`);

            // 6. Signal handlers
            if (this.config.registerSignalHandlers) {
                this.registerSignalHandlers();
            }

            this.status = 'running';
            this.log('info', '🔄 Daemon started successfully');

        } catch (err) {
            this.status = 'error';
            this.log('error', `🔄 Daemon start failed: ${err}`);
            throw err;
        }
    }

    // ============================================================
    // Lifecycle: Shutdown
    // ============================================================

    /**
     * Graceful shutdown na ordem reversa:
     * 1. Set status (prevents new work)
     * 2. Stop EvolutionScheduler
     * 3. Stop BackgroundConsciousness
     * 4. Persist TaskQueue snapshot
     * 5. Close BudgetTracker DB
     * 6. Remove signal handlers
     */
    async shutdown(): Promise<void> {
        if (this.status === 'shutting_down' || this.status === 'stopped') {
            return;
        }

        this.status = 'shutting_down';
        this.log('info', '🔄 Daemon shutting down...');

        // 1. Stop evolution
        if (this._evolution) {
            this._evolution.stop();
            this.log('debug', '  ✅ Evolution stopped');
        }

        // 2. Stop consciousness
        if (this._consciousness) {
            this._consciousness.stop();
            this.log('debug', '  ✅ Consciousness stopped');
        }

        // 3. Persist queue state
        if (this._taskQueue) {
            await this.persistQueueState();
            this.log('debug', '  ✅ Queue state persisted');
        }

        // 4. Close budget DB
        if (this._budgetTracker) {
            await this._budgetTracker.close();
            this.log('debug', '  ✅ BudgetTracker closed');
        }

        // 5. Remove signal handlers
        this.removeSignalHandlers();

        this.status = 'stopped';
        this.log('info', `🔄 Daemon stopped (uptime: ${((Date.now() - this.startTime) / 1000).toFixed(1)}s)`);
    }

    // ============================================================
    // Health Check
    // ============================================================

    getHealth(): DaemonHealth {
        return {
            status: this.status,
            uptime: this.status === 'running' ? Date.now() - this.startTime : 0,
            components: {
                budgetTracker: !!this._budgetTracker,
                consciousness: this._consciousness?.currentState ?? 'uninitialized',
                evolution: this._evolution?.currentState ?? 'uninitialized',
                taskQueue: this._taskQueue?.size ?? 0,
                eventBus: true,
            },
            lastCheckAt: new Date(),
        };
    }

    // ============================================================
    // Component Accessors
    // ============================================================

    get budgetTracker(): BudgetTracker | undefined {
        return this._budgetTracker;
    }

    get consciousness(): BackgroundConsciousness | undefined {
        return this._consciousness;
    }

    get evolution(): EvolutionScheduler | undefined {
        return this._evolution;
    }

    get taskQueue(): PriorityTaskQueue | undefined {
        return this._taskQueue;
    }

    get currentStatus(): DaemonStatus {
        return this.status;
    }

    // ============================================================
    // State Persistence
    // ============================================================

    private async persistQueueState(): Promise<void> {
        if (!this._taskQueue) return;

        try {
            const snapshot = this._taskQueue.createSnapshot();
            const filePath = path.join(this.config.projectRoot, this.config.stateDir, QUEUE_STATE_FILE);
            await fs.promises.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
        } catch (err) {
            this.log('warn', `Failed to persist queue state: ${err}`);
        }
    }

    private async restoreQueueState(): Promise<void> {
        if (!this._taskQueue) return;

        try {
            const filePath = path.join(this.config.projectRoot, this.config.stateDir, QUEUE_STATE_FILE);
            if (fs.existsSync(filePath)) {
                const data = await fs.promises.readFile(filePath, 'utf-8');
                const snapshot = JSON.parse(data) as QueueSnapshot;
                const restored = this._taskQueue.restoreFromSnapshot(snapshot);
                this.log('debug', `Restored ${restored} tasks from snapshot`);
            }
        } catch (err) {
            this.log('warn', `Failed to restore queue state: ${err}`);
        }
    }

    // ============================================================
    // Signal Handling
    // ============================================================

    private registerSignalHandlers(): void {
        const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

        for (const signal of signals) {
            const handler = () => {
                this.log('info', `🔄 Received ${signal}`);
                this.shutdown().then(() => {
                    process.exit(0);
                }).catch((err) => {
                    this.log('error', `Shutdown error: ${err}`);
                    process.exit(1);
                });
            };

            process.on(signal, handler);
            this.signalHandlers.push({ signal, handler });
        }

        this.log('debug', '  ✅ Signal handlers registered (SIGINT, SIGTERM, SIGHUP)');
    }

    private removeSignalHandlers(): void {
        for (const { signal, handler } of this.signalHandlers) {
            process.removeListener(signal, handler);
        }
        this.signalHandlers = [];
    }

    // ============================================================
    // Helpers
    // ============================================================

    private ensureStateDir(): void {
        const dirPath = path.join(this.config.projectRoot, this.config.stateDir);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    // log is now created by createEventLogger in constructor
}

// ============================================================
// Factory
// ============================================================

export function createDaemonCoordinator(
    config?: Partial<DaemonConfig>,
    eventBus?: EventBus,
): DaemonCoordinator {
    return new DaemonCoordinator(config, eventBus);
}
