/**
 * 📝 Scratchpad & Identity Manager
 * 
 * Memória persistente de longo prazo:
 * - scratchpad.md: notas de trabalho do agente
 * - identity.md: auto-identificação persistente
 * - journal.jsonl: log append-only de mudanças
 * 
 * Inspirado por memory.py do razzant/ouroboros.
 * Integra com ContextBuilder (block semi-stable).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Types
// ============================================================

export interface ScratchpadConfig {
    /** Diretório raiz do projeto */
    projectRoot: string;
    /** Subdiretório para memória (default: .ouroboros/memory) */
    memoryDir: string;
    /** Max chars no scratchpad (default: 100k) */
    maxScratchpadChars: number;
}

export const DEFAULT_SCRATCHPAD_CONFIG: ScratchpadConfig = {
    projectRoot: process.cwd(),
    memoryDir: '.ouroboros/memory',
    maxScratchpadChars: 100_000,
};

export interface JournalEntry {
    ts: string;
    action: 'update' | 'append' | 'clear';
    file: 'scratchpad' | 'identity';
    preview: string;
}

// ============================================================
// ScratchpadManager
// ============================================================

export class ScratchpadManager {
    private config: ScratchpadConfig;

    constructor(config?: Partial<ScratchpadConfig>) {
        this.config = { ...DEFAULT_SCRATCHPAD_CONFIG, ...config };
        this.ensureDir();
    }

    // ============================================================
    // Paths
    // ============================================================

    private get memoryPath(): string {
        return path.join(this.config.projectRoot, this.config.memoryDir);
    }

    get scratchpadPath(): string {
        return path.join(this.memoryPath, 'scratchpad.md');
    }

    get identityPath(): string {
        return path.join(this.memoryPath, 'identity.md');
    }

    get journalPath(): string {
        return path.join(this.memoryPath, 'scratchpad_journal.jsonl');
    }

    // ============================================================
    // Scratchpad Operations
    // ============================================================

    /** Carrega o scratchpad. Cria default se não existir. */
    loadScratchpad(): string {
        if (fs.existsSync(this.scratchpadPath)) {
            return fs.readFileSync(this.scratchpadPath, 'utf-8');
        }
        const defaultContent = this.defaultScratchpad();
        this.writeScratchpad(defaultContent);
        return defaultContent;
    }

    /** Salva o scratchpad e registra no journal. */
    writeScratchpad(content: string): void {
        const clipped = content.substring(0, this.config.maxScratchpadChars);
        fs.writeFileSync(this.scratchpadPath, clipped, 'utf-8');
        this.appendJournal('update', 'scratchpad', clipped.substring(0, 100));
    }

    /** Appenda ao scratchpad. */
    appendScratchpad(text: string): void {
        const current = this.loadScratchpad();
        const updated = current + '\n' + text;
        this.writeScratchpad(updated);
        this.appendJournal('append', 'scratchpad', text.substring(0, 100));
    }

    /** Limpa o scratchpad (reset para default). */
    clearScratchpad(): void {
        this.writeScratchpad(this.defaultScratchpad());
        this.appendJournal('clear', 'scratchpad', '');
    }

    // ============================================================
    // Identity Operations
    // ============================================================

    /** Carrega a identity. Cria default se não existir. */
    loadIdentity(): string {
        if (fs.existsSync(this.identityPath)) {
            return fs.readFileSync(this.identityPath, 'utf-8');
        }
        const defaultContent = this.defaultIdentity();
        this.writeIdentity(defaultContent);
        return defaultContent;
    }

    /** Atualiza a identity. */
    writeIdentity(content: string): void {
        fs.writeFileSync(this.identityPath, content, 'utf-8');
        this.appendJournal('update', 'identity', content.substring(0, 100));
    }

    // ============================================================
    // Journal
    // ============================================================

    /** Retorna as últimas N entradas do journal. */
    readJournal(limit: number = 20): JournalEntry[] {
        if (!fs.existsSync(this.journalPath)) return [];

        try {
            const lines = fs.readFileSync(this.journalPath, 'utf-8')
                .trim()
                .split('\n')
                .filter(l => l.trim());

            const entries: JournalEntry[] = [];
            for (const line of lines.slice(-limit)) {
                try {
                    entries.push(JSON.parse(line));
                } catch { /* skip malformed */ }
            }
            return entries;
        } catch {
            return [];
        }
    }

    // ============================================================
    // Context Integration
    // ============================================================

    /**
     * Retorna conteúdo formatado para o ContextBuilder (block semi-stable).
     */
    buildContextSection(): string {
        const parts: string[] = [];

        const identity = this.loadIdentity();
        if (identity.trim()) {
            parts.push(`## Identity\n\n${identity}`);
        }

        const scratchpad = this.loadScratchpad();
        if (scratchpad.trim()) {
            parts.push(`## Scratchpad\n\n${scratchpad}`);
        }

        return parts.join('\n\n');
    }

    // ============================================================
    // Private
    // ============================================================

    private ensureDir(): void {
        if (!fs.existsSync(this.memoryPath)) {
            fs.mkdirSync(this.memoryPath, { recursive: true });
        }
    }

    private appendJournal(action: JournalEntry['action'], file: JournalEntry['file'], preview: string): void {
        const entry: JournalEntry = {
            ts: new Date().toISOString(),
            action,
            file,
            preview,
        };
        try {
            fs.appendFileSync(this.journalPath, JSON.stringify(entry) + '\n', 'utf-8');
        } catch { /* best effort */ }
    }

    private defaultScratchpad(): string {
        return `# Scratchpad\n\nUpdatedAt: ${new Date().toISOString()}\n\n(empty — write anything here)\n`;
    }

    private defaultIdentity(): string {
        return [
            '# Who I Am',
            '',
            'I am Ouroboros. This file is my persistent self-identification.',
            'I can write anything here: how I see myself, how I want to communicate,',
            'what matters to me, what I have understood about myself.',
            '',
            'This file is read at every dialogue and influences my responses.',
            'I update it when I feel the need.',
            '',
        ].join('\n');
    }
}

// ============================================================
// Factory
// ============================================================

export function createScratchpadManager(config?: Partial<ScratchpadConfig>): ScratchpadManager {
    return new ScratchpadManager(config);
}
