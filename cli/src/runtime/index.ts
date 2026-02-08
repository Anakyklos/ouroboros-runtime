/**
 * 🐍 Runtime Module
 * 
 * Componentes de autonomia radical para o Ouroboros.
 * 
 * @module runtime
 */

export {
    PersistentPythonREPL,
    createPersistentPythonREPL,
    type ExecutionResult,
    type PythonREPLConfig,
    type REPLStatus,
} from './PersistentPythonREPL.js';

export {
    GeminiDirectAPI,
    createGeminiDirectAPI,
    createGeminiFromEnv,
    type GeminiModel,
    type GeminiMessage,
    type GeminiDirectAPIConfig,
    type QueryResult,
} from './GeminiDirectAPI.js';
