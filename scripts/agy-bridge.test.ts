import { describe, it, expect, mock } from "bun:test";

describe("Antigravity Bridge", () => {
    it("should allow execution of shell commands", async () => {
        // This is a basic sanity check since we can't easily unit test 
        // the process spawning without executing real commands.
        // We verify that the bridge script exists and is executable.
        const proc = Bun.spawn(["bun", "run", "scripts/agy-bridge.ts", "echo 'test'"]);
        const exitCode = await proc.exited;
        expect(exitCode).toBe(0);
    });

    it("should fail if no command is provided", async () => {
        const proc = Bun.spawn(["bun", "run", "scripts/agy-bridge.ts"]);
        const exitCode = await proc.exited;
        expect(exitCode).toBe(1);
    });
});
