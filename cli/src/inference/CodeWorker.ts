/**
 * 🔧 CodeWorker
 *
 * Baseado em Qwen2.5-Coder-0.5B-Instruct.
 * Gera patches pequenos, locais, validáveis.
 * Nunca aplica mudanças — sempre proposta ao runtime.
 */

import * as crypto from "node:crypto";
import { LocalInferenceProvider } from "./LocalInferenceProvider.js";
import { ModelRegistry } from "./ModelRegistry.js";
import {
    PatchProposalSchema,
    TestFixResultSchema,
    type PatchProposal,
    type TestFixResult,
} from "./schemas/inference-schemas.js";
import type { InferenceMessage } from "./types/inference-types.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// Constants
// ============================================================================

/** Limite de conteúdo de arquivo para o prompt (evitar sobrecarregar modelos pequenos) */
const MAX_FILE_CONTENT_LENGTH = 3000;
/** Limite de contexto adicional no prompt */
const MAX_CONTEXT_LENGTH = 500;
/** Limite de conteúdo de código para explicação */
const MAX_EXPLAIN_LENGTH = 2000;
/** Limite de conteúdo de teste no prompt */
const MAX_TEST_CONTENT_LENGTH = 2000;
/** Limite de conteúdo de source no prompt */
const MAX_SOURCE_CONTENT_LENGTH = 2000;
/** Limite de fallback para explicação textual */
const MAX_EXPLANATION_FALLBACK_LENGTH = 300;

// ============================================================================
// Types
// ============================================================================

interface ParseResult<T> {
    success: boolean;
    data?: T;
    error?: string;
}

// ============================================================================
// CodeWorker
// ============================================================================

export class CodeWorker {
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
     * Gera uma proposta de patch para um arquivo.
     * Nunca aplica — retorna PatchProposal validado.
     */
    async generatePatch(
        filePath: string,
        instruction: string,
        fileContent: string,
        context?: string,
    ): Promise<PatchProposal> {
        const model = this.registry.getByRole("coder");
        if (!model) throw new Error("No coder model registered");

        const truncatedContent = fileContent.length > MAX_FILE_CONTENT_LENGTH
            ? fileContent.slice(0, MAX_FILE_CONTENT_LENGTH) + "\n... (truncated)"
            : fileContent;

        const contextSection = context
            ? `\nAdditional Context:\n${context.slice(0, MAX_CONTEXT_LENGTH)}`
            : "";

        const messages: InferenceMessage[] = [
            { role: "system", content: model.systemPrompt ?? "" },
            {
                role: "user",
                content: `Generate a minimal code patch.

File: ${filePath}
Instruction: ${instruction}
${contextSection}

Current file content:
\`\`\`
${truncatedContent}
\`\`\`

Respond with JSON:
{
  "filePath": "${filePath}",
  "originalSnippet": "exact lines to replace",
  "patchedSnippet": "replacement lines",
  "explanation": "what changed and why",
  "changeType": "fix|refactor|feature|test|docs",
  "confidence": 0.0-1.0,
  "affectsTests": true/false,
  "suggestedTests": ["optional test suggestions"]
}`,
            },
        ];

        const response = await this.provider.chat({
            modelId: model.ollamaModel,
            messages,
            temperature: model.defaultTemperature,
            maxTokens: model.maxTokens,
            responseSchema: {},
            traceId: `coder_patch_${crypto.randomUUID()}`,
        });

        const result = this.safeParseAndValidate(response.content, PatchProposalSchema, "generatePatch");
        if (!result.success) {
            throw new Error(`CodeWorker.generatePatch: ${result.error}`);
        }
        return result.data!;
    }

    /**
     * Propõe correção para um teste falhando.
     */
    async fixTest(
        testFile: string,
        testContent: string,
        errorMessage: string,
        sourceFile?: string,
        sourceContent?: string,
    ): Promise<TestFixResult> {
        const model = this.registry.getByRole("coder");
        if (!model) throw new Error("No coder model registered");

        const sourceSection = sourceFile && sourceContent
            ? `\nSource file (${sourceFile}):\n\`\`\`\n${sourceContent.slice(0, MAX_SOURCE_CONTENT_LENGTH)}\n\`\`\``
            : "";

        const messages: InferenceMessage[] = [
            { role: "system", content: model.systemPrompt ?? "" },
            {
                role: "user",
                content: `Fix this failing test.

Test file: ${testFile}
Error: ${errorMessage}

Test content:
\`\`\`
${testContent.slice(0, MAX_TEST_CONTENT_LENGTH)}
\`\`\`
${sourceSection}

Respond with JSON:
{
  "testFile": "${testFile}",
  "originalError": "...",
  "fix": {
    "filePath": "...",
    "originalSnippet": "...",
    "patchedSnippet": "...",
    "explanation": "...",
    "changeType": "fix",
    "confidence": 0.0-1.0,
    "affectsTests": true,
    "suggestedTests": []
  },
  "wasSuccessful": true/false
}`,
            },
        ];

        const response = await this.provider.chat({
            modelId: model.ollamaModel,
            messages,
            temperature: model.defaultTemperature,
            maxTokens: model.maxTokens,
            responseSchema: {},
            traceId: `coder_testfix_${crypto.randomUUID()}`,
        });

        const result = this.safeParseAndValidate(response.content, TestFixResultSchema, "fixTest");
        if (!result.success) {
            throw new Error(`CodeWorker.fixTest: ${result.error}`);
        }
        return result.data!;
    }

    /**
     * Gera explicação estruturada de um trecho de código.
     */
    async explain(code: string, filePath?: string): Promise<{ explanation: string; complexity: string }> {
        const model = this.registry.getByRole("coder");
        if (!model) return { explanation: "No coder model available", complexity: "unknown" };

        const messages: InferenceMessage[] = [
            { role: "system", content: model.systemPrompt ?? "" },
            {
                role: "user",
                content: `Explain this code briefly.
${filePath ? `File: ${filePath}` : ""}

\`\`\`
${code.slice(0, MAX_EXPLAIN_LENGTH)}
\`\`\`

Respond with JSON: { "explanation": "2-3 sentence summary", "complexity": "low|medium|high" }`,
            },
        ];

        const response = await this.provider.chat({
            modelId: model.ollamaModel,
            messages,
            temperature: 0.2,
            maxTokens: 256,
            responseSchema: {},
            traceId: `coder_explain_${crypto.randomUUID()}`,
        });

        const result = this.safeParseJSON<{ explanation?: string; complexity?: string }>(response.content);
        return {
            explanation: result?.explanation ?? response.content.slice(0, MAX_EXPLANATION_FALLBACK_LENGTH),
            complexity: result?.complexity ?? "unknown",
        };
    }

    // ========================================================================
    // Private
    // ========================================================================

    /**
     * Parse + validate com retorno de resultado (sem throw).
     * Padrão consistente para todos os métodos.
     */
    private safeParseAndValidate<T>(
        content: string,
        schema: { parse: (data: unknown) => T },
        method: string,
    ): ParseResult<T> {
        try {
            const parsed = JSON.parse(content);
            return { success: true, data: schema.parse(parsed) };
        } catch (error) {
            this.log("error", `${method}: Failed to parse/validate: ${(error as Error).message}`);

            // Try to extract JSON from mixed content
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const extracted = JSON.parse(jsonMatch[0]);
                    return { success: true, data: schema.parse(extracted) };
                } catch {
                    // Fall through
                }
            }

            return { success: false, error: `Invalid model output — ${(error as Error).message}` };
        }
    }

    /**
     * Parse JSON sem schema — para métodos que retornam fallback.
     */
    private safeParseJSON<T>(content: string): T | null {
        try {
            return JSON.parse(content) as T;
        } catch {
            const match = content.match(/\{[\s\S]*\}/);
            if (match) {
                try { return JSON.parse(match[0]) as T; } catch { /* ignore */ }
            }
            return null;
        }
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[CodeWorker] ${message}`, "CodeWorker");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createCodeWorker(
    provider: LocalInferenceProvider,
    registry: ModelRegistry,
    eventBus?: EventBus,
): CodeWorker {
    return new CodeWorker(provider, registry, eventBus);
}
