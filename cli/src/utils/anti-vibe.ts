/**
 * 🛡️ Anti-Vibe Protocol
 * 
 * Máquina de estados para orquestração segura.
 * Baseado na spec do Architect (Anti-Vibe Workflow).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// --- ENUMS & TYPES ---

export enum WorkflowPhase {
    RESEARCH = 'RESEARCH',       // Read-only, exploration
    SPECIFICATION = 'SPECIFICATION', // Planning (usually internal thought)
    EXECUTION = 'EXECUTION',     // Strict implementation based on Spec
}

export interface AntiVibeConfig {
    phase: WorkflowPhase;
    contextDir: string;
    specFile: string;
    diagFile: string;
}

// --- DEFAULT CONFIGURATION ---

const DEFAULT_CONTEXT_DIR = path.join(process.cwd(), '.ouroboros', 'context');
const SPEC_FILE = 'SPEC_TECNICA.md';
const DIAG_FILE = 'DIAGNOSTICO_CTX.md';

// --- PERSONAS (SYSTEM PROMPTS) ---

export const PERSONAS: Record<WorkflowPhase, string> = {
    [WorkflowPhase.RESEARCH]: `
🚨 **MODE: RESEARCH / AUDIT (READ-ONLY)** 🚨
You are the CODE_AUDITOR. Your goal is to explore, map, and understand the codebase.
RULES:
1. USE ONLY read tools (ls, cat, grep, find).
2. DO NOT edit, create, or delete any files.
3. If asked to write code, REFUSE and ask for the Specification phase.
4. Focus on finding dependencies, current implementations, and potential risks.
`,
    [WorkflowPhase.SPECIFICATION]: `
🧠 **MODE: ARCHITECT** 🧠
You are the SYSTEM_ARCHITECT. You do not write code. You design it.
`,
    [WorkflowPhase.EXECUTION]: `
🛠️ **MODE: EXECUTION (STRICT)** 🛠️
You are the SENIOR_ENGINEER. You execute plans with surgical precision.
RULES:
1. You MUST read the attached 'SPEC_TECNICA.md' before doing anything.
2. Implement EXACTLY what is described in the Spec.
3. Do not invent features not requested.
4. Run tests after implementation to verify 'Definition of Done'.
`,
};

// --- HELPER FUNCTIONS ---

/**
 * Get current phase from environment variable.
 */
export function getPhase(): WorkflowPhase {
    const envPhase = process.env.ANTI_VIBE_PHASE?.toUpperCase();
    if (envPhase && envPhase in WorkflowPhase) {
        return envPhase as WorkflowPhase;
    }
    // Default to RESEARCH for safety if unspecified
    return WorkflowPhase.RESEARCH;
}

/**
 * Load a context file safely.
 */
export function loadContextFile(filename: string, contextDir: string = DEFAULT_CONTEXT_DIR): string | null {
    const filePath = path.join(contextDir, filename);
    if (fs.existsSync(filePath)) {
        console.log(`[Anti-Vibe] 📂 Loading context: ${filename}`);
        return fs.readFileSync(filePath, 'utf-8');
    }
    return null;
}

/**
 * Ensure context directory exists.
 */
export function ensureContextDir(contextDir: string = DEFAULT_CONTEXT_DIR): void {
    if (!fs.existsSync(contextDir)) {
        fs.mkdirSync(contextDir, { recursive: true });
    }
}

/**
 * Validate phase gate - prevents execution without spec.
 */
export function validatePhaseGate(phase: WorkflowPhase, contextDir: string = DEFAULT_CONTEXT_DIR): void {
    if (phase === WorkflowPhase.EXECUTION) {
        const specContent = loadContextFile(SPEC_FILE, contextDir);
        if (!specContent || specContent.length < 50) {
            throw new Error(
                `⛔ [ANTI-VIBE BLOCK] Execution attempt denied. '${SPEC_FILE}' not found or empty. You must complete the SPECIFICATION phase first.`
            );
        }
    }
}

/**
 * Build prompt with Anti-Vibe protocol.
 */
export function buildAntiVibePrompt(
    userQuery: string,
    phase: WorkflowPhase = getPhase(),
    contextDir: string = DEFAULT_CONTEXT_DIR
): string {
    validatePhaseGate(phase, contextDir);

    let systemInstruction = PERSONAS[phase];
    let injectedContext = "";

    // Context injection based on phase
    if (phase === WorkflowPhase.RESEARCH) {
        const diag = loadContextFile(DIAG_FILE, contextDir);
        if (diag) injectedContext += `\n\n--- PREVIOUS DIAGNOSIS ---\n${diag}\n`;
    }

    if (phase === WorkflowPhase.EXECUTION) {
        const spec = loadContextFile(SPEC_FILE, contextDir);
        injectedContext += `\n\n=== 📜 MASTER SPECIFICATION (THE LAW) ===\n${spec}\n=========================================\n`;
    }

    // "Sandwich" prompt: Persona + Context + User Request
    return `${systemInstruction}\n${injectedContext}\n\nUSER REQUEST: ${userQuery}`;
}

/**
 * Get Anti-Vibe configuration.
 */
export function getAntiVibeConfig(): AntiVibeConfig {
    ensureContextDir();
    return {
        phase: getPhase(),
        contextDir: DEFAULT_CONTEXT_DIR,
        specFile: SPEC_FILE,
        diagFile: DIAG_FILE,
    };
}
