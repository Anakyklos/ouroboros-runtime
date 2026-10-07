import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("ouroboros admin CLI entrypoint", () => {
  it("routes headless startup to the daemon and exposes no TUI/setup scripts", () => {
    expect(packageJson.scripts["start:headless"]).toBe("bun run daemon");
    expect(packageJson.scripts.daemon).toBe("bun cli/src/daemon/main.ts");
    expect(packageJson.scripts.ouroboros).toBe("bun run bin/ouroboros.js");
    expect(packageJson.scripts.tui).toBeUndefined();
    expect(packageJson.scripts.setup).toBeUndefined();
    expect(packageJson.dependencies.ink).toBeUndefined();
    expect(packageJson.dependencies.react).toBeUndefined();
    expect(packageJson.devDependencies["ink-testing-library"]).toBeUndefined();
    expect(existsSync(resolve(root, "cli/src/main.ts"))).toBe(false);
    expect(existsSync(resolve(root, "cli/src/tui"))).toBe(false);
  });

  it("does not route the installed binary's tui argument to a legacy entrypoint", () => {
    const binSource = readFileSync(resolve(root, "bin/ouroboros.js"), "utf8");
    expect(binSource).toContain("scripts', 'ouroboros-cli.ts");
    expect(binSource).not.toContain("cli', 'src', 'main.ts");
    expect(binSource).not.toContain("args[0] === 'tui'");

    const result = spawnSync(process.execPath, ["bin/ouroboros.js", "tui"], {
      cwd: root,
      env: { ...process.env, OUROBOROS_PORT: "1" },
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("Usage:");
    expect(`${result.stdout}${result.stderr}`).not.toContain("persona");
    expect(`${result.stdout}${result.stderr}`).not.toContain("COUNCIL");
  });

  for (const [label, command] of [
    ["package CLI script", ["bun", "run", "ouroboros", "status"]],
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
