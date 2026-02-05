/**
 * 🔒 SessionManager
 * 
 * Manages isolated sessions for multi-agent execution.
 * OpenClaw pattern: Each conversation/task gets isolated state.
 * 
 * Benefits:
 * - No state leakage between tasks
 * - Independent model selection per session
 * - Usage tracking per session
 * - Clean lifecycle management
 */

export interface SessionConfig {
    id: string;
    /** Optional custom model for this session */
    model?: string;
    /** Working directory for this session */
    workDir?: string;
    /** Custom timeout for this session */
    timeoutMs?: number;
}

export type SessionStatus = "active" | "paused" | "completed" | "failed";

export interface Session {
    id: string;
    status: SessionStatus;
    model: string;
    workDir: string;
    createdAt: Date;
    lastActivityAt: Date;
    /** Token usage tracking */
    usage: {
        inputTokens: number;
        outputTokens: number;
        totalCost: number;
    };
    /** Arbitrary metadata */
    metadata: Record<string, unknown>;
}

const DEFAULT_MODEL = "glm-4.7";
const DEFAULT_WORK_DIR = process.cwd();

/**
 * SessionManager - Creates and manages isolated session contexts.
 */
export class SessionManager {
    private sessions: Map<string, Session> = new Map();

    /**
     * Create a new session with isolated state.
     */
    create(config: SessionConfig): Session {
        if (this.sessions.has(config.id)) {
            throw new Error(`Session ${config.id} already exists`);
        }

        const session: Session = {
            id: config.id,
            status: "active",
            model: config.model ?? DEFAULT_MODEL,
            workDir: config.workDir ?? DEFAULT_WORK_DIR,
            createdAt: new Date(),
            lastActivityAt: new Date(),
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                totalCost: 0,
            },
            metadata: {},
        };

        this.sessions.set(config.id, session);
        return session;
    }

    /**
     * Get session by ID.
     */
    get(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    /**
     * Get or create session.
     */
    getOrCreate(config: SessionConfig): Session {
        const existing = this.sessions.get(config.id);
        if (existing) {
            existing.lastActivityAt = new Date();
            return existing;
        }
        return this.create(config);
    }

    /**
     * Update session activity timestamp.
     */
    touch(id: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.lastActivityAt = new Date();
        }
    }

    /**
     * Update session usage stats.
     */
    addUsage(id: string, inputTokens: number, outputTokens: number, cost: number = 0): void {
        const session = this.sessions.get(id);
        if (session) {
            session.usage.inputTokens += inputTokens;
            session.usage.outputTokens += outputTokens;
            session.usage.totalCost += cost;
            session.lastActivityAt = new Date();
        }
    }

    /**
     * Delete a session.
     */
    delete(id: string): boolean {
        return this.sessions.delete(id);
    }

    /**
     * List all active sessions.
     */
    listActive(): Session[] {
        return Array.from(this.sessions.values())
            .filter(s => s.status === "active" || s.status === "paused");
    }

    /**
     * List all sessions.
     */
    listAll(): Session[] {
        return Array.from(this.sessions.values());
    }

    /**
     * Cleanup expired sessions.
     * @param maxAgeMs Maximum age in milliseconds (0 = cleanup all)
     * @returns Number of sessions cleaned
     */
    cleanupExpired(maxAgeMs: number): number {
        const now = Date.now();
        let cleaned = 0;

        for (const [id, session] of this.sessions) {
            const age = now - session.lastActivityAt.getTime();
            if (maxAgeMs === 0 || age > maxAgeMs) {
                this.sessions.delete(id);
                cleaned++;
            }
        }

        return cleaned;
    }

    /**
     * Get total usage across all sessions.
     */
    getTotalUsage(): { inputTokens: number; outputTokens: number; totalCost: number } {
        let inputTokens = 0;
        let outputTokens = 0;
        let totalCost = 0;

        for (const session of this.sessions.values()) {
            inputTokens += session.usage.inputTokens;
            outputTokens += session.usage.outputTokens;
            totalCost += session.usage.totalCost;
        }

        return { inputTokens, outputTokens, totalCost };
    }
}

/**
 * Factory function.
 */
export function createSessionManager(): SessionManager {
    return new SessionManager();
}
