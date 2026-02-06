import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    loadContextFile,
    validatePhaseGate,
    buildAntiVibePrompt,
    ensureContextDir,
    getAntiVibeConfig,
    WorkflowPhase
} from './anti-vibe.js';

const TEST_DIR = path.join(process.cwd(), '.test_context_' + Date.now());
const SPEC_FILE = 'SPEC_TECNICA.md';
const DIAG_FILE = 'DIAGNOSTICO_CTX.md';

describe('Anti-Vibe Protocol (Async)', () => {
    beforeEach(() => {
        if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
        // fs.mkdirSync(TEST_DIR, { recursive: true }); // Removed to test ensureContextDir
    });

    afterEach(() => {
        if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it('should load context file asynchronously', async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        const content = 'Hello World';
        fs.writeFileSync(path.join(TEST_DIR, 'test.txt'), content);
        const loaded = await loadContextFile('test.txt', TEST_DIR);
        expect(loaded).toBe(content);
    });

    it('should return null if file does not exist', async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        const loaded = await loadContextFile('nonexistent.txt', TEST_DIR);
        expect(loaded).toBeNull();
    });

    it('should ensure context directory exists asynchronously', async () => {
        expect(fs.existsSync(TEST_DIR)).toBe(false);
        await ensureContextDir(TEST_DIR);
        expect(fs.existsSync(TEST_DIR)).toBe(true);
    });

    it('should get configuration asynchronously', async () => {
        // Mock getPhase implicitly via env or default
        const config = await getAntiVibeConfig();
        expect(config).toBeDefined();
        expect(config.phase).toBeDefined();
        // Check if default context dir is created by getAntiVibeConfig
        // Note: getAntiVibeConfig uses DEFAULT_CONTEXT_DIR, not TEST_DIR, so we should check that
        // However, we don't want to pollute the real project structure.
        // We can check the properties at least.
        expect(config.specFile).toBe(SPEC_FILE);
    });

    it('should pass validation for non-EXECUTION phases', async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        await validatePhaseGate(WorkflowPhase.RESEARCH, TEST_DIR);
        await validatePhaseGate(WorkflowPhase.SPECIFICATION, TEST_DIR);
    });

    it('should fail validation for EXECUTION phase if spec is missing', async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        try {
            await validatePhaseGate(WorkflowPhase.EXECUTION, TEST_DIR);
            throw new Error('Should have thrown');
        } catch (e: any) {
            expect(e.message).toContain('Execution attempt denied');
        }
    });

    it('should fail validation for EXECUTION phase if spec is too short', async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(path.join(TEST_DIR, SPEC_FILE), 'Too short');
        try {
            await validatePhaseGate(WorkflowPhase.EXECUTION, TEST_DIR);
            throw new Error('Should have thrown');
        } catch (e: any) {
            expect(e.message).toContain('Execution attempt denied');
        }
    });

    it('should pass validation for EXECUTION phase if spec is valid', async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        const validSpec = 'A'.repeat(100); // > 50 chars
        fs.writeFileSync(path.join(TEST_DIR, SPEC_FILE), validSpec);
        await validatePhaseGate(WorkflowPhase.EXECUTION, TEST_DIR);
    });

    it('should build prompt with injected context', async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        const validSpec = 'My valid spec content...'.padEnd(60, '.');
        fs.writeFileSync(path.join(TEST_DIR, SPEC_FILE), validSpec);

        const prompt = await buildAntiVibePrompt('Do code', WorkflowPhase.EXECUTION, TEST_DIR);
        expect(prompt).toContain('=== 📜 MASTER SPECIFICATION (THE LAW) ===');
        expect(prompt).toContain(validSpec);
        expect(prompt).toContain('USER REQUEST: Do code');
    });
});
