/**
 * 📤 Promotion Types
 *
 * Tipos para o sistema de promoção de código (playground → src).
 * Parte do protocolo Anti-Vibe: qualidade antes de promoção.
 */

import type { ValidationResult } from "./types.js";

// --- ENUMS ---

/**
 * Status de uma promoção de arquivo.
 */
export enum PromotionStatus {
    /** Arquivo candidato à promoção */
    PENDING = "PENDING",
    /** Validações em andamento */
    VALIDATING = "VALIDATING",
    /** Aguardando aprovação humana */
    AWAITING_APPROVAL = "AWAITING_APPROVAL",
    /** Aprovado e pronto para mover */
    APPROVED = "APPROVED",
    /** Rejeitado pelo humano ou validações */
    REJECTED = "REJECTED",
    /** Movido com sucesso para src */
    PROMOTED = "PROMOTED",
    /** Promoção falhou */
    FAILED = "FAILED",
}

/**
 * Tipos de validações de qualidade.
 */
export enum QualityGateType {
    /** Executar testes */
    TEST = "TEST",
    /** Verificação de tipos */
    TYPE_CHECK = "TYPE_CHECK",
    /** Linting */
    LINT = "LINT",
    /** Cobertura de testes */
    COVERAGE = "COVERAGE",
    /** Review por segundo modelo LLM */
    MULTI_MODEL_REVIEW = "MULTI_MODEL_REVIEW",
    /** Validação customizada */
    CUSTOM = "CUSTOM",
}

// --- INTERFACES ---

/**
 * Arquivo candidato à promoção.
 */
export interface PromotionCandidate {
    /** Caminho relativo do arquivo (de: playground/...) */
    sourcePath: string;
    /** Caminho de destino (para: src/...) */
    targetPath: string;
    /** Status atual da promoção */
    status: PromotionStatus;
    /** Timestamp de criação da candidatura */
    createdAt: Date;
    /** Timestamp da última atualização */
    updatedAt: Date;
    /** ID da task que gerou este arquivo */
    taskId?: string;
    /** Lista de validações executadas */
    validations: PromotionValidation[];
    /** Razão da rejeição (se aplicável) */
    rejectionReason?: string;
}

/**
 * Resultado de uma validação de qualidade.
 */
export interface PromotionValidation {
    /** Tipo da validação */
    type: QualityGateType;
    /** Resultado da validação */
    result: ValidationResult;
    /** Timestamp da execução */
    timestamp: Date;
}

/**
 * Configuração para uma promoção.
 */
export interface PromotionConfig {
    /** Diretório raiz do projeto */
    projectRoot: string;
    /** Diretório source (padrão: playground) */
    sourceDir: string;
    /** Diretório destino (padrão: src) */
    targetDir: string;
    /** Requer aprovação humana antes de mover */
    requireApproval: boolean;
    /** Validações obrigatórias antes da promoção */
    requiredGates: QualityGateType[];
    /** Habilita logs detalhados */
    verbose: boolean;
}

/**
 * Resultado de uma operação de promoção.
 */
export interface PromotionResult {
    /** Se a operação foi bem-sucedida */
    success: boolean;
    /** Arquivo que foi promovido */
    candidate: PromotionCandidate;
    /** Mensagem de erro (se falhou) */
    error?: string;
    /** Timestamp da operação */
    timestamp: Date;
}

/**
 * Estado atual do sistema de promoção.
 */
export interface PromotionState {
    /** Todos os arquivos candidatos */
    candidates: PromotionCandidate[];
    /** Arquivos aprovados pendentes de movimento */
    approvedPending: PromotionCandidate[];
    /** Arquivos aguardando aprovação humana */
    awaitingApproval: PromotionCandidate[];
}

/**
 * Callback para solicitação de aprovação humana.
 */
export type ApprovalCallback = (
    candidate: PromotionCandidate
) => Promise<boolean>;

/**
 * Configuração padrão para o PromotionManager.
 */
export const DEFAULT_PROMOTION_CONFIG: PromotionConfig = {
    projectRoot: process.cwd(),
    sourceDir: "playground",
    targetDir: "src",
    requireApproval: true,
    requiredGates: [
        QualityGateType.TEST,
        QualityGateType.TYPE_CHECK,
    ],
    verbose: true,
};

/**
 * Mapeamento de QualityGateType para comandos shell padrão.
 */
export const QUALITY_GATE_COMMANDS: Record<QualityGateType, string> = {
    [QualityGateType.TEST]: "bun test",
    [QualityGateType.TYPE_CHECK]: "bun run typecheck",
    [QualityGateType.LINT]: "bun run lint",
    [QualityGateType.COVERAGE]: "bun test --coverage",
    [QualityGateType.MULTI_MODEL_REVIEW]: "", // LLM-based, no shell command
    [QualityGateType.CUSTOM]: "",
};
