/**
 * 📦 DatasetPipeline
 *
 * Export de traces para futuro fine-tuning.
 * Sem treinar — apenas prepara dados.
 * Formato JSONL para máxima portabilidade.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { InferenceTrace } from "./schemas/inference-schemas.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";
import { redactText } from "./redaction.js";

// ============================================================================
// Types
// ============================================================================

export interface DatasetEntry {
    type: "policy_decision" | "retrieval_result" | "patch_accepted" | "patch_rejected" | "trace";
    input: string;
    output: string;
    label: string;
    outcome: "success" | "failure" | "rollback" | "human_correction";
    metadata: Record<string, unknown>;
    timestamp: string;
}

export interface DatasetStats {
    totalEntries: number;
    byType: Record<string, number>;
    byOutcome: Record<string, number>;
}

// ============================================================================
// DatasetPipeline
// ============================================================================

export class DatasetPipeline {
    private entries: DatasetEntry[] = [];
    private eventBus: EventBus;
    private knownSecrets: string[];
    private unsubscribeRedaction: () => void;

    constructor(eventBus?: EventBus, knownSecrets: readonly string[] = []) {
        this.eventBus = eventBus ?? globalEventBus;
        this.knownSecrets = [...knownSecrets].filter(secret => secret.length > 0);
        this.unsubscribeRedaction = this.eventBus.onRedactionSecret((secret, active) => {
            if (active) {
                if (!this.knownSecrets.includes(secret)) this.knownSecrets.push(secret);
            } else {
                this.knownSecrets = this.knownSecrets.filter(knownSecret => knownSecret !== secret);
            }
        });
        for (const secret of this.knownSecrets) {
            this.eventBus.registerRedactionSecret(secret);
        }
    }

    /**
     * Adiciona uma entrada de trace ao dataset.
     */
    addTrace(trace: InferenceTrace): void {
        this.entries.push({
            type: "trace",
            input: this.redact(trace.input),
            output: this.redact(trace.output),
            label: `${trace.modelRole}:${trace.modelId}`,
            outcome: (trace.outcome as DatasetEntry["outcome"]) ?? "success",
            metadata: {
                traceId: trace.traceId,
                modelId: trace.modelId,
                modelRole: trace.modelRole,
                durationMs: trace.durationMs,
                wasValid: trace.wasValid,
                wasAccepted: trace.wasAccepted,
                tokenCount: trace.tokenCount,
            },
            timestamp: trace.timestamp,
        });
    }

    /**
     * Adiciona decisão de policy ao dataset.
     */
    addPolicyDecision(
        input: string,
        decision: string,
        outcome: DatasetEntry["outcome"],
    ): void {
        this.entries.push({
            type: "policy_decision",
            input: this.redact(input),
            output: this.redact(decision),
            label: "policy",
            outcome,
            metadata: {},
            timestamp: new Date().toISOString(),
        });
    }

    /**
     * Adiciona resultado de retrieval ao dataset.
     */
    addRetrievalResult(
        query: string,
        results: string,
        wasUseful: boolean,
    ): void {
        this.entries.push({
            type: "retrieval_result",
            input: this.redact(query),
            output: this.redact(results),
            label: "retrieval",
            outcome: wasUseful ? "success" : "failure",
            metadata: { wasUseful },
            timestamp: new Date().toISOString(),
        });
    }

    /**
     * Adiciona resultado de patch ao dataset.
     */
    addPatchResult(
        instruction: string,
        patch: string,
        accepted: boolean,
        rollback?: boolean,
    ): void {
        this.entries.push({
            type: accepted ? "patch_accepted" : "patch_rejected",
            input: this.redact(instruction),
            output: this.redact(patch),
            label: "patch",
            outcome: rollback ? "rollback" : (accepted ? "success" : "failure"),
            metadata: { accepted, rollback: !!rollback },
            timestamp: new Date().toISOString(),
        });
    }

    /**
     * Exporta dataset em formato JSONL.
     */
    async export(outputPath: string): Promise<number> {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const lines = this.entries.map(e => JSON.stringify(e));
        await fs.promises.writeFile(outputPath, lines.join("\n") + "\n", "utf-8");

        this.log("info", `Exported ${lines.length} entries to ${outputPath}`);
        return lines.length;
    }

    /**
     * Retorna estatísticas do dataset.
     */
    getStats(): DatasetStats {
        const byType: Record<string, number> = {};
        const byOutcome: Record<string, number> = {};

        for (const entry of this.entries) {
            byType[entry.type] = (byType[entry.type] ?? 0) + 1;
            byOutcome[entry.outcome] = (byOutcome[entry.outcome] ?? 0) + 1;
        }

        return { totalEntries: this.entries.length, byType, byOutcome };
    }

    /**
     * Retorna contagem de entradas.
     */
    size(): number {
        return this.entries.length;
    }

    /**
     * Limpa o pipeline.
     */
    clear(): void {
        this.entries = [];
    }

    /** Libera a inscrição no ciclo de vida quando o pipeline deixa de ser usado. */
    dispose(): void {
        this.unsubscribeRedaction();
        this.knownSecrets = [];
    }

    // ========================================================================
    // Private
    // ========================================================================

    private redact(value: string): string {
        return redactText(value, this.knownSecrets);
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[DatasetPipeline] ${message}`, "DatasetPipeline");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createDatasetPipeline(eventBus?: EventBus): DatasetPipeline {
    return new DatasetPipeline(eventBus);
}
