/**
 * Daemon operational controls — shared contracts (issue #37).
 *
 * Fail-honest: never claim success without an observable backend effect.
 */

/** Valid operational modes stored in the daemon (not only in the UI). */
export const DAEMON_MODES = ["running", "pause", "frenzy"] as const;
export type DaemonMode = (typeof DAEMON_MODES)[number];

export function isDaemonMode(value: unknown): value is DaemonMode {
    return typeof value === "string" && (DAEMON_MODES as readonly string[]).includes(value);
}

/**
 * Allowed transitions. Same-mode is a no-op (not an error).
 * Unknown modes are rejected before this table is consulted.
 */
export const MODE_TRANSITIONS: Record<DaemonMode, readonly DaemonMode[]> = {
    running: ["running", "pause", "frenzy"],
    pause: ["pause", "running", "frenzy"],
    frenzy: ["frenzy", "running", "pause"],
};

export function canTransitionMode(from: DaemonMode, to: DaemonMode): boolean {
    return MODE_TRANSITIONS[from].includes(to);
}

/** Which controls the daemon actually supports. */
export interface DaemonCapabilities {
    /** Real process/session activity metrics (activeTasks, activeWaves, uptime). */
    statusMetrics: true;
    /** Mode is stored and applied in the backend. */
    modeSwitching: true;
    /** Emergency brake interrupts live sessions/orchestrators. */
    emergencyBrake: true;
    /**
     * Token accounting is not backed by a reliable daemon-wide source yet.
     * Clients must not invent zeros as "usage".
     */
    tokenMetrics: false;
}

export const DAEMON_CAPABILITIES: DaemonCapabilities = {
    statusMetrics: true,
    modeSwitching: true,
    emergencyBrake: true,
    tokenMetrics: false,
};

/** Metric with explicit availability (zero real ≠ missing). */
export type MetricValue =
    | { available: true; value: number; unit: string }
    | { available: false; reason: string };

export interface DaemonStatusResult {
    /** Process liveness of this daemon process. */
    processStatus: "alive";
    /** Operational mode stored in SessionManager. */
    mode: DaemonMode;
    /** Wall-clock seconds since process start (real). */
    uptimeSeconds: number;
    /** In-memory sessions with an attached orchestrator. */
    activeSessions: MetricValue;
    /** In-memory waves with status "active". */
    activeWaves: MetricValue;
    /** In-flight task promises tracked by SessionManager. */
    activeTasks: MetricValue;
    /**
     * Token usage is not available from a trusted aggregate source.
     * Field is always `available: false` until a real counter exists.
     */
    tokensUsed: MetricValue;
    memory: {
        rssBytes: number;
        heapUsedBytes: number;
        heapTotalBytes: number;
    };
    capabilities: DaemonCapabilities;
    timestamp: string;
}

export type SetModeOperationStatus =
    | "applied"
    | "unchanged"
    | "rejected_invalid_mode"
    | "rejected_invalid_transition";

export interface SetModeResult {
    operation: SetModeOperationStatus;
    previousMode: DaemonMode;
    requestedMode: string | null;
    resultingMode: DaemonMode;
    reason?: string;
    timestamp: string;
}

export type EmergencyBrakeOutcome =
    /** No live orchestrators/tasks/timers required interruption. */
    | "no_active_work"
    /** Every targeted session was interrupted successfully. */
    | "all_stopped"
    /** At least one session failed to interrupt. */
    | "partial"
    /** Second call while already braked with nothing left to stop. */
    | "already_stopped";

export interface EmergencyBrakeSessionResult {
    sessionId: string;
    status: "interrupted" | "failed" | "skipped";
    error?: string;
}

export interface EmergencyBrakeResult {
    outcome: EmergencyBrakeOutcome;
    /** True only when every attempted interruption succeeded (or there was nothing to do). */
    complete: boolean;
    sessions: EmergencyBrakeSessionResult[];
    interruptedCount: number;
    failedCount: number;
    checkpointTimersCleared: number;
    mode: DaemonMode;
    timestamp: string;
    message: string;
}

export function buildMetric(value: number, unit: string): MetricValue {
    return { available: true, value, unit };
}

export function unavailableMetric(reason: string): MetricValue {
    return { available: false, reason };
}
