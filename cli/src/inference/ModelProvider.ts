export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessage {
    role: ModelMessageRole;
    content: string;
    name?: string;
    toolCallId?: string;
}

export interface ModelToolDefinition {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
}

export interface ModelRequest {
    modelId: string;
    messages: readonly ModelMessage[];
    tools?: readonly ModelToolDefinition[];
    structuredOutput?: {
        name?: string;
        schema: Record<string, unknown>;
    };
    temperature?: number;
    maxTokens?: number;
    requestTimeoutMs?: number;
}

export interface ProviderCallContext {
    /**
     * Opaque reference selected by the higher-level credential/auth layer.
     * The provider must not resolve this value or treat it as authorization.
     */
    credentialRef: string;
    /**
     * Opaque isolation boundary selected by the higher-level credential/auth layer.
     * This value does not grant, prove, or validate authorization in the provider.
     */
    credentialScope: string;
    taskId: string;
    stepId: string;
    signal: AbortSignal;
    deadline: Date;
}

export interface ModelUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
}

export type FinishReason = "stop" | "length" | "tool_call" | "content_filter" | "unknown";

export interface ModelToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

export interface ModelResponse {
    modelId: string;
    content: string;
    usage?: ModelUsage;
    finishReason: FinishReason;
    toolCalls?: readonly ModelToolCall[];
}

export interface ModelStreamChunk {
    delta: string;
    finishReason?: FinishReason;
    toolCallDelta?: {
        id?: string;
        name?: string;
        arguments?: string;
    };
}

export interface CapabilitySupport {
    declared: boolean;
    implemented: boolean;
    verified: boolean;
}

/**
 * The authoritative runtime profile for what a provider/model may be asked to do.
 * Optional methods and transport compatibility are not capability signals by themselves.
 */
export interface CapabilityProfile {
    providerId: string;
    modelId: string;
    features: {
        streaming: CapabilitySupport;
        tools: CapabilitySupport;
        structuredOutput: CapabilitySupport;
    };
    limits: {
        contextWindowTokens?: number;
        maxInputTokens?: number;
        maxOutputTokens?: number;
    };
    operations: {
        complete: CapabilitySupport;
        stream: CapabilitySupport;
    };
}

export type ProviderErrorKind =
    | "authentication"
    | "authorization"
    | "invalid_request"
    | "rate_limit"
    | "timeout"
    | "cancellation"
    | "network"
    | "http_unavailable"
    | "provider"
    | "malformed_response";

export interface ModelProviderErrorOptions {
    kind: ProviderErrorKind;
    retryable: boolean;
    retryAfterMs?: number;
    fallbackAllowed: boolean;
    cause?: unknown;
}

export class ModelProviderError extends Error {
    readonly kind: ProviderErrorKind;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
    readonly fallbackAllowed: boolean;

    constructor(message: string, options: ModelProviderErrorOptions) {
        super(message, { cause: options.cause });
        this.name = "ModelProviderError";
        this.kind = options.kind;
        this.retryable = options.retryable;
        this.retryAfterMs = options.retryAfterMs;
        this.fallbackAllowed = options.fallbackAllowed;
    }
}

export interface ModelProvider {
    readonly providerId: string;

    /** Consumers must consult this profile before selecting an operation or feature. */
    getCapabilities(modelId: string): CapabilityProfile;

    complete(request: ModelRequest, context: ProviderCallContext): Promise<ModelResponse>;

    /**
     * Optional implementation hook. Its presence does not advertise streaming support;
     * consumers must use `getCapabilities(modelId)` as the source of truth.
     */
    stream?(request: ModelRequest, context: ProviderCallContext): AsyncIterable<ModelStreamChunk>;
}
