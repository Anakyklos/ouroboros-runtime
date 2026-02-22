import { Bench } from 'tinybench';

const bench = new Bench({ time: 1000 });

// Representative code sample
const code = `
export function hello() {}
export async function world(a: number) {}
function internal() {}
export class User {}
class Helper {}
export const PI = 3.14;
export const config = {};
const secret = 'hidden';
export interface Config {}
interface Internal {}
export type ID = string;
type InternalID = number;
// Add some unicode identifiers
export const café = 1;
export function ümlaut() {}
export class Ångström {}
`.repeat(10);

// 1. Baseline: Recreating Regexes (Original Implementation)
function baseline(code: string): string[] {
    const exports: string[] = [];
    const patterns = [
        /export\s+(?:async\s+)?function\s+([\p{ID_Start}$][\p{ID_Continue}$]*)/gu,
        /export\s+class\s+([\p{ID_Start}$][\p{ID_Continue}$]*)/gu,
        /export\s+const\s+([\p{ID_Start}$][\p{ID_Continue}$]*)/gu,
        /export\s+interface\s+([\p{ID_Start}$][\p{ID_Continue}$]*)/gu,
        /export\s+type\s+([\p{ID_Start}$][\p{ID_Continue}$]*)/gu,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(code)) !== null) {
            exports.push(match[1]);
        }
    }
    return exports;
}

// 2. Optimized: Static Strings + Constructor (New Implementation)
const EXPORT_PATTERNS = Object.freeze([
    'export\\s+(?:async\\s+)?function\\s+([\\p{ID_Start}$][\\p{ID_Continue}$]*)',
    'export\\s+class\\s+([\\p{ID_Start}$][\\p{ID_Continue}$]*)',
    'export\\s+const\\s+([\\p{ID_Start}$][\\p{ID_Continue}$]*)',
    'export\\s+interface\\s+([\\p{ID_Start}$][\\p{ID_Continue}$]*)',
    'export\\s+type\\s+([\\p{ID_Start}$][\\p{ID_Continue}$]*)',
]);

function optimized(code: string): string[] {
    const exports: string[] = [];
    for (const patternString of EXPORT_PATTERNS) {
        const pattern = new RegExp(patternString, 'gu');
        let match;
        while ((match = pattern.exec(code)) !== null) {
            exports.push(match[1]);
        }
    }
    return exports;
}

bench
  .add('Baseline (Recreate Array)', () => {
    baseline(code);
  })
  .add('Optimized (Static Strings)', () => {
    optimized(code);
  });

async function run() {
  await bench.run();
  console.table(bench.table());
}

run();
