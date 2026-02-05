/**
 * 🔮 Gemini Browser Provider
 * 
 * Automates communication with Gemini via browser for the Ouroboros project.
 * Encapsulates browser subagent calls into reusable functions.
 * 
 * NOTE: This provider is designed to be used BY the Antigravity agent.
 * It provides a clean interface for Gemini interactions without exposing
 * the complexity of browser automation.
 */

import type {
    GeminiModel,
    GeminiConfig,
    GeminiResult,
    ChatOptions
} from './types';
import { GEMINI_GEMS, DEFAULT_CONFIG, TIMEOUTS } from './constants';

/**
 * Instructions for the Antigravity browser subagent.
 * These are templates that get filled with specific parameters.
 */
const BROWSER_INSTRUCTIONS = {
    /**
     * Navigate to a specific Gem.
     */
    selectGem: (gemUrl: string, gemName: string) => `
Navigate to ${gemUrl} and wait for the page to fully load.
Verify that the Gem "${gemName}" is active by checking the page header.
Take a screenshot after the page loads to confirm the Gem is selected.
Report what you see on the page.
`,

    /**
     * Switch to a specific model (Pro/Flash).
     */
    setModel: (model: GeminiModel) => `
On the current Gemini page:
1. Look for the model selector (usually shows "Rapido" or "Flash" or "Pro")
2. Click on the model selector to open the dropdown
3. Select the "${model === 'pro' ? 'Pro' : 'Rapido/Flash'}" option
4. Wait for the selection to be applied
5. Take a screenshot to confirm the model is now "${model}"
Report the result.
`,

    /**
     * Send a message and wait for response.
     */
    sendMessage: (message: string, waitTimeMs: number) => `
On the current Gemini page:
1. Click on the chat input field at the bottom of the page
2. Type the following message (use only ASCII characters, no accents):
"${message.normalize('NFD').replace(/[\u0300-\u036f]/g, '')}"
3. Press Enter or click the send button to send the message
4. Wait at least ${waitTimeMs / 1000} seconds for Gemini to respond
5. Take a screenshot of the response
Report what Gemini responded with.
`,

    /**
     * Read the last response from Gemini.
     */
    getLastResponse: () => `
On the current Gemini page:
1. Read the page content to find the last assistant response
2. Extract the full text of the response
3. Take a screenshot of the response area
Report the complete response text.
`,
};

/**
 * GeminiBrowserProvider - Interface for Gemini browser automation.
 * 
 * This class provides methods that return INSTRUCTIONS for the browser subagent.
 * The actual execution is done by the Antigravity agent using these instructions.
 */
export class GeminiBrowserProvider {
    private config: GeminiConfig;
    private currentGem: string | null = null;
    private currentModel: GeminiModel;

    constructor(config: Partial<GeminiConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.currentModel = this.config.defaultModel;

        if (this.config.defaultGem) {
            this.currentGem = this.config.defaultGem;
        }
    }

    /**
     * Get the browser subagent task for selecting a Gem.
     */
    getSelectGemTask(gemName: string): { taskName: string; task: string; recordingName: string } {
        const gem = GEMINI_GEMS[gemName.toLowerCase()];
        if (!gem) {
            throw new Error(`Unknown Gem: ${gemName}. Available: ${Object.keys(GEMINI_GEMS).join(', ')}`);
        }

        this.currentGem = gemName.toLowerCase();

        return {
            taskName: `Selecting Gem: ${gem.name}`,
            task: BROWSER_INSTRUCTIONS.selectGem(gem.url, gem.name),
            recordingName: `gemini_select_${gemName.toLowerCase()}`,
        };
    }

    /**
     * Get the browser subagent task for switching models.
     */
    getSetModelTask(model: GeminiModel): { taskName: string; task: string; recordingName: string } {
        this.currentModel = model;

        return {
            taskName: `Setting Model: ${model.toUpperCase()}`,
            task: BROWSER_INSTRUCTIONS.setModel(model),
            recordingName: `gemini_set_${model}`,
        };
    }

    /**
     * Get the browser subagent task for sending a message.
     */
    getSendMessageTask(message: string): { taskName: string; task: string; recordingName: string } {
        return {
            taskName: 'Sending Message to Gemini',
            task: BROWSER_INSTRUCTIONS.sendMessage(message, this.config.waitTimeMs),
            recordingName: 'gemini_send_message',
        };
    }

    /**
     * Get the browser subagent task for reading the last response.
     */
    getReadResponseTask(): { taskName: string; task: string; recordingName: string } {
        return {
            taskName: 'Reading Gemini Response',
            task: BROWSER_INSTRUCTIONS.getLastResponse(),
            recordingName: 'gemini_read_response',
        };
    }

    /**
     * Get the complete workflow task for a full chat interaction.
     * Combines gem selection, model setting, and message sending.
     */
    getChatTask(options: ChatOptions): { taskName: string; task: string; recordingName: string } {
        const gem = options.gem ? GEMINI_GEMS[options.gem.toLowerCase()] : null;
        const model = options.model || this.currentModel;
        const gemUrl = gem?.url || (this.currentGem ? GEMINI_GEMS[this.currentGem]?.url : null);

        if (!gemUrl) {
            throw new Error('No Gem selected. Specify a gem in options or set a default.');
        }

        const steps: string[] = [];

        // Step 1: Navigate to Gem (if specified)
        if (options.gem) {
            steps.push(`1. Navigate to ${gemUrl} and wait for the page to load`);
        }

        // Step 2: Set model
        steps.push(`${steps.length + 1}. Click the model selector and choose "${model === 'pro' ? 'Pro' : 'Flash/Rapido'}"`);

        // Step 3: Send message
        const safeMessage = options.message.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        steps.push(`${steps.length + 1}. Click the chat input field`);
        steps.push(`${steps.length + 1}. Type: "${safeMessage}"`);
        steps.push(`${steps.length + 1}. Press Enter or click send`);

        // Step 4: Wait for response
        if (options.waitForResponse !== false) {
            steps.push(`${steps.length + 1}. Wait ${this.config.waitTimeMs / 1000} seconds for Gemini to respond`);
            steps.push(`${steps.length + 1}. Take a screenshot of the response`);
            steps.push(`${steps.length + 1}. Report the complete response text`);
        }

        return {
            taskName: `Chat with ${gem?.name || 'Gemini'}`,
            task: `On the Gemini page:\n${steps.join('\n')}`,
            recordingName: 'gemini_chat',
        };
    }

    /**
     * Get current state.
     */
    getState(): { gem: string | null; model: GeminiModel } {
        return {
            gem: this.currentGem,
            model: this.currentModel,
        };
    }

    /**
     * Get available Gems.
     */
    getAvailableGems(): string[] {
        return Object.keys(GEMINI_GEMS);
    }

    /**
     * Get Gem details.
     */
    getGemDetails(gemName: string) {
        return GEMINI_GEMS[gemName.toLowerCase()] || null;
    }
}

/**
 * Factory function for creating a Gemini Browser Provider.
 */
export function createGeminiBrowserProvider(config?: Partial<GeminiConfig>): GeminiBrowserProvider {
    return new GeminiBrowserProvider(config);
}
