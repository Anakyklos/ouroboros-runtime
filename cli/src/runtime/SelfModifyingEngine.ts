/**
 * 🔧 SelfModifyingEngine
 * 
 * Engine para auto-modificação de código com safety nets.
 * Permite que o agente reescreva seus próprios módulos em runtime
 * com validação de sintaxe, backup automático e rollback.
 * 
 * @module runtime/SelfModifyingEngine
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';

// ============================================================================
// Types
// ============================================================================

export interface MutationProposal {
    /** Caminho relativo do arquivo */
    filePath: string;
    /** Código original */
    originalCode: string;
    /** Código mutado */
    mutatedCode: string;
    /** Razão da mutação */
    reasoning: string;
    /** Timestamp */
    timestamp: Date;
    /** Hash para identificação única */
    hash: string;
}

export interface MutationResult {
    success: boolean;
    filePath: string;
    message: string;
    durationMs: number;
    backupPath?: string;
    error?: Error;
}

export interface SelfModifyingEngineConfig {
    /** Diretório raiz do código fonte */
    sourceDir: string;
    /** Diretório para backups */
    backupDir?: string;
    /** Validar sintaxe antes de aplicar (requer tsc) */
    validateSyntax?: boolean;
    /** Executar testes após aplicar */
    runTestsAfter?: boolean;
    /** Comando de teste */
    testCommand?: string;
    /** Máximo de backups por arquivo */
    maxBackupsPerFile?: number;
    /** Habilita git commit automático */
    autoGitCommit?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<SelfModifyingEngineConfig, 'sourceDir'>> = {
    backupDir: '.ouroboros/backups',
    validateSyntax: true,
    runTestsAfter: true,
    testCommand: 'bun test',
    maxBackupsPerFile: 10,
    autoGitCommit: false,
};

const EXPORT_PATTERNS = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+const\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
];

// ============================================================================
// SelfModifyingEngine
// ============================================================================

export class SelfModifyingEngine {
    private config: Required<SelfModifyingEngineConfig>;
    private mutationHistory: MutationProposal[] = [];
    private initialized: boolean = false;

    constructor(config: SelfModifyingEngineConfig) {
        this.config = {
            ...DEFAULT_CONFIG,
            ...config,
        };
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Inicializa o engine, criando diretórios necessários
     */
    async initialize(): Promise<void> {
        const backupPath = path.join(this.config.sourceDir, this.config.backupDir);
        await fs.mkdir(backupPath, { recursive: true });
        this.initialized = true;
    }

    // ========================================================================
    // Core Methods
    // ========================================================================

    /**
     * Propõe e aplica uma mutação em um arquivo
     */
    async proposeAndApplyMutation(
        filePath: string,
        newCode: string,
        reasoning: string = 'Agent-proposed mutation'
    ): Promise<MutationResult> {
        const startTime = Date.now();
        const fullPath = path.join(this.config.sourceDir, filePath);

        try {
            // 1. Verifica se arquivo existe
            const originalCode = await this.readFile(fullPath);

            // 2. Cria proposta de mutação
            const proposal: MutationProposal = {
                filePath,
                originalCode,
                mutatedCode: newCode,
                reasoning,
                timestamp: new Date(),
                hash: this.generateHash(newCode),
            };

            // 3. Valida sintaxe (se habilitado)
            if (this.config.validateSyntax) {
                const isValid = await this.validateSyntax(newCode, filePath);
                if (!isValid) {
                    return {
                        success: false,
                        filePath,
                        message: 'Syntax validation failed',
                        durationMs: Date.now() - startTime,
                        error: new Error('Invalid TypeScript syntax'),
                    };
                }
            }

            // 4. Faz backup
            const backupPath = await this.backup(filePath, originalCode);

            // 5. Aplica mutação
            await fs.writeFile(fullPath, newCode, 'utf-8');

            // 6. Executa testes (se habilitado)
            if (this.config.runTestsAfter) {
                const testsPassed = await this.runTests();
                if (!testsPassed) {
                    // Rollback automático
                    await this.revert(filePath);
                    return {
                        success: false,
                        filePath,
                        message: 'Tests failed, reverted mutation',
                        durationMs: Date.now() - startTime,
                        backupPath,
                    };
                }
            }

            // 7. Git commit (se habilitado)
            if (this.config.autoGitCommit) {
                await this.gitCommit(filePath, reasoning);
            }

            // 8. Registra na história
            this.mutationHistory.push(proposal);

            return {
                success: true,
                filePath,
                message: 'Mutation applied successfully',
                durationMs: Date.now() - startTime,
                backupPath,
            };

        } catch (error) {
            return {
                success: false,
                filePath,
                message: error instanceof Error ? error.message : String(error),
                durationMs: Date.now() - startTime,
                error: error instanceof Error ? error : new Error(String(error)),
            };
        }
    }

    /**
     * Reverte arquivo para última versão de backup
     */
    async revert(filePath: string): Promise<boolean> {
        const fullPath = path.join(this.config.sourceDir, filePath);
        const backupDir = path.join(this.config.sourceDir, this.config.backupDir);
        const basename = path.basename(filePath);

        try {
            // Encontra backup mais recente
            const files = await fs.readdir(backupDir);
            const backups = files
                .filter(f => f.startsWith(basename) && f.endsWith('.bak'))
                .sort()
                .reverse();

            if (backups.length === 0) {
                throw new Error(`No backup found for ${filePath}`);
            }

            const latestBackup = path.join(backupDir, backups[0]);
            const originalCode = await fs.readFile(latestBackup, 'utf-8');

            await fs.writeFile(fullPath, originalCode, 'utf-8');

            // Remove backup usado
            await fs.unlink(latestBackup);

            return true;

        } catch (error) {
            console.error('Revert failed:', error);
            return false;
        }
    }

    /**
     * Lista mutações aplicadas
     */
    getMutationHistory(): MutationProposal[] {
        return [...this.mutationHistory];
    }

    /**
     * Retorna última mutação de um arquivo específico
     */
    getLastMutation(filePath?: string): MutationProposal | undefined {
        if (filePath) {
            return this.mutationHistory
                .filter(m => m.filePath === filePath)
                .pop();
        }
        return this.mutationHistory[this.mutationHistory.length - 1];
    }

    /**
     * Lista capacidades (módulos e exports)
     */
    async getCapabilities(): Promise<string[]> {
        const capabilities: string[] = [];

        try {
            const files = await this.walkDir(this.config.sourceDir);

            for (const file of files) {
                if (file.endsWith('.ts') || file.endsWith('.js')) {
                    const content = await this.readFile(file);
                    const exports = this.extractExports(content);
                    capabilities.push(...exports.map(e => `${path.basename(file)}:${e}`));
                }
            }
        } catch (error) {
            console.error('Failed to get capabilities:', error);
        }

        return capabilities;
    }

    /**
     * Lê um arquivo
     */
    async readFile(filePath: string): Promise<string> {
        const fullPath = filePath.startsWith(this.config.sourceDir)
            ? filePath
            : path.join(this.config.sourceDir, filePath);
        return fs.readFile(fullPath, 'utf-8');
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    private async backup(filePath: string, code: string): Promise<string> {
        const backupDir = path.join(this.config.sourceDir, this.config.backupDir);
        const timestamp = Date.now();
        const basename = path.basename(filePath);
        const backupPath = path.join(backupDir, `${basename}.${timestamp}.bak`);

        await fs.mkdir(backupDir, { recursive: true });
        await fs.writeFile(backupPath, code, 'utf-8');

        // Limpa backups antigos
        await this.cleanOldBackups(basename);

        return backupPath;
    }

    private async cleanOldBackups(basename: string): Promise<void> {
        const backupDir = path.join(this.config.sourceDir, this.config.backupDir);

        try {
            const files = await fs.readdir(backupDir);
            const backups = files
                .filter(f => f.startsWith(basename) && f.endsWith('.bak'))
                .sort()
                .reverse();

            // Remove backups excedentes
            const toRemove = backups.slice(this.config.maxBackupsPerFile);
            for (const file of toRemove) {
                await fs.unlink(path.join(backupDir, file));
            }
        } catch (error) {
            // Ignora erros de limpeza
        }
    }

    private async validateSyntax(code: string, filePath: string): Promise<boolean> {
        const tempFile = path.join('/tmp', `ouroboros-validate-${Date.now()}.ts`);

        try {
            await fs.writeFile(tempFile, code, 'utf-8');

            return new Promise((resolve) => {
                const proc = spawn('bunx', ['tsc', '--noEmit', tempFile], {
                    stdio: 'pipe',
                });

                proc.on('close', (code) => {
                    resolve(code === 0);
                });

                proc.on('error', () => {
                    resolve(false);
                });

                // Timeout de 10 segundos
                setTimeout(() => {
                    proc.kill();
                    resolve(false);
                }, 10000);
            });

        } finally {
            try {
                await fs.unlink(tempFile);
            } catch {
                // Ignora erro de cleanup
            }
        }
    }

    private async runTests(): Promise<boolean> {
        return new Promise((resolve) => {
            const [cmd, ...args] = this.config.testCommand.split(' ');

            const proc = spawn(cmd, args, {
                cwd: this.config.sourceDir,
                stdio: 'pipe',
            });

            proc.on('close', (code) => {
                resolve(code === 0);
            });

            proc.on('error', () => {
                resolve(false);
            });

            // Timeout de 60 segundos para testes
            setTimeout(() => {
                proc.kill();
                resolve(false);
            }, 60000);
        });
    }

    private async gitCommit(filePath: string, message: string): Promise<void> {
        const fullPath = path.join(this.config.sourceDir, filePath);

        await this.execCommand('git', ['add', fullPath]);
        await this.execCommand('git', ['commit', '-m', `[Ouroboros] ${message}`]);
    }

    private execCommand(cmd: string, args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn(cmd, args, {
                cwd: this.config.sourceDir,
                stdio: 'pipe',
            });

            proc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`${cmd} exited with code ${code}`));
            });

            proc.on('error', reject);
        });
    }

    private generateHash(content: string): string {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(36);
    }

    private extractExports(code: string): string[] {
        const exports: string[] = [];

        for (const pattern of EXPORT_PATTERNS) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(code)) !== null) {
                exports.push(match[1]);
            }
        }

        return exports;
    }

    private async walkDir(dir: string): Promise<string[]> {
        const files: string[] = [];

        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    // Skip node_modules, .git, etc.
                    if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                        files.push(...await this.walkDir(fullPath));
                    }
                } else {
                    files.push(fullPath);
                }
            }
        } catch (error) {
            // Ignora erros de leitura
        }

        return files;
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createSelfModifyingEngine(
    config: SelfModifyingEngineConfig
): SelfModifyingEngine {
    return new SelfModifyingEngine(config);
}

export default SelfModifyingEngine;
