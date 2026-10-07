#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Going up from bin/ouroboros.js to root
const rootDir = path.resolve(__dirname, '..');
const bunBin = 'bun';

const args = process.argv.slice(2);
const adminScript = path.join(rootDir, 'scripts', 'ouroboros-cli.ts');
const child = spawn(bunBin, ['run', adminScript, ...args], {
    stdio: 'inherit',
    env: process.env,
});

child.on('exit', (code) => {
    process.exit(code ?? 0);
});
