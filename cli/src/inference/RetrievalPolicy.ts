/**
 * 📜 RetrievalPolicy
 *
 * Define políticas de ingestão e retrieval de memória semântica.
 * Regras configuráveis: tipo de artefato, tamanho, TTL.
 * Log de decisões de política.
 */

import type { MemoryWriteCandidate } from "./schemas/inference-schemas.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// Types
// ============================================================================

export interface PolicyDecision {
    allowed: boolean;
    reason: string;
}

export interface RetrievalPolicyConfig {
    /** Tipos de artefato permitidos para ingestão */
    allowedArtifactTypes: string[];
    /** Tamanho mínimo de conteúdo para ingestão (chars) */
    minContentLength: number;
    /** Tamanho máximo de conteúdo para ingestão (chars) */
    maxContentLength: number;
    /** TTL padrão em horas (null = permanente) */
    defaultTtlHours: number | null;
    /** Similaridade mínima para retrieval */
    minRetrievalSimilarity: number;
    /** Máximo de resultados por retrieval */
    maxRetrievalResults: number;
    /** Se deve logar decisões de política */
    logDecisions: boolean;
}

const DEFAULT_POLICY_CONFIG: RetrievalPolicyConfig = {
    allowedArtifactTypes: [
        "task_summary",
        "decision",
        "solution",
        "failure",
        "correction",
        "code_snippet",
        "trace",
        "document",
    ],
    minContentLength: 10,
    maxContentLength: 50000,
    defaultTtlHours: null,
    minRetrievalSimilarity: 0.3,
    maxRetrievalResults: 10,
    logDecisions: true,
};

// ============================================================================
// RetrievalPolicy
// ============================================================================

export class RetrievalPolicy {
    private config: RetrievalPolicyConfig;
    private eventBus: EventBus;
    private decisionLog: Array<{ timestamp: string; type: "ingest" | "retrieve"; decision: PolicyDecision }> = [];

    constructor(config?: Partial<RetrievalPolicyConfig>, eventBus?: EventBus) {
        this.config = { ...DEFAULT_POLICY_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
    }

    /**
     * Decide se um artefato deve ser ingerido na memória semântica.
     */
    shouldIngest(candidate: MemoryWriteCandidate): PolicyDecision {
        // Check artifact type
        if (!this.config.allowedArtifactTypes.includes(candidate.artifactType)) {
            return this.decide("ingest", false,
                `Artifact type "${candidate.artifactType}" not in allowed list`);
        }

        // Check content length
        if (candidate.content.length < this.config.minContentLength) {
            return this.decide("ingest", false,
                `Content too short: ${candidate.content.length} < ${this.config.minContentLength}`);
        }

        if (candidate.content.length > this.config.maxContentLength) {
            return this.decide("ingest", false,
                `Content too long: ${candidate.content.length} > ${this.config.maxContentLength}`);
        }

        // Check label
        if (!candidate.label || candidate.label.trim().length === 0) {
            return this.decide("ingest", false, "Missing label");
        }

        // Check origin
        if (!candidate.origin || candidate.origin.trim().length === 0) {
            return this.decide("ingest", false, "Missing origin");
        }

        return this.decide("ingest", true, "Passed all ingestion checks");
    }

    /**
     * Decide se um retrieval deve ser realizado.
     */
    shouldRetrieve(context: { query: string; source: string }): PolicyDecision {
        if (!context.query || context.query.trim().length < 3) {
            return this.decide("retrieve", false, "Query too short");
        }

        return this.decide("retrieve", true, "Retrieval allowed");
    }

    /**
     * Retorna o TTL padrão configurado.
     */
    getDefaultTtl(): number | null {
        return this.config.defaultTtlHours;
    }

    /**
     * Retorna similaridade mínima para retrieval.
     */
    getMinSimilarity(): number {
        return this.config.minRetrievalSimilarity;
    }

    /**
     * Retorna máximo de resultados por retrieval.
     */
    getMaxResults(): number {
        return this.config.maxRetrievalResults;
    }

    /**
     * Retorna histórico de decisões de política.
     */
    getDecisionLog(): readonly typeof this.decisionLog[number][] {
        return this.decisionLog;
    }

    /**
     * Limpa log de decisões.
     */
    clearDecisionLog(): void {
        this.decisionLog = [];
    }

    // ========================================================================
    // Private
    // ========================================================================

    private decide(type: "ingest" | "retrieve", allowed: boolean, reason: string): PolicyDecision {
        const decision = { allowed, reason };

        if (this.config.logDecisions) {
            this.decisionLog.push({
                timestamp: new Date().toISOString(),
                type,
                decision,
            });

            // Keep log bounded
            if (this.decisionLog.length > 500) {
                this.decisionLog = this.decisionLog.slice(-250);
            }

            this.log("debug", `[${type}] ${allowed ? "✅" : "❌"} ${reason}`);
        }

        return decision;
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[RetrievalPolicy] ${message}`, "RetrievalPolicy");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createRetrievalPolicy(
    config?: Partial<RetrievalPolicyConfig>,
    eventBus?: EventBus,
): RetrievalPolicy {
    return new RetrievalPolicy(config, eventBus);
}
