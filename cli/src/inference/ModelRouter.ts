/**
 * 🔀 ModelRouter
 *
 * Decide qual modelo usar para cada subtarefa.
 * Registra a justificativa da escolha e suporta fallback controlado.
 */

import type {
    ModelRole,
    TaskType,
    RoutingRequest,
    RoutingDecision,
} from "./types/inference-types.js";
import { ModelRegistry } from "./ModelRegistry.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";
import { ModelFailureReportSchema, type ModelFailureReport } from "./schemas/inference-schemas.js";

// ============================================================================
// Task → Role Mapping
// ============================================================================

const TASK_ROLE_MAP: Record<TaskType, ModelRole> = {
    tool_selection: "policy",
    action_planning: "policy",
    state_summary: "policy",
    intent_classification: "policy",
    patch_generation: "coder",
    code_edit: "coder",
    test_fix: "coder",
    refactor: "coder",
    embedding: "embedding",
    retrieval: "embedding",
    similarity: "embedding",
    clustering: "embedding",
};

// ============================================================================
// ModelRouter
// ============================================================================

export class ModelRouter {
    private registry: ModelRegistry;
    private eventBus: EventBus;
    private routingHistory: RoutingDecision[] = [];
    private failureCount: Map<string, number> = new Map();

    constructor(registry: ModelRegistry, eventBus?: EventBus) {
        this.registry = registry;
        this.eventBus = eventBus ?? globalEventBus;
    }

    /**
     * Decide qual modelo usar para uma tarefa.
     * Regras determinísticas baseadas no tipo de tarefa.
     */
    route(request: RoutingRequest): RoutingDecision {
        const targetRole = TASK_ROLE_MAP[request.taskType];

        if (!targetRole) {
            const decision = this.createDecision(
                "policy", // fallback to policy for unknown tasks
                "policy",
                `Unknown task type "${request.taskType}", defaulting to policy model`,
            );
            this.log("warn", `Unknown task type: ${request.taskType}`);
            return decision;
        }

        // Find primary model for the role
        const primaryModel = this.registry.getByRole(targetRole);

        if (!primaryModel) {
            // No model registered for this role — try fallback
            const fallback = this.findFallback(targetRole);
            if (fallback) {
                const decision = this.createDecision(
                    fallback.id,
                    fallback.role,
                    `No ${targetRole} model available, falling back to ${fallback.name}`,
                    undefined,
                );
                this.log("warn", `Fallback: ${targetRole} → ${fallback.name}`);
                return decision;
            }

            // No fallback either
            const decision = this.createDecision(
                "none",
                targetRole,
                `No model available for role ${targetRole} and no fallback found`,
            );
            this.log("error", `No model for role: ${targetRole}`);
            return decision;
        }

        // Check if primary has had too many failures
        const failures = this.failureCount.get(primaryModel.id) ?? 0;
        if (failures >= 3) {
            const fallback = this.findFallback(targetRole);
            if (fallback) {
                const decision = this.createDecision(
                    fallback.id,
                    fallback.role,
                    `Primary model ${primaryModel.name} has ${failures} consecutive failures, using fallback`,
                    primaryModel.id,
                );
                this.log("warn", `Circuit breaker: ${primaryModel.id} → ${fallback.id}`);
                return decision;
            }
        }

        // Normal routing
        const decision = this.createDecision(
            primaryModel.id,
            primaryModel.role,
            `Task type "${request.taskType}" routed to ${primaryModel.name} (${primaryModel.role})`,
        );

        this.log("debug", `Routed ${request.taskType} → ${primaryModel.id}`);
        return decision;
    }

    /**
     * Registra falha de um modelo (para circuit breaker).
     */
    recordFailure(modelId: string): void {
        const count = (this.failureCount.get(modelId) ?? 0) + 1;
        this.failureCount.set(modelId, count);
        this.log("warn", `Model ${modelId} failure count: ${count}`);
    }

    /**
     * Registra sucesso de um modelo (reseta circuit breaker).
     */
    recordSuccess(modelId: string): void {
        this.failureCount.set(modelId, 0);
    }

    /**
     * Retorna histórico de roteamentos.
     */
    getRoutingHistory(): readonly RoutingDecision[] {
        return this.routingHistory;
    }

    /**
     * Limpa histórico de roteamento.
     */
    clearHistory(): void {
        this.routingHistory = [];
    }

    /**
     * Retorna mapa de task types e seus modelos atuais.
     */
    getRoutingTable(): Record<TaskType, string> {
        const table: Partial<Record<TaskType, string>> = {};
        for (const [taskType, role] of Object.entries(TASK_ROLE_MAP)) {
            const model = this.registry.getByRole(role);
            table[taskType as TaskType] = model?.id ?? "none";
        }
        return table as Record<TaskType, string>;
    }

    // ========================================================================
    // Private
    // ========================================================================

    private findFallback(failedRole: ModelRole): { id: string; name: string; role: ModelRole } | undefined {
        // Fallback chain: coder → policy, policy → coder (but not for embedding)
        const fallbackRoles: Record<ModelRole, ModelRole[]> = {
            policy: ["coder"],
            coder: ["policy"],
            embedding: [], // No fallback for embedding — it's fundamentally different
        };

        for (const role of fallbackRoles[failedRole] ?? []) {
            const model = this.registry.getByRole(role);
            if (model) {
                return { id: model.id, name: model.name, role: model.role };
            }
        }

        return undefined;
    }

    private createDecision(
        modelId: string,
        role: ModelRole,
        reasoning: string,
        fallbackModelId?: string,
    ): RoutingDecision {
        const decision: RoutingDecision = {
            modelId,
            role,
            reasoning,
            fallbackModelId,
            timestamp: new Date().toISOString(),
        };

        this.routingHistory.push(decision);

        // Keep history bounded
        if (this.routingHistory.length > 1000) {
            this.routingHistory = this.routingHistory.slice(-500);
        }

        return decision;
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[ModelRouter] ${message}`, "ModelRouter");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createModelRouter(registry: ModelRegistry, eventBus?: EventBus): ModelRouter {
    return new ModelRouter(registry, eventBus);
}
