import { Bench } from 'tinybench';

const bench = new Bench({ time: 1000 });
const code = "foo".repeat(10);

// 1. Original (Array of literals inside)
function original() {
    const patterns = [ /foo/g, /bar/g ];
    for (const p of patterns) { p.lastIndex = 0; p.exec(code); }
}

// 2. Static (Hoisted array)
const STATIC_PATTERNS = [ /foo/g, /bar/g ];
function static_() {
    for (const p of STATIC_PATTERNS) { p.lastIndex = 0; p.exec(code); }
}

// 3. Cloned (Hoisted array + clone)
function cloned() {
    for (const p of STATIC_PATTERNS) {
        const c = new RegExp(p, p.flags);
        c.exec(code);
    }
}

bench
  .add('Original', original)
  .add('Static', static_)
  .add('Cloned', cloned);

async function run() {
  await bench.run();
  console.table(bench.table());
}

run();
