/**
 * 🔧 CodeWorker
 *
 * Baseado em Qwen2.5-Coder-0.5B-Instruct.
 * Gera patches pequenos, locais, validáveis.
 * Nunca aplica mudanças — sempre proposta ao runtime.
 */

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

        // Truncate file content to avoid overwhelming small model
        const truncatedContent = fileContent.length > 3000
            ? fileContent.slice(0, 3000) + "\n... (truncated)"
            : fileContent;

        const contextSection = context
            ? `\nAdditional Context:\n${context.slice(0, 500)}`
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
            traceId: `coder_patch_${Date.now()}`,
        });

        return this.parseAndValidate(response.content, PatchProposalSchema, "generatePatch");
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
            ? `\nSource file (${sourceFile}):\n\`\`\`\n${sourceContent.slice(0, 2000)}\n\`\`\``
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
${testContent.slice(0, 2000)}
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
            traceId: `coder_testfix_${Date.now()}`,
        });

        return this.parseAndValidate(response.content, TestFixResultSchema, "fixTest");
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
${code.slice(0, 2000)}
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
            traceId: `coder_explain_${Date.now()}`,
        });

        try {
            const parsed = JSON.parse(response.content);
            return {
                explanation: parsed.explanation ?? response.content.slice(0, 300),
                complexity: parsed.complexity ?? "unknown",
            };
        } catch {
            return { explanation: response.content.slice(0, 300), complexity: "unknown" };
        }
    }

    // ========================================================================
    // Private
    // ========================================================================

    private parseAndValidate<T>(content: string, schema: { parse: (data: unknown) => T }, method: string): T {
        try {
            const parsed = JSON.parse(content);
            return schema.parse(parsed);
        } catch (error) {
            this.log("error", `${method}: Failed to parse/validate: ${(error as Error).message}`);

            // Try to extract JSON from mixed content
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const extracted = JSON.parse(jsonMatch[0]);
                    return schema.parse(extracted);
                } catch {
                    // Fall through
                }
            }

            throw new Error(`CodeWorker.${method}: Invalid model output — ${(error as Error).message}`);
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
