/**
 * 🧠 PolicyEngine
 *
 * Baseado em FunctionGemma.
 * Responsável por decidir a próxima ação, selecionar tools,
 * classificar intenção, e sinalizar incerteza.
 *
 * Todas as saídas são validadas por Zod antes de retornar.
 */

import * as crypto from "node:crypto";
import { LocalInferenceProvider } from "./LocalInferenceProvider.js";
import { ModelRegistry } from "./ModelRegistry.js";
import {
    ActionDecisionSchema,
    ToolCallProposalSchema,
    EscalationDecisionSchema,
    UncertaintyReportSchema,
    type ActionDecision,
    type ToolCallProposal,
    type EscalationDecision,
    type UncertaintyReport,
} from "./schemas/inference-schemas.js";
import type { InferenceMessage } from "./types/inference-types.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// PolicyEngine
// ============================================================================

export class PolicyEngine {
    private provider: LocalInferenceProvider;
    private registry: ModelRegistry;
    private eventBus: EventBus;

    constructor(
        provider: LocalInferenceProvider,
        registry: ModelRegistry,
        eventBus?: EventBus,
    ) {
        this.provider = provider;
        this.registry = registry;
        this.eventBus = eventBus ?? globalEventBus;
    }

    /**
     * Decide a próxima ação com base no contexto atual.
     * Retorna ActionDecision validado por Zod.
     */
    async decideNextAction(context: string, availableTools?: string[]): Promise<ActionDecision> {
        const model = this.registry.getByRole("policy");
        if (!model) throw new Error("No policy model registered");

        const toolList = availableTools?.length
            ? `\nAvailable tools: ${availableTools.join(", ")}`
            : "";

        const messages: InferenceMessage[] = [
            { role: "system", content: model.systemPrompt ?? "" },
            {
                role: "user",
                content: `Decide the next action for this context.

Context:
${context}
${toolList}

Respond with a JSON object: { "action": "...", "reasoning": "...", "confidence": 0.0-1.0, "requiresRetrieval": bool, "requiresCodeModel": bool }

Valid actions: call_tool, generate_code, retrieve_memory, escalate, summarize, classify, complete, wait`,
            },
        ];

        const response = await this.provider.chat({
            modelId: model.ollamaModel,
            messages,
            temperature: model.defaultTemperature,
            maxTokens: model.maxTokens,
            responseSchema: {},
            traceId: `policy_action_${crypto.randomUUID()}`,
        });

        return this.parseAndValidate(response.content, ActionDecisionSchema, "decideNextAction");
    }

    /**
     * Seleciona a tool mais adequada para o contexto.
     */
    async selectTool(context: string, availableTools: string[]): Promise<ToolCallProposal> {
        const model = this.registry.getByRole("policy");
        if (!model) throw new Error("No policy model registered");

        const messages: InferenceMessage[] = [
            { role: "system", content: model.systemPrompt ?? "" },
            {
                role: "user",
                content: `Select the best tool for this task.

Available tools: ${availableTools.join(", ")}

Context:
${context}

Respond with JSON: { "toolName": "...", "arguments": {...}, "reasoning": "...", "confidence": 0.0-1.0 }`,
            },
        ];

        const response = await this.provider.chat({
            modelId: model.ollamaModel,
            messages,
            temperature: model.defaultTemperature,
            maxTokens: model.maxTokens,
            responseSchema: {},
            traceId: `policy_tool_${crypto.randomUUID()}`,
        });

        return this.parseAndValidate(response.content, ToolCallProposalSchema, "selectTool");
    }

    /**
     * Classifica a intenção de uma entrada.
     */
    async classifyIntent(input: string): Promise<string> {
        const model = this.registry.getByRole("policy");
        if (!model) throw new Error("No policy model registered");

        const messages: InferenceMessage[] = [
            { role: "system", content: model.systemPrompt ?? "" },
            {
                role: "user",
                content: `Classify the intent of this input into one category.

Input: "${input}"

Categories: code_change, bug_fix, question, deployment, test, refactor, documentation, unknown

Respond with JSON: { "intent": "...", "confidence": 0.0-1.0 }`,
            },
        ];

        const response = await this.provider.chat({
            modelId: model.ollamaModel,
            messages,
            temperature: 0.1,
            maxTokens: 128,
            responseSchema: {},
            traceId: `policy_intent_${crypto.randomUUID()}`,
        });

        const parsed = this.safeParseJSON<{ intent?: string }>(response.content);
        return parsed?.intent ?? "unknown";
    }

    /**
     * Decide se precisa recuperar memória semântica.
     */
    async shouldRetrieve(context: string): Promise<{ retrieve: boolean; reasoning: string }> {
        const model = this.registry.getByRole("policy");
        if (!model) return { retrieve: false, reasoning: "No policy model available" };

        const messages: InferenceMessage[] = [
            { role: "system", content: model.systemPrompt ?? "" },
            {
                role: "user",
                content: `Should we retrieve semantic memory for this context?

Context:
${context.slice(0, 500)}

Respond with JSON: { "retrieve": true/false, "reasoning": "..." }`,
            },
        ];

        const response = await this.provider.chat({
            modelId: model.ollamaModel,
            messages,
            temperature: 0.1,
            maxTokens: 256,
            responseSchema: {},
            traceId: `policy_retrieve_${crypto.randomUUID()}`,
        });

        const parsed = this.safeParseJSON<{ retrieve?: boolean; reasoning?: string }>(response.content);
        return {
            retrieve: !!parsed?.retrieve,
            reasoning: parsed?.reasoning ?? "Failed to parse policy response",
        };
    }

    /**
     * Decide se precisa escalar para humano ou outro modelo.
     */
    async shouldEscalate(context: string, errorHistory?: string[]): Promise<EscalationDecision> {
        const model = this.registry.getByRole("policy");
        if (!model) {
            return {
                shouldEscalate: true,
                reason: "No policy model available",
                targetRole: "human",
            };
        }

        const errors = errorHistory?.length
            ? `\nPrevious errors:\n${errorHistory.join("\n")}`
            : "";

        const messages: InferenceMessage[] = [
            { role: "system", content: model.systemPrompt ?? "" },
            {
                role: "user",
                content: `Should this task be escalated?

Context:
${context.slice(0, 500)}
${errors}

Respond with JSON: { "shouldEscalate": bool, "reason": "...", "targetRole": "code_model|human|retry" }`,
            },
        ];

        const response = await this.provider.chat({
            modelId: model.ollamaModel,
            messages,
            temperature: 0.1,
            maxTokens: 256,
            responseSchema: {},
            traceId: `policy_escalate_${crypto.randomUUID()}`,
        });

        return this.parseAndValidate(response.content, EscalationDecisionSchema, "shouldEscalate");
    }

    /**
     * Resume estado operacional de forma estruturada.
     */
    async summarizeState(entries: string[]): Promise<string> {
        const model = this.registry.getByRole("policy");
        if (!model) return "No policy model available for summarization";

        const messages: InferenceMessage[] = [
            { role: "system", content: model.systemPrompt ?? "" },
            {
                role: "user",
                content: `Summarize the current operational state in 2-3 sentences.

Recent entries:
${entries.slice(-5).join("\n")}

Respond with JSON: { "summary": "...", "status": "healthy|degraded|failing", "actionItems": [] }`,
            },
        ];

        const response = await this.provider.chat({
            modelId: model.ollamaModel,
            messages,
            temperature: 0.2,
            maxTokens: 256,
            responseSchema: {},
            traceId: `policy_summary_${crypto.randomUUID()}`,
        });

        const parsed = this.safeParseJSON<{ summary?: string }>(response.content);
        return parsed?.summary ?? response.content.slice(0, 500);
    }

    // ========================================================================
    // Private
    // ========================================================================

    private parseAndValidate<T>(content: string, schema: { parse: (data: unknown) => T }, method: string): T {
        try {
            const parsed = JSON.parse(content);
            return schema.parse(parsed);
        } catch (error) {
            this.log("error", `${method}: Failed to parse/validate output: ${(error as Error).message}`);
            this.log("debug", `Raw output: ${content.slice(0, 300)}`);

            // Try to extract JSON from mixed content
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const extracted = JSON.parse(jsonMatch[0]);
                    return schema.parse(extracted);
                } catch (extractionError) {
                    throw new Error(`PolicyEngine.${method}: Invalid model output (after extraction) — ${(extractionError as Error).message}`);
                }
            }

            throw new Error(`PolicyEngine.${method}: Invalid model output — ${(error as Error).message}`);
        }
    }

    /**
     * Parse JSON seguro sem schema — para métodos que retornam fallback.
     */
    private safeParseJSON<T>(content: string): T | null {
        try {
            return JSON.parse(content) as T;
        } catch (initialError) {
            const match = content.match(/\{[\s\S]*\}/);
            if (match) {
                try {
                    return JSON.parse(match[0]) as T;
                } catch (extractionError) {
                    this.log("warn", `Failed to parse extracted JSON: ${(extractionError as Error).message}`);
                }
            }
            return null;
        }
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[PolicyEngine] ${message}`, "PolicyEngine");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createPolicyEngine(
    provider: LocalInferenceProvider,
    registry: ModelRegistry,
    eventBus?: EventBus,
): PolicyEngine {
    return new PolicyEngine(provider, registry, eventBus);
}
