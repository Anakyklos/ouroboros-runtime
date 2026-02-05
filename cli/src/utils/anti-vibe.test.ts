import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    loadContextFile,
    validatePhaseGate,
    buildAntiVibePrompt,
    WorkflowPhase
} from './anti-vibe.js';

const TEST_DIR = path.join(process.cwd(), '.test_context_' + Date.now());
const SPEC_FILE = 'SPEC_TECNICA.md';
const DIAG_FILE = 'DIAGNOSTICO_CTX.md';

describe('Anti-Vibe Protocol (Async)', () => {
    beforeEach(() => {
        if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
        fs.mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it('should load context file asynchronously', async () => {
        const content = 'Hello World';
        fs.writeFileSync(path.join(TEST_DIR, 'test.txt'), content);
        const loaded = await loadContextFile('test.txt', TEST_DIR);
        expect(loaded).toBe(content);
    });

    it('should return null if file does not exist', async () => {
        const loaded = await loadContextFile('nonexistent.txt', TEST_DIR);
        expect(loaded).toBeNull();
    });

    it('should pass validation for non-EXECUTION phases', async () => {
        // Should not throw
        await validatePhaseGate(WorkflowPhase.RESEARCH, TEST_DIR);
        await validatePhaseGate(WorkflowPhase.SPECIFICATION, TEST_DIR);
    });

    it('should fail validation for EXECUTION phase if spec is missing', async () => {
        try {
            await validatePhaseGate(WorkflowPhase.EXECUTION, TEST_DIR);
            throw new Error('Should have thrown');
        } catch (e: any) {
            expect(e.message).toContain('Execution attempt denied');
        }
    });

    it('should fail validation for EXECUTION phase if spec is too short', async () => {
        fs.writeFileSync(path.join(TEST_DIR, SPEC_FILE), 'Too short');
        try {
            await validatePhaseGate(WorkflowPhase.EXECUTION, TEST_DIR);
            throw new Error('Should have thrown');
        } catch (e: any) {
            expect(e.message).toContain('Execution attempt denied');
        }
    });

    it('should pass validation for EXECUTION phase if spec is valid', async () => {
        const validSpec = 'A'.repeat(100); // > 50 chars
        fs.writeFileSync(path.join(TEST_DIR, SPEC_FILE), validSpec);
        await validatePhaseGate(WorkflowPhase.EXECUTION, TEST_DIR);
    });

    it('should build prompt with injected context', async () => {
        const validSpec = 'My valid spec content...'.padEnd(60, '.');
        fs.writeFileSync(path.join(TEST_DIR, SPEC_FILE), validSpec);

        const prompt = await buildAntiVibePrompt('Do code', WorkflowPhase.EXECUTION, TEST_DIR);
        expect(prompt).toContain('=== 📜 MASTER SPECIFICATION (THE LAW) ===');
        expect(prompt).toContain(validSpec);
        expect(prompt).toContain('USER REQUEST: Do code');
    });
});
