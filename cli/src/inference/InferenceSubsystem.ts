/**
 * 🧬 InferenceSubsystem
 *
 * Facade que amarra todos os componentes da camada de inferência local.
 * Ponto único de inicialização e acesso para o resto do runtime.
 *
 * Ordem de init:
 * 1. LocalInferenceProvider (conexão Ollama)
 * 2. ModelRegistry (registro de modelos)
 * 3. ModelRouter (roteamento de tarefas)
 * 4. Engines (Policy, Coder, Embedding)
 * 5. Memory (MemoryIndexer, SemanticRetriever, SemanticCache, TraceEmbedder)
 * 6. Safety (InferenceGuardrails)
 * 7. Dataset (DatasetPipeline)
 */

import { EventBus, globalEventBus } from "../daemon/event-bus.js";

// Core
import { LocalInferenceProvider, createLocalInferenceProvider } from "./LocalInferenceProvider.js";
import { ModelRegistry, createModelRegistry } from "./ModelRegistry.js";
import { ModelRouter, createModelRouter } from "./ModelRouter.js";
import { DEFAULT_MODELS } from "./inference-config.js";
import {
    CredentialRegistry,
    CredentialedProviderInvoker,
} from "./provider-security.js";
import { ProviderResilience, type ProviderResilienceOptions } from "./provider-resilience.js";

// Engines
import { PolicyEngine, createPolicyEngine } from "./PolicyEngine.js";
import { CodeWorker, createCodeWorker } from "./CodeWorker.js";
import { EmbeddingEngine, createEmbeddingEngine } from "./EmbeddingEngine.js";

// Memory & Retrieval
import { MemoryIndexer, createMemoryIndexer } from "./MemoryIndexer.js";
import { SemanticRetriever, createSemanticRetriever } from "./SemanticRetriever.js";
import { SemanticCache, createSemanticCache } from "./SemanticCache.js";
import { TraceEmbedder, createTraceEmbedder } from "./TraceEmbedder.js";
import { RetrievalPolicy, createRetrievalPolicy } from "./RetrievalPolicy.js";

// Safety & Quality
import { InferenceGuardrails, createInferenceGuardrails } from "./InferenceGuardrails.js";

// Dataset & Benchmark
import { DatasetPipeline, createDatasetPipeline } from "./DatasetPipeline.js";
import { LocalBenchmark, createLocalBenchmark, type BenchmarkReport } from "./LocalBenchmark.js";

import type { InferenceProviderConfig } from "./types/inference-types.js";

// ============================================================================
// Types
// ============================================================================

export interface InferenceSubsystemConfig {
    /** Override de config do provider (Ollama URL, timeouts, etc.) */
    provider?: Partial<InferenceProviderConfig>;
    /** Diretório raiz do projeto (para persistência de memória) */
    projectRoot?: string;
    /** Diretório de estado local para a identidade estável de credential scopes */
    stateDir?: string;
    /** Registry opcional injetado pela camada superior de credenciais */
    credentialRegistry?: CredentialRegistry;
    /** Política comum de retry, quota e circuit breaker para a provider boundary */
    resilience?: ProviderResilienceOptions;
}

export interface InferenceStatus {
    ready: boolean;
    ollamaHealthy: boolean;
    models: Array<{ id: string; name: string; role: string; available: boolean }>;
    memoryEntries: number;
    cacheStats: { size: number; hitRate: number };
    metrics: Record<string, { totalRequests: number; avgDurationMs: number; validJSONRate: number }>;
}

// ============================================================================
// InferenceSubsystem
// ============================================================================

export class InferenceSubsystem {
    private provider!: LocalInferenceProvider;
    private credentialRegistry: CredentialRegistry;
    private credentialedInvoker!: CredentialedProviderInvoker;
    private resilience!: ProviderResilience;
    private registry!: ModelRegistry;
    private router!: ModelRouter;

    private policy!: PolicyEngine;
    private coder!: CodeWorker;
    private embedding!: EmbeddingEngine;

    private indexer!: MemoryIndexer;
    private retriever!: SemanticRetriever;
    private cache!: SemanticCache;
    private traceEmbedder!: TraceEmbedder;
    private retrievalPolicy!: RetrievalPolicy;

    private guardrails!: InferenceGuardrails;
    private dataset!: DatasetPipeline;
    private benchmark!: LocalBenchmark;

    private eventBus: EventBus;
    private config: InferenceSubsystemConfig;
    private initialized = false;

    constructor(config?: InferenceSubsystemConfig, eventBus?: EventBus) {
        this.config = config ?? {};
        this.eventBus = eventBus ?? globalEventBus;
        this.credentialRegistry = this.config.credentialRegistry ?? new CredentialRegistry({
            projectRoot: this.config.projectRoot ?? process.cwd(),
            stateDir: this.config.stateDir ?? ".ouroboros",
        });
    }

    /**
     * Inicializa todos os componentes de inferência.
     * Retorna status de disponibilidade dos modelos.
     */
    async initialize(): Promise<{ ready: boolean; availableModels: string[] }> {
        if (this.initialized) {
            this.log("warn", "Already initialized, skipping");
            return { ready: true, availableModels: this.getAvailableModelIds() };
        }

        this.log("info", "Initializing inference subsystem...");

        // 1. Provider (Ollama connection)
        this.provider = createLocalInferenceProvider(this.config.provider, this.eventBus);
        this.resilience = new ProviderResilience(this.config.resilience);
        this.credentialedInvoker = new CredentialedProviderInvoker(
            this.provider,
            this.credentialRegistry,
            this.eventBus,
            undefined,
            this.resilience,
        );

        // 2. Check Ollama health
        const healthy = await this.provider.isHealthy();
        if (!healthy) {
            this.log("warn", "Ollama is not reachable — inference will be unavailable");
            this.initialized = false;
            return { ready: false, availableModels: [] };
        }

        // 3. Model Registry
        this.registry = createModelRegistry(this.provider, this.eventBus, DEFAULT_MODELS);

        // 4. Check model availability
        const availability = await this.registry.checkAllAvailability();
        const availableModels: string[] = [];
        for (const [id, available] of availability) {
            if (available) availableModels.push(id);
        }

        if (availableModels.length === 0) {
            this.log("warn", "No models available in Ollama — inference will be limited");
        }

        // 5. Router
        this.router = createModelRouter(this.registry, this.eventBus);

        // 6. Engines
        this.policy = createPolicyEngine(this.provider, this.registry, this.eventBus);
        this.coder = createCodeWorker(this.provider, this.registry, this.eventBus);
        this.embedding = createEmbeddingEngine(this.provider, this.registry, this.eventBus);

        // 7. Memory & Retrieval
        this.retrievalPolicy = createRetrievalPolicy(undefined, this.eventBus);
        this.indexer = createMemoryIndexer(this.embedding, this.retrievalPolicy, undefined, this.eventBus);
        this.retriever = createSemanticRetriever(this.embedding, this.indexer, this.retrievalPolicy, this.eventBus);
        this.cache = createSemanticCache(this.embedding, undefined, this.eventBus);
        this.traceEmbedder = createTraceEmbedder(this.embedding, this.eventBus);

        // 8. Initialize memory persistence
        const projectRoot = this.config.projectRoot ?? process.cwd();
        await this.indexer.initialize(projectRoot);

        // 9. Safety
        this.guardrails = createInferenceGuardrails(this.eventBus);

        // 10. Dataset & Benchmark
        this.dataset = createDatasetPipeline(this.eventBus);
        this.benchmark = createLocalBenchmark(this.provider, this.registry, this.embedding, this.eventBus);

        this.initialized = true;
        this.log("info", `Inference subsystem ready — ${availableModels.length}/${DEFAULT_MODELS.length} models available`);
        this.log("info", this.registry.getSummary());

        return { ready: true, availableModels };
    }

    // ========================================================================
    // Status
    // ========================================================================

    isReady(): boolean {
        return this.initialized;
    }

    async getStatus(): Promise<InferenceStatus> {
        if (!this.initialized) {
            return {
                ready: false,
                ollamaHealthy: false,
                models: [],
                memoryEntries: 0,
                cacheStats: { size: 0, hitRate: 0 },
                metrics: {},
            };
        }

        const ollamaHealthy = await this.provider.isHealthy();
        const availability = await this.registry.checkAllAvailability();

        const models = this.registry.listAll().map(m => ({
            id: m.id,
            name: m.name,
            role: m.role,
            available: availability.get(m.id) ?? false,
        }));

        const cacheStats = this.cache.getStats();
        const memoryStats = this.indexer.getStats();

        const metricsMap = this.provider.getMetrics();
        const metrics: InferenceStatus["metrics"] = {};
        for (const [id, m] of metricsMap) {
            metrics[id] = {
                totalRequests: m.totalRequests,
                avgDurationMs: Math.round(m.avgDurationMs),
                validJSONRate: Math.round(m.validJSONRate * 100) / 100,
            };
        }

        return {
            ready: this.initialized,
            ollamaHealthy,
            models,
            memoryEntries: memoryStats.totalEntries,
            cacheStats: { size: cacheStats.size, hitRate: Math.round(cacheStats.hitRate * 100) / 100 },
            metrics,
        };
    }

    // ========================================================================
    // Accessors
    // ========================================================================

    getProvider(): LocalInferenceProvider { return this.provider; }
    getCredentialRegistry(): CredentialRegistry { return this.credentialRegistry; }
    getCredentialedInvoker(): CredentialedProviderInvoker { return this.credentialedInvoker; }
    getResilience(): ProviderResilience { return this.resilience; }
    getRegistry(): ModelRegistry { return this.registry; }
    getRouter(): ModelRouter { return this.router; }
    getPolicy(): PolicyEngine { return this.policy; }
    getCoder(): CodeWorker { return this.coder; }
    getEmbedding(): EmbeddingEngine { return this.embedding; }
    getRetriever(): SemanticRetriever { return this.retriever; }
    getCache(): SemanticCache { return this.cache; }
    getIndexer(): MemoryIndexer { return this.indexer; }
    getTraceEmbedder(): TraceEmbedder { return this.traceEmbedder; }
    getGuardrails(): InferenceGuardrails { return this.guardrails; }
    getDataset(): DatasetPipeline { return this.dataset; }

    // ========================================================================
    // High-Level Operations
    // ========================================================================

    /**
     * Executa benchmark completo dos modelos locais.
     */
    async runBenchmark(): Promise<BenchmarkReport> {
        this.ensureReady();
        return this.benchmark.run();
    }

    /**
     * Persiste memória semântica em disco.
     */
    async persistMemory(): Promise<void> {
        this.ensureReady();
        const projectRoot = this.config.projectRoot ?? process.cwd();
        await this.indexer.persist(projectRoot);
    }

    /**
     * Exporta dataset de traces para fine-tuning futuro.
     */
    async exportDataset(outputPath: string): Promise<number> {
        this.ensureReady();
        return this.dataset.export(outputPath);
    }

    // ========================================================================
    // Private
    // ========================================================================

    private ensureReady(): void {
        if (!this.initialized) {
            throw new Error("InferenceSubsystem not initialized. Call initialize() first.");
        }
    }

    private getAvailableModelIds(): string[] {
        return this.registry.listEnabled().map(m => m.id);
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, `[InferenceSubsystem] ${message}`, "InferenceSubsystem");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createInferenceSubsystem(
    config?: InferenceSubsystemConfig,
    eventBus?: EventBus,
): InferenceSubsystem {
    return new InferenceSubsystem(config, eventBus);
}
