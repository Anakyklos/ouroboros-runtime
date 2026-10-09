/** Coordinates the headless daemon's single bounded shutdown sequence. */

export type DaemonShutdownReason = 'SIGINT' | 'SIGTERM' | 'RPC' | 'startup_failure';
export type ShutdownDiagnosticOutcome = 'failed' | 'timed_out' | 'forced_termination';

export interface ShutdownDiagnostic {
    stage: 'server' | 'mission_scheduler' | 'storage' | 'mission_store' | 'local_control_auth' | 'process';
    outcome: ShutdownDiagnosticOutcome;
}

export interface DaemonShutdownOptions {
    stopServer: () => Promise<void>;
    stopMissionScheduler?: () => Promise<void>;
    closeStorage: () => Promise<void>;
    closeMissionStore: () => Promise<void>;
    closeLocalControlAuth?: () => Promise<void>;
    onDiagnostic?: (diagnostic: ShutdownDiagnostic) => void;
    forceTerminate?: () => void;
    setExitCode?: (code: number) => void;
    stepTimeoutMs?: number;
    forceTerminationTimeoutMs?: number;
}

const DEFAULT_STEP_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_TERMINATION_TIMEOUT_MS = 16_000;

/**
 * Coalesces RPC and process-signal requests and attempts every owned close once.
 * Failures are reduced to stage/outcome diagnostics so private error text never
 * reaches process logs. A failed or timed-out close ends in explicit forced
 * termination with a nonzero exit code.
 */
export class DaemonShutdownCoordinator {
    private readonly options: DaemonShutdownOptions;
    private shutdownPromise: Promise<void> | null = null;

    constructor(options: DaemonShutdownOptions) {
        this.options = options;
    }

    /** Start shutdown once; later requests share the original completion. */
    requestShutdown(_reason: DaemonShutdownReason): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.shutdownPromise = this.runShutdown();
        return this.shutdownPromise;
    }

    private async runShutdown(): Promise<void> {
        let failed = false;
        const stepTimeoutMs = this.options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
        const forceTimeoutMs = this.options.forceTerminationTimeoutMs ?? DEFAULT_FORCE_TERMINATION_TIMEOUT_MS;
        let watchdogFired = false;
        const watchdog = setTimeout(() => {
            watchdogFired = true;
            failed = true;
            this.options.setExitCode?.(1);
            this.report({ stage: 'process', outcome: 'timed_out' });
            this.forceTerminate();
        }, forceTimeoutMs);

        const close = async (
            stage: 'server' | 'storage' | 'mission_store' | 'local_control_auth',
            action: () => Promise<void>,
        ): Promise<boolean> => {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    Promise.resolve().then(action),
                    new Promise<never>((_, reject) => {
                        timeout = setTimeout(() => reject(new ShutdownTimeoutError()), stepTimeoutMs);
                    }),
                ]);
                return true;
            } catch (error) {
                failed = true;
                this.report({
                    stage,
                    outcome: error instanceof ShutdownTimeoutError || isTimeoutFailure(error) ? 'timed_out' : 'failed',
                });
                return false;
            } finally {
                if (timeout) clearTimeout(timeout);
            }
        };

        try {
            const serverStopped = await close('server', this.options.stopServer);
            let schedulerStopped = true;
            if (this.options.stopMissionScheduler) {
                let timeout: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        Promise.resolve().then(this.options.stopMissionScheduler),
                        new Promise<never>((_, reject) => {
                            timeout = setTimeout(() => reject(new ShutdownTimeoutError()), stepTimeoutMs);
                        }),
                    ]);
                } catch (error) {
                    failed = true;
                    schedulerStopped = false;
                    this.report({
                        stage: 'mission_scheduler',
                        outcome: error instanceof ShutdownTimeoutError ? 'timed_out' : 'failed',
                    });
                } finally {
                    if (timeout) clearTimeout(timeout);
                }
            }
            if (serverStopped) {
                await close('storage', this.options.closeStorage);
            } else {
                // A failed RPC drain leaves accepted handlers able to reach
                // either database. Preserve both until forced termination.
                failed = true;
                this.report({ stage: 'storage', outcome: 'timed_out' });
                this.report({ stage: 'mission_store', outcome: 'timed_out' });
            }
            if (serverStopped && schedulerStopped) {
                await close('mission_store', this.options.closeMissionStore);
            } else if (serverStopped && !schedulerStopped) {
                // The scheduler may still be inside a MissionStore operation.
                failed = true;
                this.report({ stage: 'mission_store', outcome: 'timed_out' });
            }
            if (this.options.closeLocalControlAuth) {
                await close('local_control_auth', this.options.closeLocalControlAuth);
            }
        } finally {
            clearTimeout(watchdog);
        }

        if (failed && !watchdogFired) {
            this.options.setExitCode?.(1);
            this.report({ stage: 'process', outcome: 'forced_termination' });
            this.forceTerminate();
        }
    }

    private report(diagnostic: ShutdownDiagnostic): void {
        try {
            this.options.onDiagnostic?.(diagnostic);
        } catch {
            // Diagnostics are observational and cannot interrupt resource cleanup.
        }
    }

    private forceTerminate(): void {
        try {
            (this.options.forceTerminate ?? (() => process.exit(1)))();
        } catch {
            this.options.setExitCode?.(1);
        }
    }
}

class ShutdownTimeoutError extends Error {}

function isTimeoutFailure(error: unknown): boolean {
    return error instanceof Error && error.name === 'RpcDrainTimeoutError';
}
