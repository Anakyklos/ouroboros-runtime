import { ToolExecutor } from '../../cli/src/providers/tool-executor';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

const TEMP_FILE = path.join(process.cwd(), 'benchmark-temp-file.txt');
const FILE_SIZE_MB = 10;
const CONCURRENT_READS = 100;

async function setup() {
    console.log(`Creating ${FILE_SIZE_MB}MB temporary file...`);
    const buffer = Buffer.alloc(FILE_SIZE_MB * 1024 * 1024, 'x');
    fs.writeFileSync(TEMP_FILE, buffer);
}

async function cleanup() {
    if (fs.existsSync(TEMP_FILE)) {
        fs.unlinkSync(TEMP_FILE);
    }
}

async function runBenchmark() {
    await setup();

    const executor = new ToolExecutor({ workingDirectory: process.cwd() });

    // We need to access the private method handleReadFile for benchmarking directly
    // Ideally we would use runTool but handleReadFile is not exposed publically in the interface shown
    // Let's use 'any' casting to access it for the benchmark
    const handleReadFile = (executor as any).handleReadFile.bind(executor);

    console.log(`Starting benchmark: ${CONCURRENT_READS} concurrent reads of ${FILE_SIZE_MB}MB file...`);

    const start = performance.now();

    const promises = [];
    for (let i = 0; i < CONCURRENT_READS; i++) {
        promises.push(handleReadFile({ path: TEMP_FILE }));
    }

    const results = await Promise.all(promises);

    const end = performance.now();

    const successfulReads = results.filter((result: any) => result?.success).length;
    const failedReads = CONCURRENT_READS - successfulReads;

    if (successfulReads === 0) {
        await cleanup();
        throw new Error(`Benchmark aborted: all ${CONCURRENT_READS} read operations failed.`);
    }

    if (failedReads > 0) {
        console.warn(`Warning: ${failedReads} of ${CONCURRENT_READS} read operations failed and are excluded from benchmark success count.`);
    }

    const duration = end - start;

    console.log(`\nBenchmark Result:`);
    console.log(`Total Time: ${duration.toFixed(2)}ms`);
    console.log(`Successful Reads: ${successfulReads}`);
    console.log(`Average Time per Read: ${(duration / CONCURRENT_READS).toFixed(2)}ms`);

    await cleanup();
}

runBenchmark().catch(console.error);
