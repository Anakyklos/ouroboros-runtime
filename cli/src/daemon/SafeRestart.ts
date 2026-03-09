/**
 * 🔄 Safe Restart + Auto Resume
 * 
 * Orchestrates safe restart with:
 * 1. Pre-restart: snapshot untracked files to rescue dir
 * 2. State persistence (queue, budget, scratchpad)
 * 3. Auto-resume: detect interrupted work and resume
 * 
 * Inspirado por git_ops.safe_restart() e workers.auto_resume_after_restart()
 * do razzant/ouroboros.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'child_process';
import { EventBus, globalEventBus } from './event-bus.js';
import { createEventLogger } from './event-logger.js';

// ============================================================
// Types
// ============================================================

export interface SafeRestartConfig {
    /** Diretório raiz do projeto */
    projectRoot: string;
    /** Diretório para estado persistente */
    stateDir: string;
    /** Max arquivos no rescue snapshot */
    maxRescueFiles: number;
    /** Max tamanho total do rescue em bytes */
    maxRescueBytes: number;
}

export const DEFAULT_RESTART_CONFIG: SafeRestartConfig = {
    projectRoot: process.cwd(),
    stateDir: '.ouroboros',
    maxRescueFiles: 100,
    maxRescueBytes: 10_000_000, // 10MB
};

export interface RestartResult {
    success: boolean;
    rescueDir?: string;
    filesRescued: number;
    message: string;
}

export interface ResumeInfo {
    /** Se há trabalho interrompido para retomar */
    hasInterruptedWork: boolean;
    /** Detalhes do que retomar */
    details: string[];
    /** Tasks pendentes na queue */
    pendingTaskCount: number;
    /** Conteúdo do scratchpad (para contexto) */
    scratchpadPreview?: string;
}

// ============================================================
// SafeRestart
// ============================================================

export class SafeRestart {
    private config: SafeRestartConfig;
    private eventBus: EventBus;
    private log: ReturnType<typeof createEventLogger>;

    constructor(config?: Partial<SafeRestartConfig>, eventBus?: EventBus) {
        this.config = { ...DEFAULT_RESTART_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
        this.log = createEventLogger('SafeRestart', this.eventBus);
    }

    // ============================================================
    // Pre-Restart: Rescue Snapshot
    // ============================================================

    /**
     * Salva arquivos untracked/modified antes de um restart.
     * Cria um diretório rescue com timestamp.
     */
    createRescueSnapshot(reason: string = 'pre-restart'): RestartResult {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const rescueDir = path.join(
                this.config.projectRoot,
                this.config.stateDir,
                'rescue',
                `${timestamp}_${reason}`,
            );

            fs.mkdirSync(rescueDir, { recursive: true });

            // Get list of modified/untracked files via git
            const files = this.getUntrackedAndModified();
            let totalBytes = 0;
            let copied = 0;

            for (const file of files) {
                if (copied >= this.config.maxRescueFiles) break;
                if (totalBytes >= this.config.maxRescueBytes) break;

                try {
                    const srcPath = path.join(this.config.projectRoot, file);
                    if (!fs.existsSync(srcPath)) continue;

                    const stat = fs.statSync(srcPath);
                    if (!stat.isFile()) continue;
                    if (totalBytes + stat.size > this.config.maxRescueBytes) continue;

                    const destPath = path.join(rescueDir, file);
                    fs.mkdirSync(path.dirname(destPath), { recursive: true });
                    fs.copyFileSync(srcPath, destPath);

                    totalBytes += stat.size;
                    copied++;
                } catch { /* skip individual files */ }
            }

            // Write manifest
            const manifest = {
                timestamp,
                reason,
                fileCount: copied,
                totalBytes,
                files: files.slice(0, copied),
            };
            fs.writeFileSync(
                path.join(rescueDir, '_manifest.json'),
                JSON.stringify(manifest, null, 2),
                'utf-8',
            );

            this.log('info', `🔄 Rescue snapshot created: ${copied} files, ${(totalBytes / 1024).toFixed(1)}KB`);

            return {
                success: true,
                rescueDir,
                filesRescued: copied,
                message: `Rescued ${copied} files to ${rescueDir}`,
            };
        } catch (err) {
            return {
                success: false,
                filesRescued: 0,
                message: `Rescue failed: ${err}`,
            };
        }
    }

    // ============================================================
    // Auto-Resume Detection
    // ============================================================

    /**
     * Detecta se há trabalho interrompido que pode ser retomado.
     * Verifica scratchpad, queue state, e eventos recentes.
     */
    detectInterruptedWork(): ResumeInfo {
        const details: string[] = [];
        let pendingTaskCount = 0;
        let scratchpadPreview: string | undefined;

        // 1. Check queue state file
        const queueStatePath = path.join(
            this.config.projectRoot,
            this.config.stateDir,
            'queue-state.json',
        );

        if (fs.existsSync(queueStatePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(queueStatePath, 'utf-8'));
                const pendingTasks = (data.tasks || []).filter(
                    (t: any) => t.status === 'pending' || t.status === 'running'
                );
                pendingTaskCount = pendingTasks.length;
                if (pendingTaskCount > 0) {
                    details.push(`${pendingTaskCount} tasks pending/running in queue`);
                    // Show first few task instructions
                    for (const t of pendingTasks.slice(0, 3)) {
                        details.push(`  - [${t.priority}] ${(t.instruction || '').substring(0, 60)}`);
                    }
                }
            } catch { /* invalid state file */ }
        }

        // 2. Check scratchpad for recent work notes
        const scratchpadPath = path.join(
            this.config.projectRoot,
            this.config.stateDir,
            'memory',
            'scratchpad.md',
        );

        if (fs.existsSync(scratchpadPath)) {
            try {
                const content = fs.readFileSync(scratchpadPath, 'utf-8');
                if (content.trim() && !content.includes('(empty — write anything here)')) {
                    details.push('Scratchpad has active notes');
                    scratchpadPreview = content.substring(0, 500);
                }
            } catch { /* ignore */ }
        }

        // 3. Check for recent rescue snapshots (indicates crash)
        const rescueDir = path.join(this.config.projectRoot, this.config.stateDir, 'rescue');
        if (fs.existsSync(rescueDir)) {
            try {
                const rescues = fs.readdirSync(rescueDir).sort().reverse();
                if (rescues.length > 0) {
                    const latest = rescues[0];
                    details.push(`Recent rescue snapshot found: ${latest}`);
                }
            } catch { /* ignore */ }
        }

        return {
            hasInterruptedWork: details.length > 0,
            details,
            pendingTaskCount,
            scratchpadPreview,
        };
    }

    // ============================================================
    // Git Helpers
    // ============================================================

    private getUntrackedAndModified(): string[] {
        try {
            const output = execSync(
                'git status --porcelain --untracked-files=all 2>/dev/null',
                { cwd: this.config.projectRoot, encoding: 'utf-8' },
            );

            return output
                .split('\n')
                .filter(l => l.trim())
                .map(l => l.substring(3).trim())
                .filter(f => !f.startsWith('.ouroboros/')); // Don't rescue state dir
        } catch {
            return [];
        }
    }

    // log is now created by createEventLogger in constructor
    // Kept comment for searchability
}

// ============================================================
// Factory
// ============================================================

export function createSafeRestart(
    config?: Partial<SafeRestartConfig>,
    eventBus?: EventBus,
): SafeRestart {
    return new SafeRestart(config, eventBus);
}
