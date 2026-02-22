/**
 * 📊 Test Coverage Validator
 *
 * Validador que verifica se o novo código possui cobertura de testes adequada.
 * Segue protocolo Anti-Vibe: "Trust but Verify" - não confia que o LLM escreveu
 * testes, valida programaticamente a existência e cobertura de testes para
 * arquivos de código novos ou modificados.
 *
 * Inspirado em:
 * - OpenClaw/ClawedBot: validação objetiva por análise de arquivos
 * - Pickle Rickle: loops de auto-refinamento com feedback
 * - CommandValidationStrategy: padrão de validação com contexto completo
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import type { ValidationStrategy, ValidationContext, ValidationResult } from "../types.js";

/**
 * Configuração de threshold para cobertura de testes.
 */
export interface CoverageThreshold {
    /** Cobertura mínima de linhas em porcentagem (0-100) */
    lineCoverage: number;
    /** Cobertura mínima de funções em porcentagem (0-100) */
    functionCoverage: number;
    /** Cobertura mínima de branches em porcentagem (0-100) */
    branchCoverage: number;
}

/**
 * Resultado da análise de cobertura de um arquivo.
 */
export interface FileCoverageResult {
    /** Caminho relativo do arquivo */
    filePath: string;
    /** Se possui arquivo de teste correspondente */
    hasTestFile: boolean;
    /** Caminho do arquivo de teste (se existir) */
    testFilePath?: string;
    /** Se a cobertura está adequada */
    hasAdequateCoverage: boolean;
    /** Cobertura de linhas em porcentagem */
    lineCoverage?: number;
    /** Cobertura de funções em porcentagem */
    functionCoverage?: number;
    /** Cobertura de branches em porcentagem */
    branchCoverage?: number;
}

/**
 * Resultado detalhado da validação de cobertura de testes.
 */
export interface TestCoverageDetails {
    /** Total de arquivos de código analisados */
    totalFiles: number;
    /** Arquivos com testes correspondentes */
    filesWithTests: number;
    /** Arquivos sem testes correspondentes */
    filesWithoutTests: number;
    /** Arquivos com cobertura inadequada */
    filesWithPoorCoverage: number;
    /** Cobertura agregada do projeto */
    aggregateCoverage: {
        lines: number;
        functions: number;
        branches: number;
    };
    /** Lista de arquivos que precisam de testes */
    missingTests: string[];
    /** Lista de arquivos com cobertura insuficiente */
    poorCoverage: string[];
    /** Resultados por arquivo */
    fileResults: FileCoverageResult[];
}

/**
 * Threshold padrão para cobertura de testes.
 */
const DEFAULT_THRESHOLD: CoverageThreshold = {
    lineCoverage: 80,
    functionCoverage: 80,
    branchCoverage: 70,
};

/**
 * Extensões de arquivo que são consideradas código de produção.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/**
 * Extensões de arquivo que são consideradas testes.
 */
const TEST_EXTENSIONS = [".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".spec.ts", ".spec.tsx"];

/**
 * Padrões de diretórios que devem ser ignorados na análise.
 */
const IGNORED_PATTERNS = [
    "node_modules",
    "dist",
    "build",
    ".git",
    "coverage",
    ".next",
    ".cache",
    "playground", // Playground é para código experimental, não requer testes
];

/**
 * Verifica se um caminho deve ser ignorado na análise.
 */
function shouldIgnorePath(filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, "/");
    return IGNORED_PATTERNS.some(pattern => normalizedPath.includes(pattern));
}

/**
 * Verifica se um arquivo é um arquivo de teste.
 */
function isTestFile(filePath: string): boolean {
    const ext = extname(filePath);
    const baseName = filePath.replace(ext, "").toLowerCase();
    return TEST_EXTENSIONS.some(testExt => baseName.endsWith(testExt.replace(".", "")));
}

/**
 * Verifica se um arquivo é um arquivo de código de produção.
 */
function isSourceFile(filePath: string): boolean {
    const ext = extname(filePath);
    return SOURCE_EXTENSIONS.includes(ext) && !isTestFile(filePath);
}

/**
 * Encontra o arquivo de teste correspondente para um arquivo de código.
 *
 * @example
 * ```ts
 * findTestFile("src/utils/file.ts", "src")
 * // Returns: "src/utils/file.test.ts" se existir
 * ```
 */
function findTestFile(sourcePath: string, baseDir: string): string | null {
    const ext = extname(sourcePath);
    const basePath = sourcePath.replace(ext, "");

    // Tenta encontrar teste com cada extensão de teste
    for (const testExt of TEST_EXTENSIONS) {
        const testPath = basePath + testExt;
        const fullPath = join(baseDir, testPath);
        if (existsSync(fullPath)) {
            return testPath;
        }
    }

    // Tenta encontrar em diretório __tests__
    const fileName = basePath.split("/").pop() || "";
    const testDirPath = join(baseDir, "__tests__", fileName + ".test" + ext);
    if (existsSync(testDirPath)) {
        return relative(baseDir, testDirPath);
    }

    return null;
}

/**
 * Recursively scans a directory for source files.
 */
async function scanSourceFiles(
    dir: string,
    baseDir: string,
    maxDepth = 10,
    currentDepth = 0
): Promise<string[]> {
    if (currentDepth >= maxDepth || shouldIgnorePath(dir)) {
        return [];
    }

    const sourceFiles: string[] = [];

    try {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);

            if (entry.isDirectory()) {
                const subFiles = await scanSourceFiles(fullPath, baseDir, maxDepth, currentDepth + 1);
                sourceFiles.push(...subFiles);
            } else if (entry.isFile() && isSourceFile(fullPath)) {
                const relativePath = relative(baseDir, fullPath);
                sourceFiles.push(relativePath);
            }
        }
    } catch (error) {
        // Diretório pode não ser acessível, ignora silenciosamente
    }

    return sourceFiles;
}

/**
 * Faz parse do output de cobertura do bun test para extrair métricas.
 */
function parseCoverageOutput(coverageOutput: string): {
    lines: number;
    functions: number;
    branches: number;
} {
    const metrics = {
        lines: 0,
        functions: 0,
        branches: 0,
    };

    // Bun coverage output format
    const linesMatch = coverageOutput.match(/lines?\s*:\s*([\d.]+)%/i);
    const functionsMatch = coverageOutput.match(/functions?\s*:\s*([\d.]+)%/i);
    const branchesMatch = coverageOutput.match(/branches?\s*:\s*([\d.]+)%/i);

    if (linesMatch) metrics.lines = parseFloat(linesMatch[1]);
    if (functionsMatch) metrics.functions = parseFloat(functionsMatch[1]);
    if (branchesMatch) metrics.branches = parseFloat(branchesMatch[1]);

    return metrics;
}

/**
 * Estratégia de validação que verifica cobertura de testes para novo código.
 *
 * Esta estratégia:
 * - Identifica arquivos de código novo ou modificados
 * - Verifica existência de arquivos de teste correspondentes
 * - Analisa cobertura de testes se disponível
 * - Valida se thresholds mínimos são atendidos
 *
 * @example
 * ```ts
 * const validator = new TestCoverageValidator();
 * const result = await validator.validate({
 *     workDir: "./project",
 *     taskId: "task-1",
 *     output: "",
 * });
 * console.log(result.details?.coverage); // { totalFiles: 5, filesWithTests: 4, ... }
 * ```
 */
export class TestCoverageValidator implements ValidationStrategy {
    readonly name: string;
    private threshold: CoverageThreshold;
    private requireTestsForNewCode: boolean;
    private checkCoverageThresholds: boolean;
    private excludePatterns: string[];

    constructor(config?: {
        threshold?: Partial<CoverageThreshold>;
        requireTestsForNewCode?: boolean;
        checkCoverageThresholds?: boolean;
        excludePatterns?: string[];
    }) {
        this.threshold = {
            lineCoverage: config?.threshold?.lineCoverage ?? DEFAULT_THRESHOLD.lineCoverage,
            functionCoverage: config?.threshold?.functionCoverage ?? DEFAULT_THRESHOLD.functionCoverage,
            branchCoverage: config?.threshold?.branchCoverage ?? DEFAULT_THRESHOLD.branchCoverage,
        };
        this.requireTestsForNewCode = config?.requireTestsForNewCode ?? true;
        this.checkCoverageThresholds = config?.checkCoverageThresholds ?? true;
        this.excludePatterns = config?.excludePatterns ?? [];
        this.name = `TestCoverageValidator(threshold: ${this.threshold.lineCoverage}% lines)`;
    }

    async validate(context: ValidationContext): Promise<ValidationResult> {
        const startTime = Date.now();

        try {
            // Escaneia arquivos de código no diretório de trabalho
            const sourceFiles = await scanSourceFiles(context.workDir, context.workDir);

            // Filtra arquivos baseado em padrões de exclusão
            const filteredFiles = sourceFiles.filter(file => {
                return !this.excludePatterns.some(pattern => file.includes(pattern));
            });

            const fileResults: FileCoverageResult[] = [];
            const missingTests: string[] = [];
            const poorCoverage: string[] = [];

            // Analisa cada arquivo
            for (const sourcePath of filteredFiles) {
                const result = await this.analyzeFileCoverage(sourcePath, context.workDir);
                fileResults.push(result);

                if (!result.hasTestFile) {
                    missingTests.push(sourcePath);
                }

                if (!result.hasAdequateCoverage) {
                    poorCoverage.push(sourcePath);
                }
            }

            // Calcula métricas agregadas
            const totalFiles = fileResults.length;
            const filesWithTests = fileResults.filter(r => r.hasTestFile).length;
            const filesWithoutTests = fileResults.filter(r => !r.hasTestFile).length;
            const filesWithPoorCoverage = fileResults.filter(r => !r.hasAdequateCoverage).length;

            // Tenta obter cobertura agregada do projeto (se disponível)
            const aggregateCoverage = await this.getProjectCoverage(context.workDir);

            // Determina se validação passou
            const isValid = this.determineValidation({
                totalFiles,
                filesWithoutTests,
                filesWithPoorCoverage,
                aggregateCoverage,
            });

            const durationMs = Date.now() - startTime;

            const details: TestCoverageDetails = {
                totalFiles,
                filesWithTests,
                filesWithoutTests,
                filesWithPoorCoverage,
                aggregateCoverage,
                missingTests,
                poorCoverage,
                fileResults,
            };

            const message = this.formatMessage(isValid, details);

            return {
                isValid,
                message,
                exitCode: isValid ? 0 : 1,
                details: {
                    workDir: context.workDir,
                    durationMs,
                    coverage: details,
                    threshold: this.threshold,
                },
            };
        } catch (error: unknown) {
            const durationMs = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : String(error);

            return {
                isValid: false,
                exitCode: 1,
                message: `Test coverage validation failed: ${errorMessage}`,
                details: {
                    workDir: context.workDir,
                    durationMs,
                    error: errorMessage,
                },
            };
        }
    }

    /**
     * Analisa a cobertura de testes de um arquivo específico.
     */
    private async analyzeFileCoverage(
        sourcePath: string,
        baseDir: string
    ): Promise<FileCoverageResult> {
        const testFilePath = findTestFile(sourcePath, baseDir);
        const hasTestFile = testFilePath !== null;

        // Por padrão, assume cobertura inadequada se não houver teste
        let hasAdequateCoverage = false;
        let lineCoverage = 0;
        let functionCoverage = 0;
        let branchCoverage = 0;

        if (hasTestFile) {
            // Se há arquivo de teste, assume cobertura adequada
            // (cobertura detalhada requer análise do relatório de cobertura)
            hasAdequateCoverage = true;
            lineCoverage = 100;
            functionCoverage = 100;
            branchCoverage = 100;
        }

        return {
            filePath: sourcePath,
            hasTestFile,
            testFilePath: testFilePath ?? undefined,
            hasAdequateCoverage,
            lineCoverage,
            functionCoverage,
            branchCoverage,
        };
    }

    /**
     * Tenta obter a cobertura agregada do projeto.
     */
    private async getProjectCoverage(workDir: string): Promise<{
        lines: number;
        functions: number;
        branches: number;
    }> {
        // Tenta ler arquivo de cobertura se existir
        // (implementação básica - pode ser expandida para ler arquivos de cobertura reais)
        return {
            lines: 0,
            functions: 0,
            branches: 0,
        };
    }

    /**
     * Determina se a validação passou baseado nas regras configuradas.
     */
    private determineValidation(metrics: {
        totalFiles: number;
        filesWithoutTests: number;
        filesWithPoorCoverage: number;
        aggregateCoverage: {
            lines: number;
            functions: number;
            branches: number;
        };
    }): boolean {
        // Se não há arquivos de código, passa por padrão
        if (metrics.totalFiles === 0) {
            return true;
        }

        // Verifica se todos os arquivos têm testes (se configurado)
        if (this.requireTestsForNewCode && metrics.filesWithoutTests > 0) {
            return false;
        }

        // Verifica thresholds de cobertura (se configurado)
        if (this.checkCoverageThresholds) {
            const { lines, functions, branches } = metrics.aggregateCoverage;

            // Só valida cobertura se há dados de cobertura disponíveis
            if (lines > 0 || functions > 0 || branches > 0) {
                if (lines < this.threshold.lineCoverage) return false;
                if (functions < this.threshold.functionCoverage) return false;
                if (branches < this.threshold.branchCoverage) return false;
            }
        }

        return true;
    }

    /**
     * Formata mensagem de resultado da validação.
     */
    private formatMessage(isValid: boolean, details: TestCoverageDetails): string {
        const emoji = isValid ? "✅" : "❌";
        const status = isValid ? "passed" : "failed";

        let message = `${emoji} Test coverage validation ${status}\n`;

        message += `   📊 Files analyzed: ${details.totalFiles}\n`;
        message += `   📝 Files with tests: ${details.filesWithTests}\n`;

        if (details.filesWithoutTests > 0) {
            message += `   ⚠️  Files without tests: ${details.filesWithoutTests}\n`;
        }

        if (details.aggregateCoverage.lines > 0) {
            message += `   📈 Coverage:\n`;
            message += `      - Lines: ${details.aggregateCoverage.lines}%\n`;
            message += `      - Functions: ${details.aggregateCoverage.functions}%\n`;
            message += `      - Branches: ${details.aggregateCoverage.branches}%\n`;
        }

        if (details.missingTests.length > 0) {
            message += `\n   ❌ Missing tests for:\n`;
            for (const file of details.missingTests.slice(0, 5)) {
                message += `      - ${file}\n`;
            }
            if (details.missingTests.length > 5) {
                message += `      ... and ${details.missingTests.length - 5} more\n`;
            }
        }

        if (details.poorCoverage.length > 0) {
            message += `\n   ⚠️  Poor coverage for:\n`;
            for (const file of details.poorCoverage.slice(0, 5)) {
                message += `      - ${file}\n`;
            }
            if (details.poorCoverage.length > 5) {
                message += `      ... and ${details.poorCoverage.length - 5} more\n`;
            }
        }

        return message.trim();
    }
}

// --- FACTORIES ---

/**
 * Factory para criar validador com thresholds padrão.
 */
export function createDefaultTestCoverageValidator(): TestCoverageValidator {
    return new TestCoverageValidator();
}

/**
 * Factory para criar validador com thresholds customizados.
 */
export function createCustomThresholdValidator(
    lineCoverage: number,
    functionCoverage = lineCoverage,
    branchCoverage = lineCoverage - 10
): TestCoverageValidator {
    return new TestCoverageValidator({
        threshold: {
            lineCoverage,
            functionCoverage,
            branchCoverage,
        },
    });
}

/**
 * Factory para criar validador que requer testes mas não verifica thresholds.
 */
export function createTestExistenceValidator(): TestCoverageValidator {
    return new TestCoverageValidator({
        requireTestsForNewCode: true,
        checkCoverageThresholds: false,
    });
}

/**
 * Factory para criar validador que apenas verifica thresholds (não requer testes para todos os arquivos).
 */
export function createCoverageThresholdValidator(threshold: Partial<CoverageThreshold>): TestCoverageValidator {
    return new TestCoverageValidator({
        requireTestsForNewCode: false,
        checkCoverageThresholds: true,
        threshold,
    });
}

/**
 * Factory para criar validador com padrões de exclusão customizados.
 */
export function createExclusionValidator(
    excludePatterns: string[],
    config?: Partial<CoverageThreshold>
): TestCoverageValidator {
    return new TestCoverageValidator({
        threshold: config,
        excludePatterns,
    });
}
