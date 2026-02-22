/**
 * 💾 SQLite Adapter
 * 
 * Implementação do StoragePort usando SQLite.
 * Usa better-sqlite3 para performance síncrona.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { StoragePort, Session, SessionSummary, AuditEntry, SessionWave, SessionCheckpoint, SessionMemory } from '../ports/storage.port.js';

export class SqliteAdapter implements StoragePort {
    private db: Database.Database | null = null;
    private dbPath: string;
    // Cache prepared statements to improve performance
    private statements: Record<string, Database.Statement> = {};

    constructor(dbPath: string = '.ouroboros/daemon.db') {
        this.dbPath = dbPath;
    }

    private getStatement(key: string, sql: string): Database.Statement {
        const db = this.ensureDb();
        if (!this.statements[key]) {
            this.statements[key] = db.prepare(sql);
        }
        return this.statements[key];
    }

    async initialize(): Promise<void> {
        this.db = new Database(this.dbPath);

        // Enable WAL mode for better concurrency
        this.db.pragma('journal_mode = WAL');

        // Create tables
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'failed')),
                context_snapshot TEXT NOT NULL DEFAULT '',
                metadata TEXT NOT NULL DEFAULT '{}'
            );
            
            CREATE TABLE IF NOT EXISTS session_waves (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                wave_number INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'done', 'failed')),
                task_count INTEGER NOT NULL DEFAULT 0,
                completed_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                task_data TEXT NOT NULL DEFAULT '[]',
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            
            CREATE TABLE IF NOT EXISTS session_checkpoints (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                checkpoint_number INTEGER NOT NULL,
                state TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            
            CREATE TABLE IF NOT EXISTS session_memory (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('fact', 'decision', 'context')),
                content TEXT NOT NULL,
                source TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            
            CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('input', 'output', 'error', 'decision')),
                content TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            
            CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_logs(session_id);
            CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
            CREATE INDEX IF NOT EXISTS idx_session_waves_session ON session_waves(session_id);
            CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session ON session_checkpoints(session_id);
            CREATE INDEX IF NOT EXISTS idx_session_checkpoints_number ON session_checkpoints(session_id, checkpoint_number);
            CREATE INDEX IF NOT EXISTS idx_session_memory_session ON session_memory(session_id);
            CREATE INDEX IF NOT EXISTS idx_session_memory_type ON session_memory(session_id, type);
        `);
    }

    async close(): Promise<void> {
        this.db?.close();
        this.db = null;
        this.statements = {};
    }

    private ensureDb(): Database.Database {
        if (!this.db) {
            throw new Error('Database not initialized. Call initialize() first.');
        }
        return this.db;
    }

    async createSession(data: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Promise<Session> {
        const now = new Date();
        const session: Session = {
            id: randomUUID(),
            createdAt: now,
            updatedAt: now,
            ...data,
        };

        const stmt = this.getStatement('createSession', `
            INSERT INTO sessions (id, created_at, updated_at, status, context_snapshot, metadata)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            session.id,
            session.createdAt.toISOString(),
            session.updatedAt.toISOString(),
            session.status,
            session.contextSnapshot,
            JSON.stringify(session.metadata)
        );

        return session;
    }

    async getSession(id: string): Promise<Session | null> {
        const stmt = this.getStatement('getSession', 'SELECT * FROM sessions WHERE id = ?');
        const row = stmt.get(id) as {
            id: string;
            created_at: string;
            updated_at: string;
            status: Session['status'];
            context_snapshot: string;
            metadata: string;
        } | undefined;

        if (!row) return null;

        return {
            id: row.id,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
            status: row.status,
            contextSnapshot: row.context_snapshot,
            metadata: JSON.parse(row.metadata),
        };
    }

    async updateSession(id: string, data: Partial<Session>): Promise<void> {
        const db = this.ensureDb();
        const updates: string[] = ['updated_at = ?'];
        const values: unknown[] = [new Date().toISOString()];

        if (data.status) {
            updates.push('status = ?');
            values.push(data.status);
        }
        if (data.contextSnapshot !== undefined) {
            updates.push('context_snapshot = ?');
            values.push(data.contextSnapshot);
        }
        if (data.metadata) {
            updates.push('metadata = ?');
            values.push(JSON.stringify(data.metadata));
        }

        values.push(id);

        db.prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    async listSessions(filter?: { status?: Session['status'] }): Promise<SessionSummary[]> {
        let stmt: Database.Statement;
        const params: unknown[] = [];

        // Optimize: Select only summary fields, excluding large context_snapshot
        const queryCols = 'id, created_at, updated_at, status, metadata';

        if (filter?.status) {
            stmt = this.getStatement('listSessionsByStatus', `SELECT ${queryCols} FROM sessions WHERE status = ? ORDER BY created_at DESC`);
            params.push(filter.status);
        } else {
            stmt = this.getStatement('listSessionsAll', `SELECT ${queryCols} FROM sessions ORDER BY created_at DESC`);
        }

        const rows = stmt.all(...params) as Array<{
            id: string;
            created_at: string;
            updated_at: string;
            status: Session['status'];
            metadata: string;
        }>;

        return rows.map(row => ({
            id: row.id,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
            status: row.status,
            metadata: JSON.parse(row.metadata),
        }));
    }

    async deleteSession(id: string): Promise<void> {
        const stmt = this.getStatement('deleteSession', 'DELETE FROM sessions WHERE id = ?');
        stmt.run(id);
    }

    async appendLog(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> {
        const log: AuditEntry = {
            id: randomUUID(),
            timestamp: new Date(),
            ...entry,
        };

        const stmt = this.getStatement('appendLog', `
            INSERT INTO audit_logs (id, session_id, timestamp, type, content)
            VALUES (?, ?, ?, ?, ?)
        `);

        stmt.run(
            log.id,
            log.sessionId,
            log.timestamp.toISOString(),
            log.type,
            log.content
        );

        return log;
    }

    async getLogs(sessionId: string, options?: { limit?: number; offset?: number }): Promise<AuditEntry[]> {
        // SQLite supports LIMIT -1 for no limit
        const limit = options?.limit ?? -1;
        const offset = options?.offset ?? 0;

        const stmt = this.getStatement('getLogs', 'SELECT * FROM audit_logs WHERE session_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?');

        const rows = stmt.all(sessionId, limit, offset) as Array<{
            id: string;
            session_id: string;
            timestamp: string;
            type: AuditEntry['type'];
            content: string;
        }>;

        return rows.map(row => ({
            id: row.id,
            sessionId: row.session_id,
            timestamp: new Date(row.timestamp),
            type: row.type,
            content: row.content,
        }));
    }

    // Session Waves
    async saveWave(wave: Omit<SessionWave, 'id' | 'createdAt' | 'updatedAt'>): Promise<SessionWave> {
        const now = new Date();
        const savedWave: SessionWave = {
            id: randomUUID(),
            createdAt: now,
            updatedAt: now,
            ...wave,
        };

        const stmt = this.getStatement('saveWave', `
            INSERT INTO session_waves (id, session_id, wave_number, status, task_count, completed_count, created_at, updated_at, task_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            savedWave.id,
            savedWave.sessionId,
            savedWave.waveNumber,
            savedWave.status,
            savedWave.taskCount,
            savedWave.completedCount,
            savedWave.createdAt.toISOString(),
            savedWave.updatedAt.toISOString(),
            JSON.stringify(savedWave.taskData)
        );

        return savedWave;
    }

    async getWave(id: string): Promise<SessionWave | null> {
        const stmt = this.getStatement('getWave', 'SELECT * FROM session_waves WHERE id = ?');
        const row = stmt.get(id) as {
            id: string;
            session_id: string;
            wave_number: number;
            status: SessionWave['status'];
            task_count: number;
            completed_count: number;
            created_at: string;
            updated_at: string;
            task_data: string;
        } | undefined;

        if (!row) return null;

        return {
            id: row.id,
            sessionId: row.session_id,
            waveNumber: row.wave_number,
            status: row.status,
            taskCount: row.task_count,
            completedCount: row.completed_count,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
            taskData: JSON.parse(row.task_data),
        };
    }

    async listWaves(sessionId: string): Promise<SessionWave[]> {
        const stmt = this.getStatement('listWaves', 'SELECT * FROM session_waves WHERE session_id = ? ORDER BY wave_number ASC');
        const rows = stmt.all(sessionId) as Array<{
            id: string;
            session_id: string;
            wave_number: number;
            status: SessionWave['status'];
            task_count: number;
            completed_count: number;
            created_at: string;
            updated_at: string;
            task_data: string;
        }>;

        return rows.map(row => ({
            id: row.id,
            sessionId: row.session_id,
            waveNumber: row.wave_number,
            status: row.status,
            taskCount: row.task_count,
            completedCount: row.completed_count,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
            taskData: JSON.parse(row.task_data),
        }));
    }

    async updateWave(id: string, data: Partial<SessionWave>): Promise<void> {
        const db = this.ensureDb();
        const updates: string[] = ['updated_at = ?'];
        const values: unknown[] = [new Date().toISOString()];

        if (data.status) {
            updates.push('status = ?');
            values.push(data.status);
        }
        if (data.taskCount !== undefined) {
            updates.push('task_count = ?');
            values.push(data.taskCount);
        }
        if (data.completedCount !== undefined) {
            updates.push('completed_count = ?');
            values.push(data.completedCount);
        }
        if (data.taskData) {
            updates.push('task_data = ?');
            values.push(JSON.stringify(data.taskData));
        }

        values.push(id);
        db.prepare(`UPDATE session_waves SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    // Session Checkpoints
    async createCheckpoint(sessionId: string, state: Record<string, unknown>): Promise<SessionCheckpoint> {
        const db = this.ensureDb();
        
        const countStmt = db.prepare('SELECT COALESCE(MAX(checkpoint_number), 0) as max FROM session_checkpoints WHERE session_id = ?');
        const result = countStmt.get(sessionId) as { max: number };
        const checkpointNumber = result.max + 1;

        const checkpoint: SessionCheckpoint = {
            id: randomUUID(),
            sessionId,
            checkpointNumber,
            state,
            createdAt: new Date(),
        };

        const stmt = this.getStatement('createCheckpoint', `
            INSERT INTO session_checkpoints (id, session_id, checkpoint_number, state, created_at)
            VALUES (?, ?, ?, ?, ?)
        `);

        stmt.run(
            checkpoint.id,
            checkpoint.sessionId,
            checkpoint.checkpointNumber,
            JSON.stringify(checkpoint.state),
            checkpoint.createdAt.toISOString()
        );

        return checkpoint;
    }

    async getLatestCheckpoint(sessionId: string): Promise<SessionCheckpoint | null> {
        const stmt = this.getStatement('getLatestCheckpoint', 
            'SELECT * FROM session_checkpoints WHERE session_id = ? ORDER BY checkpoint_number DESC LIMIT 1');
        const row = stmt.get(sessionId) as {
            id: string;
            session_id: string;
            checkpoint_number: number;
            state: string;
            created_at: string;
        } | undefined;

        if (!row) return null;

        return {
            id: row.id,
            sessionId: row.session_id,
            checkpointNumber: row.checkpoint_number,
            state: JSON.parse(row.state),
            createdAt: new Date(row.created_at),
        };
    }

    async listCheckpoints(sessionId: string): Promise<SessionCheckpoint[]> {
        const stmt = this.getStatement('listCheckpoints', 
            'SELECT * FROM session_checkpoints WHERE session_id = ? ORDER BY checkpoint_number DESC');
        const rows = stmt.all(sessionId) as Array<{
            id: string;
            session_id: string;
            checkpoint_number: number;
            state: string;
            created_at: string;
        }>;

        return rows.map(row => ({
            id: row.id,
            sessionId: row.session_id,
            checkpointNumber: row.checkpoint_number,
            state: JSON.parse(row.state),
            createdAt: new Date(row.created_at),
        }));
    }

    async deleteOldCheckpoints(sessionId: string, keepCount: number): Promise<void> {
        const db = this.ensureDb();
        db.prepare(`
            DELETE FROM session_checkpoints 
            WHERE session_id = ? 
            AND checkpoint_number <= (
                SELECT COALESCE(MAX(checkpoint_number), 0) - ? FROM session_checkpoints WHERE session_id = ?
            )
        `).run(sessionId, keepCount, sessionId);
    }

    // Session Memory
    async saveMemory(entry: Omit<SessionMemory, 'id' | 'createdAt'>): Promise<SessionMemory> {
        const memory: SessionMemory = {
            id: randomUUID(),
            createdAt: new Date(),
            ...entry,
        };

        const stmt = this.getStatement('saveMemory', `
            INSERT INTO session_memory (id, session_id, type, content, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            memory.id,
            memory.sessionId,
            memory.type,
            memory.content,
            memory.source || null,
            memory.createdAt.toISOString()
        );

        return memory;
    }

    async listMemory(sessionId: string, filter?: { type?: SessionMemory['type'] }): Promise<SessionMemory[]> {
        let stmt: Database.Statement;
        const params: unknown[] = [sessionId];

        if (filter?.type) {
            stmt = this.getStatement('listMemoryByType', 
                'SELECT * FROM session_memory WHERE session_id = ? AND type = ? ORDER BY created_at DESC');
            params.push(filter.type);
        } else {
            stmt = this.getStatement('listMemoryAll', 
                'SELECT * FROM session_memory WHERE session_id = ? ORDER BY created_at DESC');
        }

        const rows = stmt.all(...params) as Array<{
            id: string;
            session_id: string;
            type: SessionMemory['type'];
            content: string;
            source: string | null;
            created_at: string;
        }>;

        return rows.map(row => ({
            id: row.id,
            sessionId: row.session_id,
            type: row.type,
            content: row.content,
            source: row.source || undefined,
            createdAt: new Date(row.created_at),
        }));
    }

    async deleteOldMemory(sessionId: string, olderThanDays: number): Promise<void> {
        const db = this.ensureDb();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - olderThanDays);

        db.prepare('DELETE FROM session_memory WHERE session_id = ? AND created_at < ?')
            .run(sessionId, cutoff.toISOString());
    }
}
