/**
 * 🔮 Gemini Browser Integration - Types
 * 
 * Type definitions for the Gemini Browser Provider.
 */

/**
 * Available Gemini models.
 */
export type GeminiModel = 'pro' | 'flash';

/**
 * Known Gemini Gems with their URLs.
 */
export interface GeminiGem {
    name: string;
    slug: string;
    url: string;
    description?: string;
}

/**
 * Message structure for Gemini conversations.
 */
export interface GeminiMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp?: Date;
}

/**
 * Configuration for the Gemini Browser Provider.
 */
export interface GeminiConfig {
    defaultModel: GeminiModel;
    defaultGem?: string;
    waitTimeMs: number;
    maxRetries: number;
}

/**
 * Options for sending a chat message.
 */
export interface ChatOptions {
    gem?: string;
    model?: GeminiModel;
    message: string;
    waitForResponse?: boolean;
}

/**
 * Result from a Gemini interaction.
 */
export interface GeminiResult {
    success: boolean;
    response?: string;
    error?: string;
    screenshotPath?: string;
}
