/**
 * 🔐 ApprovalManager
 *
 * Gerencia solicitações de aprovação humana para promoção de código.
 * OpenClaw pattern: isolamento de estado e ciclo de vida claro.
 *
 * Benefits:
 * - Fila de aprovações separada da lógica de promoção
 * - Rastreabilidade completa de decisões humanas
 * - Controle de prioridade e expiração
 * - Auditoria de quem aprovou o que e quando
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
    ApprovalStatus,
    ApprovalPriority,
    type ApprovalRequest,
    type ApprovalConfig,
    type ApprovalResult,
    type ApprovalState,
    type ApprovalFilters,
    type ApprovalStats,
    type ApprovalNotificationCallback,
    DEFAULT_APPROVAL_CONFIG,
    DEFAULT_APPROVAL_PRIORITY,
} from "./approval-types.js";
import { EventBus } from "../daemon/event-bus.js";

const APPROVAL_STATE_DIR = ".agent/approval";
const STATE_FILE = "approval-state.json";

/**
 * Garante que o diretório de estado existe.
 */
function ensureStateDir(projectRoot: string): string {
    const statePath = path.join(projectRoot, APPROVAL_STATE_DIR);
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
 * Carrega o estado de aprovação do disco.
 */
function loadState(projectRoot: string): ApprovalState {
    const statePath = getStateFilePath(projectRoot);
    try {
        const content = fs.readFileSync(statePath, "utf-8");
        const data = JSON.parse(content);

        // Converte strings de data para objetos Date
        const requests: ApprovalRequest[] = data.requests.map((r: any) => ({
            ...r,
            createdAt: new Date(r.createdAt),
            updatedAt: new Date(r.updatedAt),
            reviewedAt: r.reviewedAt ? new Date(r.reviewedAt) : undefined,
        }));

        return rebuildStateIndexes(requests);
    } catch (err) {
        // Arquivo não existe ou inválido: retorna estado inicial
        return {
            requests: [],
            pending: [],
            approved: [],
            rejected: [],
        };
    }
}

/**
 * Salva o estado de aprovação no disco.
 */
function saveState(projectRoot: string, state: ApprovalState): void {
    const statePath = getStateFilePath(projectRoot);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Reconstrói os índices de estado a partir da lista de solicitações.
 */
function rebuildStateIndexes(requests: ApprovalRequest[]): ApprovalState {
    return {
        requests,
        pending: requests.filter((r) => r.status === ApprovalStatus.PENDING),
        approved: requests.filter((r) => r.status === ApprovalStatus.APPROVED),
        rejected: requests.filter((r) => r.status === ApprovalStatus.REJECTED),
    };
}

/**
 * Gera um ID único para a solicitação.
 */
function generateRequestId(): string {
    return `approval-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * ApprovalManager - Gerencia fila de aprovações humanas para promoção de código.
 */
export class ApprovalManager {
    private config: ApprovalConfig;
    private state: ApprovalState;
    private eventBus: EventBus;
    private notificationCallback?: ApprovalNotificationCallback;

    constructor(
        config: Partial<ApprovalConfig> = {},
        eventBus?: EventBus,
        notificationCallback?: ApprovalNotificationCallback
    ) {
        this.config = { ...DEFAULT_APPROVAL_CONFIG, ...config };
        this.state = loadState(this.config.projectRoot);
        this.eventBus = eventBus || new EventBus();
        this.notificationCallback = notificationCallback;

        this.log('info', '✅ ApprovalManager initialized');
        this.cleanupExpired();
    }

    /**
     * Cria uma nova solicitação de aprovação.
     */
    async createRequest(
        sourcePath: string,
        targetPath: string,
        taskId?: string,
        priority: ApprovalPriority = DEFAULT_APPROVAL_PRIORITY,
        validationResults?: string[]
    ): Promise<ApprovalRequest> {
        // Verifica limite de solicitações pendentes
        if (this.state.pending.length >= this.config.maxPendingRequests) {
            throw new Error(
                `Maximum pending requests reached (${this.config.maxPendingRequests})`
            );
        }

        const request: ApprovalRequest = {
            id: generateRequestId(),
            sourcePath,
            targetPath,
            status: ApprovalStatus.PENDING,
            priority,
            taskId,
            createdAt: new Date(),
            updatedAt: new Date(),
            validationResults,
        };

        this.state.requests.push(request);
        this.state.pending.push(request);
        this.saveState();

        this.log('info', `📝 Created approval request: ${request.id} for ${sourcePath}`);

        // Notifica sobre nova solicitação
        if (this.notificationCallback) {
            try {
                await this.notificationCallback(request);
            } catch (err) {
                this.log('error', `Failed to send notification: ${err}`);
            }
        }

        return request;
    }

    /**
     * Busca uma solicitação por ID.
     */
    getRequest(id: string): ApprovalRequest | undefined {
        return this.state.requests.find((r) => r.id === id);
    }

    /**
     * Lista solicitações com filtros opcionais.
     */
    listRequests(filters?: ApprovalFilters): ApprovalRequest[] {
        let results = [...this.state.requests];

        if (filters?.status) {
            results = results.filter((r) => r.status === filters.status);
        }

        if (filters?.priority) {
            results = results.filter((r) => r.priority === filters.priority);
        }

        if (filters?.taskId) {
            results = results.filter((r) => r.taskId === filters.taskId);
        }

        if (filters?.createdAfter) {
            results = results.filter((r) => r.createdAt >= filters.createdAfter!);
        }

        if (filters?.createdBefore) {
            results = results.filter((r) => r.createdAt <= filters.createdBefore!);
        }

        // Ordena por data (mais recente primeiro) e prioridade
        results.sort((a, b) => {
            // Primeiro por prioridade (urgente primeiro)
            const priorityOrder = [
                ApprovalPriority.URGENT,
                ApprovalPriority.HIGH,
                ApprovalPriority.NORMAL,
                ApprovalPriority.LOW,
            ];
            const aPriorityIndex = priorityOrder.indexOf(a.priority);
            const bPriorityIndex = priorityOrder.indexOf(b.priority);

            if (aPriorityIndex !== bPriorityIndex) {
                return aPriorityIndex - bPriorityIndex;
            }

            // Depois por data (mais recente primeiro)
            return b.createdAt.getTime() - a.createdAt.getTime();
        });

        if (filters?.limit) {
            results = results.slice(0, filters.limit);
        }

        return results;
    }

    /**
     * Retorna todas as solicitações pendentes.
     */
    getPending(): ApprovalRequest[] {
        return [...this.state.pending].sort((a, b) => {
            const priorityOrder = [
                ApprovalPriority.URGENT,
                ApprovalPriority.HIGH,
                ApprovalPriority.NORMAL,
                ApprovalPriority.LOW,
            ];
            const aPriorityIndex = priorityOrder.indexOf(a.priority);
            const bPriorityIndex = priorityOrder.indexOf(b.priority);
            return aPriorityIndex - bPriorityIndex;
        });
    }

    /**
     * Aprova uma solicitação.
     */
    async approveRequest(
        id: string,
        reviewer: string,
        comments?: string
    ): Promise<ApprovalResult> {
        const request = this.getRequest(id);
        if (!request) {
            return {
                success: false,
                request: {} as ApprovalRequest,
                error: `Request not found: ${id}`,
                timestamp: new Date(),
            };
        }

        if (request.status !== ApprovalStatus.PENDING) {
            return {
                success: false,
                request,
                error: `Request is not pending (status: ${request.status})`,
                timestamp: new Date(),
            };
        }

        // Atualiza a solicitação
        request.status = ApprovalStatus.APPROVED;
        request.updatedAt = new Date();
        request.reviewedAt = new Date();
        request.reviewedBy = reviewer;
        request.reviewerComments = comments;

        // Atualiza os índices
        this.removeFromPending(request);
        this.state.approved.push(request);
        this.saveState();

        this.log('info', `✅ Approved request: ${id} by ${reviewer}`);

        return {
            success: true,
            request,
            timestamp: new Date(),
        };
    }

    /**
     * Rejeita uma solicitação.
     */
    async rejectRequest(
        id: string,
        reviewer: string,
        reason: string,
        comments?: string
    ): Promise<ApprovalResult> {
        const request = this.getRequest(id);
        if (!request) {
            return {
                success: false,
                request: {} as ApprovalRequest,
                error: `Request not found: ${id}`,
                timestamp: new Date(),
            };
        }

        if (request.status !== ApprovalStatus.PENDING) {
            return {
                success: false,
                request,
                error: `Request is not pending (status: ${request.status})`,
                timestamp: new Date(),
            };
        }

        // Atualiza a solicitação
        request.status = ApprovalStatus.REJECTED;
        request.updatedAt = new Date();
        request.reviewedAt = new Date();
        request.reviewedBy = reviewer;
        request.rejectionReason = reason;
        request.reviewerComments = comments;

        // Atualiza os índices
        this.removeFromPending(request);
        this.state.rejected.push(request);
        this.saveState();

        this.log('info', `⛔ Rejected request: ${id} by ${reviewer} - ${reason}`);

        return {
            success: true,
            request,
            timestamp: new Date(),
        };
    }

    /**
     * Cancela uma solicitação (ex: expired ou withdrawn).
     */
    async cancelRequest(id: string, reason?: string): Promise<ApprovalResult> {
        const request = this.getRequest(id);
        if (!request) {
            return {
                success: false,
                request: {} as ApprovalRequest,
                error: `Request not found: ${id}`,
                timestamp: new Date(),
            };
        }

        if (request.status !== ApprovalStatus.PENDING) {
            return {
                success: false,
                request,
                error: `Request is not pending (status: ${request.status})`,
                timestamp: new Date(),
            };
        }

        // Atualiza a solicitação
        request.status = ApprovalStatus.CANCELLED;
        request.updatedAt = new Date();
        request.rejectionReason = reason;

        // Atualiza os índices
        this.removeFromPending(request);
        this.saveState();

        this.log('info', `🚫 Cancelled request: ${id} - ${reason || 'No reason provided'}`);

        return {
            success: true,
            request,
            timestamp: new Date(),
        };
    }

    /**
     * Marca uma solicitação aprovada como promovida (remove dos aprovados).
     */
    markAsPromoted(id: string): boolean {
        const request = this.getRequest(id);
        if (!request) {
            return false;
        }

        if (request.status !== ApprovalStatus.APPROVED) {
            return false;
        }

        // Remove da lista de aprovados
        const index = this.state.approved.findIndex((r) => r.id === id);
        if (index !== -1) {
            this.state.approved.splice(index, 1);
            this.saveState();
            this.log('info', `📤 Marked as promoted: ${id}`);
            return true;
        }

        return false;
    }

    /**
     * Retorna o estado atual do sistema de aprovação.
     */
    getState(): ApprovalState {
        return {
            requests: [...this.state.requests],
            pending: [...this.state.pending],
            approved: [...this.state.approved],
            rejected: [...this.state.rejected],
        };
    }

    /**
     * Calcula estatísticas de aprovações.
     */
    getStats(): ApprovalStats {
        const total = this.state.requests.length;
        const pending = this.state.pending.length;
        const approved = this.state.approved.length;
        const rejected = this.state.rejected.length;
        const cancelled = this.state.requests.filter(
            (r) => r.status === ApprovalStatus.CANCELLED
        ).length;

        // Taxa de aprovação (aprovados / (aprovados + rejeitados))
        const decisions = approved + rejected;
        const approvalRate = decisions > 0 ? (approved / decisions) * 100 : 0;

        // Tempo médio de aprovação
        const approvedRequests = this.state.requests.filter(
            (r) => r.status === ApprovalStatus.APPROVED && r.reviewedAt
        );
        const avgApprovalTime =
            approvedRequests.length > 0
                ? approvedRequests.reduce(
                      (sum, r) =>
                          sum +
                          (r.reviewedAt!.getTime() - r.createdAt.getTime()),
                      0
                  ) / approvedRequests.length
                : 0;

        return {
            total,
            pending,
            approved,
            rejected,
            cancelled,
            approvalRate,
            avgApprovalTime,
        };
    }

    /**
     * Limpa solicitações expiradas (antigas demais).
     * @returns Número de solicitações canceladas
     */
    cleanupExpired(): number {
        const now = Date.now();
        let cleaned = 0;

        for (const request of this.state.pending) {
            const age = now - request.createdAt.getTime();
            if (age > this.config.approvalTimeoutMs) {
                this.cancelRequest(request.id, "Expired due to timeout");
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.log('info', `🧹 Cleaned up ${cleaned} expired requests`);
        }

        return cleaned;
    }

    /**
     * Remove solicitações antigas (manutenção).
     * @param maxAgeMs Idade máxima em ms (0 = remove todas completadas)
     * @returns Número de solicitações removidas
     */
    cleanupOld(maxAgeMs: number): number {
        const now = Date.now();
        let cleaned = 0;

        // Remove apenas solicitações completadas (approved, rejected, cancelled)
        const toRemove: ApprovalRequest[] = [];

        for (const request of this.state.requests) {
            if (
                request.status !== ApprovalStatus.PENDING &&
                (maxAgeMs === 0 ||
                    now - request.updatedAt.getTime() > maxAgeMs)
            ) {
                toRemove.push(request);
            }
        }

        for (const request of toRemove) {
            const index = this.state.requests.findIndex(
                (r) => r.id === request.id
            );
            if (index !== -1) {
                this.state.requests.splice(index, 1);
                cleaned++;
            }
        }

        // Reconstrói os índices
        this.state = rebuildStateIndexes(this.state.requests);
        this.saveState();

        if (cleaned > 0) {
            this.log('info', `🧹 Cleaned up ${cleaned} old requests`);
        }

        return cleaned;
    }

    // --- PRIVATE HELPERS ---

    /**
     * Remove uma solicitação da lista de pending.
     */
    private removeFromPending(request: ApprovalRequest): void {
        const index = this.state.pending.findIndex(
            (r) => r.id === request.id
        );
        if (index !== -1) {
            this.state.pending.splice(index, 1);
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
            this.eventBus.log(level, message, 'ApprovalManager');
        }
    }
}

/**
 * Factory function para criar ApprovalManager.
 */
export function createApprovalManager(
    config?: Partial<ApprovalConfig>,
    eventBus?: EventBus,
    notificationCallback?: ApprovalNotificationCallback
): ApprovalManager {
    return new ApprovalManager(config, eventBus, notificationCallback);
}
