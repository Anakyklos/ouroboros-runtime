/**
 * 💾 SQLite Adapter
 * 
 * Implementação do StoragePort usando SQLite.
 * Usa better-sqlite3 para performance síncrona.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { StoragePort, Session, AuditEntry } from '../ports/storage.port.js';

export class SqliteAdapter implements StoragePort {
    private db: Database.Database | null = null;
    private dbPath: string;

    constructor(dbPath: string = '.ouroboros/daemon.db') {
        this.dbPath = dbPath;
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
        `);
    }

    async close(): Promise<void> {
        this.db?.close();
        this.db = null;
    }

    private ensureDb(): Database.Database {
        if (!this.db) {
            throw new Error('Database not initialized. Call initialize() first.');
        }
        return this.db;
    }

    async createSession(data: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Promise<Session> {
        const db = this.ensureDb();
        const now = new Date();
        const session: Session = {
            id: randomUUID(),
            createdAt: now,
            updatedAt: now,
            ...data,
        };

        db.prepare(`
            INSERT INTO sessions (id, created_at, updated_at, status, context_snapshot, metadata)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
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
        const db = this.ensureDb();
        const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as {
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

    async listSessions(filter?: { status?: Session['status'] }): Promise<Session[]> {
        const db = this.ensureDb();
        let query = 'SELECT * FROM sessions';
        const params: unknown[] = [];

        if (filter?.status) {
            query += ' WHERE status = ?';
            params.push(filter.status);
        }

        query += ' ORDER BY created_at DESC';

        const rows = db.prepare(query).all(...params) as Array<{
            id: string;
            created_at: string;
            updated_at: string;
            status: Session['status'];
            context_snapshot: string;
            metadata: string;
        }>;

        return rows.map(row => ({
            id: row.id,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
            status: row.status,
            contextSnapshot: row.context_snapshot,
            metadata: JSON.parse(row.metadata),
        }));
    }

    async deleteSession(id: string): Promise<void> {
        const db = this.ensureDb();
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }

    async appendLog(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> {
        const db = this.ensureDb();
        const log: AuditEntry = {
            id: randomUUID(),
            timestamp: new Date(),
            ...entry,
        };

        db.prepare(`
            INSERT INTO audit_logs (id, session_id, timestamp, type, content)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            log.id,
            log.sessionId,
            log.timestamp.toISOString(),
            log.type,
            log.content
        );

        return log;
    }

    async getLogs(sessionId: string, options?: { limit?: number; offset?: number }): Promise<AuditEntry[]> {
        const db = this.ensureDb();
        let query = 'SELECT * FROM audit_logs WHERE session_id = ? ORDER BY timestamp DESC';
        const params: unknown[] = [sessionId];

        if (options?.limit) {
            query += ' LIMIT ?';
            params.push(options.limit);
        }
        if (options?.offset) {
            query += ' OFFSET ?';
            params.push(options.offset);
        }

        const rows = db.prepare(query).all(...params) as Array<{
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
}
