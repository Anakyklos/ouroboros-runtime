#!/usr/bin/env tsx
/**
 * 🧪 Test DirectZAI + ToolExecutor + AgentLoop
 * 
 * Usage:
 *   ZAI_API_KEY=xxx npx tsx scripts/test-direct-zai.ts "Create a file hello.txt with Hello World"
 */

import { createAgent } from '../cli/src/providers/agent-loop.js';
import * as path from 'node:path';

async function main() {
    const prompt = process.argv.slice(2).join(' ') || 'List the files in the current directory';

    console.log('🧪 Testing Direct Z.AI Integration\n');
    console.log(`📝 Prompt: "${prompt}"\n`);

    // Check API key
    const apiKey = process.env.ZAI_API_KEY || process.env.ZHIPU_API_KEY;
    if (!apiKey) {
        console.error('❌ No API key found!');
        console.error('   Set ZAI_API_KEY or ZHIPU_API_KEY environment variable');
        console.error('   Get your key from: https://z.ai → API Keys');
        process.exit(1);
    }

    console.log('✅ API Key found\n');

    // Create agent
    const workingDirectory = path.resolve(process.cwd(), '.ouroboros/workspace');
    console.log(`📂 Working directory: ${workingDirectory}\n`);

    try {
        const agent = createAgent({
            apiKey,
            workingDirectory,
            verbose: true,
        });

        console.log('🚀 Starting agent...\n');
        console.log('─'.repeat(50));

        const result = await agent.run(prompt);

        console.log('─'.repeat(50));
        console.log('\n📊 Result:');
        console.log(`   Success: ${result.success}`);
        console.log(`   Tool Calls: ${result.toolCallsCount}`);
        console.log(`   Tokens: ${result.totalTokens ?? 'N/A'}`);
        console.log(`   Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
        console.log('\n📄 Response:');
        console.log(result.content);

    } catch (err) {
        console.error('❌ Error:', err);
        process.exit(1);
    }
}

main();
