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
import {
    ModelProviderError,
    type CapabilityProfile,
    type FinishReason,
    type ModelProvider,
    type ModelRequest,
    type ModelResponse,
    type ProviderCallContext,
} from "./ModelProvider.js";

// ============================================================================
// LocalInferenceProvider
// ============================================================================

export class LocalInferenceProvider implements ModelProvider {
    readonly providerId = "ollama-local";
    private config: InferenceProviderConfig;
    private eventBus: EventBus;
    private metrics: Map<string, ModelMetrics> = new Map();
    private requestCounter = 0;

    constructor(config?: Partial<InferenceProviderConfig>, eventBus?: EventBus) {
        const defaults = loadInferenceConfig();
        this.config = { ...defaults, ...config };
        this.eventBus = eventBus ?? globalEventBus;
    }

    getCapabilities(modelId: string): CapabilityProfile {
        const unsupported = {
            declared: false,
            implemented: false,
            verified: false,
        } as const;

        return {
            providerId: this.providerId,
            modelId,
            features: {
                streaming: unsupported,
                tools: unsupported,
                structuredOutput: unsupported,
            },
            limits: {},
            operations: {
                complete: {
                    declared: true,
                    implemented: true,
                    verified: true,
                },
                stream: unsupported,
            },
        };
    }

    async complete(request: ModelRequest, context: ProviderCallContext): Promise<ModelResponse> {
        const capabilities = this.getCapabilities(request.modelId);
        if (request.tools && request.tools.length > 0 && !capabilities.features.tools.implemented) {
            throw new ModelProviderError("Ollama local provider does not implement tools through ModelProvider", {
                kind: "invalid_request",
                retryable: false,
                fallbackAllowed: false,
            });
        }
        if (request.structuredOutput && !capabilities.features.structuredOutput.implemented) {
            throw new ModelProviderError("Ollama local provider does not implement structured output through ModelProvider", {
                kind: "invalid_request",
                retryable: false,
                fallbackAllowed: false,
            });
        }

        const deadlineMs = context.deadline.getTime() - Date.now();
        if (deadlineMs <= 0) {
            throw new ModelProviderError("Model provider call deadline has elapsed", {
                kind: "timeout",
                retryable: false,
                fallbackAllowed: true,
            });
        }

        const controller = new AbortController();
        let abortKind: "timeout" | "cancellation" | undefined;
        const onCallerAbort = () => {
            abortKind = "cancellation";
            controller.abort(context.signal.reason);
        };
        const requestTimeoutMs = Math.max(
            0,
            Math.min(request.requestTimeoutMs ?? Number.POSITIVE_INFINITY, deadlineMs),
        );
        const timeoutId = setTimeout(() => {
            if (!context.signal.aborted) {
                abortKind = "timeout";
                controller.abort();
            }
        }, requestTimeoutMs);

        if (context.signal.aborted) {
            onCallerAbort();
        } else {
            context.signal.addEventListener("abort", onCallerAbort, { once: true });
        }

        try {
            const response = await fetch(`${this.config.ollamaBaseUrl}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: request.modelId,
                    messages: request.messages,
                    stream: false,
                    options: {
                        temperature: request.temperature,
                        num_predict: request.maxTokens,
                    },
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
                throw classifyHttpError(response.status, retryAfterMs);
            }

            let data: unknown;
            try {
                data = await response.json();
            } catch (error) {
                throw new ModelProviderError("Provider returned invalid JSON", {
                    kind: "malformed_response",
                    retryable: false,
                    fallbackAllowed: true,
                    cause: error,
                });
            }

            return normalizeOllamaResponse(request.modelId, data);
        } catch (error) {
            if (error instanceof ModelProviderError) {
                throw error;
            }
            if (abortKind === "cancellation" || context.signal.aborted) {
                throw new ModelProviderError("Model provider call was cancelled", {
                    kind: "cancellation",
                    retryable: false,
                    fallbackAllowed: false,
                    cause: error,
                });
            }
            if (abortKind === "timeout" || isAbortError(error)) {
                throw new ModelProviderError("Model provider call timed out", {
                    kind: "timeout",
                    retryable: false,
                    fallbackAllowed: true,
                    cause: error,
                });
            }
            if (isNetworkError(error)) {
                throw new ModelProviderError("Model provider network request failed", {
                    kind: "network",
                    retryable: true,
                    fallbackAllowed: true,
                    cause: error,
                });
            }
            throw new ModelProviderError("Model provider request failed", {
                kind: "provider",
                retryable: false,
                fallbackAllowed: true,
                cause: error,
            });
        } finally {
            clearTimeout(timeoutId);
            context.signal.removeEventListener("abort", onCallerAbort);
        }
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

        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
                    this.log("warn", `[${traceId}] Embed retry ${attempt}/${this.config.maxRetries} after ${delay}ms`);
                    await this.sleep(delay);
                }

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
                lastError = error as Error;
                const durationMs = Date.now() - startTime;

                this.log("error", `[${traceId}] Embed attempt ${attempt} failed: ${lastError.message}`);
                this.recordMetric(modelId, durationMs, false, false);

                // Don't retry on abort (timeout)
                if (lastError.name === "AbortError") {
                    break;
                }
            }
        }

        // All retries exhausted
        const durationMs = Date.now() - startTime;
        this.log("error", `[${traceId}] All embed retries exhausted for ${modelId}`);

        return {
            vector: [],
            dimension: 0,
            modelId,
            durationMs,
            traceId,
        };
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

function parseRetryAfterMs(value: string | null): number | undefined {
    if (!value) return undefined;

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

    const dateMs = Date.parse(value) - Date.now();
    return Number.isFinite(dateMs) && dateMs >= 0 ? dateMs : undefined;
}

function classifyHttpError(status: number, retryAfterMs?: number): ModelProviderError {
    if (status === 401) {
        return new ModelProviderError("Provider authentication failed", {
            kind: "authentication",
            retryable: false,
            fallbackAllowed: false,
            retryAfterMs,
        });
    }
    if (status === 403) {
        return new ModelProviderError("Provider authorization failed", {
            kind: "authorization",
            retryable: false,
            fallbackAllowed: false,
            retryAfterMs,
        });
    }
    if (status === 400 || status === 422) {
        return new ModelProviderError("Provider rejected the request", {
            kind: "invalid_request",
            retryable: false,
            fallbackAllowed: false,
            retryAfterMs,
        });
    }
    if (status === 429) {
        return new ModelProviderError("Provider rate limit exceeded", {
            kind: "rate_limit",
            retryable: true,
            fallbackAllowed: true,
            retryAfterMs,
        });
    }
    return new ModelProviderError(`Provider unavailable with HTTP ${status}`, {
        kind: "http_unavailable",
        retryable: status >= 500,
        fallbackAllowed: true,
        retryAfterMs,
    });
}

function normalizeOllamaResponse(modelId: string, data: unknown): ModelResponse {
    if (!data || typeof data !== "object") {
        throw new ModelProviderError("Provider response is not an object", {
            kind: "malformed_response",
            retryable: false,
            fallbackAllowed: true,
        });
    }

    const record = data as Record<string, unknown>;
    const message = record.message;
    if (!message || typeof message !== "object") {
        throw new ModelProviderError("Provider response has no message", {
            kind: "malformed_response",
            retryable: false,
            fallbackAllowed: true,
        });
    }

    const messageRecord = message as Record<string, unknown>;
    if (typeof messageRecord.content !== "string") {
        throw new ModelProviderError("Provider response message has no content", {
            kind: "malformed_response",
            retryable: false,
            fallbackAllowed: true,
        });
    }

    const inputTokens = numberOrUndefined(record.prompt_eval_count);
    const outputTokens = numberOrUndefined(record.eval_count);
    const usage = inputTokens !== undefined || outputTokens !== undefined
        ? {
            inputTokens,
            outputTokens,
            totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
        }
        : undefined;

    const rawToolCalls = messageRecord.tool_calls;
    const toolCalls = Array.isArray(rawToolCalls)
        ? rawToolCalls.flatMap((candidate, index) => {
            if (!candidate || typeof candidate !== "object") return [];
            const call = candidate as Record<string, unknown>;
            const functionData = call.function && typeof call.function === "object"
                ? call.function as Record<string, unknown>
                : call;
            if (typeof functionData.name !== "string") return [];
            return [{
                id: typeof call.id === "string" ? call.id : `${modelId}-tool-${index}`,
                name: functionData.name,
                arguments: parseToolArguments(functionData.arguments),
            }];
        })
        : undefined;

    return {
        modelId,
        content: messageRecord.content,
        usage,
        finishReason: normalizeFinishReason(record.done_reason),
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object") return value as Record<string, unknown>;
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
        } catch {
            // The normalized response must remain a JSON object even for a malformed tool payload.
        }
    }
    return {};
}

function normalizeFinishReason(value: unknown): FinishReason {
    if (value === "stop" || value === "length" || value === "tool_call" || value === "content_filter") {
        return value;
    }
    return "unknown";
}

function numberOrUndefined(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

function isNetworkError(error: unknown): boolean {
    return error instanceof TypeError || (error instanceof Error && /fetch|network|connect/i.test(error.message));
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
