/**
 * 🚀 GeminiDirectAPI
 * 
 * Comunicação direta com a API REST do Gemini.
 * Controle total sobre histórico de chat, parâmetros e safety settings.
 * 
 * Substitui o padrão `spawn('gemini', ['--prompt', ...])` por chamadas HTTP diretas.
 * 
 * @module runtime/GeminiDirectAPI
 */

// ============================================================================
// Types
// ============================================================================

export type GeminiModel = 'gemini-2.0-flash-exp' | 'gemini-1.5-pro' | 'gemini-1.5-flash' | 'gemini-1.0-pro';

export interface GeminiPart {
    text?: string;
    inlineData?: {
        mimeType: string;
        data: string; // base64
    };
}

export interface GeminiMessage {
    role: 'user' | 'model';
    parts: GeminiPart[];
}

export interface GenerationConfig {
    temperature?: number;
    topK?: number;
    topP?: number;
    maxOutputTokens?: number;
    candidateCount?: number;
    stopSequences?: string[];
}

export interface SafetySetting {
    category: string;
    threshold: 'BLOCK_NONE' | 'BLOCK_LOW_AND_ABOVE' | 'BLOCK_MEDIUM_AND_ABOVE' | 'BLOCK_ONLY_HIGH';
}

export interface GeminiRequestPayload {
    contents: GeminiMessage[];
    generationConfig?: GenerationConfig;
    safetySettings?: SafetySetting[];
    systemInstruction?: {
        parts: GeminiPart[];
    };
}

export interface GeminiCandidate {
    content: GeminiMessage;
    finishReason: string;
    index: number;
    safetyRatings?: Array<{
        category: string;
        probability: string;
    }>;
}

export interface GeminiResponse {
    candidates: GeminiCandidate[];
    promptFeedback?: {
        safetyRatings?: Array<{
            category: string;
            probability: string;
        }>;
        blockReason?: string;
    };
    usageMetadata?: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
    };
}

export interface GeminiDirectAPIConfig {
    /** API Key do Gemini */
    apiKey: string;
    /** Modelo padrão */
    model?: GeminiModel;
    /** Configuração de geração padrão */
    defaultGenerationConfig?: GenerationConfig;
    /** Desabilita safety filters */
    disableSafetyFilters?: boolean;
    /** System instruction padrão */
    systemInstruction?: string;
    /** Base URL (para testes ou proxies) */
    baseUrl?: string;
    /** Timeout em ms */
    timeoutMs?: number;
}

export interface QueryResult {
    content: string;
    model: GeminiModel;
    tokensUsed: number;
    durationMs: number;
    success: boolean;
    error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_GENERATION_CONFIG: GenerationConfig = {
    temperature: 0.7,
    topK: 40,
    topP: 0.95,
    maxOutputTokens: 8192,
};

// Safety settings que desabilitam filtros
const DISABLED_SAFETY_SETTINGS: SafetySetting[] = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

// ============================================================================
// GeminiDirectAPI
// ============================================================================

export class GeminiDirectAPI {
    private config: Required<Omit<GeminiDirectAPIConfig, 'systemInstruction' | 'defaultGenerationConfig'>> & {
        systemInstruction?: string;
        defaultGenerationConfig: GenerationConfig;
    };
    private conversationHistory: GeminiMessage[] = [];
    private tokensUsedTotal: number = 0;

    constructor(config: GeminiDirectAPIConfig) {
        if (!config.apiKey) {
            throw new Error('Gemini API key is required');
        }

        this.config = {
            apiKey: config.apiKey,
            model: config.model ?? 'gemini-2.0-flash-exp',
            defaultGenerationConfig: {
                ...DEFAULT_GENERATION_CONFIG,
                ...config.defaultGenerationConfig,
            },
            disableSafetyFilters: config.disableSafetyFilters ?? false,
            systemInstruction: config.systemInstruction,
            baseUrl: config.baseUrl ?? GEMINI_BASE_URL,
            timeoutMs: config.timeoutMs ?? 60000,
        };
    }

    // ========================================================================
    // Main Methods
    // ========================================================================

    /**
     * Envia mensagem para Gemini e recebe resposta.
     * Adiciona ao histórico automaticamente.
     */
    async query(prompt: string, options?: {
        model?: GeminiModel;
        generationConfig?: GenerationConfig;
        addToHistory?: boolean;
    }): Promise<QueryResult> {
        const startTime = Date.now();
        const model = options?.model ?? this.config.model;
        const addToHistory = options?.addToHistory ?? true;

        try {
            // Monta payload
            const payload = this.buildPayload(prompt, options?.generationConfig);

            // Faz request
            const response = await this.makeRequest(model, payload);

            // Extrai conteúdo
            const content = this.extractContent(response);
            const tokensUsed = response.usageMetadata?.totalTokenCount ?? 0;
            this.tokensUsedTotal += tokensUsed;

            // Adiciona ao histórico
            if (addToHistory) {
                this.conversationHistory.push({
                    role: 'user',
                    parts: [{ text: prompt }],
                });
                this.conversationHistory.push({
                    role: 'model',
                    parts: [{ text: content }],
                });
            }

            return {
                content,
                model,
                tokensUsed,
                durationMs: Date.now() - startTime,
                success: true,
            };

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return {
                content: '',
                model,
                tokensUsed: 0,
                durationMs: Date.now() - startTime,
                success: false,
                error: errorMsg,
            };
        }
    }

    /**
     * Query sem adicionar ao histórico (one-shot)
     */
    async queryOnce(prompt: string, options?: {
        model?: GeminiModel;
        generationConfig?: GenerationConfig;
    }): Promise<QueryResult> {
        return this.query(prompt, { ...options, addToHistory: false });
    }

    /**
     * Query com contexto de arquivos
     */
    async queryWithFiles(
        prompt: string,
        files: Array<{ path: string; content: string }>,
        options?: {
            model?: GeminiModel;
            generationConfig?: GenerationConfig;
        }
    ): Promise<QueryResult> {
        // Injeta conteúdo dos arquivos no prompt
        const fileContext = files.map(f =>
            `### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
        ).join('\n\n');

        const enrichedPrompt = `${fileContext}\n\n---\n\n${prompt}`;
        return this.query(enrichedPrompt, options);
    }

    // ========================================================================
    // History Management
    // ========================================================================

    /**
     * Retorna histórico completo
     */
    getHistory(): GeminiMessage[] {
        return [...this.conversationHistory];
    }

    /**
     * Limpa histórico de conversação
     */
    clearHistory(): void {
        this.conversationHistory = [];
    }

    /**
     * Edita mensagem no histórico por índice
     */
    editHistory(index: number, newContent: string): void {
        if (index < 0 || index >= this.conversationHistory.length) {
            throw new Error(`Invalid history index: ${index}`);
        }
        this.conversationHistory[index].parts = [{ text: newContent }];
    }

    /**
     * Remove mensagem do histórico por índice
     */
    removeFromHistory(index: number): void {
        if (index < 0 || index >= this.conversationHistory.length) {
            throw new Error(`Invalid history index: ${index}`);
        }
        this.conversationHistory.splice(index, 1);
    }

    /**
     * Injeta mensagem no histórico
     */
    injectToHistory(message: GeminiMessage, index?: number): void {
        if (index === undefined) {
            this.conversationHistory.push(message);
        } else {
            this.conversationHistory.splice(index, 0, message);
        }
    }

    // ========================================================================
    // Configuration
    // ========================================================================

    /**
     * Altera modelo padrão
     */
    setModel(model: GeminiModel): void {
        this.config.model = model;
    }

    /**
     * Altera system instruction
     */
    setSystemInstruction(instruction: string): void {
        this.config.systemInstruction = instruction;
    }

    /**
     * Retorna configuração atual
     */
    getConfig(): Readonly<typeof this.config> {
        return { ...this.config };
    }

    /**
     * Retorna total de tokens usados na sessão
     */
    getTotalTokensUsed(): number {
        return this.tokensUsedTotal;
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    private buildPayload(prompt: string, generationConfig?: GenerationConfig): GeminiRequestPayload {
        const payload: GeminiRequestPayload = {
            contents: [
                ...this.conversationHistory,
                {
                    role: 'user',
                    parts: [{ text: prompt }],
                },
            ],
            generationConfig: {
                ...this.config.defaultGenerationConfig,
                ...generationConfig,
            },
        };

        // Safety settings
        if (this.config.disableSafetyFilters) {
            payload.safetySettings = DISABLED_SAFETY_SETTINGS;
        }

        // System instruction
        if (this.config.systemInstruction) {
            payload.systemInstruction = {
                parts: [{ text: this.config.systemInstruction }],
            };
        }

        return payload;
    }

    private async makeRequest(model: GeminiModel, payload: GeminiRequestPayload): Promise<GeminiResponse> {
        const url = `${this.config.baseUrl}/models/${model}:generateContent?key=${this.config.apiKey}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`Gemini API error (${response.status}): ${errorBody}`);
            }

            return await response.json() as GeminiResponse;

        } finally {
            clearTimeout(timeout);
        }
    }

    private extractContent(response: GeminiResponse): string {
        if (!response.candidates || response.candidates.length === 0) {
            if (response.promptFeedback?.blockReason) {
                throw new Error(`Blocked: ${response.promptFeedback.blockReason}`);
            }
            throw new Error('No candidates in response');
        }

        const candidate = response.candidates[0];
        if (!candidate.content?.parts) {
            throw new Error('No content in candidate');
        }

        return candidate.content.parts
            .map(part => part.text ?? '')
            .join('');
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createGeminiDirectAPI(config: GeminiDirectAPIConfig): GeminiDirectAPI {
    return new GeminiDirectAPI(config);
}

/**
 * Cria instância com API key do ambiente
 */
export function createGeminiFromEnv(options?: Omit<GeminiDirectAPIConfig, 'apiKey'>): GeminiDirectAPI {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is required');
    }
    return new GeminiDirectAPI({ ...options, apiKey });
}

export default GeminiDirectAPI;
