import { afterEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAIN = join(ROOT, "cli/src/daemon/main.ts");
const CLI = join(ROOT, "scripts/ouroboros-cli.ts");

interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

function baseEnv(root: string, dataDir: string, configDir: string, port: number): Record<string, string> {
    return {
        PATH: process.env.PATH ?? "",
        HOME: root,
        TMPDIR: root,
        OUROBOROS_DATA_DIR: dataDir,
        XDG_CONFIG_HOME: configDir,
        OUROBOROS_PORT: String(port),
        OUROBOROS_ALLOWED_ORIGINS: "",
    };
}

async function unusedPort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port");
    const port = address.port;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    return port;
}

function startDaemon(env: Record<string, string>): ChildProcess {
    return spawn(process.execPath, [MAIN], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<number> {
    if (child.exitCode !== null) return child.exitCode;
    return new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Daemon did not exit before the deadline")), timeoutMs);
        child.once("exit", (code) => {
            clearTimeout(timeout);
            resolve(code ?? -1);
        });
    });
}

async function waitUntilReady(port: number, child: ChildProcess, timeoutMs = 12_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error("Daemon exited before becoming ready");
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.ok) return;
        } catch {
            // Startup is asynchronous; retry only the local health observation.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Daemon did not become ready before the deadline");
}

async function runCli(env: Record<string, string>, args: string[], timeoutMs = 15_000): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`CLI did not exit before the deadline: ${args.join(" ")}`));
        }, timeoutMs);
        child.once("exit", (code) => {
            clearTimeout(timeout);
            resolve({ code: code ?? -1, stdout, stderr });
        });
        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}

function parseJson(text: string): unknown {
    return JSON.parse(text.trim());
}

describe("default headless daemon black-box operator smoke", () => {
    const children: ChildProcess[] = [];
    const directories: string[] = [];

    afterEach(async () => {
        const cleanupErrors: Error[] = [];
        for (const child of children.splice(0)) {
            if (child.exitCode === null && child.signalCode === null) {
                try {
                    child.kill("SIGKILL");
                } catch (error) {
                    cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
                }
            }
            try {
                await waitForExit(child, 5_000);
            } catch (error) {
                cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
            }
        }
        for (const directory of directories.splice(0)) {
            try {
                await rm(directory, { recursive: true, force: true });
            } catch (error) {
                cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
            }
        }
        if (cleanupErrors.length > 0) {
            throw new Error(`black-box cleanup failed: ${cleanupErrors.map((error) => error.message).join("; ")}`);
        }
    });

    it("scenario A: startup without provisioned credentials fails conservatively", async () => {
        const root = await mkdtemp(join(tmpdir(), "ouroboros-bb-noauth-"));
        directories.push(root);
        const dataDir = join(root, ".ouroboros");
        const configDir = join(root, ".config");
        const port = await unusedPort();
        const env = baseEnv(root, dataDir, configDir, port);

        const child = startDaemon(env);
        children.push(child);
        const code = await waitForExit(child, 10_000);
        expect(code).not.toBe(0);
        await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    }, 30_000);

    it("scenario B: provisioned credentials allow real daemon startup", async () => {
        const root = await mkdtemp(join(tmpdir(), "ouroboros-bb-startup-"));
        directories.push(root);
        const dataDir = join(root, ".ouroboros");
        const configDir = join(root, ".config");
        const port = await unusedPort();
        const env = baseEnv(root, dataDir, configDir, port);

        const provisioned = await runCli(env, ["auth", "provision", "operator-cli", "mission.read,mission.control,daemon.admin", "90"]);
        expect(provisioned.code).toBe(0);
        const provisionedJson = parseJson(provisioned.stdout) as { result: string; clientId: string };
        expect(provisionedJson.result).toBe("provisioned");
        expect(provisionedJson.clientId).toBe("operator-cli");

        const child = startDaemon(env);
        children.push(child);
        await waitUntilReady(port, child);

        const health = await fetch(`http://127.0.0.1:${port}/health`);
        expect(health.ok).toBe(true);
    }, 60_000);

    it("scenario C: administrative CLI works against the real daemon", async () => {
        const root = await mkdtemp(join(tmpdir(), "ouroboros-bb-cli-"));
        directories.push(root);
        const dataDir = join(root, ".ouroboros");
        const configDir = join(root, ".config");
        const port = await unusedPort();
        const env = baseEnv(root, dataDir, configDir, port);

        await runCli(env, ["auth", "provision", "operator-cli", "mission.read,mission.control,daemon.admin", "90"]);

        const child = startDaemon(env);
        children.push(child);
        await waitUntilReady(port, child);

        const version = await runCli(env, ["version"]);
        expect(version.code).toBe(0);
        const versionJson = parseJson(version.stdout) as { healthy: boolean; protocolVersion: number };
        expect(versionJson.healthy).toBe(true);
        expect(versionJson.protocolVersion).toBe(1);

        const status = await runCli(env, ["status"]);
        expect(status.code).toBe(0);
        const statusJson = parseJson(status.stdout) as { processStatus: string; mode: string };
        expect(statusJson.processStatus).toBe("alive");
        expect(statusJson.mode).toBe("running");

        const missions = await runCli(env, ["missions"]);
        expect(missions.code).toBe(0);
        const missionsJson = parseJson(missions.stdout) as { available: boolean; items: unknown[] };
        expect(missionsJson.available).toBe(true);
        expect(Array.isArray(missionsJson.items)).toBe(true);

        const invocations = await runCli(env, ["invocations"]);
        expect(invocations.code).toBe(0);
        const invocationsJson = parseJson(invocations.stdout) as { available: boolean; items: unknown[] };
        expect(invocationsJson.available).toBe(true);
        expect(Array.isArray(invocationsJson.items)).toBe(true);

        const capabilities = await runCli(env, ["capabilities"]);
        expect(capabilities.code).toBe(0);
        const capabilitiesJson = parseJson(capabilities.stdout) as { available: boolean; items: unknown[]; truncated: boolean };
        expect(capabilitiesJson.available).toBe(true);
        expect(Array.isArray(capabilitiesJson.items)).toBe(true);
        expect(capabilitiesJson.truncated).toBe(false);
    }, 60_000);

    it("scenario D: limited-scope credentials are rejected for unauthorized operations", async () => {
        const root = await mkdtemp(join(tmpdir(), "ouroboros-bb-perms-"));
        directories.push(root);
        const dataDir = join(root, ".ouroboros");
        const configDir = join(root, ".config");
        const port = await unusedPort();
        const env = baseEnv(root, dataDir, configDir, port);

        const provisionFull = await runCli(env, ["auth", "provision", "operator-cli", "mission.read,mission.control,daemon.admin", "90"]);
        expect(provisionFull.code).toBe(0);
        const provisionFullJson = parseJson(provisionFull.stdout) as { result: string; clientId: string };
        expect(provisionFullJson.result).toBe("provisioned");
        expect(provisionFullJson.clientId).toBe("operator-cli");

        const provisionLimited = await runCli(env, ["auth", "provision", "limited-cli", "mission.read", "90"]);
        expect(provisionLimited.code).toBe(0);
        const provisionLimitedJson = parseJson(provisionLimited.stdout) as { result: string; clientId: string };
        expect(provisionLimitedJson.result).toBe("provisioned");
        expect(provisionLimitedJson.clientId).toBe("limited-cli");

        const child = startDaemon(env);
        children.push(child);
        await waitUntilReady(port, child);

        const limitedCredentialFile = join(configDir, "ouroboros", "local-control", "limited-cli.json");
        const fullCredentialFile = join(configDir, "ouroboros", "local-control", "operator-cli.json");
        const limitedToken = JSON.parse(await readFile(limitedCredentialFile, "utf8")) as { token: string };
        const fullToken = JSON.parse(await readFile(fullCredentialFile, "utf8")) as { token: string };

        const limitedEnv = { ...env, OUROBOROS_CLIENT_CREDENTIAL_FILE: limitedCredentialFile };
        const missingMissionId = "no-such-mission";
        const pauseParams = {
            protocolVersion: 1,
            operation: "mission.pause",
            missionId: missingMissionId,
            reason: "operator requested pause via CLI",
        };

        const unauthorizedHttp = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${limitedToken.token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: "scenario-d-forbidden", method: "local_control.command", params: pauseParams }),
        });
        const unauthorizedBody = await unauthorizedHttp.json() as { error?: { code?: string } };
        expect(unauthorizedHttp.status).toBe(403);
        expect(unauthorizedBody.error?.code).toBe("FORBIDDEN");

        const authorizedHttp = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${fullToken.token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: "scenario-d-authorized", method: "local_control.command", params: pauseParams }),
        });
        const authorizedBody = await authorizedHttp.json() as { result?: { ok?: boolean; code?: string } };
        expect(authorizedHttp.status).toBe(200);
        expect(authorizedBody.result?.ok).toBe(false);
        expect(authorizedBody.result?.code).toBe("MISSION_NOT_FOUND");

        const limitedStatus = await runCli(limitedEnv, ["status"]);
        expect(limitedStatus.code).toBe(0);

        const limitedPause = await runCli(limitedEnv, ["mission", "pause", missingMissionId]);
        expect(limitedPause.code).not.toBe(0);

        const missions = await runCli(env, ["missions"]);
        expect(missions.code).toBe(0);
        const missionsJson = parseJson(missions.stdout) as { items: unknown[] };
        expect(missionsJson.items).toHaveLength(0);
    }, 60_000);

    it("scenario E: ordered shutdown releases resources and restart preserves access", async () => {
        const root = await mkdtemp(join(tmpdir(), "ouroboros-bb-restart-"));
        directories.push(root);
        const dataDir = join(root, ".ouroboros");
        const configDir = join(root, ".config");
        const port = await unusedPort();
        const env = baseEnv(root, dataDir, configDir, port);

        await runCli(env, ["auth", "provision", "operator-cli", "mission.read,mission.control,daemon.admin", "90"]);

        const first = startDaemon(env);
        children.push(first);
        await waitUntilReady(port, first);

        first.kill("SIGTERM");
        const firstCode = await waitForExit(first, 10_000);
        expect(firstCode).toBe(0);

        await new Promise((resolve) => setTimeout(resolve, 500));
        await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();

        const second = startDaemon(env);
        children.push(second);
        await waitUntilReady(port, second);

        const version = await runCli(env, ["version"]);
        expect(version.code).toBe(0);

        const capabilities = await runCli(env, ["capabilities"]);
        expect(capabilities.code).toBe(0);
        const capabilitiesJson = parseJson(capabilities.stdout) as { available: boolean; items: unknown[] };
        expect(capabilitiesJson.available).toBe(true);
        expect(Array.isArray(capabilitiesJson.items)).toBe(true);

        second.kill("SIGTERM");
        const secondCode = await waitForExit(second, 10_000);
        expect(secondCode).toBe(0);
    }, 60_000);

    it("scenario F: default composition registers no capabilities", async () => {
        const root = await mkdtemp(join(tmpdir(), "ouroboros-bb-caps-"));
        directories.push(root);
        const dataDir = join(root, ".ouroboros");
        const configDir = join(root, ".config");
        const port = await unusedPort();
        const env = baseEnv(root, dataDir, configDir, port);

        await runCli(env, ["auth", "provision", "operator-cli", "mission.read,mission.control,daemon.admin", "90"]);

        const child = startDaemon(env);
        children.push(child);
        await waitUntilReady(port, child);

        const capabilities = await runCli(env, ["capabilities"]);
        expect(capabilities.code).toBe(0);
        const json = parseJson(capabilities.stdout) as { available: boolean; items: unknown[]; truncated: boolean };
        expect(json.available).toBe(true);
        expect(json.items).toHaveLength(0);
        expect(json.truncated).toBe(false);

        const status = await runCli(env, ["status"]);
        expect(status.code).toBe(0);
        const statusJson = parseJson(status.stdout) as { processStatus: string };
        expect(statusJson.processStatus).toBe("alive");
    }, 60_000);
});
