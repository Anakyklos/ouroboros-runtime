import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildHealthResults } from './health-check.ts';

const root = resolve(import.meta.dir, '..');

describe('modern runtime health check', () => {
    it('does not fail when legacy workspace, venv, provider keys, or Gemini CLI are absent', () => {
        const results = buildHealthResults({
            envFile: false,
            groqApiKey: false,
            googleApiKey: false,
            workspace: '/project/.ouroboros/workspace',
            workspaceReady: false,
            python: '/project/.ouroboros/venv/bin/python',
            pythonVenv: false,
            geminiCli: false,
            bunRuntime: true,
        });

        expect(results.filter((result) => result.status === 'error')).toEqual([]);
        expect(results.filter((result) => result.status === 'warn')).toHaveLength(6);
        expect(results.find((result) => result.name === 'Ouroboros workspace')?.status).toBe('warn');
        expect(results.find((result) => result.name === 'Python venv')?.status).toBe('warn');
        expect(results.find((result) => result.name === 'GROQ_API_KEY')?.status).toBe('warn');
        expect(results.find((result) => result.name === 'GOOGLE_API_KEY')?.status).toBe('warn');
        expect(results.find((result) => result.name === 'Gemini CLI')?.status).toBe('warn');
    });

    it('keeps the Bun runtime requirement fatal and never labels a fatal result optional', () => {
        const results = buildHealthResults({
            envFile: false,
            groqApiKey: false,
            googleApiKey: false,
            workspace: '/project/.ouroboros/workspace',
            workspaceReady: false,
            python: '/project/.ouroboros/venv/bin/python',
            pythonVenv: false,
            geminiCli: false,
            bunRuntime: false,
        });

        const errors = results.filter((result) => result.status === 'error');
        expect(errors.map((result) => result.name)).toEqual(['Bun runtime']);
        expect(errors.every((result) => !result.message.toLowerCase().includes('optional'))).toBe(true);
    });

    it('keeps health and daemon composition independent from TUI, Council, persona, and provider setup', () => {
        const healthSource = readFileSync(resolve(root, 'scripts/health-check.ts'), 'utf8');
        const daemonSource = readFileSync(resolve(root, 'cli/src/daemon/main.ts'), 'utf8');

        expect(healthSource).not.toMatch(/Council|Persona|GROQ_API_KEY.*required|GOOGLE_API_KEY.*required/);
        expect(daemonSource).not.toMatch(/from ['"].*(tui|provider|orchestration)\//i);
        expect(daemonSource).not.toMatch(/Council|Persona/);
    });
});
