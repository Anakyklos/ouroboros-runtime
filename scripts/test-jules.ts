#!/usr/bin/env bun
/**
 * 🧪 Jules API Integration Test
 * 
 * Tests the JulesBridge by listing available sources.
 * Requires JULES_API_KEY in environment.
 * 
 * Usage: bun run scripts/test-jules.ts
 */

import { createJulesBridge, type JulesSource } from "../cli/src/bridges/JulesBridge.js";

async function main() {
    console.log("🧪 Jules API Integration Test\n");
    console.log("=".repeat(50));

    // 1. Check for API key
    const apiKey = process.env.JULES_API_KEY;
    if (!apiKey) {
        console.error("❌ JULES_API_KEY not set in environment");
        console.log("\nTo set it:");
        console.log("  1. Get your key from: https://jules.google.com/settings");
        console.log("  2. Add to .env: JULES_API_KEY=your_key_here");
        process.exit(1);
    }

    console.log("✅ JULES_API_KEY found");

    // 2. Create bridge
    const bridge = createJulesBridge({ apiKey });
    console.log("✅ JulesBridge created");

    // 3. Test availability
    console.log("\nChecking Jules API availability...");
    const available = await bridge.isAvailable();
    if (!available) {
        console.error("❌ Jules API is not accessible");
        process.exit(1);
    }
    console.log("✅ Jules API is accessible");

    // 4. List sources
    console.log("\nListing connected sources (GitHub repos)...");
    const sources: JulesSource[] = await bridge.listSources();

    if (sources.length === 0) {
        console.log("⚠️  No sources connected yet.");
        console.log("   Connect a GitHub repo at: https://jules.google/");
    } else {
        console.log(`📂 Found ${sources.length} source(s):\n`);
        for (const source of sources) {
            console.log(`   - ${source.name}`);
            if (source.githubRepo) {
                console.log(`     GitHub: ${source.githubRepo.owner}/${source.githubRepo.repo}`);
            }
        }
    }

    // 5. List recent sessions
    console.log("\nListing recent sessions...");
    const sessions = await bridge.listSessions(5);

    if (sessions.length === 0) {
        console.log("📋 No sessions found.");
    } else {
        console.log(`📋 Found ${sessions.length} session(s):\n`);
        for (const session of sessions) {
            console.log(`   - [${session.state}] ${session.title ?? session.prompt.slice(0, 40)}`);
            console.log(`     URL: ${session.url}`);
        }
    }

    console.log("\n" + "=".repeat(50));
    console.log("✅ Jules integration test complete!");
    console.log("\nNext steps:");
    console.log("  - Create a session: go.delegateToJules('Add tests')");
    console.log("  - Await completion: go.awaitJulesSession(sessionId)");
    console.log("  - Full execution: go.executeJulesTask('Refactor module')");
}

main().catch((err) => {
    console.error("❌ Test failed:", err.message);
    process.exit(1);
});
