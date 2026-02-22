import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createSelfModifyingEngine, SelfModifyingEngineConfig } from './SelfModifyingEngine';

describe('SelfModifyingEngine', () => {
    let testDir: string;
    let sourceDir: string;
    let backupDir: string;

    beforeEach(async () => {
        // Create a unique temporary directory for each test
        testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ouroboros-test-'));
        sourceDir = path.join(testDir, 'src');
        backupDir = path.join(sourceDir, '.ouroboros/backups');
        await fs.mkdir(sourceDir, { recursive: true });
    });

    afterEach(async () => {
        // Clean up the unique temporary directory
        if (testDir) {
            await fs.rm(testDir, { recursive: true, force: true });
        }
    });

    test('should respect maxBackupsPerFile limit', async () => {
        const config: SelfModifyingEngineConfig = {
            sourceDir: sourceDir,
            backupDir: '.ouroboros/backups',
            maxBackupsPerFile: 3,
            validateSyntax: false,
            runTestsAfter: false,
        };

        const engine = createSelfModifyingEngine(config);
        const testFile = 'test.ts';
        const fullPath = path.join(sourceDir, testFile);

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
            const backups = await fs.readdir(backupDir);
            const testBackups = backups.filter(f => f.startsWith(testFile) && f.endsWith('.bak'));

            expect(testBackups.length).toBe(3);
        } catch (e) {
            console.error('Error reading backups:', e);
            expect(true).toBe(false); // Fail test
        }
    });
});
