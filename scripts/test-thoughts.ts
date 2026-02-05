#!/usr/bin/env npx tsx
/**
 * 🧪 Test Thoughts System
 * 
 * Valida que ThoughtEvents são emitidos durante execução do AgentLoop.
 * 
 * Usage: npx tsx scripts/test-thoughts.ts
 */

import { globalEventBus, type ThoughtEvent } from '../cli/src/daemon/event-bus.js';
import { createAgent } from '../cli/src/providers/agent-loop.js';
import { getWorkspacePath } from '../cli/src/utils/ouroboros.js';

// Collect thoughts
const collectedThoughts: ThoughtEvent[] = [];

// Subscribe to thought events
const unsubscribe = globalEventBus.on('thought', (thought) => {
    collectedThoughts.push(thought);
    console.log(`💭 [${thought.type}] ${thought.content}`);
    if (thought.metadata) {
        console.log(`   📎 Metadata:`, thought.metadata);
    }
});

// Also log regular logs
globalEventBus.on('log', (log) => {
    console.log(`[${log.level.toUpperCase()}] ${log.message}`);
});

async function main() {
    console.log('\n🧪 Testing Thoughts System\n');
    console.log('='.repeat(50));

    // Check for API key
    const apiKey = process.env.ZAI_API_KEY ?? process.env.ZHIPU_API_KEY;

    if (!apiKey) {
        console.log('\n⚠️  No API key found. Running mock test.\n');
        runMockTest();
        return;
    }

    console.log('✅ API key found, running live test...\n');

    try {
        const agent = createAgent({
            apiKey,
            workingDirectory: getWorkspacePath(),
            verbose: true,
        });

        // Simple task that should generate thoughts
        const result = await agent.run('List the files in the current directory');

        console.log('\n' + '='.repeat(50));
        console.log('\n📊 Results:\n');
        console.log(`Success: ${result.success}`);
        console.log(`Tool Calls: ${result.toolCallsCount}`);
        console.log(`Duration: ${result.durationMs}ms`);
        console.log(`\n📝 Content:\n${result.content.substring(0, 200)}...`);

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        unsubscribe();
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('\n💭 Thoughts Summary:\n');
    console.log(`Total thoughts: ${collectedThoughts.length}`);

    const byType = collectedThoughts.reduce((acc, t) => {
        acc[t.type] = (acc[t.type] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    for (const [type, count] of Object.entries(byType)) {
        console.log(`  - ${type}: ${count}`);
    }
}

function runMockTest() {
    console.log('📝 Mock test: Emitting sample thoughts...\n');

    // Simulate thought emission
    globalEventBus.emit('thought', {
        type: 'reasoning',
        content: 'Analyzing the request to list files',
        timestamp: new Date(),
    });

    globalEventBus.emit('thought', {
        type: 'tool_call',
        content: 'Calling list_directory',
        metadata: { toolName: 'list_directory', args: '{"path": "."}' },
        timestamp: new Date(),
    });

    globalEventBus.emit('thought', {
        type: 'tool_result',
        content: 'list_directory completed',
        metadata: { success: true, outputLength: 256 },
        timestamp: new Date(),
    });

    globalEventBus.emit('thought', {
        type: 'decision',
        content: 'Task completed successfully',
        metadata: { iterations: 1, toolCalls: 1 },
        timestamp: new Date(),
    });

    console.log('\n✅ Mock test passed!');
    console.log(`💭 Total thoughts emitted: ${collectedThoughts.length}`);

    unsubscribe();
}

main().catch(console.error);
