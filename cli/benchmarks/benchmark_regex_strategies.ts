import { Bench } from 'tinybench';

const bench = new Bench({ time: 1000 });

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

// Use the production-grade unicode pattern
const PATTERN = /export\s+(?:async\s+)?function\s+([\p{ID_Start}$][\p{ID_Continue}$]*)/gu;

// 1. Static Loop (Shared Instance - Manual Reset)
function staticLoop(code: string) {
    PATTERN.lastIndex = 0;
    while (PATTERN.exec(code) !== null) {}
}

// 2. Cloned Instance (Safe - New RegExp per call)
function clonedLoop(code: string) {
    // Clone: new RegExp(pattern) copies flags automatically in ES6+
    const p = new RegExp(PATTERN);
    while (p.exec(code) !== null) {}
}

// 3. MatchAll (Safe - Iterator)
function matchAllLoop(code: string) {
    const matches = code.matchAll(PATTERN);
    for (const match of matches) {}
}

bench
  .add('Static Loop', () => {
    staticLoop(code);
  })
  .add('Cloned Loop', () => {
    clonedLoop(code);
  })
  .add('MatchAll', () => {
    matchAllLoop(code);
  });

async function run() {
  await bench.run();
  console.table(bench.table());
}

run();
