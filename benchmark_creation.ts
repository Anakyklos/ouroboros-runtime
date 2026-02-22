import { Bench } from 'tinybench';

const bench = new Bench({ time: 1000 });

const code = "foo";
const PATTERN = /foo/g;

bench
  .add('Literal', () => {
    const r = /foo/g;
    r.exec(code);
  })
  .add('Cloned', () => {
    const r = new RegExp(PATTERN, PATTERN.flags);
    r.exec(code);
  });

async function run() {
  await bench.run();
  console.table(bench.table());
}

run();
