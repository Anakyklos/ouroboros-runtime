/**
 * 📬 Per-Task Mailbox
 * 
 * Mailbox JSONL para enviar mensagens a tasks em execução.
 * Permite intervenção humana mid-task sem cancelar.
 * 
 * Inspirado por owner_inject.py do razzant/ouroboros.
 * Cada task tem seu próprio mailbox file (task_id.jsonl).
 * Dedup via msg_id + seenIds set.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'crypto';

// ============================================================
// Types
// ============================================================

export interface MailboxMessage {
    msgId: string;
    ts: string;
    text: string;
    metadata?: Record<string, unknown>;
}

export interface MailboxConfig {
    /** Diretório raiz do projeto */
    projectRoot: string;
    /** Subdiretório para mailboxes (default: .ouroboros/mailbox) */
    mailboxDir: string;
}

export const DEFAULT_MAILBOX_CONFIG: MailboxConfig = {
    projectRoot: process.cwd(),
    mailboxDir: '.ouroboros/mailbox',
};

// ============================================================
// TaskMailbox
// ============================================================

export class TaskMailbox {
    private config: MailboxConfig;

    constructor(config?: Partial<MailboxConfig>) {
        this.config = { ...DEFAULT_MAILBOX_CONFIG, ...config };
        this.ensureDir();
    }

    // ============================================================
    // Core Operations
    // ============================================================

    /**
     * Escreve uma mensagem no mailbox de uma task.
     */
    write(taskId: string, text: string, metadata?: Record<string, unknown>): MailboxMessage {
        const msg: MailboxMessage = {
            msgId: randomUUID(),
            ts: new Date().toISOString(),
            text,
            metadata,
        };

        const filePath = this.mailboxPath(taskId);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.appendFileSync(filePath, JSON.stringify(msg) + '\n', 'utf-8');
        return msg;
    }

    /**
     * Drena mensagens novas de um mailbox.
     * Usa seenIds para dedup — mensagens já vistas são skipadas.
     * 
     * @returns Array de textos de mensagens novas
     */
    drain(taskId: string, seenIds: Set<string> = new Set()): string[] {
        const filePath = this.mailboxPath(taskId);
        if (!fs.existsSync(filePath)) return [];

        try {
            const content = fs.readFileSync(filePath, 'utf-8').trim();
            if (!content) return [];

            const messages: string[] = [];

            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                try {
                    const entry = JSON.parse(trimmed) as MailboxMessage;
                    if (entry.msgId && seenIds.has(entry.msgId)) continue;
                    if (entry.msgId) seenIds.add(entry.msgId);
                    if (entry.text) messages.push(entry.text);
                } catch { /* skip malformed */ }
            }

            return messages;
        } catch {
            return [];
        }
    }

    /**
     * Retorna todas as mensagens raw de um mailbox.
     */
    readAll(taskId: string): MailboxMessage[] {
        const filePath = this.mailboxPath(taskId);
        if (!fs.existsSync(filePath)) return [];

        try {
            const content = fs.readFileSync(filePath, 'utf-8').trim();
            if (!content) return [];

            const messages: MailboxMessage[] = [];
            for (const line of content.split('\n')) {
                try {
                    messages.push(JSON.parse(line.trim()));
                } catch { /* skip */ }
            }
            return messages;
        } catch {
            return [];
        }
    }

    /**
     * Limpa o mailbox de uma task completada.
     */
    cleanup(taskId: string): boolean {
        const filePath = this.mailboxPath(taskId);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                return true;
            }
        } catch { /* ignore */ }
        return false;
    }

    /**
     * Verifica se há mensagens pendentes para uma task.
     */
    hasPending(taskId: string): boolean {
        const filePath = this.mailboxPath(taskId);
        return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
    }

    /**
     * Lista task IDs com mailboxes ativas.
     */
    listActiveMailboxes(): string[] {
        const dir = this.dirPath();
        if (!fs.existsSync(dir)) return [];

        try {
            return fs.readdirSync(dir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => f.replace('.jsonl', ''));
        } catch {
            return [];
        }
    }

    // ============================================================
    // Private
    // ============================================================

    private mailboxPath(taskId: string): string {
        // Sanitize taskId for filename safety
        const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
        return path.join(this.dirPath(), `${safe}.jsonl`);
    }

    private dirPath(): string {
        return path.join(this.config.projectRoot, this.config.mailboxDir);
    }

    private ensureDir(): void {
        const dir = this.dirPath();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

// ============================================================
// Factory
// ============================================================

export function createTaskMailbox(config?: Partial<MailboxConfig>): TaskMailbox {
    return new TaskMailbox(config);
}
