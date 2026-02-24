/**
 * 🔐 Approval Types
 *
 * Tipos para o sistema de aprovação humana de promoções de código.
 * Parte do protocolo Anti-Vibe: controle humano antes de promoção.
 */

// --- ENUMS ---

/**
 * Status de uma solicitação de aprovação.
 */
export enum ApprovalStatus {
    /** Aguardando revisão humana */
    PENDING = "PENDING",
    /** Aprovado pelo humano */
    APPROVED = "APPROVED",
    /** Rejeitado pelo humano */
    REJECTED = "REJECTED",
    /** Cancelado (expirado ou withdrawn) */
    CANCELLED = "CANCELLED",
}

/**
 * Prioridade de uma solicitação de aprovação.
 */
export enum ApprovalPriority {
    /** Baixa prioridade */
    LOW = "LOW",
    /** Prioridade normal */
    NORMAL = "NORMAL",
    /** Alta prioridade */
    HIGH = "HIGH",
    /** Crítico */
    URGENT = "URGENT",
}

// --- INTERFACES ---

/**
 * Solicitação de aprovação humana.
 */
export interface ApprovalRequest {
    /** ID único da solicitação */
    id: string;
    /** Caminho do arquivo candidato */
    sourcePath: string;
    /** Caminho de destino após aprovação */
    targetPath: string;
    /** Status atual da aprovação */
    status: ApprovalStatus;
    /** Prioridade da solicitação */
    priority: ApprovalPriority;
    /** ID da task que gerou esta solicitação */
    taskId?: string;
    /** Timestamp de criação da solicitação */
    createdAt: Date;
    /** Timestamp da última atualização */
    updatedAt: Date;
    /** Timestamp de quando foi aprovado/rejeitado */
    reviewedAt?: Date;
    /** Quem aprovou/rejeitou (user identifier) */
    reviewedBy?: string;
    /** Motivo da rejeição (se aplicável) */
    rejectionReason?: string;
    /** Comentários do revisor */
    reviewerComments?: string;
    /** Validações de qualidade que passaram */
    validationResults?: string[];
}

/**
 * Configuração para o ApprovalManager.
 */
export interface ApprovalConfig {
    /** Diretório raiz do projeto */
    projectRoot: string;
    /** Tempo máximo para aprovação (ms) antes de expirar */
    approvalTimeoutMs: number;
    /** Número máximo de solicitações pendentes */
    maxPendingRequests: number;
    /** Habilita logs detalhados */
    verbose: boolean;
}

/**
 * Resultado de uma operação de aprovação.
 */
export interface ApprovalResult {
    /** Se a operação foi bem-sucedida */
    success: boolean;
    /** Solicitação de aprovação */
    request?: ApprovalRequest;
    /** Mensagem de erro (se falhou) */
    error?: string;
    /** Timestamp da operação */
    timestamp: Date;
}

/**
 * Estado atual do sistema de aprovação.
 */
export interface ApprovalState {
    /** Todas as solicitações */
    requests: ApprovalRequest[];
    /** Solicitações pendentes */
    pending: ApprovalRequest[];
    /** Solicitações aprovadas (não promovidas ainda) */
    approved: ApprovalRequest[];
    /** Solicitações rejeitadas */
    rejected: ApprovalRequest[];
}

/**
 * Filtros para listar solicitações.
 */
export interface ApprovalFilters {
    /** Filtra por status */
    status?: ApprovalStatus;
    /** Filtra por prioridade */
    priority?: ApprovalPriority;
    /** Filtra por task ID */
    taskId?: string;
    /** Filtra por período (createdAt) */
    createdAfter?: Date;
    createdBefore?: Date;
    /** Limite de resultados */
    limit?: number;
}

/**
 * Estatísticas de aprovações.
 */
export interface ApprovalStats {
    /** Total de solicitações */
    total: number;
    /** Número de pendentes */
    pending: number;
    /** Número de aprovadas */
    approved: number;
    /** Número de rejeitadas */
    rejected: number;
    /** Número de canceladas */
    cancelled: number;
    /** Taxa de aprovação (%) */
    approvalRate: number;
    /** Tempo médio de aprovação (ms) */
    avgApprovalTime: number;
}

/**
 * Callback para notificação de nova solicitação de aprovação.
 */
export type ApprovalNotificationCallback = (
    request: ApprovalRequest
) => Promise<void>;

// --- CONSTANTS ---

/**
 * Configuração padrão para o ApprovalManager.
 */
export const DEFAULT_APPROVAL_CONFIG: ApprovalConfig = {
    projectRoot: process.cwd(),
    approvalTimeoutMs: 7 * 24 * 60 * 60 * 1000, // 7 dias
    maxPendingRequests: 100,
    verbose: true,
};

/**
 * Prioridade padrão para novas solicitações.
 */
export const DEFAULT_APPROVAL_PRIORITY = ApprovalPriority.NORMAL;
