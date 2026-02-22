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
`.repeat(10);

const PATTERN = /export\s+(?:async\s+)?function\s+(\w+)/g;

// Shared (Current)
function shared(code: string) {
    PATTERN.lastIndex = 0;
    while (PATTERN.exec(code) !== null) {}
}

// Cloned (Safe)
function cloned(code: string) {
    const p = new RegExp(PATTERN, PATTERN.flags);
    while (p.exec(code) !== null) {}
}

bench
  .add('Shared', () => {
    shared(code);
  })
  .add('Cloned', () => {
    cloned(code);
  });

async function run() {
  await bench.run();
  console.table(bench.table());
}

run();
