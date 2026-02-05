#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Going up from bin/ouroboros.js to root
const rootDir = path.resolve(__dirname, '..');
const loopScript = path.join(rootDir, 'cli', 'src', 'daemon', 'loop.ts');

// Find local tsx
const tsxBin = path.join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

const child = spawn(tsxBin, [loopScript, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
    shell: true
});

child.on('exit', (code) => {
    process.exit(code ?? 0);
});
