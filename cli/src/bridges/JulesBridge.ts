/**
 * 🌐 JulesBridge - REST API client for Jules
 * 
 * Async worker for GitHub-based tasks via Jules REST API.
 * Creates sessions that result in Pull Requests.
 * 
 * Usage:
 * ```typescript
 * const bridge = createJulesBridge({ apiKey: process.env.JULES_API_KEY });
 * const sources = await bridge.listSources();
 * const session = await bridge.createSession("Add unit tests", sources[0].name);
 * const result = await bridge.waitForCompletion(session.id);
 * console.log(result.outputs?.[0]?.pullRequest?.url);
 * ```
 */

import { EventBus, globalEventBus } from "../daemon/event-bus.js";
import {
    type JulesConfig,
    type JulesSession,
    type JulesSource,
    type JulesActivity,
    type JulesTaskResult,
    type CreateSessionRequest,
    type ListSessionsResponse,
    type ListSourcesResponse,
    type ListActivitiesResponse,
    type JulesApiError,
    DEFAULT_JULES_CONFIG,
    JULES_TERMINAL_STATES,
    JULES_WAITING_STATES,
} from "./jules-types.js";

export type { JulesConfig, JulesSession, JulesSource, JulesTaskResult } from "./jules-types.js";

// ============================================================================
// Bridge
// ============================================================================

export class JulesBridge {
    private config: JulesConfig;
    private eventBus: EventBus;

    constructor(config: Partial<JulesConfig> & { apiKey: string }, eventBus?: EventBus) {
        this.config = { ...DEFAULT_JULES_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
    }

    // ========================================================================
    // Core API Methods
    // ========================================================================

    /**
     * List available sources (connected GitHub repos)
     */
    async listSources(): Promise<JulesSource[]> {
        const response = await this.request<ListSourcesResponse>("GET", "/sources");
        return response.sources ?? [];
    }

    /**
     * Create a new session
     */
    async createSession(prompt: string, source?: string, title?: string): Promise<JulesSession> {
        const sourceToUse = source ?? this.config.defaultSource;
        if (!sourceToUse) {
            throw new Error("No source specified and no defaultSource configured");
        }

        const body: CreateSessionRequest = {
            prompt,
            title,
            sourceContext: {
                source: sourceToUse,
                githubRepoContext: {
                    startingBranch: this.config.defaultBranch ?? "main",
                },
            },
            requirePlanApproval: this.config.requirePlanApproval,
            automationMode: this.config.automationMode,
        };

        this.log("info", `Creating Jules session: "${prompt.slice(0, 50)}..."`);
        const session = await this.request<JulesSession>("POST", "/sessions", body);
        this.log("info", `Session created: ${session.url}`);
        return session;
    }

    /**
     * Get session by ID
     */
    async getSession(sessionId: string): Promise<JulesSession> {
        return this.request<JulesSession>("GET", `/sessions/${sessionId}`);
    }

    /**
     * List all sessions
     */
    async listSessions(pageSize = 20): Promise<JulesSession[]> {
        const response = await this.request<ListSessionsResponse>(
            "GET",
            `/sessions?pageSize=${pageSize}`
        );
        return response.sessions ?? [];
    }

    /**
     * Delete a session
     */
    async deleteSession(sessionId: string): Promise<void> {
        await this.request("DELETE", `/sessions/${sessionId}`);
    }

    /**
     * Approve the current plan
     */
    async approvePlan(sessionId: string): Promise<void> {
        this.log("info", `Approving plan for session ${sessionId}`);
        await this.request("POST", `/sessions/${sessionId}:approvePlan`);
    }

    /**
     * Send a message to the agent
     */
    async sendMessage(sessionId: string, message: string): Promise<void> {
        await this.request("POST", `/sessions/${sessionId}:sendMessage`, { prompt: message });
    }

    /**
     * List activities in a session
     */
    async listActivities(sessionId: string, pageSize = 30): Promise<JulesActivity[]> {
        const response = await this.request<ListActivitiesResponse>(
            "GET",
            `/sessions/${sessionId}/activities?pageSize=${pageSize}`
        );
        return response.activities ?? [];
    }

    // ========================================================================
    // High-Level Methods
    // ========================================================================

    /**
     * Poll for session completion
     */
    async waitForCompletion(sessionId: string): Promise<JulesSession> {
        const { pollIntervalMs, maxPollAttempts } = this.config;
        let attempts = 0;

        this.log("info", `Waiting for session ${sessionId} to complete...`);

        while (attempts < maxPollAttempts) {
            const session = await this.getSession(sessionId);

            if (JULES_TERMINAL_STATES.includes(session.state)) {
                this.log("info", `Session ${sessionId} finished with state: ${session.state}`);
                return session;
            }

            if (JULES_WAITING_STATES.includes(session.state)) {
                if (session.state === "AWAITING_PLAN_APPROVAL" && !this.config.requirePlanApproval) {
                    // Auto-approve if configured
                    await this.approvePlan(sessionId);
                } else {
                    this.log("warn", `Session ${sessionId} waiting for user: ${session.state}`);
                }
            }

            attempts++;
            this.log("debug", `Poll ${attempts}/${maxPollAttempts}: state=${session.state}`);
            await this.sleep(pollIntervalMs);
        }

        throw new Error(`Timeout waiting for session ${sessionId} after ${maxPollAttempts} attempts`);
    }

    /**
     * Execute a task end-to-end: create session and wait for result
     */
    async executeTask(prompt: string, source?: string): Promise<JulesTaskResult> {
        const startTime = Date.now();

        try {
            const session = await this.createSession(prompt, source);
            const finalSession = await this.waitForCompletion(session.id);

            const pullRequestUrl = finalSession.outputs?.[0]?.pullRequest?.url;

            return {
                session: finalSession,
                success: finalSession.state === "COMPLETED",
                pullRequestUrl,
                durationMs: Date.now() - startTime,
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log("error", `Task execution failed: ${errorMsg}`);
            return {
                session: {} as JulesSession,
                success: false,
                error: errorMsg,
                durationMs: Date.now() - startTime,
            };
        }
    }

    /**
     * Check if Jules API is accessible
     */
    async isAvailable(): Promise<boolean> {
        try {
            await this.listSources();
            return true;
        } catch {
            return false;
        }
    }

    // ========================================================================
    // HTTP Client
    // ========================================================================

    private async request<T>(
        method: "GET" | "POST" | "DELETE",
        path: string,
        body?: unknown
    ): Promise<T> {
        const url = `${this.config.baseUrl}${path}`;
        const headers: Record<string, string> = {
            "x-goog-api-key": this.config.apiKey,
            "Content-Type": "application/json",
        };

        const options: RequestInit = {
            method,
            headers,
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);

        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}`;
            try {
                const errorData = (await response.json()) as JulesApiError;
                errorMessage = errorData.error?.message ?? errorMessage;
            } catch {
                // Ignore JSON parse errors
            }
            throw new Error(`Jules API error: ${errorMessage}`);
        }

        // Handle empty responses (e.g., DELETE, approvePlan)
        const text = await response.text();
        if (!text) {
            return {} as T;
        }

        return JSON.parse(text) as T;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private log(level: "debug" | "info" | "warn" | "error", message: string): void {
        this.eventBus.log(level, message, "JulesBridge");
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createJulesBridge(
    config: Partial<JulesConfig> & { apiKey: string }
): JulesBridge {
    return new JulesBridge(config);
}
