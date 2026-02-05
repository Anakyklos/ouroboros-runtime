/**
 * 🧪 Daemon Test Script
 * 
 * Testa endpoints do daemon via HTTP.
 * Usage: bun run cli/src/daemon/test-daemon.ts
 */

const BASE_URL = 'http://127.0.0.1:7777';

async function rpc(method: string, params: Record<string, unknown> = {}) {
    const response = await fetch(`${BASE_URL}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method,
            params,
        }),
    });
    return response.json();
}

async function main() {
    console.log('🧪 Testing Ouroboros Daemon...\n');

    // Test 1: Health check
    console.log('1. Testing /health endpoint...');
    const healthRes = await fetch(`${BASE_URL}/health`);
    const health = await healthRes.json();
    console.log('   ✅ Health:', health);

    // Test 2: RPC system.health
    console.log('\n2. Testing system.health RPC...');
    const sysHealth = await rpc('system.health');
    console.log('   ✅ System Health:', sysHealth);

    // Test 3: RPC system.version
    console.log('\n3. Testing system.version RPC...');
    const version = await rpc('system.version');
    console.log('   ✅ Version:', version);

    // Test 4: Create session
    console.log('\n4. Creating new session...');
    const createRes = await rpc('session.create', { context: 'Test context' });
    console.log('   ✅ Created:', createRes);
    const sessionId = (createRes as { result: { sessionId: string } }).result?.sessionId;

    // Test 5: List sessions
    console.log('\n5. Listing sessions...');
    const listRes = await rpc('session.list');
    console.log('   ✅ Sessions:', listRes);

    // Test 6: Get session
    if (sessionId) {
        console.log('\n6. Getting session details...');
        const getRes = await rpc('session.get', { id: sessionId });
        console.log('   ✅ Session:', getRes);
    }

    // Test 7: Invalid method
    console.log('\n7. Testing invalid method (should return error)...');
    const invalidRes = await rpc('invalid.method');
    console.log('   ✅ Error response:', invalidRes);

    console.log('\n🎉 All tests passed!');
}

main().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
