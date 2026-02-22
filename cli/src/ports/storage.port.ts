/**
 * 🔌 Storage Port
 * 
 * Interface para persistência de dados.
 * Permite trocar implementação (SQLite, File, Memory) sem afetar core.
 */

export interface Session {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    status: 'active' | 'paused' | 'completed' | 'failed';
    contextSnapshot: string;
    metadata: Record<string, unknown>;
}

export type SessionSummary = Omit<Session, 'contextSnapshot'>;

export interface AuditEntry {
    id: string;
    sessionId: string;
    timestamp: Date;
    type: 'input' | 'output' | 'error' | 'decision';
    content: string;
}

export interface SessionWave {
    id: string;
    sessionId: string;
    waveNumber: number;
    status: 'pending' | 'active' | 'done' | 'failed';
    taskCount: number;
    completedCount: number;
    createdAt: Date;
    updatedAt: Date;
    taskData: Array<{
        id: string;
        title: string;
        phase: string;
        progress: number;
    }>;
}

export interface SessionCheckpoint {
    id: string;
    sessionId: string;
    checkpointNumber: number;
    state: Record<string, unknown>;
    createdAt: Date;
}

export interface SessionMemory {
    id: string;
    sessionId: string;
    type: 'fact' | 'decision' | 'context';
    content: string;
    source?: string;
    createdAt: Date;
}

export interface StoragePort {
    // Session management
    createSession(data: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Promise<Session>;
    getSession(id: string): Promise<Session | null>;
    updateSession(id: string, data: Partial<Session>): Promise<void>;
    listSessions(filter?: { status?: Session['status'] }): Promise<SessionSummary[]>;
    deleteSession(id: string): Promise<void>;

    // Audit logging
    appendLog(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry>;
    getLogs(sessionId: string, options?: { limit?: number; offset?: number }): Promise<AuditEntry[]>;

    // Session waves
    saveWave(wave: Omit<SessionWave, 'id' | 'createdAt' | 'updatedAt'>): Promise<SessionWave>;
    getWave(id: string): Promise<SessionWave | null>;
    listWaves(sessionId: string): Promise<SessionWave[]>;
    updateWave(id: string, data: Partial<SessionWave>): Promise<void>;

    // Session checkpoints
    createCheckpoint(sessionId: string, state: Record<string, unknown>): Promise<SessionCheckpoint>;
    getLatestCheckpoint(sessionId: string): Promise<SessionCheckpoint | null>;
    listCheckpoints(sessionId: string): Promise<SessionCheckpoint[]>;
    deleteOldCheckpoints(sessionId: string, keepCount: number): Promise<void>;

    // Session memory
    saveMemory(entry: Omit<SessionMemory, 'id' | 'createdAt'>): Promise<SessionMemory>;
    listMemory(sessionId: string, filter?: { type?: SessionMemory['type'] }): Promise<SessionMemory[]>;
    deleteOldMemory(sessionId: string, olderThanDays: number): Promise<void>;

    // Lifecycle
    initialize(): Promise<void>;
    close(): Promise<void>;
}
