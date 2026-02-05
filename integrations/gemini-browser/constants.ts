/**
 * 🔮 Gemini Browser Integration - Constants
 * 
 * Centralized configuration for Gemini browser automation.
 */

import type { GeminiGem, GeminiConfig } from './types';

/**
 * Base URL for Gemini.
 */
export const GEMINI_BASE_URL = 'https://gemini.google.com';

/**
 * Known Gems with their configurations.
 */
export const GEMINI_GEMS: Record<string, GeminiGem> = {
    architect: {
        name: 'Architect (Anti-Vibe Workflow)',
        slug: '59819c5e4bfe',
        url: 'https://gemini.google.com/gem/59819c5e4bfe',
        description: 'Engenheiro de Software Senior especializado na metodologia Pesquisa -> Spec -> Execucao',
    },
};

/**
 * Default configuration for the provider.
 */
export const DEFAULT_CONFIG: GeminiConfig = {
    defaultModel: 'pro',
    defaultGem: 'architect',
    waitTimeMs: 15000,
    maxRetries: 3,
};

/**
 * Timeouts for browser operations (in milliseconds).
 */
export const TIMEOUTS = {
    PAGE_LOAD: 5000,
    MESSAGE_SEND: 3000,
    RESPONSE_WAIT: 30000,
    MODEL_SWITCH: 2000,
};

/**
 * UI Element identifiers (for documentation purposes).
 * Note: Actual interaction is done via pixel coordinates due to browser subagent limitations.
 */
export const UI_ELEMENTS = {
    CHAT_INPUT: 'Chat input field at bottom of page',
    SEND_BUTTON: 'Blue send button to the right of input',
    MODEL_SELECTOR: 'Dropdown showing current model (Pro/Flash)',
    RESPONSE_AREA: 'Main content area where responses appear',
};
