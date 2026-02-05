/**
 * 🚪 Gateway
 * 
 * Central coordination hub inspired by OpenClaw's Gateway pattern.
 * 
 * Responsibilities:
 * - Route messages between sessions
 * - Control concurrency (prevent runaway loops)
 * - Heartbeat for proactive activation
 * - Session lifecycle management
 */

import { EventBus, globalEventBus } from "./event-bus.js";
import { SessionManager, type Session, type SessionConfig } from "../orchestration/SessionManager.js";

export interface GatewayConfig {
    /** Maximum concurrent sessions */
    maxConcurrentSessions: number;
    /** Heartbeat interval in ms (0 = disabled) */
    heartbeatIntervalMs: number;
    /** Session timeout in ms */
    sessionTimeoutMs: number;
    /** Enable verbose logging */
    verbose: boolean;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
    maxConcurrentSessions: 3,
    heartbeatIntervalMs: 30_000, // 30 seconds
    sessionTimeoutMs: 600_000,   // 10 minutes
    verbose: true,
};

export interface RouteMessage {
    sessionId: string;
    type: "task" | "response" | "control";
    payload: unknown;
    timestamp: Date;
}

/**
 * Gateway - Central coordination for multi-session agent execution.
 * 
 * OpenClaw-inspired patterns:
 * - Heartbeat loop for proactive checks
 * - Session isolation
 * - Concurrency control
 */
export class Gateway {
    private config: GatewayConfig;
    private eventBus: EventBus;
    private sessionManager: SessionManager;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private isRunning = false;

    constructor(config: Partial<GatewayConfig> = {}, eventBus?: EventBus) {
        this.config = { ...DEFAULT_GATEWAY_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
        this.sessionManager = new SessionManager();
    }

    /**
     * Start the Gateway daemon.
     */
    start(): void {
        if (this.isRunning) {
            this.log("warn", "Gateway already running");
            return;
        }

        this.isRunning = true;
        this.log("info", "🚪 Gateway starting...");

        // Start heartbeat if enabled
        if (this.config.heartbeatIntervalMs > 0) {
            this.startHeartbeat();
        }

        this.eventBus.emit("daemon", { type: "ready" });
        this.log("info", "✅ Gateway ready");
    }

    /**
     * Stop the Gateway daemon.
     */
    stop(): void {
        if (!this.isRunning) return;

        this.log("info", "🛑 Gateway shutting down...");
        this.eventBus.emit("daemon", { type: "shutting_down" });

        // Stop heartbeat
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        // Cleanup sessions
        this.sessionManager.cleanupExpired(0); // Force cleanup all

        this.isRunning = false;
        this.eventBus.emit("daemon", { type: "stopped" });
        this.log("info", "Gateway stopped");
    }

    /**
     * Route a message to the appropriate session.
     */
    async route(message: RouteMessage): Promise<void> {
        if (!this.isRunning) {
            throw new Error("Gateway not running");
        }

        const { sessionId, type, payload } = message;
        this.log("debug", `Routing ${type} to session ${sessionId}`);

        // Get or create session
        let session = this.sessionManager.get(sessionId);
        if (!session) {
            // Check concurrency limit
            const activeSessions = this.sessionManager.listActive();
            if (activeSessions.length >= this.config.maxConcurrentSessions) {
                throw new Error(
                    `Max concurrent sessions (${this.config.maxConcurrentSessions}) reached. ` +
                    `Active: ${activeSessions.map(s => s.id).join(", ")}`
                );
            }

            session = this.sessionManager.create({ id: sessionId });
            this.log("info", `Created new session: ${sessionId}`);
        }

        // Route based on message type
        switch (type) {
            case "task":
                this.eventBus.emit("task", {
                    type: "started",
                    sessionId,
                    data: payload,
                });
                break;

            case "response":
                this.eventBus.emit("task", {
                    type: "completed",
                    sessionId,
                    data: payload,
                });
                break;

            case "control":
                // Handle control messages (pause, resume, cancel)
                this.handleControlMessage(session, payload);
                break;
        }
    }

    /**
     * Get current Gateway status.
     */
    getStatus(): { running: boolean; activeSessions: number; config: GatewayConfig } {
        return {
            running: this.isRunning,
            activeSessions: this.sessionManager.listActive().length,
            config: this.config,
        };
    }

    // --- Private Methods ---

    /**
     * Start heartbeat loop for proactive monitoring.
     * OpenClaw pattern: Agent periodically activates to check state.
     */
    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            this.onHeartbeat();
        }, this.config.heartbeatIntervalMs);

        this.log("debug", `Heartbeat started (${this.config.heartbeatIntervalMs}ms)`);
    }

    /**
     * Heartbeat tick - cleanup expired sessions, log stats.
     */
    private onHeartbeat(): void {
        // Cleanup expired sessions
        const cleaned = this.sessionManager.cleanupExpired(this.config.sessionTimeoutMs);
        if (cleaned > 0) {
            this.log("info", `💀 Cleaned ${cleaned} expired sessions`);
        }

        // Log stats
        const active = this.sessionManager.listActive();
        if (active.length > 0 && this.config.verbose) {
            this.log("debug", `💓 Heartbeat: ${active.length} active sessions`);
        }
    }

    /**
     * Handle control messages (pause, resume, cancel).
     */
    private handleControlMessage(session: Session, payload: unknown): void {
        const control = payload as { action: string };

        switch (control?.action) {
            case "pause":
                session.status = "paused";
                this.log("info", `⏸️ Session ${session.id} paused`);
                break;
            case "resume":
                session.status = "active";
                this.log("info", `▶️ Session ${session.id} resumed`);
                break;
            case "cancel":
                this.sessionManager.delete(session.id);
                this.log("info", `🗑️ Session ${session.id} cancelled`);
                break;
        }
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        if (this.config.verbose) {
            this.eventBus.log(level, message, "Gateway");
        }
    }
}

/**
 * Factory function.
 */
export function createGateway(config?: Partial<GatewayConfig>): Gateway {
    return new Gateway(config);
}
