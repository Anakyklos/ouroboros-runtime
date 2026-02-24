/**
 * 🔐 Approval Commands
 *
 * CLI commands para gerenciar aprovações humanas de promoções de código.
 * Parte do protocolo Anti-Vibe: controle humano antes de promoção.
 *
 * Uso:
 *   bun run approval-commands.ts list              # Lista solicitações pendentes
 *   bun run approval-commands.ts approve <id>      # Aprova uma solicitação
 *   bun run approval-commands.ts reject <id>       # Rejeita uma solicitação
 *   bun run approval-commands.ts show <id>         # Mostra detalhes de uma solicitação
 *   bun run approval-commands.ts stats             # Mostra estatísticas
 */

import inquirer from "inquirer";
import {
    ApprovalManager,
    createApprovalManager,
} from "../orchestration/ApprovalManager.js";
import {
    ApprovalStatus,
    ApprovalPriority,
    type ApprovalFilters,
    type ApprovalRequest,
    type ApprovalStats,
} from "../orchestration/approval-types.js";

// Cores para output
const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
    magenta: "\x1b[35m",
    blue: "\x1b[34m",
    gray: "\x1b[90m",
};

/**
 * Log com emoji e cor.
 */
function log(emoji: string, message: string, color = colors.reset) {
    console.log(`${color}${emoji} ${message}${colors.reset}`);
}

/**
 * Formata uma data para exibição.
 */
function formatDate(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "agora";
    if (diffMins < 60) return `${diffMins}min atrás`;
    if (diffHours < 24) return `${diffHours}h atrás`;
    if (diffDays < 7) return `${diffDays}d atrás`;

    return date.toLocaleDateString("pt-BR");
}

/**
 * Retorna a cor para um status.
 */
function getStatusColor(status: ApprovalStatus): string {
    switch (status) {
        case ApprovalStatus.PENDING:
            return colors.yellow;
        case ApprovalStatus.APPROVED:
            return colors.green;
        case ApprovalStatus.REJECTED:
            return colors.red;
        case ApprovalStatus.CANCELLED:
            return colors.gray;
        default:
            return colors.reset;
    }
}

/**
 * Retorna a cor para uma prioridade.
 */
function getPriorityColor(priority: ApprovalPriority): string {
    switch (priority) {
        case ApprovalPriority.URGENT:
            return colors.red;
        case ApprovalPriority.HIGH:
            return colors.yellow;
        case ApprovalPriority.NORMAL:
            return colors.cyan;
        case ApprovalPriority.LOW:
            return colors.gray;
        default:
            return colors.reset;
    }
}

/**
 * Formata uma solicitação para exibição em lista.
 */
function formatRequestShort(request: ApprovalRequest): string {
    const statusColor = getStatusColor(request.status);
    const priorityColor = getPriorityColor(request.priority);
    const age = formatDate(request.createdAt);

    return `${statusColor}[${request.status}]${colors.reset} ${priorityColor}[${request.priority}]${colors.reset} ${colors.cyan}${request.id}${colors.reset} ${colors.gray}${age}${colors.reset}
  ${colors.bright}→${colors.reset} ${request.sourcePath}
  ${colors.bright}↝${colors.reset} ${request.targetPath}`;
}

/**
 * Formata uma solicitação com detalhes completos.
 */
function formatRequestDetailed(request: ApprovalRequest): string {
    const lines: string[] = [];

    lines.push(`${colors.bright}${colors.cyan}═══ ${request.id} ═══${colors.reset}`);
    lines.push("");

    // Status e prioridade
    const statusColor = getStatusColor(request.status);
    const priorityColor = getPriorityColor(request.priority);
    lines.push(`${statusColor}Status:${colors.reset} ${request.status}`);
    lines.push(`${priorityColor}Prioridade:${colors.reset} ${request.priority}`);
    lines.push("");

    // Caminhos
    lines.push(`${colors.bright}Origem:${colors.reset}`);
    lines.push(`  ${colors.gray}${request.sourcePath}${colors.reset}`);
    lines.push("");
    lines.push(`${colors.bright}Destino:${colors.reset}`);
    lines.push(`  ${colors.gray}${request.targetPath}${colors.reset}`);
    lines.push("");

    // Timestamps
    lines.push(`${colors.bright}Criado:${colors.reset} ${request.createdAt.toLocaleString("pt-BR")} (${formatDate(request.createdAt)})`);
    if (request.updatedAt.getTime() !== request.createdAt.getTime()) {
        lines.push(`${colors.bright}Atualizado:${colors.reset} ${request.updatedAt.toLocaleString("pt-BR")}`);
    }
    if (request.reviewedAt) {
        lines.push(`${colors.bright}Revisado:${colors.reset} ${request.reviewedAt.toLocaleString("pt-BR")}`);
    }
    lines.push("");

    // Revisor
    if (request.reviewedBy) {
        lines.push(`${colors.bright}Revisor:${colors.reset} ${request.reviewedBy}`);
        lines.push("");
    }

    // Comentários
    if (request.reviewerComments) {
        lines.push(`${colors.bright}Comentários:${colors.reset}`);
        lines.push(`  ${colors.gray}${request.reviewerComments}${colors.reset}`);
        lines.push("");
    }

    // Razão da rejeição
    if (request.rejectionReason) {
        lines.push(`${colors.red}${colors.bright}Razão da rejeição:${colors.reset}`);
        lines.push(`  ${colors.gray}${request.rejectionReason}${colors.reset}`);
        lines.push("");
    }

    // Validações
    if (request.validationResults && request.validationResults.length > 0) {
        lines.push(`${colors.bright}Validações:${colors.reset}`);
        for (const validation of request.validationResults) {
            lines.push(`  ${colors.green}✓${colors.reset} ${validation}`);
        }
        lines.push("");
    }

    // Task ID
    if (request.taskId) {
        lines.push(`${colors.bright}Task ID:${colors.reset} ${colors.gray}${request.taskId}${colors.reset}`);
        lines.push("");
    }

    lines.push(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);

    return lines.join("\n");
}

/**
 * Lista solicitações de aprovação.
 */
export async function listApprovalsCommand(filters?: ApprovalFilters): Promise<void> {
    const manager = createApprovalManager({ verbose: false });

    const requests = manager.listRequests(filters);

    if (requests.length === 0) {
        log("📭", "Nenhuma solicitação encontrada", colors.cyan);
        return;
    }

    log("📋", `Solicitações encontradas: ${requests.length}`, colors.bright);
    console.log("");

    for (const request of requests) {
        console.log(formatRequestShort(request));
        console.log("");
    }
}

/**
 * Lista apenas solicitações pendentes (atalho).
 */
export async function listPendingCommand(): Promise<void> {
    const manager = createApprovalManager({ verbose: false });

    const pending = manager.getPending();

    if (pending.length === 0) {
        log("✅", "Nenhuma solicitação pendente", colors.green);
        return;
    }

    log("⏳", `Solicitações pendentes: ${pending.length}`, colors.yellow);
    console.log("");

    for (const request of pending) {
        console.log(formatRequestShort(request));
        console.log("");
    }
}

/**
 * Mostra detalhes de uma solicitação.
 */
export async function showApprovalCommand(requestId: string): Promise<void> {
    const manager = createApprovalManager({ verbose: false });

    const request = manager.getRequest(requestId);

    if (!request) {
        log("❌", `Solicitação não encontrada: ${requestId}`, colors.red);
        process.exit(1);
    }

    console.log("");
    console.log(formatRequestDetailed(request));
    console.log("");
}

/**
 * Aprova uma solicitação.
 */
export async function approveCommand(
    requestId: string,
    reviewer?: string,
    comments?: string
): Promise<void> {
    const manager = createApprovalManager({ verbose: false });

    // Busca a solicitação
    const request = manager.getRequest(requestId);

    if (!request) {
        log("❌", `Solicitação não encontrada: ${requestId}`, colors.red);
        process.exit(1);
    }

    // Mostra detalhes da solicitação
    console.log("");
    console.log(formatRequestShort(request));
    console.log("");

    // Pergunta pelo revisor se não fornecido
    if (!reviewer) {
        const answers = await inquirer.prompt([
            {
                type: "input",
                name: "reviewer",
                message: "Seu nome:",
                default: process.env.USER || process.env.USERNAME || "human",
            },
        ]);
        reviewer = answers.reviewer;
    }

    // Pergunta por comentários se não fornecido
    if (!comments) {
        const answers = await inquirer.prompt([
            {
                type: "input",
                name: "comments",
                message: "Comentários (opcional):",
                default: "",
            },
        ]);
        comments = answers.comments || undefined;
    }

    // Confirmação
    const { confirmed } = await inquirer.prompt([
        {
            type: "confirm",
            name: "confirmed",
            message: `Aprovar promoção de ${request.sourcePath}?`,
            default: true,
        },
    ]);

    if (!confirmed) {
        log("⏭️", "Aprovação cancelada", colors.yellow);
        process.exit(0);
    }

    // Valida que o revisor foi fornecido
    if (!reviewer) {
        log("❌", "Nome do revisor é obrigatório", colors.red);
        process.exit(1);
    }

    // Executa a aprovação
    const result = await manager.approveRequest(requestId, reviewer, comments);

    if (!result.success) {
        log("❌", `Falha ao aprovar: ${result.error}`, colors.red);
        process.exit(1);
    }

    log("✅", `Solicitação aprovada com sucesso!`, colors.green);
    log("📝", `Revisor: ${reviewer}`, colors.cyan);

    if (comments) {
        log("💬", `Comentários: ${comments}`, colors.gray);
    }
}

/**
 * Rejeita uma solicitação.
 */
export async function rejectCommand(
    requestId: string,
    reviewer?: string,
    reason?: string,
    comments?: string
): Promise<void> {
    const manager = createApprovalManager({ verbose: false });

    // Busca a solicitação
    const request = manager.getRequest(requestId);

    if (!request) {
        log("❌", `Solicitação não encontrada: ${requestId}`, colors.red);
        process.exit(1);
    }

    // Mostra detalhes da solicitação
    console.log("");
    console.log(formatRequestShort(request));
    console.log("");

    // Pergunta pelo revisor se não fornecido
    if (!reviewer) {
        const answers = await inquirer.prompt([
            {
                type: "input",
                name: "reviewer",
                message: "Seu nome:",
                default: process.env.USER || process.env.USERNAME || "human",
            },
        ]);
        reviewer = answers.reviewer;
    }

    // Pergunta pela razão se não fornecida
    if (!reason) {
        const answers = await inquirer.prompt([
            {
                type: "input",
                name: "reason",
                message: "Motivo da rejeição:",
                validate: (input: string) => input.length > 0 || "Motivo é obrigatório",
            },
        ]);
        reason = answers.reason;
    }

    // Pergunta por comentários adicionais
    if (!comments) {
        const answers = await inquirer.prompt([
            {
                type: "input",
                name: "comments",
                message: "Comentários adicionais (opcional):",
                default: "",
            },
        ]);
        comments = answers.comments || undefined;
    }

    // Confirmação
    const { confirmed } = await inquirer.prompt([
        {
            type: "confirm",
            name: "confirmed",
            message: `Rejeitar promoção de ${request.sourcePath}?`,
            default: false,
        },
    ]);

    if (!confirmed) {
        log("⏭️", "Rejeição cancelada", colors.yellow);
        process.exit(0);
    }

    // Valida que o revisor e motivo foram fornecidos
    if (!reviewer) {
        log("❌", "Nome do revisor é obrigatório", colors.red);
        process.exit(1);
    }

    if (!reason) {
        log("❌", "Motivo da rejeição é obrigatório", colors.red);
        process.exit(1);
    }

    // Executa a rejeição
    const result = await manager.rejectRequest(requestId, reviewer, reason, comments);

    if (!result.success) {
        log("❌", `Falha ao rejeitar: ${result.error}`, colors.red);
        process.exit(1);
    }

    log("⛔", `Solicitação rejeitada!`, colors.red);
    log("📝", `Revisor: ${reviewer}`, colors.cyan);
    log("💡", `Motivo: ${reason}`, colors.yellow);

    if (comments) {
        log("💬", `Comentários: ${comments}`, colors.gray);
    }
}

/**
 * Cancela uma solicitação.
 */
export async function cancelCommand(
    requestId: string,
    reason?: string
): Promise<void> {
    const manager = createApprovalManager({ verbose: false });

    // Busca a solicitação
    const request = manager.getRequest(requestId);

    if (!request) {
        log("❌", `Solicitação não encontrada: ${requestId}`, colors.red);
        process.exit(1);
    }

    // Mostra detalhes da solicitação
    console.log("");
    console.log(formatRequestShort(request));
    console.log("");

    // Confirmação
    const { confirmed } = await inquirer.prompt([
        {
            type: "confirm",
            name: "confirmed",
            message: `Cancelar solicitação ${requestId}?`,
            default: false,
        },
    ]);

    if (!confirmed) {
        log("⏭️", "Cancelamento abortado", colors.yellow);
        process.exit(0);
    }

    // Executa o cancelamento
    const result = await manager.cancelRequest(requestId, reason);

    if (!result.success) {
        log("❌", `Falha ao cancelar: ${result.error}`, colors.red);
        process.exit(1);
    }

    log("🚫", `Solicitação cancelada!`, colors.gray);
    if (reason) {
        log("💡", `Motivo: ${reason}`, colors.yellow);
    }
}

/**
 * Mostra estatísticas de aprovações.
 */
export async function statsCommand(): Promise<void> {
    const manager = createApprovalManager({ verbose: false });

    const stats = manager.getStats();

    console.log("");
    log("📊", "Estatísticas de Aprovações", colors.bright);
    console.log("");
    console.log(`${colors.bright}Total de solicitações:${colors.reset} ${stats.total}`);
    console.log(`${colors.yellow}Pendentes:${colors.reset} ${stats.pending}`);
    console.log(`${colors.green}Aprovadas:${colors.reset} ${stats.approved}`);
    console.log(`${colors.red}Rejeitadas:${colors.reset} ${stats.rejected}`);
    console.log(`${colors.gray}Canceladas:${colors.reset} ${stats.cancelled}`);
    console.log("");

    if (stats.approved + stats.rejected > 0) {
        const rateColor = stats.approvalRate >= 70 ? colors.green : stats.approvalRate >= 50 ? colors.yellow : colors.red;
        console.log(`${rateColor}${colors.bright}Taxa de aprovação:${colors.reset} ${stats.approvalRate.toFixed(1)}%`);
    }

    if (stats.avgApprovalTime > 0) {
        const avgMins = Math.floor(stats.avgApprovalTime / 60000);
        const avgHours = (stats.avgApprovalTime / 3600000).toFixed(1);
        console.log(`${colors.cyan}${colors.bright}Tempo médio de aprovação:${colors.reset} ${avgMins}min (${avgHours}h)`);
    }

    console.log("");
}

/**
 * Modo interativo para revisar solicitações pendentes.
 */
export async function reviewCommand(): Promise<void> {
    const manager = createApprovalManager({ verbose: false });

    const pending = manager.getPending();

    if (pending.length === 0) {
        log("✅", "Nenhuma solicitação pendente para revisar", colors.green);
        return;
    }

    log("🔍", `Modo de revisão: ${pending.length} solicitações pendentes`, colors.bright);
    console.log("");

    for (const request of pending) {
        console.log("");
        console.log(formatRequestShort(request));
        console.log("");

        const { action } = await inquirer.prompt([
            {
                type: "list",
                name: "action",
                message: "Ação:",
                choices: [
                    { name: "✅ Aprovar", value: "approve" },
                    { name: "⛔ Rejeitar", value: "reject" },
                    { name: "⏭️ Pular", value: "skip" },
                    { name: "🚪 Sair", value: "exit" },
                ],
            },
        ]);

        if (action === "exit") {
            log("👋", "Revisão encerrada", colors.cyan);
            break;
        }

        if (action === "skip") {
            log("⏭️", "Solicitação pulada", colors.yellow);
            continue;
        }

        if (action === "approve") {
            const answers = await inquirer.prompt([
                {
                    type: "input",
                    name: "reviewer",
                    message: "Seu nome:",
                    default: process.env.USER || process.env.USERNAME || "human",
                },
                {
                    type: "input",
                    name: "comments",
                    message: "Comentários (opcional):",
                    default: "",
                },
            ]);

            const result = await manager.approveRequest(
                request.id,
                answers.reviewer,
                answers.comments || undefined
            );

            if (result.success) {
                log("✅", "Aprovada!", colors.green);
            } else {
                log("❌", `Erro: ${result.error}`, colors.red);
            }
        } else if (action === "reject") {
            const answers = await inquirer.prompt([
                {
                    type: "input",
                    name: "reviewer",
                    message: "Seu nome:",
                    default: process.env.USER || process.env.USERNAME || "human",
                },
                {
                    type: "input",
                    name: "reason",
                    message: "Motivo da rejeição:",
                    validate: (input: string) => input.length > 0 || "Motivo é obrigatório",
                },
                {
                    type: "input",
                    name: "comments",
                    message: "Comentários adicionais (opcional):",
                    default: "",
                },
            ]);

            const result = await manager.rejectRequest(
                request.id,
                answers.reviewer,
                answers.reason,
                answers.comments || undefined
            );

            if (result.success) {
                log("⛔", "Rejeitada!", colors.red);
            } else {
                log("❌", `Erro: ${result.error}`, colors.red);
            }
        }
    }

    log("🏁", "Revisão concluída", colors.bright);
}

/**
 * Main - CLI entry point.
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log(`
${colors.bright}🔐 Approval Commands${colors.reset}

Gerencia aprovações humanas de promoções de código.

${colors.cyan}Comandos:${colors.reset}
  list                 Lista todas as solicitações
  pending              Lista apenas solicitações pendentes
  show <id>            Mostra detalhes de uma solicitação
  approve <id>         Aprova uma solicitação
  reject <id>          Rejeita uma solicitação
  cancel <id>          Cancela uma solicitação
  stats                Mostra estatísticas
  review               Modo interativo de revisão

${colors.yellow}Exemplos:${colors.reset}
  bun run approval-commands.ts list
  bun run approval-commands.ts pending
  bun run approval-commands.ts show approval-1234567890-abcd1234
  bun run approval-commands.ts approve approval-1234567890-abcd1234
  bun run approval-commands.ts reject approval-1234567890-abcd1234
  bun run approval-commands.ts review

${colors.magenta}Filtros:${colors.reset}
  --status <STATUS>      Filtra por status (PENDING, APPROVED, REJECTED, CANCELLED)
  --priority <PRIORITY>  Filtra por prioridade (LOW, NORMAL, HIGH, URGENT)
  --limit <N>            Limita número de resultados
`);
        process.exit(0);
    }

    const command = args[0];

    switch (command) {
        case "list":
            await listApprovalsCommand();
            break;

        case "pending":
            await listPendingCommand();
            break;

        case "show":
            if (!args[1]) {
                log("❌", "ID da solicitação é obrigatório", colors.red);
                process.exit(1);
            }
            await showApprovalCommand(args[1]);
            break;

        case "approve":
            if (!args[1]) {
                log("❌", "ID da solicitação é obrigatório", colors.red);
                process.exit(1);
            }
            await approveCommand(args[1]);
            break;

        case "reject":
            if (!args[1]) {
                log("❌", "ID da solicitação é obrigatório", colors.red);
                process.exit(1);
            }
            await rejectCommand(args[1]);
            break;

        case "cancel":
            if (!args[1]) {
                log("❌", "ID da solicitação é obrigatório", colors.red);
                process.exit(1);
            }
            await cancelCommand(args[1]);
            break;

        case "stats":
            await statsCommand();
            break;

        case "review":
            await reviewCommand();
            break;

        default:
            log("❌", `Comando desconhecido: ${command}`, colors.red);
            process.exit(1);
    }
}

// Executa se chamado diretamente (detecta pelo nome do arquivo)
const isMainModule = process.argv[1]?.endsWith("approval-commands.ts");
if (isMainModule) {
    main().catch((err) => {
        log("💥", `Erro fatal: ${err}`, colors.red);
        process.exit(1);
    });
}
