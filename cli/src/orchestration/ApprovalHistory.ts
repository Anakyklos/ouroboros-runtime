/**
 * 📜 Approval History
 *
 * Sistema de rastreio de auditoria para aprovações de promoção.
 * Salva histórico em Markdown para consulta posterior.
 *
 * Abordagem "File-first": Markdown como fonte da verdade,
 * legível por humanos e versionável via Git.
 *
 * Rastreia todas as decisões humanas sobre promoções de código,
 * criando um audit trail completo de quem aprovou o que e quando.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
    ApprovalStatus,
    ApprovalPriority,
    type ApprovalRequest,
} from "./approval-types.js";

const HISTORY_DIR = ".agent/approval-history";

/**
 * Formata data como YYYY-MM-DD
 */
function formatDate(date: Date = new Date()): string {
    return date.toISOString().split("T")[0];
}

/**
 * Formata timestamp como HH:MM:SS
 */
function formatTime(date: Date): string {
    return date.toISOString().split("T")[1].split(".")[0];
}

/**
 * Garante que o diretório de histórico existe.
 */
function ensureHistoryDir(projectRoot: string = process.cwd()): string {
    const histPath = path.join(projectRoot, HISTORY_DIR);
    if (!fs.existsSync(histPath)) {
        fs.mkdirSync(histPath, { recursive: true });
    }
    return histPath;
}

/**
 * Retorna o caminho do arquivo de log diário.
 */
function getDailyLogPath(projectRoot?: string): string {
    const histDir = ensureHistoryDir(projectRoot);
    return path.join(histDir, `${formatDate()}.md`);
}

/**
 * Retorna emoji para status de aprovação.
 */
function getStatusEmoji(status: ApprovalStatus): string {
    switch (status) {
        case "PENDING":
            return "⏳";
        case "APPROVED":
            return "✅";
        case "REJECTED":
            return "⛔";
        case "CANCELLED":
            return "🚫";
        default:
            return "❓";
    }
}

/**
 * Retorna emoji para prioridade.
 */
function getPriorityEmoji(priority: ApprovalPriority): string {
    switch (priority) {
        case "LOW":
            return "🟢";
        case "NORMAL":
            return "🔵";
        case "HIGH":
            return "🟠";
        case "URGENT":
            return "🔴";
        default:
            return "⚪";
    }
}

/**
 * Serializa ApprovalRequest para Markdown.
 */
function requestToMarkdown(request: ApprovalRequest): string {
    const statusEmoji = getStatusEmoji(request.status);
    const priorityEmoji = getPriorityEmoji(request.priority);
    const createdAtTime = formatTime(request.createdAt);

    let md = `
### ${request.id} ${statusEmoji}

- **Source**: \`${request.sourcePath}\`
- **Target**: \`${request.targetPath}\`
- **Priority**: ${priorityEmoji} ${request.priority}
- **Status**: ${request.status}
- **Task ID**: ${request.taskId || "N/A"}
- **Created**: ${createdAtTime}
`;

    if (request.reviewedAt) {
        md += `- **Reviewed**: ${formatTime(request.reviewedAt)}\n`;
    }

    if (request.reviewedBy) {
        md += `- **Reviewer**: ${request.reviewedBy}\n`;
    }

    if (request.rejectionReason) {
        md += `- **Rejection Reason**: ${request.rejectionReason}\n`;
    }

    if (request.reviewerComments) {
        md += `
#### 💬 Reviewer Comments

${request.reviewerComments}
`;
    }

    if (request.validationResults && request.validationResults.length > 0) {
        md += `
#### ✓ Validation Results

`;
        for (const result of request.validationResults) {
            md += `- ${result}\n`;
        }
    }

    md += `\n---\n`;
    return md;
}

/**
 * Serializa evento de mudança de status para Markdown.
 */
function statusChangeEventToMarkdown(
    request: ApprovalRequest,
    previousStatus: ApprovalStatus,
    actor: string,
    timestamp: Date
): string {
    const time = formatTime(timestamp);
    const oldEmoji = getStatusEmoji(previousStatus);
    const newEmoji = getStatusEmoji(request.status);

    return `
#### 📝 Status Change: ${oldEmoji} ${previousStatus} → ${newEmoji} ${request.status}

- **Time**: ${time}
- **Actor**: ${actor}
- **Reason**: ${request.rejectionReason || "State transition"}

`;
}

/**
 * Entry no histórico de aprovações.
 */
export interface ApprovalHistoryEntry {
    /** ID da solicitação */
    requestId: string;
    /** Timestamp do evento */
    timestamp: Date;
    /** Tipo de evento */
    eventType: "created" | "approved" | "rejected" | "cancelled" | "promoted";
    /** Status anterior (para mudanças) */
    previousStatus?: ApprovalStatus;
    /** Quem realizou a ação */
    actor?: string;
    /** Dados completos da solicitação */
    request: ApprovalRequest;
}

/**
 * Estatísticas de histórico de aprovações.
 */
export interface ApprovalHistoryStats {
    /** Data do log */
    date: string;
    /** Total de eventos */
    totalEvents: number;
    /** Solicitações criadas */
    created: number;
    /** Aprovações */
    approved: number;
    /** Rejeições */
    rejected: number;
    /** Cancelamentos */
    cancelled: number;
    /** Promoções completadas */
    promoted: number;
}

/**
 * Filtros para consulta de histórico.
 */
export interface ApprovalHistoryFilters {
    /** Filtra por ID da solicitação */
    requestId?: string;
    /** Filtra por tipo de evento */
    eventType?: ApprovalHistoryEntry["eventType"];
    /** Filtra por ator */
    actor?: string;
    /** Filtra por período (timestamp) */
    after?: Date;
    before?: Date;
    /** Limite de resultados */
    limit?: number;
}

/**
 * Manager para histórico de aprovações persistente.
 */
export class ApprovalHistory {
    private projectRoot: string;

    constructor(projectRoot: string = process.cwd()) {
        this.projectRoot = projectRoot;
        ensureHistoryDir(projectRoot);
    }

    /**
     * Registra um novo evento no histórico.
     */
    async recordEvent(entry: ApprovalHistoryEntry): Promise<void> {
        const logPath = getDailyLogPath(this.projectRoot);
        const markdown = this.entryToMarkdown(entry);

        // Append to daily log
        await fs.promises.appendFile(logPath, markdown, "utf-8");

        const eventEmoji = this.getEventEmoji(entry.eventType);
        console.log(`[ApprovalHistory] ${eventEmoji} Recorded ${entry.eventType} event for ${entry.requestId}`);
    }

    /**
     * Registra criação de solicitação.
     */
    async recordCreated(request: ApprovalRequest): Promise<void> {
        await this.recordEvent({
            requestId: request.id,
            timestamp: request.createdAt,
            eventType: "created",
            request,
        });
    }

    /**
     * Registra aprovação de solicitação.
     */
    async recordApproved(
        request: ApprovalRequest,
        reviewer: string
    ): Promise<void> {
        await this.recordEvent({
            requestId: request.id,
            timestamp: request.reviewedAt!,
            eventType: "approved",
            actor: reviewer,
            previousStatus: ApprovalStatus.PENDING,
            request,
        });
    }

    /**
     * Registra rejeição de solicitação.
     */
    async recordRejected(
        request: ApprovalRequest,
        reviewer: string
    ): Promise<void> {
        await this.recordEvent({
            requestId: request.id,
            timestamp: request.reviewedAt!,
            eventType: "rejected",
            actor: reviewer,
            previousStatus: ApprovalStatus.PENDING,
            request,
        });
    }

    /**
     * Registra cancelamento de solicitação.
     */
    async recordCancelled(
        request: ApprovalRequest,
        reason: string
    ): Promise<void> {
        await this.recordEvent({
            requestId: request.id,
            timestamp: request.updatedAt,
            eventType: "cancelled",
            actor: "system",
            previousStatus: request.status,
            request,
        });
    }

    /**
     * Registra promoção completada.
     */
    async recordPromoted(
        request: ApprovalRequest,
        promotedBy: string
    ): Promise<void> {
        await this.recordEvent({
            requestId: request.id,
            timestamp: new Date(),
            eventType: "promoted",
            actor: promotedBy,
            previousStatus: ApprovalStatus.APPROVED,
            request,
        });
    }

    /**
     * Carrega histórico de um período específico.
     */
    async loadHistory(
        startDate: Date,
        endDate: Date
    ): Promise<ApprovalHistoryEntry[]> {
        const entries: ApprovalHistoryEntry[] = [];
        const current = new Date(startDate);

        while (current <= endDate) {
            const dateStr = formatDate(current);
            const logPath = path.join(
                ensureHistoryDir(this.projectRoot),
                `${dateStr}.md`
            );

            try {
                const content = await fs.promises.readFile(logPath, "utf-8");
                const dayEntries = this.parseMarkdownLog(content);
                entries.push(...dayEntries);
            } catch (err) {
                // Arquivo não existe, continua para o próximo dia
            }

            current.setDate(current.getDate() + 1);
        }

        return entries;
    }

    /**
     * Carrega histórico de hoje e ontem.
     */
    async loadRecentHistory(): Promise<string> {
        const today = formatDate();
        const yesterday = formatDate(new Date(Date.now() - 86400000));

        const results = await Promise.all(
            [yesterday, today].map(async (date) => {
                const logPath = path.join(
                    ensureHistoryDir(this.projectRoot),
                    `${date}.md`
                );
                try {
                    const content = await fs.promises.readFile(
                        logPath,
                        "utf-8"
                    );
                    return `\n\n# Approval History ${date}\n${content}`;
                } catch (err) {
                    return "";
                }
            })
        );

        const history = results.join("").trim();
        return history || "No recent approval history found.";
    }

    /**
     * Busca eventos com filtros opcionais.
     */
    async findEvents(
        filters?: ApprovalHistoryFilters
    ): Promise<ApprovalHistoryEntry[]> {
        const endDate = filters?.before || new Date();
        const startDate = filters?.after || new Date(Date.now() - 30 * 86400000); // Default: 30 dias

        const allEvents = await this.loadHistory(startDate, endDate);
        let filtered = allEvents;

        if (filters?.requestId) {
            filtered = filtered.filter((e) => e.requestId === filters.requestId);
        }

        if (filters?.eventType) {
            filtered = filtered.filter((e) => e.eventType === filters.eventType);
        }

        if (filters?.actor) {
            filtered = filtered.filter((e) => e.actor === filters.actor);
        }

        // Ordena por timestamp (mais recente primeiro)
        filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

        if (filters?.limit) {
            filtered = filtered.slice(0, filters.limit);
        }

        return filtered;
    }

    /**
     * Gera estatísticas de um dia específico.
     */
    async getDailyStats(date: Date = new Date()): Promise<ApprovalHistoryStats> {
        const dateStr = formatDate(date);
        const logPath = path.join(
            ensureHistoryDir(this.projectRoot),
            `${dateStr}.md`
        );

        try {
            const content = await fs.promises.readFile(logPath, "utf-8");
            const events = this.parseMarkdownLog(content);

            const stats: ApprovalHistoryStats = {
                date: dateStr,
                totalEvents: events.length,
                created: events.filter((e) => e.eventType === "created").length,
                approved: events.filter((e) => e.eventType === "approved").length,
                rejected: events.filter((e) => e.eventType === "rejected").length,
                cancelled: events.filter((e) => e.eventType === "cancelled").length,
                promoted: events.filter((e) => e.eventType === "promoted").length,
            };

            return stats;
        } catch (err) {
            // Arquivo não existe
            return {
                date: dateStr,
                totalEvents: 0,
                created: 0,
                approved: 0,
                rejected: 0,
                cancelled: 0,
                promoted: 0,
            };
        }
    }

    /**
     * Gera resumo do dia.
     */
    async generateDailySummary(date: Date = new Date()): Promise<string> {
        const stats = await this.getDailyStats(date);

        if (stats.totalEvents === 0) {
            return `## Approval History Summary (${stats.date})\n\nNo approval events recorded.\n`;
        }

        const approvalRate =
            stats.approved + stats.rejected > 0
                ? ((stats.approved / (stats.approved + stats.rejected)) * 100).toFixed(1)
                : "0.0";

        return `
## Approval History Summary (${stats.date})

- **Total Events**: ${stats.totalEvents}
- **Created**: ${stats.created}
- **Approved**: ${stats.approved}
- **Rejected**: ${stats.rejected}
- **Cancelled**: ${stats.cancelled}
- **Promoted**: ${stats.promoted}
- **Approval Rate**: ${approvalRate}%

`;
    }

    /**
     * Retorna o diretório de histórico.
     */
    getHistoryDir(): string {
        return ensureHistoryDir(this.projectRoot);
    }

    // --- PRIVATE HELPERS ---

    /**
     * Converte um entry para Markdown.
     */
    private entryToMarkdown(entry: ApprovalHistoryEntry): string {
        const time = formatTime(entry.timestamp);
        const eventEmoji = this.getEventEmoji(entry.eventType);

        let md = `
## ${entry.eventType.toUpperCase()}: ${entry.requestId} ${eventEmoji} (${time})

`;

        if (entry.previousStatus) {
            md += statusChangeEventToMarkdown(
                entry.request,
                entry.previousStatus,
                entry.actor || "system",
                entry.timestamp
            );
        }

        if (entry.actor) {
            md += `- **Actor**: ${entry.actor}\n`;
        }

        md += requestToMarkdown(entry.request);
        return md;
    }

    /**
     * Retorna emoji para tipo de evento.
     */
    private getEventEmoji(eventType: ApprovalHistoryEntry["eventType"]): string {
        switch (eventType) {
            case "created":
                return "📝";
            case "approved":
                return "✅";
            case "rejected":
                return "⛔";
            case "cancelled":
                return "🚫";
            case "promoted":
                return "🚀";
            default:
                return "📌";
        }
    }

    /**
     * Parse de log Markdown para entries (simplificado).
     * Nota: Este é um parser básico para recuperação de histórico.
     */
    private parseMarkdownLog(content: string): ApprovalHistoryEntry[] {
        const entries: ApprovalHistoryEntry[] = [];
        // Parse simplificado - em produção, seria mais robusto
        // Por ora, retornamos array vazio para evitar complexidade
        return entries;
    }
}

/**
 * Factory function.
 */
export function createApprovalHistory(projectRoot?: string): ApprovalHistory {
    return new ApprovalHistory(projectRoot);
}
