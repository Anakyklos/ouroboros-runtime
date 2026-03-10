/**
 * 🏗️ LocalInferenceProvider
 *
 * Abstrai chamadas de inferência local via Ollama HTTP API.
 * Suporta chat completions e embeddings com:
 * - Timeouts configuráveis
 * - Retries exponenciais
 * - Logging via EventBus
 * - Métricas por modelo
 * - Trace ID por requisição
 */

import * as crypto from "node:crypto";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";
import type {
    InferenceRequest,
    InferenceResponse,
    EmbeddingRequest,
    EmbeddingResponse,
    InferenceProviderConfig,
    ModelMetrics,
} from "./types/inference-types.js";
import { ModelFailureReportSchema, type ModelFailureReport } from "./schemas/inference-schemas.js";
import { loadInferenceConfig } from "./inference-config.js";

// ============================================================================
// LocalInferenceProvider
// ============================================================================

export class LocalInferenceProvider {
    private config: InferenceProviderConfig;
    private eventBus: EventBus;
    private metrics: Map<string, ModelMetrics> = new Map();
    private requestCounter = 0;

    constructor(config?: Partial<InferenceProviderConfig>, eventBus?: EventBus) {
        const defaults = loadInferenceConfig();
        this.config = { ...defaults, ...config };
        this.eventBus = eventBus ?? globalEventBus;
    }

    // ========================================================================
    // Chat Completion
    // ========================================================================

    /**
     * Envia mensagens para completions via Ollama.
     * Implementa retry com backoff exponencial.
     */
    async chat(request: InferenceRequest): Promise<InferenceResponse> {
        const traceId = request.traceId ?? this.generateTraceId();
        const timeoutMs = request.timeoutMs ?? this.config.defaultTimeoutMs;
        const startTime = Date.now();

        this.log("debug", `[${traceId}] Chat request to ${request.modelId}`, {
            messageCount: request.messages.length,
            temperature: request.temperature,
        });

        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
                    this.log("warn", `[${traceId}] Retry ${attempt}/${this.config.maxRetries} after ${delay}ms`);
                    await this.sleep(delay);
                }

                const body: Record<string, unknown> = {
                    model: request.modelId,
                    messages: request.messages,
                    stream: false,
                    options: {
                        temperature: request.temperature ?? 0.1,
                        num_predict: request.maxTokens ?? 512,
                    },
                };

                if (request.responseSchema) {
                    body.format = "json";
                }

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

                try {
                    const response = await fetch(`${this.config.ollamaBaseUrl}/api/chat`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    });

                    clearTimeout(timeoutId);

                    if (!response.ok) {
                        const errText = await response.text();
                        throw new Error(`Ollama HTTP ${response.status}: ${errText}`);
                    }

                    const data = await response.json() as {
                        message?: { content: string };
                        eval_count?: number;
                    };

                    if (!data.message?.content) {
                        throw new Error("Empty response from Ollama");
                    }

                    const content = data.message.content;
                    const durationMs = Date.now() - startTime;

                    let isValidJSON = false;
                    try {
                        JSON.parse(content);
                        isValidJSON = true;
                    } catch {
                        // Not JSON — valid for some use cases
                    }

                    const result: InferenceResponse = {
                        content,
                        modelId: request.modelId,
                        durationMs,
                        tokenCount: data.eval_count,
                        usedFallback: false,
                        traceId,
                        isValidJSON,
                    };

                    this.recordMetric(request.modelId, durationMs, true, isValidJSON);

                    this.log("info", `[${traceId}] Chat completed in ${durationMs}ms (valid_json=${isValidJSON})`);

                    return result;
                } finally {
                    clearTimeout(timeoutId);
                }
            } catch (error) {
                lastError = error as Error;
                const durationMs = Date.now() - startTime;

                this.log("error", `[${traceId}] Chat attempt ${attempt} failed: ${lastError.message}`);
                this.recordMetric(request.modelId, durationMs, false, false);

                // Don't retry on abort (timeout)
                if (lastError.name === "AbortError") {
                    break;
                }
            }
        }

        // All retries exhausted
        const durationMs = Date.now() - startTime;
        const failureReport = this.createFailureReport(
            request.modelId,
            lastError!,
            durationMs,
        );

        this.log("error", `[${traceId}] All retries exhausted for ${request.modelId}`);

        return {
            content: JSON.stringify(failureReport),
            modelId: request.modelId,
            durationMs,
            usedFallback: false,
            traceId,
            isValidJSON: true,
        };
    }

    // ========================================================================
    // Embeddings
    // ========================================================================

    /**
     * Gera embedding de texto via Ollama.
     */
    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
        const traceId = request.traceId ?? this.generateTraceId();
        const modelId = request.modelId ?? "embedding";
        const startTime = Date.now();

        this.log("debug", `[${traceId}] Embedding request (${request.text.length} chars)`);

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(
                () => controller.abort(),
                this.config.defaultTimeoutMs,
            );

            try {
                const response = await fetch(`${this.config.ollamaBaseUrl}/api/embeddings`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: modelId,
                        prompt: request.text,
                    }),
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`Ollama embed HTTP ${response.status}: ${errText}`);
                }

                const data = await response.json() as { embedding?: number[] };

                if (!data.embedding || !Array.isArray(data.embedding)) {
                    throw new Error("Invalid embedding response from Ollama");
                }

                const durationMs = Date.now() - startTime;
                this.recordMetric(modelId, durationMs, true, true);

                this.log("debug", `[${traceId}] Embedding done: dim=${data.embedding.length} in ${durationMs}ms`);

                return {
                    vector: data.embedding,
                    dimension: data.embedding.length,
                    modelId,
                    durationMs,
                    traceId,
                };
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (error) {
            const durationMs = Date.now() - startTime;
            this.recordMetric(modelId, durationMs, false, false);
            this.log("error", `[${traceId}] Embedding failed: ${(error as Error).message}`);

            return {
                vector: [],
                dimension: 0,
                modelId,
                durationMs,
                traceId,
            };
        }
    }

    // ========================================================================
    // Health Check
    // ========================================================================

    /**
     * Verifica se Ollama está acessível e se o modelo está carregado.
     */
    async isModelAvailable(ollamaModel: string): Promise<boolean> {
        try {
            const response = await fetch(`${this.config.ollamaBaseUrl}/api/tags`, {
                signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) return false;

            const data = await response.json() as { models?: Array<{ name: string }> };
            return data.models?.some(m => m.name.startsWith(ollamaModel)) ?? false;
        } catch {
            return false;
        }
    }

    /**
     * Verifica se o Ollama está acessível.
     */
    async isHealthy(): Promise<boolean> {
        try {
            const response = await fetch(`${this.config.ollamaBaseUrl}/api/tags`, {
                signal: AbortSignal.timeout(3000),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    // ========================================================================
    // Metrics
    // ========================================================================

    /**
     * Retorna métricas coletadas por modelo.
     */
    getMetrics(): Map<string, ModelMetrics> {
        return new Map(this.metrics);
    }

    /**
     * Retorna métricas de um modelo específico.
     */
    getModelMetrics(modelId: string): ModelMetrics | undefined {
        return this.metrics.get(modelId);
    }

    /**
     * Reseta métricas.
     */
    resetMetrics(): void {
        this.metrics.clear();
    }

    // ========================================================================
    // Private
    // ========================================================================

    private recordMetric(modelId: string, durationMs: number, success: boolean, validJSON: boolean): void {
        if (!this.config.collectMetrics) return;

        const existing = this.metrics.get(modelId) ?? {
            modelId,
            totalRequests: 0,
            successCount: 0,
            failureCount: 0,
            validJSONCount: 0,
            totalDurationMs: 0,
            avgDurationMs: 0,
            validJSONRate: 0,
            lastRequestAt: "",
        };

        existing.totalRequests++;
        if (success) existing.successCount++;
        else existing.failureCount++;
        if (validJSON) existing.validJSONCount++;
        existing.totalDurationMs += durationMs;
        existing.avgDurationMs = existing.totalDurationMs / existing.totalRequests;
        existing.validJSONRate = existing.totalRequests > 0
            ? existing.validJSONCount / existing.totalRequests
            : 0;
        existing.lastRequestAt = new Date().toISOString();

        this.metrics.set(modelId, existing);
    }

    private createFailureReport(
        modelId: string,
        error: Error,
        durationMs: number,
    ): ModelFailureReport {
        let errorType: ModelFailureReport["errorType"] = "unknown";

        if (error.name === "AbortError") errorType = "timeout";
        else if (error.message.includes("ECONNREFUSED") || error.message.includes("fetch"))
            errorType = "connection_error";
        else if (error.message.includes("Empty response")) errorType = "empty_response";
        else if (error.message.includes("Invalid")) errorType = "malformed_output";

        const report: ModelFailureReport = {
            modelId,
            modelRole: this.inferRole(modelId),
            errorType,
            errorMessage: error.message,
            requestDurationMs: durationMs,
            timestamp: new Date().toISOString(),
            retryable: errorType !== "timeout",
            fallbackUsed: false,
        };

        // Validate our own report
        ModelFailureReportSchema.parse(report);

        return report;
    }

    private inferRole(modelId: string): "policy" | "coder" | "embedding" {
        if (modelId.includes("gemma") || modelId === "policy") return "policy";
        if (modelId.includes("qwen") || modelId.includes("coder") || modelId === "coder") return "coder";
        return "embedding";
    }

    private generateTraceId(): string {
        return `trace_${crypto.randomUUID()}`;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private log(
        level: "debug" | "info" | "warn" | "error",
        message: string,
        metadata?: Record<string, unknown>,
    ): void {
        if (this.config.logRequests) {
            this.eventBus.log(level, `[LocalInference] ${message}`, "LocalInferenceProvider");
        }
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createLocalInferenceProvider(
    config?: Partial<InferenceProviderConfig>,
    eventBus?: EventBus,
): LocalInferenceProvider {
    return new LocalInferenceProvider(config, eventBus);
}
