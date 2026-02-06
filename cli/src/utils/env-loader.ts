/**
 * 🐍 Ouroboros Environment Loader
 *
 * Loads environment variables from .env file.
 * Must be imported FIRST in main.ts before any other imports.
 */

import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface EnvConfig {
    groqApiKey: string;
    googleApiKey: string;
    ouroborosRoot?: string;
}

/**
 * Load .env file if it exists
 */
export function loadEnv(projectRoot?: string): void {
    const root = projectRoot ?? process.cwd();
    const envPath = resolve(root, '.env');

    if (existsSync(envPath)) {
        config({ path: envPath });
        console.log('📦 Loaded environment from .env');
    }
}

/**
 * Get required environment variables
 * @throws Error if required variables are missing
 */
export function getEnvConfig(): EnvConfig {
    const groqApiKey = process.env.GROQ_API_KEY;
    const googleApiKey = process.env.GOOGLE_API_KEY;

    const missing: string[] = [];
    if (!groqApiKey) missing.push('GROQ_API_KEY');
    if (!googleApiKey) missing.push('GOOGLE_API_KEY');

    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}\n` +
            `Please create a .env file or set these variables.`
        );
    }

    return {
        groqApiKey: groqApiKey!,
        googleApiKey: googleApiKey!,
        ouroborosRoot: process.env.OUROBOROS_ROOT,
    };
}

/**
 * Check if running in headless mode (env vars present, no TTY)
 */
export function isHeadlessMode(): boolean {
    return !!(process.env.GROQ_API_KEY && process.env.GOOGLE_API_KEY);
}
