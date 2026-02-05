/**
 * 🔮 Gemini Browser Integration
 * 
 * Public API for the Gemini Browser Provider.
 */

export { GeminiBrowserProvider, createGeminiBrowserProvider } from './gemini-browser';
export { GEMINI_GEMS, DEFAULT_CONFIG, TIMEOUTS, GEMINI_BASE_URL } from './constants';
export type {
    GeminiModel,
    GeminiGem,
    GeminiMessage,
    GeminiConfig,
    ChatOptions,
    GeminiResult
} from './types';
