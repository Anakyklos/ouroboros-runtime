/**
 * 📤 Promotion Manager
 *
 * Sistema de promoção de código (playground → src) com quality gates.
 * Parte do protocolo Anti-Vibe: garante qualidade antes de promoção.
 *
 * Fluxo:
 * 1. Arquivo é criado em playground/
 * 2. Candidato é registrado com validações obrigatórias
 * 3. Quality gates são executados (test, type-check, lint)
 * 4. Se aprovado, solicita aprovação humana
 * 5. Movido para src/ após aprovação
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
    PromotionStatus,
    QualityGateType,
    type PromotionCandidate,
    type PromotionConfig,
    type PromotionResult,
    type PromotionState,
    type ApprovalCallback,
    type PromotionValidation,
    DEFAULT_PROMOTION_CONFIG,
    QUALITY_GATE_COMMANDS,
} from "./promotion-types.js";
import type { ValidationResult, ValidationStrategy } from "./types.js";
import { CommandValidationStrategy } from "./strategies/CommandValidationStrategy.js";
import { EventBus } from "../daemon/event-bus.js";

const PROMOTION_STATE_DIR = ".agent/promotion";
const STATE_FILE = "promotion-state.json";

/**
 * Garante que o diretório de estado existe.
 */
function ensureStateDir(projectRoot: string): string {
    const statePath = path.join(projectRoot, PROMOTION_STATE_DIR);
    if (!fs.existsSync(statePath)) {
        fs.mkdirSync(statePath, { recursive: true });
    }
    return statePath;
}

/**
 * Retorna o caminho do arquivo de estado.
 */
function getStateFilePath(projectRoot: string): string {
    const stateDir = ensureStateDir(projectRoot);
    return path.join(stateDir, STATE_FILE);
}

/**
 * Carrega o estado de promoção do disco.
 */
function loadState(projectRoot: string): PromotionState {
    const statePath = getStateFilePath(projectRoot);
    try {
        const content = fs.readFileSync(statePath, "utf-8");
        return JSON.parse(content) as PromotionState;
    } catch (err) {
        // Arquivo não existe ou inválido: retorna estado inicial
        return {
            candidates: [],
            approvedPending: [],
            awaitingApproval: [],
        };
    }
}

/**
 * Salva o estado de promoção no disco.
 */
function saveState(projectRoot: string, state: PromotionState): void {
    const statePath = getStateFilePath(projectRoot);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Manager para promoção de código com quality gates.
 */
export class PromotionManager {
    private config: PromotionConfig;
    private state: PromotionState;
    private eventBus: EventBus;
    private approvalCallback?: ApprovalCallback;
    private validationStrategies: Map<QualityGateType, ValidationStrategy>;

    constructor(
        config: Partial<PromotionConfig> = {},
        eventBus?: EventBus,
        approvalCallback?: ApprovalCallback
    ) {
        this.config = { ...DEFAULT_PROMOTION_CONFIG, ...config };
        this.state = loadState(this.config.projectRoot);
        this.eventBus = eventBus || new EventBus();
        this.approvalCallback = approvalCallback;

        // Inicializa estratégias de validação padrão
        this.validationStrategies = new Map([
            [QualityGateType.TEST, new CommandValidationStrategy(QUALITY_GATE_COMMANDS[QualityGateType.TEST], 60000)],
            [QualityGateType.TYPE_CHECK, new CommandValidationStrategy(QUALITY_GATE_COMMANDS[QualityGateType.TYPE_CHECK], 30000)],
            [QualityGateType.LINT, new CommandValidationStrategy(QUALITY_GATE_COMMANDS[QualityGateType.LINT], 30000)],
            [QualityGateType.COVERAGE, new CommandValidationStrategy(QUALITY_GATE_COMMANDS[QualityGateType.COVERAGE], 90000)],
        ]);

        this.log('info', '✅ PromotionManager initialized');
    }

    /**
     * Registra um arquivo como candidato à promoção.
     */
    async registerCandidate(
        sourcePath: string,
        targetPath: string,
        taskId?: string
    ): Promise<PromotionCandidate> {
        const candidate: PromotionCandidate = {
            sourcePath,
            targetPath,
            status: PromotionStatus.PENDING,
            createdAt: new Date(),
            updatedAt: new Date(),
            taskId,
            validations: [],
        };

        this.state.candidates.push(candidate);
        this.saveState();

        this.log('info', `📝 Registered candidate: ${sourcePath} → ${targetPath}`);
        return candidate;
    }

    /**
     * Executa validações de qualidade para um candidato.
     */
    async validateCandidate(sourcePath: string): Promise<PromotionValidation[]> {
        const candidate = this.findCandidate(sourcePath);
        if (!candidate) {
            throw new Error(`Candidate not found: ${sourcePath}`);
        }

        candidate.status = PromotionStatus.VALIDATING;
        candidate.updatedAt = new Date();
        this.saveState();

        this.log('info', `🔍 Validating candidate: ${sourcePath}`);

        const validations: PromotionValidation[] = [];

        for (const gateType of this.config.requiredGates) {
            const strategy = this.validationStrategies.get(gateType);
            if (!strategy) {
                this.log('warn', `⚠️ No validation strategy for gate: ${gateType}`);
                continue;
            }

            this.log('info', `   Running gate: ${gateType}`);
            const result = await strategy.validate({
                workDir: this.config.projectRoot,
                taskId: candidate.taskId || sourcePath,
                output: "",
            });

            validations.push({
                type: gateType,
                result,
                timestamp: new Date(),
            });

            if (!result.isValid) {
                this.log('error', `   ❌ Gate ${gateType} failed: ${result.message}`);
                candidate.status = PromotionStatus.REJECTED;
                candidate.rejectionReason = `Quality gate ${gateType} failed: ${result.message}`;
                candidate.validations.push(...validations);
                this.saveState();
                return validations;
            }

            this.log('info', `   ✅ Gate ${gateType} passed`);
        }

        // Todas as validações passaram
        candidate.validations.push(...validations);
        candidate.status = PromotionStatus.AWAITING_APPROVAL;
        this.state.awaitingApproval.push(candidate);
        this.saveState();

        this.log('info', `✅ All validations passed for: ${sourcePath}`);
        return validations;
    }

    /**
     * Solicita aprovação humana para um candidato.
     */
    async requestApproval(sourcePath: string): Promise<boolean> {
        const candidate = this.findCandidate(sourcePath);
        if (!candidate) {
            throw new Error(`Candidate not found: ${sourcePath}`);
        }

        if (candidate.status !== PromotionStatus.AWAITING_APPROVAL) {
            throw new Error(
                `Candidate ${sourcePath} is not awaiting approval (status: ${candidate.status})`
            );
        }

        if (!this.config.requireApproval) {
            // Auto-aprova se não requer aprovação
            candidate.status = PromotionStatus.APPROVED;
            this.state.approvedPending.push(candidate);
            this.removeFromAwaiting(candidate);
            this.saveState();
            this.log('info', `✅ Auto-approved: ${sourcePath}`);
            return true;
        }

        if (!this.approvalCallback) {
            throw new Error("Approval required but no callback configured");
        }

        this.log('info', `🔒 Requesting approval for: ${sourcePath}`);
        const approved = await this.approvalCallback(candidate);

        if (approved) {
            candidate.status = PromotionStatus.APPROVED;
            this.state.approvedPending.push(candidate);
            this.removeFromAwaiting(candidate);
            this.saveState();
            this.log('info', `✅ Approved: ${sourcePath}`);
        } else {
            candidate.status = PromotionStatus.REJECTED;
            candidate.rejectionReason = "Rejected by human approval";
            this.removeFromAwaiting(candidate);
            this.saveState();
            this.log('warn', `⛔ Rejected by human: ${sourcePath}`);
        }

        return approved;
    }

    /**
     * Promove um arquivo aprovado de playground para src.
     */
    async promote(sourcePath: string): Promise<PromotionResult> {
        const candidate = this.findCandidate(sourcePath);
        if (!candidate) {
            return {
                success: false,
                candidate: {} as PromotionCandidate,
                error: `Candidate not found: ${sourcePath}`,
                timestamp: new Date(),
            };
        }

        if (candidate.status !== PromotionStatus.APPROVED) {
            return {
                success: false,
                candidate,
                error: `Candidate not approved (status: ${candidate.status})`,
                timestamp: new Date(),
            };
        }

        try {
            const sourceFullPath = path.join(
                this.config.projectRoot,
                this.config.sourceDir,
                candidate.sourcePath
            );
            const targetFullPath = path.join(
                this.config.projectRoot,
                this.config.targetDir,
                candidate.targetPath
            );

            // Garante que o diretório de destino existe
            const targetDir = path.dirname(targetFullPath);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            // Copia o arquivo
            fs.copyFileSync(sourceFullPath, targetFullPath);

            // Atualiza o estado
            candidate.status = PromotionStatus.PROMOTED;
            candidate.updatedAt = new Date();
            this.removeFromApprovedPending(candidate);
            this.saveState();

            this.log('info', `📤 Promoted: ${candidate.sourcePath} → ${candidate.targetPath}`);

            return {
                success: true,
                candidate,
                timestamp: new Date(),
            };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            candidate.status = PromotionStatus.FAILED;
            candidate.rejectionReason = error;
            this.saveState();

            this.log('error', `❌ Promotion failed for ${sourcePath}: ${error}`);

            return {
                success: false,
                candidate,
                error,
                timestamp: new Date(),
            };
        }
    }

    /**
     * Executa a promoção de todos os arquivos aprovados pendentes.
     * Este é o executor principal que move todos os arquivos validados
     * de playground para src em lote.
     */
    async executePromotions(): Promise<{
        success: number;
        failed: number;
        results: PromotionResult[];
    }> {
        const approved = [...this.state.approvedPending];
        this.log('info', `🚀 Executing promotions for ${approved.length} approved files`);

        const results: PromotionResult[] = [];
        let successCount = 0;
        let failedCount = 0;

        for (const candidate of approved) {
            this.log('info', `   Processing: ${candidate.sourcePath}`);
            const result = await this.promote(candidate.sourcePath);

            results.push(result);

            if (result.success) {
                successCount++;
            } else {
                failedCount++;
            }
        }

        this.log('info', `✅ Execution complete: ${successCount} succeeded, ${failedCount} failed`);

        return {
            success: successCount,
            failed: failedCount,
            results,
        };
    }

    /**
     * Faz rollback de um arquivo promovido (move de volta para playground).
     */
    async rollbackPromotion(sourcePath: string): Promise<PromotionResult> {
        const candidate = this.findCandidate(sourcePath);
        if (!candidate) {
            return {
                success: false,
                candidate: {} as PromotionCandidate,
                error: `Candidate not found: ${sourcePath}`,
                timestamp: new Date(),
            };
        }

        if (candidate.status !== PromotionStatus.PROMOTED) {
            return {
                success: false,
                candidate,
                error: `Cannot rollback: file is not promoted (status: ${candidate.status})`,
                timestamp: new Date(),
            };
        }

        try {
            const sourceFullPath = path.join(
                this.config.projectRoot,
                this.config.targetDir,
                candidate.targetPath
            );
            const playgroundFullPath = path.join(
                this.config.projectRoot,
                this.config.sourceDir,
                candidate.sourcePath
            );

            // Verifica se o arquivo promovido existe
            if (!fs.existsSync(sourceFullPath)) {
                throw new Error(`Promoted file not found: ${sourceFullPath}`);
            }

            // Move de volta para o playground
            fs.copyFileSync(sourceFullPath, playgroundFullPath);
            fs.unlinkSync(sourceFullPath);

            // Atualiza o estado
            candidate.status = PromotionStatus.APPROVED;
            candidate.updatedAt = new Date();
            this.state.approvedPending.push(candidate);
            this.saveState();

            this.log('info', `↩️ Rolled back: ${candidate.targetPath} → ${candidate.sourcePath}`);

            return {
                success: true,
                candidate,
                timestamp: new Date(),
            };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            this.log('error', `❌ Rollback failed for ${sourcePath}: ${error}`);

            return {
                success: false,
                candidate,
                error,
                timestamp: new Date(),
            };
        }
    }

    /**
     * Remove arquivos do playground após promoção bem-sucedida.
     */
    cleanupPromotedFiles(sourcePath?: string): number {
        let cleaned = 0;

        const candidatesToClean = sourcePath
            ? this.state.candidates.filter(c => c.sourcePath === sourcePath)
            : this.state.candidates.filter(c => c.status === PromotionStatus.PROMOTED);

        for (const candidate of candidatesToClean) {
            const sourceFullPath = path.join(
                this.config.projectRoot,
                this.config.sourceDir,
                candidate.sourcePath
            );

            try {
                if (fs.existsSync(sourceFullPath)) {
                    fs.unlinkSync(sourceFullPath);
                    cleaned++;
                    this.log('info', `🧹 Cleaned up: ${candidate.sourcePath}`);
                }
            } catch (err) {
                this.log('warn', `⚠️ Failed to cleanup ${candidate.sourcePath}: ${err}`);
            }
        }

        return cleaned;
    }

    /**
     * Retorna o estado atual do sistema de promoção.
     */
    getState(): PromotionState {
        return { ...this.state };
    }

    /**
     * Remove um candidato da lista (usado para limpeza).
     */
    removeCandidate(sourcePath: string): boolean {
        const index = this.state.candidates.findIndex(
            (c) => c.sourcePath === sourcePath
        );
        if (index === -1) {
            return false;
        }

        this.state.candidates.splice(index, 1);
        this.removeFromAwaiting(this.state.candidates[index]);
        this.removeFromApprovedPending(this.state.candidates[index]);
        this.saveState();

        this.log('info', `🗑️ Removed candidate: ${sourcePath}`);
        return true;
    }

    /**
     * Configura uma estratégia de validação customizada.
     */
    setValidationStrategy(
        gateType: QualityGateType,
        strategy: ValidationStrategy
    ): void {
        this.validationStrategies.set(gateType, strategy);
        this.log('info', `🔧 Set validation strategy for ${gateType}`);
    }

    // --- PRIVATE HELPERS ---

    /**
     * Encontra um candidato por sourcePath.
     */
    private findCandidate(sourcePath: string): PromotionCandidate | undefined {
        return this.state.candidates.find((c) => c.sourcePath === sourcePath);
    }

    /**
     * Remove um candidato da lista de awaitingApproval.
     */
    private removeFromAwaiting(candidate: PromotionCandidate): void {
        const index = this.state.awaitingApproval.findIndex(
            (c) => c.sourcePath === candidate.sourcePath
        );
        if (index !== -1) {
            this.state.awaitingApproval.splice(index, 1);
        }
    }

    /**
     * Remove um candidato da lista de approvedPending.
     */
    private removeFromApprovedPending(candidate: PromotionCandidate): void {
        const index = this.state.approvedPending.findIndex(
            (c) => c.sourcePath === candidate.sourcePath
        );
        if (index !== -1) {
            this.state.approvedPending.splice(index, 1);
        }
    }

    /**
     * Salva o estado no disco.
     */
    private saveState(): void {
        saveState(this.config.projectRoot, this.state);
    }

    /**
     * Log message se verbose mode enabled.
     */
    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        if (this.config.verbose) {
            this.eventBus.log(level, message, 'PromotionManager');
        }
    }
}

/**
 * Factory function para criar PromotionManager.
 */
export function createPromotionManager(
    config?: Partial<PromotionConfig>,
    eventBus?: EventBus,
    approvalCallback?: ApprovalCallback
): PromotionManager {
    return new PromotionManager(config, eventBus, approvalCallback);
}
