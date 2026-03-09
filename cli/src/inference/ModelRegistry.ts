/**
 * 📋 ModelRegistry
 *
 * Registro declarativo de modelos disponíveis para inferência local.
 * Identifica papel, capacidades, configuração e estado de cada modelo.
 */

import type { ModelConfig, ModelRole, ModelCapability } from "./types/inference-types.js";
import { DEFAULT_MODELS } from "./inference-config.js";
import { LocalInferenceProvider } from "./LocalInferenceProvider.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// ============================================================================
// ModelRegistry
// ============================================================================

export class ModelRegistry {
    private models: Map<string, ModelConfig> = new Map();
    private provider: LocalInferenceProvider;
    private eventBus: EventBus;

    constructor(
        provider: LocalInferenceProvider,
        eventBus?: EventBus,
        initialModels?: ModelConfig[],
    ) {
        this.provider = provider;
        this.eventBus = eventBus ?? globalEventBus;

        // Register default models
        const models = initialModels ?? DEFAULT_MODELS;
        for (const model of models) {
            this.register(model);
        }
    }

    // ========================================================================
    // Registration
    // ========================================================================

    /**
     * Registra um modelo com sua configuração.
     */
    register(config: ModelConfig): void {
        this.models.set(config.id, config);
        this.log("info", `Registered model: ${config.name} (${config.id}) as ${config.role}`);
    }

    /**
     * Remove um modelo do registro.
     */
    unregister(modelId: string): boolean {
        const removed = this.models.delete(modelId);
        if (removed) {
            this.log("info", `Unregistered model: ${modelId}`);
        }
        return removed;
    }

    // ========================================================================
    // Queries
    // ========================================================================

    /**
     * Busca modelo por ID.
     */
    get(modelId: string): ModelConfig | undefined {
        return this.models.get(modelId);
    }

    /**
     * Busca modelo por papel (policy, coder, embedding).
     * Retorna o primeiro modelo habilitado com esse papel.
     */
    getByRole(role: ModelRole): ModelConfig | undefined {
        for (const model of this.models.values()) {
            if (model.role === role && model.enabled) {
                return model;
            }
        }
        return undefined;
    }

    /**
     * Busca modelos que possuem uma capacidade específica.
     */
    getByCapability(capability: ModelCapability): ModelConfig[] {
        return Array.from(this.models.values()).filter(
            m => m.enabled && m.capabilities.includes(capability),
        );
    }

    /**
     * Lista todos os modelos registrados.
     */
    listAll(): ModelConfig[] {
        return Array.from(this.models.values());
    }

    /**
     * Lista modelos habilitados.
     */
    listEnabled(): ModelConfig[] {
        return Array.from(this.models.values()).filter(m => m.enabled);
    }

    /**
     * Retorna o nome Ollama do modelo.
     */
    getOllamaModel(modelId: string): string | undefined {
        return this.models.get(modelId)?.ollamaModel;
    }

    // ========================================================================
    // Health & Availability
    // ========================================================================

    /**
     * Verifica se um modelo está disponível no Ollama.
     */
    async isAvailable(modelId: string): Promise<boolean> {
        const config = this.models.get(modelId);
        if (!config || !config.enabled) return false;

        return this.provider.isModelAvailable(config.ollamaModel);
    }

    /**
     * Verifica disponibilidade de todos os modelos registrados.
     */
    async checkAllAvailability(): Promise<Map<string, boolean>> {
        const results = new Map<string, boolean>();

        for (const [id, config] of this.models) {
            if (!config.enabled) {
                results.set(id, false);
                continue;
            }
            const available = await this.provider.isModelAvailable(config.ollamaModel);
            results.set(id, available);

            if (!available) {
                this.log("warn", `Model ${config.name} (${config.ollamaModel}) not available in Ollama`);
            }
        }

        return results;
    }

    /**
     * Retorna resumo do registry para logs/debug.
     */
    getSummary(): string {
        const lines: string[] = ["=== Model Registry ==="];
        for (const model of this.models.values()) {
            const status = model.enabled ? "✅" : "❌";
            lines.push(`${status} ${model.name} (${model.id}) → ${model.ollamaModel} [${model.role}]`);
            lines.push(`   Capabilities: ${model.capabilities.join(", ")}`);
        }
        return lines.join("\n");
    }

    // ========================================================================
    // Private
    // ========================================================================

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[ModelRegistry] ${message}`, "ModelRegistry");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createModelRegistry(
    provider: LocalInferenceProvider,
    eventBus?: EventBus,
    models?: ModelConfig[],
): ModelRegistry {
    return new ModelRegistry(provider, eventBus, models);
}
