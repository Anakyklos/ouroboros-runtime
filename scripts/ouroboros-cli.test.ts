import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("ouroboros admin CLI entrypoint", () => {
  for (const [label, command] of [
    ["package CLI script", ["bun", "run", "scripts/ouroboros-cli.ts", "status"]],
    ["installed binary entrypoint", [process.execPath, "bin/ouroboros.js", "status"]],
  ] as const) {
    it(`fails factually through the ${label} when the daemon is unavailable`, () => {
      const result = spawnSync(command[0], command.slice(1), {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, OUROBOROS_PORT: "1" },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("daemon unavailable");
      expect(`${result.stdout}${result.stderr}`).not.toContain("COUNCIL");
      expect(`${result.stdout}${result.stderr}`).not.toContain("persona");
    });
  }
});
