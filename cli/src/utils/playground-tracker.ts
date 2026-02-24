/**
 * 📂 Playground Tracker
 *
 * Sistema de rastreamento de arquivos no playground.
 * Monitora arquivos candidatos à promoção (playground → src).
 *
 * Abordagem "File-first": JSON como fonte da verdade,
 * com metadados sobre arquivos em playground para controle de promoção.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const PLAYGROUND_TRACKING_DIR = ".agent/playground";
const TRACKING_FILE = "playground-files.json";

// --- TYPES ---

/**
 * Metadados de um arquivo em playground.
 */
export interface PlaygroundFile {
    /** Caminho relativo do arquivo (de: playground/...) */
    path: string;
    /** Caminho de destino sugerido (para: src/...) */
    suggestedTarget: string;
    /** Timestamp de criação do arquivo */
    createdAt: Date;
    /** Timestamp da última modificação */
    modifiedAt: Date;
    /** Tamanho do arquivo em bytes */
    size: number;
    /** ID da task que criou este arquivo */
    taskId?: string;
    /** Status do arquivo no workflow de promoção */
    status: PlaygroundFileStatus;
    /** Tipo de arquivo (baseado na extensão) */
    fileType: string;
}

/**
 * Status de um arquivo no playground.
 */
export enum PlaygroundFileStatus {
    /** Arquivo criado recentemente */
    NEW = "NEW",
    /** Modificado após criação */
    MODIFIED = "MODIFIED",
    /** Candidato registrado para promoção */
    REGISTERED = "REGISTERED",
    /** Validações em andamento */
    VALIDATING = "VALIDATING",
    /** Aguardando aprovação humana */
    AWAITING_APPROVAL = "AWAITING_APPROVAL",
    /** Aprovado e pronto para mover */
    APPROVED = "APPROVED",
    /** Movido para src/ */
    PROMOTED = "PROMOTED",
    /** Rejeitado pelo humano ou validações */
    REJECTED = "REJECTED",
    /** Ignorado (não candidato à promoção) */
    IGNORED = "IGNORED",
}

/**
 * Estado do sistema de tracking do playground.
 */
export interface PlaygroundTrackingState {
    /** Arquivos rastreados no playground */
    files: PlaygroundFile[];
    /** Timestamp da última verificação */
    lastScanAt: Date;
}

/**
 * Configuração para o PlaygroundTracker.
 */
export interface PlaygroundTrackerConfig {
    /** Diretório raiz do projeto */
    projectRoot: string;
    /** Diretório do playground (relativo ao projectRoot) */
    playgroundDir: string;
    /** Diretório destino para promoção (relativo ao projectRoot) */
    targetDir: string;
    /** Habilita logs detalhados */
    verbose: boolean;
}

/**
 * Configuração padrão para o PlaygroundTracker.
 */
export const DEFAULT_PLAYGROUND_TRACKER_CONFIG: PlaygroundTrackerConfig = {
    projectRoot: process.cwd(),
    playgroundDir: ".ouroboros/playground",
    targetDir: "src",
    verbose: true,
};

/**
 * Resultado de uma operação de scan.
 */
export interface ScanResult {
    /** Novos arquivos descobertos */
    newFiles: PlaygroundFile[];
    /** Arquivos modificados desde o último scan */
    modifiedFiles: PlaygroundFile[];
    /** Arquivos removidos desde o último scan */
    removedFiles: string[];
    /** Total de arquivos rastreados */
    totalTracked: number;
    /** Timestamp do scan */
    scannedAt: Date;
}

// --- HELPER FUNCTIONS ---

/**
 * Garante que o diretório de tracking existe.
 */
function ensureTrackingDir(projectRoot: string): string {
    const trackingPath = path.join(projectRoot, PLAYGROUND_TRACKING_DIR);
    if (!fs.existsSync(trackingPath)) {
        fs.mkdirSync(trackingPath, { recursive: true });
    }
    return trackingPath;
}

/**
 * Retorna o caminho do arquivo de estado.
 */
function getTrackingFilePath(projectRoot: string): string {
    const trackingDir = ensureTrackingDir(projectRoot);
    return path.join(trackingDir, TRACKING_FILE);
}

/**
 * Carrega o estado de tracking do disco.
 */
function loadTrackingState(projectRoot: string): PlaygroundTrackingState {
    const trackingPath = getTrackingFilePath(projectRoot);
    try {
        const content = fs.readFileSync(trackingPath, "utf-8");
        const state = JSON.parse(content) as PlaygroundTrackingState;
        // Converte strings de data para objetos Date
        state.files.forEach((f) => {
            f.createdAt = new Date(f.createdAt);
            f.modifiedAt = new Date(f.modifiedAt);
        });
        state.lastScanAt = new Date(state.lastScanAt);
        return state;
    } catch (err) {
        // Arquivo não existe ou inválido: retorna estado inicial
        return {
            files: [],
            lastScanAt: new Date(0),
        };
    }
}

/**
 * Salva o estado de tracking no disco.
 */
function saveTrackingState(
    projectRoot: string,
    state: PlaygroundTrackingState
): void {
    const trackingPath = getTrackingFilePath(projectRoot);
    fs.writeFileSync(trackingPath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Retorna o caminho completo do diretório playground.
 */
function getPlaygroundPath(config: PlaygroundTrackerConfig): string {
    return path.join(config.projectRoot, config.playgroundDir);
}

/**
 * Extrai a extensão do arquivo.
 */
function getFileExtension(filePath: string): string {
    const ext = path.extname(filePath);
    return ext.slice(1); // Remove o ponto
}

/**
 * Infere o caminho de destino sugerido baseado no caminho do playground.
 */
function inferTargetPath(
    playgroundPath: string,
    config: PlaygroundTrackerConfig
): string {
    // Remove o prefixo do playground e adiciona o diretório target
    const relativePath = playgroundPath.replace(
        new RegExp(`^${config.playgroundDir}/?`),
        ""
    );
    return path.join(config.targetDir, relativePath);
}

/**
 * Determina se um arquivo deve ser ignorado pelo tracking.
 */
function shouldIgnoreFile(filePath: string): boolean {
    const ignoredPatterns = [
        /^\./, // Arquivos ocultos
        /node_modules/,
        /\.test\.(ts|js|tsx|jsx)$/, // Arquivos de teste
        /\.spec\.(ts|js|tsx|jsx)$/, // Arquivos de spec
        /\.md$/, // Arquivos markdown
        /\.json$/, // Arquivos de configuração
    ];

    return ignoredPatterns.some((pattern) => pattern.test(filePath));
}

/**
 * Escaneia o diretório playground recursivamente.
 */
function scanPlaygroundDirectory(
    playgroundPath: string,
    basePath: string = playgroundPath
): string[] {
    let files: string[] = [];

    if (!fs.existsSync(playgroundPath)) {
        return files;
    }

    const entries = fs.readdirSync(playgroundPath, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(playgroundPath, entry.name);

        if (entry.isDirectory()) {
            files = files.concat(scanPlaygroundDirectory(fullPath, basePath));
        } else if (entry.isFile()) {
            const relativePath = path.relative(basePath, fullPath);
            if (!shouldIgnoreFile(relativePath)) {
                files.push(relativePath);
            }
        }
    }

    return files;
}

/**
 * Obtém metadados do arquivo.
 */
function getFileMetadata(fullPath: string): { size: number; modifiedAt: Date } {
    const stats = fs.statSync(fullPath);
    return {
        size: stats.size,
        modifiedAt: stats.mtime,
    };
}

// --- MAIN CLASS ---

/**
 * Manager para rastreamento de arquivos no playground.
 */
export class PlaygroundTracker {
    private config: PlaygroundTrackerConfig;
    private state: PlaygroundTrackingState;

    constructor(config: Partial<PlaygroundTrackerConfig> = {}) {
        this.config = { ...DEFAULT_PLAYGROUND_TRACKER_CONFIG, ...config };
        this.state = loadTrackingState(this.config.projectRoot);
        this.log("info", "✅ PlaygroundTracker initialized");
    }

    /**
     * Escaneia o diretório playground em busca de novos arquivos.
     */
    async scan(): Promise<ScanResult> {
        const playgroundPath = getPlaygroundPath(this.config);
        const currentFiles = scanPlaygroundDirectory(playgroundPath);

        const result: ScanResult = {
            newFiles: [],
            modifiedFiles: [],
            removedFiles: [],
            totalTracked: this.state.files.length,
            scannedAt: new Date(),
        };

        // Mapa de arquivos existentes para comparação rápida
        const existingFilesMap = new Map<string, PlaygroundFile>();
        for (const file of this.state.files) {
            existingFilesMap.set(file.path, file);
        }

        // Verifica arquivos atuais
        for (const relativePath of currentFiles) {
            const fullPath = path.join(playgroundPath, relativePath);
            const metadata = getFileMetadata(fullPath);
            const existing = existingFilesMap.get(relativePath);

            if (!existing) {
                // Novo arquivo
                const newFile: PlaygroundFile = {
                    path: relativePath,
                    suggestedTarget: inferTargetPath(relativePath, this.config),
                    createdAt: metadata.modifiedAt,
                    modifiedAt: metadata.modifiedAt,
                    size: metadata.size,
                    status: PlaygroundFileStatus.NEW,
                    fileType: getFileExtension(relativePath),
                };

                this.state.files.push(newFile);
                result.newFiles.push(newFile);
                this.log("info", `🆕 New file: ${relativePath}`);
            } else {
                // Arquivo existente - verifica se foi modificado
                if (existing.modifiedAt < metadata.modifiedAt) {
                    existing.modifiedAt = metadata.modifiedAt;
                    existing.size = metadata.size;

                    if (
                        existing.status === PlaygroundFileStatus.NEW ||
                        existing.status === PlaygroundFileStatus.MODIFIED
                    ) {
                        existing.status = PlaygroundFileStatus.MODIFIED;
                        result.modifiedFiles.push(existing);
                        this.log("info", `📝 Modified file: ${relativePath}`);
                    }
                }

                existingFilesMap.delete(relativePath);
            }
        }

        // Arquivos que foram removidos
        for (const [removedPath] of existingFilesMap) {
            const index = this.state.files.findIndex((f) => f.path === removedPath);
            if (index !== -1) {
                this.state.files.splice(index, 1);
                result.removedFiles.push(removedPath);
                this.log("info", `🗑️ Removed file: ${removedPath}`);
            }
        }

        // Atualiza o estado
        this.state.lastScanAt = result.scannedAt;
        this.saveState();

        result.totalTracked = this.state.files.length;

        this.log(
            "info",
            `📊 Scan complete: ${result.newFiles.length} new, ${result.modifiedFiles.length} modified, ${result.removedFiles.length} removed`
        );

        return result;
    }

    /**
     * Registra um arquivo como candidato à promoção.
     */
    registerFile(filePath: string, taskId?: string): PlaygroundFile | null {
        const file = this.findFile(filePath);
        if (!file) {
            this.log("warn", `⚠️ File not found: ${filePath}`);
            return null;
        }

        file.status = PlaygroundFileStatus.REGISTERED;
        file.taskId = taskId;
        this.saveState();

        this.log("info", `📝 Registered file: ${filePath}`);
        return file;
    }

    /**
     * Atualiza o status de um arquivo.
     */
    updateFileStatus(
        filePath: string,
        status: PlaygroundFileStatus
    ): boolean {
        const file = this.findFile(filePath);
        if (!file) {
            this.log("warn", `⚠️ File not found: ${filePath}`);
            return false;
        }

        file.status = status;
        this.saveState();

        this.log("info", `🔄 Status updated: ${filePath} → ${status}`);
        return true;
    }

    /**
     * Marca um arquivo como ignorado (não candidato à promoção).
     */
    ignoreFile(filePath: string): boolean {
        return this.updateFileStatus(filePath, PlaygroundFileStatus.IGNORED);
    }

    /**
     * Remove um arquivo do tracking.
     */
    removeFile(filePath: string): boolean {
        const index = this.state.files.findIndex((f) => f.path === filePath);
        if (index === -1) {
            return false;
        }

        this.state.files.splice(index, 1);
        this.saveState();

        this.log("info", `🗑️ Removed from tracking: ${filePath}`);
        return true;
    }

    /**
     * Retorna todos os arquivos rastreados.
     */
    getAllFiles(): PlaygroundFile[] {
        return [...this.state.files];
    }

    /**
     * Retorna arquivos por status.
     */
    getFilesByStatus(status: PlaygroundFileStatus): PlaygroundFile[] {
        return this.state.files.filter((f) => f.status === status);
    }

    /**
     * Retorna arquivos por tipo.
     */
    getFilesByType(fileType: string): PlaygroundFile[] {
        return this.state.files.filter((f) => f.fileType === fileType);
    }

    /**
     * Retorna arquivos criados por uma task específica.
     */
    getFilesByTask(taskId: string): PlaygroundFile[] {
        return this.state.files.filter((f) => f.taskId === taskId);
    }

    /**
     * Retorna arquivos que são candidatos à promoção.
     */
    getCandidateFiles(): PlaygroundFile[] {
        return this.state.files.filter((f) => {
            return (
                f.status !== PlaygroundFileStatus.IGNORED &&
                f.status !== PlaygroundFileStatus.PROMOTED &&
                f.status !== PlaygroundFileStatus.REJECTED
            );
        });
    }

    /**
     * Retorna estatísticas do playground.
     */
    getStats(): {
        total: number;
        byStatus: Record<PlaygroundFileStatus, number>;
        byType: Record<string, number>;
        totalSize: number;
    } {
        const byStatus: Record<PlaygroundFileStatus, number> = {
            [PlaygroundFileStatus.NEW]: 0,
            [PlaygroundFileStatus.MODIFIED]: 0,
            [PlaygroundFileStatus.REGISTERED]: 0,
            [PlaygroundFileStatus.VALIDATING]: 0,
            [PlaygroundFileStatus.AWAITING_APPROVAL]: 0,
            [PlaygroundFileStatus.APPROVED]: 0,
            [PlaygroundFileStatus.PROMOTED]: 0,
            [PlaygroundFileStatus.REJECTED]: 0,
            [PlaygroundFileStatus.IGNORED]: 0,
        };

        const byType: Record<string, number> = {};
        let totalSize = 0;

        for (const file of this.state.files) {
            byStatus[file.status]++;
            byType[file.fileType] = (byType[file.fileType] || 0) + 1;
            totalSize += file.size;
        }

        return {
            total: this.state.files.length,
            byStatus,
            byType,
            totalSize,
        };
    }

    /**
     * Limpa arquivos promovidos ou rejeitos antigos.
     */
    cleanup(maxAge: number = 7 * 24 * 60 * 60 * 1000): number {
        const now = Date.now();
        const beforeCount = this.state.files.length;

        this.state.files = this.state.files.filter((file) => {
            if (
                file.status === PlaygroundFileStatus.PROMOTED ||
                file.status === PlaygroundFileStatus.REJECTED
            ) {
                const age = now - file.modifiedAt.getTime();
                return age < maxAge; // Remove apenas arquivos muito antigos
            }
            return true;
        });

        const removedCount = beforeCount - this.state.files.length;
        if (removedCount > 0) {
            this.saveState();
            this.log("info", `🧹 Cleaned up ${removedCount} old files`);
        }

        return removedCount;
    }

    // --- PRIVATE HELPERS ---

    /**
     * Encontra um arquivo por path.
     */
    private findFile(filePath: string): PlaygroundFile | undefined {
        return this.state.files.find((f) => f.path === filePath);
    }

    /**
     * Salva o estado no disco.
     */
    private saveState(): void {
        saveTrackingState(this.config.projectRoot, this.state);
    }

    /**
     * Log message se verbose mode enabled.
     */
    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        if (this.config.verbose) {
            const prefix = {
                debug: "🐛",
                info: "ℹ️",
                warn: "⚠️",
                error: "❌",
            }[level];
            console.log(`${prefix} [PlaygroundTracker] ${message}`);
        }
    }
}

// --- FACTORY FUNCTIONS ---

/**
 * Factory function para criar PlaygroundTracker.
 */
export function createPlaygroundTracker(
    config?: Partial<PlaygroundTrackerConfig>
): PlaygroundTracker {
    return new PlaygroundTracker(config);
}

/**
 * Factory function para criar PlaygroundTracker com configuração mínima.
 */
export function createMinimalPlaygroundTracker(
    projectRoot?: string
): PlaygroundTracker {
    return new PlaygroundTracker({
        projectRoot: projectRoot || process.cwd(),
        verbose: false,
    });
}
