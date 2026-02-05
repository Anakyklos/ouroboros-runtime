/**
 * Bridges Module Index
 * 
 * Re-exports all CLI bridge implementations for convenient importing.
 */

export {
    AntigravityBridge,
    createAntigravityBridge,
    type AntigravityConfig,
    type AntigravityResponse,
    type ExecuteOptions as AntigravityExecuteOptions
} from "./AntigravityBridge.js";

export {
    GeminiCliBridge,
    createGeminiCliBridge,
    type GeminiCliConfig,
    type GeminiCliResponse,
    type GeminiModel,
    type QueryOptions as GeminiQueryOptions
} from "./GeminiCliBridge.js";
