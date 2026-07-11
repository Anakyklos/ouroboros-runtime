/**
 * 🚀 DirectZAIProvider
 * 
 * HTTP client para API Z.AI com suporte a tool calling nativo.
 * Acesso direto via API HTTP para performance e controle.
 */

import { EventBus, globalEventBus } from '../daemon/event-bus.js';

// ============================================================
// Types
// ============================================================

export interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
}

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, {
                type: string;
                description?: string;
                enum?: string[];
            }>;
            required?: string[];
        };
    };
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string; // JSON string
    };
}

export interface ChatResponse {
    id: string;
    choices: {
        index: number;
        message: Message;
        finish_reason: 'stop' | 'tool_calls' | 'length';
    }[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export interface StreamChunk {
    id: string;
    choices: {
        index: number;
        delta: Partial<Message>;
        finish_reason: 'stop' | 'tool_calls' | 'length' | null;
    }[];
}

export interface DirectZAIConfig {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    timeout?: number;
    verbose?: boolean;
}

// ============================================================
// DirectZAIProvider
// ============================================================

export class DirectZAIProvider {
    private apiKey: string;
    private _model: string;
    private baseUrl: string;
    private timeout: number;
    private verbose: boolean;
    private eventBus: EventBus;

    constructor(config: DirectZAIConfig, eventBus?: EventBus) {
        if (!config.apiKey) {
            throw new Error('⛔ API Key is required. Set ZAI_API_KEY env or pass in config.');
        }

        this.apiKey = config.apiKey;
        this._model = config.model ?? 'glm-4.7';
        this.baseUrl = config.baseUrl ?? 'https://api.z.ai/api/coding/paas/v4';
        this.timeout = config.timeout ?? 120_000; // 2 min default
        this.verbose = config.verbose ?? false;
        this.eventBus = eventBus ?? globalEventBus;

        this.log('info', `Initialized with model: ${this._model}`);
    }

    /** Current model name */
    get modelName(): string {
        return this._model;
    }

    /**
     * Send a chat completion request (non-streaming)
     */
    async chat(
        messages: Message[],
        tools?: ToolDefinition[],
        options?: { temperature?: number; max_tokens?: number; signal?: AbortSignal }
    ): Promise<ChatResponse> {
        const body = {
            model: this._model,
            messages,
            tools,
            temperature: options?.temperature ?? 0.7,
            max_tokens: options?.max_tokens ?? 4096,
            stream: false,
        };

        this.log('debug', `Sending chat request with ${messages.length} messages`);

        const response = await this.fetch('/chat/completions', body, options?.signal);

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Z.AI API error (${response.status}): ${error}`);
        }

        const data = await response.json() as ChatResponse;

        this.log('debug', `Received response: ${data.choices[0]?.finish_reason}`);

        if (data.usage) {
            this.log('info', `Tokens: ${data.usage.total_tokens} (prompt: ${data.usage.prompt_tokens}, completion: ${data.usage.completion_tokens})`);
        }

        return data;
    }

    /**
     * Send a streaming chat completion request
     */
    async *chatStream(
        messages: Message[],
        tools?: ToolDefinition[],
        options?: { temperature?: number; max_tokens?: number }
    ): AsyncGenerator<StreamChunk> {
        const body = {
            model: this._model,
            messages,
            tools,
            temperature: options?.temperature ?? 0.7,
            max_tokens: options?.max_tokens ?? 4096,
            stream: true,
        };

        this.log('debug', `Starting streaming chat with ${messages.length} messages`);

        const response = await this.fetch('/chat/completions', body);

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Z.AI API error (${response.status}): ${error}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') {
                            return;
                        }
                        try {
                            const chunk = JSON.parse(data) as StreamChunk;
                            yield chunk;
                        } catch {
                            // Skip invalid JSON
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Helper method to extract tool calls from response
     */
    static extractToolCalls(response: ChatResponse): ToolCall[] {
        const message = response.choices[0]?.message;
        return message?.tool_calls ?? [];
    }

    /**
     * Helper method to check if response needs tool execution
     */
    static needsToolExecution(response: ChatResponse): boolean {
        return response.choices[0]?.finish_reason === 'tool_calls';
    }

    /**
     * Helper to parse tool arguments
     */
    static parseToolArgs<T = Record<string, unknown>>(call: ToolCall): T {
        try {
            return JSON.parse(call.function.arguments) as T;
        } catch {
            return {} as T;
        }
    }

    // ============================================================
    // Private
    // ============================================================

    private async fetch(endpoint: string, body: unknown, externalSignal?: AbortSignal): Promise<Response> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const onExternalAbort = () => controller.abort();
        if (externalSignal) {
            if (externalSignal.aborted) {
                clearTimeout(timeoutId);
                throw new DOMException("The operation was aborted.", "AbortError");
            }
            externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        }

        try {
            return await fetch(`${this.baseUrl}${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeoutId);
            externalSignal?.removeEventListener("abort", onExternalAbort);
        }
    }

    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        if (this.verbose) {
            this.eventBus.log(level, message, 'DirectZAI');
        }
    }
}

// ============================================================
// Factory
// ============================================================

/**
 * Create a DirectZAIProvider from environment or explicit config
 */
export function createDirectZAI(config?: Partial<DirectZAIConfig>): DirectZAIProvider {
    const apiKey = config?.apiKey ?? process.env.ZAI_API_KEY ?? process.env.ZHIPU_API_KEY;

    if (!apiKey) {
        throw new Error(
            '⛔ No API key found.\n' +
            '   Set ZAI_API_KEY or ZHIPU_API_KEY environment variable,\n' +
            '   or pass apiKey in config.'
        );
    }

    return new DirectZAIProvider({ ...config, apiKey });
}
