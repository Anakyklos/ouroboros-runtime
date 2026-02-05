#!/usr/bin/env npx tsx
/**
 * 🌊 Test Wave Coding with Z.AI
 * 
 * Teste REAL - Wave Coding delegando tasks para Z.AI.
 * Versão simplificada que não depende do Orchestrator.
 * 
 * Usage: 
 *   $env:ZAI_API_KEY="your-key"
 *   npx tsx scripts/test-wave-zai.ts
 */

import { createAgent } from '../cli/src/providers/agent-loop.js';
import { globalEventBus } from '../cli/src/daemon/event-bus.js';
import { getWorkspacePath } from '../cli/src/utils/ouroboros.js';

// Check API key
const apiKey = process.env.ZAI_API_KEY ?? process.env.ZHIPU_API_KEY;
if (!apiKey) {
    console.error('❌ Set ZAI_API_KEY or ZHIPU_API_KEY');
    process.exit(1);
}

// Subscribe to thoughts
globalEventBus.on('thought', (t) => {
    console.log(`💭 [${t.type}] ${t.content.slice(0, 80)}...`);
});

// Create agent that will execute tasks
const agent = createAgent({
    apiKey,
    workingDirectory: getWorkspacePath(),
    verbose: true,
});

// Define Wave tasks with dependencies
interface SimpleWaveTask {
    id: string;
    name: string;
    dependsOn?: string[];
    execute: () => Promise<{ success: boolean; output?: string }>;
}

const tasks: SimpleWaveTask[] = [
    // Wave 1: Paralelas (sem dependências)
    {
        id: 'create-hello',
        name: 'Create hello.txt',
        execute: async () => {
            console.log('\n🚀 Task create-hello: Delegating to Z.AI...\n');
            const result = await agent.run(
                'Create a file called "wave_test_hello.txt" in the current directory with content "Hello from Wave 1A - Z.AI did this!"'
            );
            return { success: result.success, output: result.content };
        },
    },
    {
        id: 'create-world',
        name: 'Create world.txt',
        execute: async () => {
            console.log('\n🚀 Task create-world: Delegating to Z.AI...\n');
            const result = await agent.run(
                'Create a file called "wave_test_world.txt" in the current directory with content "World from Wave 1B - Z.AI did this!"'
            );
            return { success: result.success, output: result.content };
        },
    },
    // Wave 2: Depende de Wave 1
    {
        id: 'merge-files',
        name: 'Merge files',
        dependsOn: ['create-hello', 'create-world'],
        execute: async () => {
            console.log('\n🚀 Task merge-files: Delegating to Z.AI...\n');
            const result = await agent.run(
                'Read "wave_test_hello.txt" and "wave_test_world.txt", then create "wave_test_merged.txt" with both contents combined.'
            );
            return { success: result.success, output: result.content };
        },
    },
];

// Simple wave grouper
function groupIntoWaves(tasks: SimpleWaveTask[]): SimpleWaveTask[][] {
    const waves: SimpleWaveTask[][] = [];
    const completed = new Set<string>();
    const remaining = [...tasks];

    while (remaining.length > 0) {
        const wave: SimpleWaveTask[] = [];
        const toRemove: number[] = [];

        remaining.forEach((task, idx) => {
            const deps = task.dependsOn || [];
            if (deps.every(d => completed.has(d))) {
                wave.push(task);
                toRemove.push(idx);
            }
        });

        if (wave.length === 0) {
            throw new Error('Circular dependency detected!');
        }

        wave.forEach(t => completed.add(t.id));
        toRemove.reverse().forEach(i => remaining.splice(i, 1));
        waves.push(wave);
    }

    return waves;
}

async function main() {
    console.log('\n🌊 Wave Coding Test with Z.AI\n');
    console.log('='.repeat(60));
    console.log('This test will delegate file creation tasks to Z.AI!');
    console.log('\nTasks:');
    console.log('  Wave 1: create-hello ‖ create-world (parallel)');
    console.log('  Wave 2: merge-files (depends on Wave 1)');
    console.log('='.repeat(60));

    const waves = groupIntoWaves(tasks);
    const startTime = Date.now();
    const results = new Map<string, { success: boolean; output?: string }>();
    let failedCount = 0;

    for (let i = 0; i < waves.length; i++) {
        const wave = waves[i];
        console.log(`\n━━━ Wave ${i + 1}/${waves.length} ━━━`);
        console.log(`Tasks: ${wave.map(t => t.id).join(', ')}`);

        // Execute tasks in parallel within wave
        const waveResults = await Promise.all(
            wave.map(async (task) => {
                console.log(`▶️ Starting: ${task.id}`);
                try {
                    const result = await task.execute();
                    const emoji = result.success ? '✅' : '❌';
                    console.log(`${emoji} Finished: ${task.id}`);
                    return { id: task.id, ...result };
                } catch (error) {
                    console.log(`❌ Error: ${task.id}`);
                    return { id: task.id, success: false, output: String(error) };
                }
            })
        );

        for (const r of waveResults) {
            results.set(r.id, { success: r.success, output: r.output });
            if (!r.success) failedCount++;
        }
    }

    const totalDuration = Date.now() - startTime;
    const successCount = results.size - failedCount;

    console.log('\n' + '='.repeat(60));
    console.log('\n📊 Wave Execution Results:\n');
    console.log(`Success: ${failedCount === 0 ? '✅' : '❌'}`);
    console.log(`Total Duration: ${(totalDuration / 1000).toFixed(1)}s`);
    console.log(`Tasks Completed: ${successCount}/${results.size}`);

    if (failedCount > 0) {
        console.log('\n❌ Failed tasks:');
        results.forEach((r, id) => {
            if (!r.success) console.log(`  - ${id}: ${r.output?.slice(0, 100)}`);
        });
    }

    console.log('\n✅ Wave Coding Test Complete!\n');
}

main().catch(console.error);
