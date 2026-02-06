/**
 * 🌐 GatewayOrchestrator
 * 
 * Integrates Gateway (session management) with Orchestrator (task execution).
 * 
 * Design Decision: Wrapper pattern (Gateway CONTAINS Orchestrator)
 * - Gateway handles session lifecycle and routing
 * - Orchestrator handles actual task execution
 * - Clean separation of concerns
 * 
 * OpenClaw-inspired patterns:
 * - Sessions provide isolation
 * - Gateway provides central coordination
 * - Orchestrator provides execution with retry logic
 */

import { Gateway, createGateway, type GatewayConfig } from "../daemon/Gateway.js";
import { Orchestrator, createOrchestrator } from "./Orchestrator.js";
import { SessionManager, type Session } from "./SessionManager.js";
import { type OrchestratorTask, type TaskResult, type OrchestratorConfig, TaskStatus, PersonaType } from "./types.js";
import { EventBus, globalEventBus } from "../daemon/event-bus.js";
import { ArchitectClient, createArchitect, type ArchitectConfig } from "./ArchitectClient.js";
import { MemoryRetriever, createMemoryRetriever, type MemoryConfig } from "./MemoryRetriever.js";
import { WaveExecutor, createWaveExecutor, type WaveConfig } from "./WaveExecutor.js";
import { type WaveTask, type WaveExecutionResult } from "./wave-types.js";
import { AntigravityBridge, createAntigravityBridge, type AntigravityConfig } from "../bridges/AntigravityBridge.js";
import { GeminiCliBridge, createGeminiCliBridge, type GeminiCliConfig } from "../bridges/GeminiCliBridge.js";

export interface GatewayOrchestratorConfig {
    gateway: Partial<GatewayConfig>;
    orchestrator: Partial<OrchestratorConfig>;
    architect: Partial<ArchitectConfig>;
    memory: Partial<MemoryConfig>;
    wave: Partial<WaveConfig>;
    antigravity: Partial<AntigravityConfig>;
    gemini: Partial<GeminiCliConfig>;
}

const DEFAULT_CONFIG: GatewayOrchestratorConfig = {
    gateway: {},
    orchestrator: {},
    architect: {},
    memory: {},
    wave: {},
    antigravity: {},
    gemini: {},
};

/**
 * GatewayOrchestrator - Unified interface for session-aware task execution.
 * 
 * Usage:
 * ```typescript
 * const go = createGatewayOrchestrator();
 * go.initialize(apiKey);
 * go.start();
 * 
 * const result = await go.executeTask("session-123", task);
 * ```
 */
export class GatewayOrchestrator {
    private gateway: Gateway;
    private orchestrator: Orchestrator;
    private sessionManager: SessionManager;
    private architect: ArchitectClient;
    private memory: MemoryRetriever;
    private waveExecutor: WaveExecutor;
    private antigravity: AntigravityBridge;
    private gemini: GeminiCliBridge;
    private eventBus: EventBus;
    private config: GatewayOrchestratorConfig;

    constructor(config: Partial<GatewayOrchestratorConfig> = {}, eventBus?: EventBus) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
        this.gateway = createGateway(this.config.gateway);
        this.orchestrator = createOrchestrator(this.config.orchestrator, this.eventBus);
        this.sessionManager = new SessionManager();
        this.architect = createArchitect(this.config.architect);
        this.memory = createMemoryRetriever(this.config.memory);
        this.waveExecutor = createWaveExecutor(this.orchestrator, this.config.wave);
        this.antigravity = createAntigravityBridge(this.config.antigravity);
        this.gemini = createGeminiCliBridge(this.config.gemini);
    }

    /**
     * Initialize with API key.
     */
    initialize(apiKey: string): void {
        this.orchestrator.initialize(apiKey);
        this.log("info", "✅ GatewayOrchestrator initialized");
    }

    /**
     * Start the gateway daemon.
     */
    start(): void {
        this.gateway.start();
        this.log("info", "🚀 GatewayOrchestrator started");
    }

    /**
     * Stop the gateway daemon.
     */
    stop(): void {
        this.gateway.stop();
        this.log("info", "🛑 GatewayOrchestrator stopped");
    }

    /**
     * Execute a task within a session context.
     * 
     * This is the main entry point for session-aware execution:
     * 1. Gets or creates session
     * 2. Routes to Orchestrator
     * 3. Tracks usage
     * 4. Returns result
     */
    async executeTask(sessionId: string, task: OrchestratorTask): Promise<TaskResult> {
        // 1. Get or create session
        const session = this.sessionManager.getOrCreate({ id: sessionId });
        this.log("info", `📍 Executing in session: ${sessionId}`);

        // 2. Emit task started event
        this.eventBus.emit("task", {
            type: "started",
            sessionId,
            data: { taskId: task.id, persona: task.persona },
        });

        try {
            // 3. Execute via Orchestrator
            const result = await this.orchestrator.loopUntilSuccess(task);

            // 4. Update session with result
            if (result.status === TaskStatus.SUCCESS) {
                this.eventBus.emit("task", {
                    type: "completed",
                    sessionId,
                    data: { taskId: task.id, output: result.output.slice(0, 200) },
                });
            } else {
                this.eventBus.emit("task", {
                    type: "failed",
                    sessionId,
                    data: { taskId: task.id, error: result.error },
                });
            }

            // 5. Touch session to update activity timestamp
            this.sessionManager.touch(sessionId);

            return result;

        } catch (error) {
            this.eventBus.emit("task", {
                type: "failed",
                sessionId,
                data: { taskId: task.id, error: String(error) },
            });
            throw error;
        }
    }

    /**
     * Execute multiple tasks in a session.
     */
    async executeTasks(
        sessionId: string,
        tasks: OrchestratorTask[]
    ): Promise<Map<string, TaskResult>> {
        const results = new Map<string, TaskResult>();

        for (const task of tasks) {
            const result = await this.executeTask(sessionId, task);
            results.set(task.id, result);

            // Stop on failure if task is critical
            if (result.status === TaskStatus.FAILURE || result.status === TaskStatus.NEEDS_HUMAN) {
                this.log("warn", `Task ${task.id} failed, stopping sequence`);
                break;
            }
        }

        return results;
    }

    /**
     * Get session by ID.
     */
    getSession(sessionId: string): Session | undefined {
        return this.sessionManager.get(sessionId);
    }

    /**
     * List active sessions.
     */
    listSessions(): Session[] {
        return this.sessionManager.listActive();
    }

    /**
     * Get gateway status.
     */
    getStatus() {
        return {
            gateway: this.gateway.getStatus(),
            sessions: this.sessionManager.listActive().length,
        };
    }

    /**
     * Pause orchestrator execution.
     */
    pause(): void {
        this.orchestrator.pause();
    }

    /**
     * Resume orchestrator execution.
     */
    resume(): void {
        this.orchestrator.resume();
    }

    // --- ARCHITECT METHODS (Design Review) ---

    /**
     * Consult the Architect for design review.
     */
    async consultArchitect(query: string, files?: string[]): Promise<string> {
        const response = await this.architect.consult(query, { files });
        return response.success ? response.content : `Error: ${response.error}`;
    }

    /**
     * Request spec approval from Architect.
     */
    async approveSpec(specPath: string) {
        return this.architect.approveSpec(specPath);
    }

    // --- MEMORY METHODS (Context Retrieval) ---

    /**
     * Get the memory retriever instance.
     */
    getMemory(): MemoryRetriever {
        return this.memory;
    }

    /**
     * Get relevant context for a task.
     */
    async getRelevantContext(taskPrompt: string): Promise<string> {
        return this.memory.getRelevantContext(taskPrompt);
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, message, "GatewayOrchestrator");
    }

    // --- CLI BRIDGE METHODS (Agent Delegation) ---

    /**
     * Delegate a task to Antigravity (AGY CLI).
     */
    async delegateToAntigravity(prompt: string, context?: string) {
        this.log("info", `🚀 Delegating to Antigravity...`);
        return this.antigravity.task(prompt, context);
    }

    /**
     * Delegate a task to Gemini CLI.
     */
    async delegateToGemini(prompt: string, model: "flash" | "pro" = "flash") {
        this.log("info", `💎 Delegating to Gemini (${model})...`);
        return this.gemini.query(prompt, { model });
    }

    /**
     * Get bridge instances for direct access.
     */
    getBridges() {
        return {
            antigravity: this.antigravity,
            gemini: this.gemini,
        };
    }

    /**
     * Check which CLI agents are available.
     */
    async checkBridgeAvailability() {
        const [agyAvailable, geminiAvailable] = await Promise.all([
            this.antigravity.isAvailable(),
            this.gemini.isAvailable(),
        ]);
        return { antigravity: agyAvailable, gemini: geminiAvailable };
    }
}

/**
 * Factory function.
 */
export function createGatewayOrchestrator(
    config?: Partial<GatewayOrchestratorConfig>
): GatewayOrchestrator {
    return new GatewayOrchestrator(config);
}
