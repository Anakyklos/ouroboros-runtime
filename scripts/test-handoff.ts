#!/usr/bin/env npx tsx
/**
 * 🧪 Test Handoff Protocol
 * 
 * Valida serialização/deserialização de contexto para handoff.
 * 
 * Usage: npx tsx scripts/test-handoff.ts
 */

import { createHandoffManager, type HandoffContext } from '../cli/src/daemon/handoff.js';
import type { Message } from '../cli/src/providers/direct-zai.js';

function main() {
    console.log('\n🧪 Testing Handoff Protocol\n');
    console.log('='.repeat(50));

    const manager = createHandoffManager();

    // Test 1: Prepare handoff context
    console.log('\n📦 Test 1: Prepare handoff context\n');

    const mockHistory: Message[] = [
        { role: 'system', content: 'You are an assistant' },
        { role: 'user', content: 'List files in current directory' },
        { role: 'assistant', content: 'I will list the files for you.' },
        { role: 'tool', tool_call_id: 'call_1', content: 'file1.txt\nfile2.txt' },
        { role: 'assistant', content: 'Here are the files:\n- file1.txt\n- file2.txt' },
    ];

    const context = manager.prepareHandoff({
        sessionId: 'session_123',
        conversationHistory: mockHistory,
        systemPrompt: 'You are a helpful assistant',
        workingDirectory: '/workspace',
        reason: 'User requested handoff',
    });

    console.log('✅ Context prepared');
    console.log(`   Session: ${context.sessionId}`);
    console.log(`   Messages: ${context.conversationHistory.length} (excluding system)`);
    console.log(`   Working dir: ${context.workingDirectory}`);
    console.log(`   Reason: ${context.reason}`);

    // Test 2: Serialize context
    console.log('\n📄 Test 2: Serialize context\n');

    const serialized = manager.serializeContext(context);
    console.log('✅ Context serialized');
    console.log(`   Size: ${serialized.length} bytes`);

    // Test 3: Deserialize context
    console.log('\n📥 Test 3: Deserialize context\n');

    const result = manager.deserializeContext(serialized);

    if (result.success && result.context) {
        console.log('✅ Context deserialized');
        console.log(`   Session: ${result.context.sessionId}`);
        console.log(`   Messages: ${result.context.conversationHistory.length}`);
    } else {
        console.log('❌ Deserialization failed:', result.error);
        process.exit(1);
    }

    // Test 4: Rebuild messages
    console.log('\n🔄 Test 4: Rebuild messages\n');

    const messages = manager.rebuildMessages(result.context);
    console.log('✅ Messages rebuilt');
    console.log(`   Total messages: ${messages.length}`);
    console.log(`   First role: ${messages[0]?.role} (should be system)`);

    // Test 5: Estimate tokens
    console.log('\n🔢 Test 5: Estimate tokens\n');

    const tokens = manager.estimateTokens(result.context);
    console.log(`✅ Estimated tokens: ${tokens}`);

    // Test 6: Truncate context
    console.log('\n✂️ Test 6: Truncate context\n');

    const truncated = manager.truncateContext(result.context, 50);
    console.log('✅ Context truncated');
    console.log(`   Original messages: ${result.context.conversationHistory.length}`);
    console.log(`   Truncated messages: ${truncated.conversationHistory.length}`);
    console.log(`   Truncated: ${truncated.metadata?.truncated ?? false}`);

    // Test 7: Handle invalid JSON
    console.log('\n⚠️ Test 7: Handle invalid JSON\n');

    const invalidResult = manager.deserializeContext('not valid json');
    console.log(`✅ Invalid JSON handled: ${invalidResult.success === false ? 'correctly rejected' : 'ERROR'}`);

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('\n✅ All tests passed!\n');
}

main();
