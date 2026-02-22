import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createSelfModifyingEngine, SelfModifyingEngineConfig } from './SelfModifyingEngine';

const TEST_DIR = path.join(process.cwd(), 'test_temp_engine');
const SOURCE_DIR = path.join(TEST_DIR, 'src');
const BACKUP_DIR = path.join(SOURCE_DIR, '.ouroboros/backups');

describe('SelfModifyingEngine', () => {
    beforeEach(async () => {
        await fs.rm(TEST_DIR, { recursive: true, force: true });
        await fs.mkdir(SOURCE_DIR, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(TEST_DIR, { recursive: true, force: true });
    });

    test('should respect maxBackupsPerFile limit', async () => {
        const config: SelfModifyingEngineConfig = {
            sourceDir: SOURCE_DIR,
            backupDir: '.ouroboros/backups',
            maxBackupsPerFile: 3,
            validateSyntax: false,
            runTestsAfter: false,
        };

        const engine = createSelfModifyingEngine(config);
        const testFile = 'test.ts';
        const fullPath = path.join(SOURCE_DIR, testFile);

        await fs.writeFile(fullPath, 'original content');

        // Apply 5 mutations to generate 5 backups
        for (let i = 0; i < 5; i++) {
            await engine.proposeAndApplyMutation(
                testFile,
                `// mutation ${i}\noriginal content`,
                'test'
            );

            // minimal delay to ensure distinct timestamps
            await new Promise(r => setTimeout(r, 10));
        }

        try {
            const backups = await fs.readdir(BACKUP_DIR);
            const testBackups = backups.filter(f => f.startsWith(testFile) && f.endsWith('.bak'));

            expect(testBackups.length).toBe(3);
        } catch (e) {
            console.error('Error reading backups:', e);
            expect(true).toBe(false); // Fail test
        }
    });
});
