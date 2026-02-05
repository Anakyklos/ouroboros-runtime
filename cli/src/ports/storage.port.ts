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

export interface AuditEntry {
    id: string;
    sessionId: string;
    timestamp: Date;
    type: 'input' | 'output' | 'error' | 'decision';
    content: string;
}

export interface StoragePort {
    // Session management
    createSession(data: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Promise<Session>;
    getSession(id: string): Promise<Session | null>;
    updateSession(id: string, data: Partial<Session>): Promise<void>;
    listSessions(filter?: { status?: Session['status'] }): Promise<Session[]>;
    deleteSession(id: string): Promise<void>;

    // Audit logging
    appendLog(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry>;
    getLogs(sessionId: string, options?: { limit?: number; offset?: number }): Promise<AuditEntry[]>;

    // Lifecycle
    initialize(): Promise<void>;
    close(): Promise<void>;
}
