import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSelfModifyingEngine } from "../src/runtime/SelfModifyingEngine.js";

const DEPTH = parseInt(process.env.BENCH_DEPTH || "4", 10);
const BREADTH = parseInt(process.env.BENCH_BREADTH || "5", 10);
const NUM_FILES_PER_DIR = parseInt(process.env.BENCH_FILES || "3", 10);

console.log(`🔧 Configuration: DEPTH=${DEPTH}, BREADTH=${BREADTH}, FILES=${NUM_FILES_PER_DIR}`);

async function createDeepDir(baseDir: string, currentDepth: number) {
    if (currentDepth >= DEPTH) return;

    // Create subdirectories
    for (let i = 0; i < BREADTH; i++) {
        const subDir = path.join(baseDir, `dir_${i}`);
        await fs.mkdir(subDir, { recursive: true });

        // Create some files
        for (let j = 0; j < NUM_FILES_PER_DIR; j++) {
            await fs.writeFile(path.join(subDir, `file_${j}.ts`), `export const x${i}${j} = 1;`);
        }

        await createDeepDir(subDir, currentDepth + 1);
    }
}

async function countFiles(dir: string): Promise<number> {
    let count = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            count += await countFiles(path.join(dir, entry.name));
        } else {
            count++;
        }
    }
    return count;
}

if (import.meta.main) {
    console.log("🚀 Starting SelfModifyingEngine Benchmark");

    // Setup temp directory
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bench-"));
    console.log(`📁 Created temp dir: ${tempDir}`);

    try {
        console.log("🌳 Generating directory structure...");
        const startGen = performance.now();
        await createDeepDir(tempDir, 0);
        const genTime = performance.now() - startGen;
        console.log(`✅ Generation complete in ${genTime.toFixed(2)}ms`);

        const expectedFiles = await countFiles(tempDir);
        console.log(`📄 Total files created: ${expectedFiles}`);

        const engine = createSelfModifyingEngine({
            sourceDir: tempDir,
            backupDir: ".backups",
            testCommand: "echo 'pass'",
            autoGitCommit: false,
            maxBackupsPerFile: 5
        });

        console.log("\n⏱️  Running Benchmark: walkDir...");
        const start = performance.now();

        // Access private method for focused benchmark
        const files = await engine.scanDirectory(tempDir);

        const end = performance.now();
        const duration = end - start;

        console.log(`\n🏁 Result:`);
        console.log(`   Time: ${duration.toFixed(2)}ms`);
        console.log(`   Files found: ${files.length}`);

        if (files.length !== expectedFiles) {
            console.error(`❌ Mismatch! Expected ${expectedFiles}, found ${files.length}`);
            throw new Error("Mismatch!");
        } else {
            console.log("✅ File count matches!");
        }

    } catch (e) {
        console.error("❌ Benchmark failed:", e);
    } finally {
        console.log("\n🧹 Cleaning up...");
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log("✨ Done");
    }
}
