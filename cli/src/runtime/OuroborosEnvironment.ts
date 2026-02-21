/**
 * 🐍 OuroborosEnvironment
 *
 * Configuração do ambiente isolado Ouroboros para execução segura de código.
 * Gerencia caminhos do venv, playground e executáveis Python.
 *
 * @module runtime/OuroborosEnvironment
 */

import { PathLike } from "fs";
import { resolve, join } from "path";

// ============================================================================
// Types
// ============================================================================

export interface OuroborosEnvironmentConfig {
    /** Diretório raiz do projeto (default: cwd) */
    projectRoot?: string;
    /** Nome do diretório .ouroboros (default: .ouroboros) */
    ouroborosDirName?: string;
    /** Nome do diretório do venv (default: venv) */
    venvDirName?: string;
    /** Nome do diretório do playground (default: playground) */
    playgroundDirName?: string;
}

export interface EnvironmentPaths {
    projectRoot: string;
    ouroborosDir: string;
    venvDir: string;
    playgroundDir: string;
    pythonExecutable: string;
    pipExecutable: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: Required<OuroborosEnvironmentConfig> = {
    projectRoot: process.cwd(),
    ouroborosDirName: '.ouroboros',
    venvDirName: 'venv',
    playgroundDirName: 'playground',
};

// ============================================================================
// OuroborosEnvironment
// ============================================================================

export class OuroborosEnvironment {
    private config: Required<OuroborosEnvironmentConfig>;
    private _paths: EnvironmentPaths | null = null;

    constructor(config: OuroborosEnvironmentConfig = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /**
     * Inicializa o ambiente, criando diretórios necessários
     */
    async initialize(): Promise<void> {
        const paths = this.paths;

        // Criar diretório .ouroboros se não existir
        await this.ensureDirectory(paths.ouroborosDir);

        // Criar diretório playground se não existir
        await this.ensureDirectory(paths.playgroundDir);
    }

    /**
     * Verifica se o venv existe e é válido
     */
    async validate(): Promise<boolean> {
        const paths = this.paths;

        try {
            // Verificar se o venv existe
            const fs = await import('fs/promises');
            await fs.access(paths.pythonExecutable);

            // Verificar se o playground existe
            await fs.access(paths.playgroundDir);

            return true;
        } catch {
            return false;
        }
    }

    // ========================================================================
    // Properties
    // ========================================================================

    /**
     * Retorna todos os caminhos do ambiente
     */
    get paths(): EnvironmentPaths {
        if (this._paths) {
            return this._paths;
        }

        const { projectRoot, ouroborosDirName, venvDirName, playgroundDirName } = this.config;

        const ouroborosDir = resolve(projectRoot, ouroborosDirName);
        const venvDir = join(ouroborosDir, venvDirName);
        const playgroundDir = join(ouroborosDir, playgroundDirName);

        // Determinar caminho do executável Python baseado no OS
        const scriptsDir = process.platform === 'win32' ? 'Scripts' : 'bin';
        const pythonBin = process.platform === 'win32' ? 'python.exe' : 'python';
        const pipBin = process.platform === 'win32' ? 'pip.exe' : 'pip';

        const pythonExecutable = join(venvDir, scriptsDir, pythonBin);
        const pipExecutable = join(venvDir, scriptsDir, pipBin);

        this._paths = {
            projectRoot: resolve(projectRoot),
            ouroborosDir,
            venvDir,
            playgroundDir,
            pythonExecutable,
            pipExecutable,
        };

        return this._paths;
    }

    /**
     * Caminho do interpretador Python do venv
     */
    get pythonPath(): string {
        return this.paths.pythonExecutable;
    }

    /**
     * Caminho do executável pip do venv
     */
    get pipPath(): string {
        return this.paths.pipExecutable;
    }

    /**
     * Caminho do diretório playground
     */
    get playgroundPath(): string {
        return this.paths.playgroundDir;
    }

    /**
     * Caminho do diretório venv
     */
    get venvPath(): string {
        return this.paths.venvDir;
    }

    // ========================================================================
    // Utilities
    // ========================================================================

    /**
     * Resolve um caminho relativo ao playground
     */
    resolveInPlayground(...pathSegments: string[]): string {
        return resolve(this.playgroundPath, ...pathSegments);
    }

    /**
     * Verifica se um caminho está dentro do playground
     */
    isPathInPlayground(filePath: string): boolean {
        const resolvedPath = resolve(filePath);
        const resolvedPlayground = resolve(this.playgroundPath);
        return resolvedPath.startsWith(resolvedPlayground);
    }

    /**
     * Verifica se um caminho está dentro do .ouroboros
     */
    isPathInOuroboros(filePath: string): boolean {
        const resolvedPath = resolve(filePath);
        const resolvedOuroboros = resolve(this.paths.ouroborosDir);
        return resolvedPath.startsWith(resolvedOuroboros);
    }

    /**
     * Retorna o caminho relativo de um arquivo em relação ao playground
     */
    getRelativePathInPlayground(filePath: string): string | null {
        const resolvedPath = resolve(filePath);
        const resolvedPlayground = resolve(this.playgroundPath);

        if (!resolvedPath.startsWith(resolvedPlayground)) {
            return null;
        }

        return resolvedPath.slice(resolvedPlayground.length + 1);
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    /**
     * Garante que um diretório existe, criando se necessário
     */
    private async ensureDirectory(dirPath: string): Promise<void> {
        try {
            const fs = await import('fs/promises');
            await fs.mkdir(dirPath, { recursive: true });
        } catch (error) {
            // Ignorar erro se diretório já existe
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }
    }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Cria uma instância de OuroborosEnvironment com configuração padrão
 */
export function createOuroborosEnvironment(
    config?: OuroborosEnvironmentConfig
): OuroborosEnvironment {
    return new OuroborosEnvironment(config);
}

export default OuroborosEnvironment;
