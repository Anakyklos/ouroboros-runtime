/**
 * 🌐 Jules API Types
 * 
 * Type definitions for the Jules REST API (v1alpha)
 * https://jules.google/docs/api/reference/
 */

// ============================================================================
// Session States
// ============================================================================

export type JulesSessionState =
    | "QUEUED"
    | "PLANNING"
    | "AWAITING_PLAN_APPROVAL"
    | "AWAITING_USER_FEEDBACK"
    | "IN_PROGRESS"
    | "PAUSED"
    | "COMPLETED"
    | "FAILED";

export const JULES_TERMINAL_STATES: JulesSessionState[] = ["COMPLETED", "FAILED"];
export const JULES_WAITING_STATES: JulesSessionState[] = ["AWAITING_PLAN_APPROVAL", "AWAITING_USER_FEEDBACK"];

// ============================================================================
// API Resources
// ============================================================================

export interface JulesSource {
    name: string;       // e.g., "sources/github/owner/repo"
    id: string;         // e.g., "github/owner/repo"
    githubRepo?: {
        owner: string;
        repo: string;
    };
}

export interface JulesSourceContext {
    source: string;     // e.g., "sources/github/owner/repo"
    githubRepoContext?: {
        startingBranch: string;
    };
}

export interface JulesPullRequest {
    url: string;
    title: string;
    description?: string;
}

export interface JulesOutput {
    pullRequest?: JulesPullRequest;
}

export interface JulesSession {
    name: string;           // e.g., "sessions/1234567"
    id: string;             // e.g., "1234567"
    title?: string;
    prompt: string;
    state: JulesSessionState;
    url: string;            // Web UI URL
    sourceContext?: JulesSourceContext;
    outputs?: JulesOutput[];
    createTime?: string;
    updateTime?: string;
}

export interface JulesActivity {
    name: string;
    type: "USER_MESSAGE" | "AGENT_MESSAGE" | "PLAN" | "PROGRESS" | "ERROR";
    content?: string;
    createTime?: string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export type JulesAutomationMode = "AUTO_CREATE_PR" | "MANUAL";

export interface CreateSessionRequest {
    prompt: string;
    title?: string;
    sourceContext: JulesSourceContext;
    requirePlanApproval?: boolean;
    automationMode?: JulesAutomationMode;
}

export interface ListSessionsResponse {
    sessions: JulesSession[];
    nextPageToken?: string;
}

export interface ListSourcesResponse {
    sources: JulesSource[];
    nextPageToken?: string;
}

export interface ListActivitiesResponse {
    activities: JulesActivity[];
    nextPageToken?: string;
}

export interface SendMessageRequest {
    prompt: string;
}

export interface JulesApiError {
    error: {
        code: number;
        message: string;
        status: string;
    };
}

// ============================================================================
// Bridge Configuration
// ============================================================================

export interface JulesConfig {
    apiKey: string;
    baseUrl: string;
    defaultSource?: string;         // Default GitHub source
    defaultBranch?: string;         // Default starting branch
    pollIntervalMs: number;         // Polling interval
    maxPollAttempts: number;        // Max polling attempts
    requirePlanApproval: boolean;   // Require manual plan approval
    automationMode: JulesAutomationMode;
}

export interface JulesTaskResult {
    session: JulesSession;
    success: boolean;
    pullRequestUrl?: string;
    error?: string;
    durationMs: number;
}

// ============================================================================
// Constants
// ============================================================================

export const JULES_API_BASE_URL = "https://jules.googleapis.com/v1alpha";

export const DEFAULT_JULES_CONFIG: Omit<JulesConfig, "apiKey"> = {
    baseUrl: JULES_API_BASE_URL,
    pollIntervalMs: 5000,           // 5 seconds
    maxPollAttempts: 120,           // 10 minutes total
    requirePlanApproval: false,     // Auto-approve by default
    automationMode: "AUTO_CREATE_PR",
};
