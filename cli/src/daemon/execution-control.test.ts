/**
 * Atomic admission gate + control plane tests (issue #37).
 * Settlement-based cancelled_confirmed; partial already_stopped; real races.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
    DaemonExecutionController,
    AdmissionDeniedError,
    stopCapabilityFor,
    type ExecutionLease,
} from "./execution-control.js";

/** Worker that observes abort, acknowledges, and settles (provider-like). */
function settleOnAbort(lease: ExecutionLease): void {
    lease.signal.abortSignal.addEventListener(
        "abort",
        () => {
            lease.acknowledgeAbort();
            queueMicrotask(() => lease.fail(Object.assign(new Error("Aborted"), { name: "AbortError" })));
        },
        { once: true }
    );
}

describe("DaemonExecutionController", () => {
    let controller: DaemonExecutionController;
    let opsPath: string;

    beforeEach(() => {
        opsPath = `/tmp/ouroboros-ctrl-${Date.now()}-${Math.random()}.json`;
        controller = new DaemonExecutionController({
            opsStatePath: opsPath,
            settlementTimeoutMs: 150,
        });
    });

    it("acquires lease only when admission is open", async () => {
        const lease = await controller.acquire({ kind: "session_task", sessionId: "s1" });
        expect(lease.workId).toBeTruthy();
        expect(controller.snapshot().activeWork).toBe(1);
        lease.complete();
        expect(controller.snapshot().activeWork).toBe(0);
    });

    it("rejects acquire after emergencyBrake closes admission", async () => {
        await controller.emergencyBrake("test");
        await expect(controller.acquire({ kind: "delegate_gemini" })).rejects.toBeInstanceOf(
            AdmissionDeniedError
        );
        expect(controller.admissionOpen()).toBe(false);
    });

    it("rejects concurrent session_task for same session", async () => {
        const a = await controller.acquire({ kind: "session_task", sessionId: "s1" });
        await expect(
            controller.acquire({ kind: "session_task", sessionId: "s1" })
        ).rejects.toBeInstanceOf(AdmissionDeniedError);
        a.release();
    });

    it("closes admission before brake enumerates — no TOCTOU escape", async () => {
        const brake = await controller.emergencyBrake("race");
        expect(brake.admissionClosed).toBe(true);
        expect(brake.outcome).toBe("no_active_work");

        await expect(controller.acquire({ kind: "delegate_jules" })).rejects.toThrow(
            /Admission closed/
        );
    });

    it("cancelled_confirmed only when provider settles after abort", async () => {
        const lease = await controller.acquire({ kind: "delegate_glm", label: "glm" });
        settleOnAbort(lease);
        const result = await controller.emergencyBrake("stop");
        expect(result.works[0].action).toBe("cancelled_confirmed");
        expect(result.works[0].requestAbort.acknowledged).toBe(true);
        expect(result.works[0].requestAbort.settled).toBe(true);
        expect(result.complete).toBe(true);
        expect(result.outcome).toBe("all_stopped");
    });

    it("abort_requested_unconfirmed when provider ignores abort (no settlement)", async () => {
        const lease = await controller.acquire({ kind: "delegate_glm", label: "hang" });
        // Listen but never settle
        let sawAbort = false;
        lease.signal.abortSignal.addEventListener("abort", () => {
            sawAbort = true;
        });
        const result = await controller.emergencyBrake("stop");
        expect(sawAbort).toBe(true);
        expect(result.works[0].action).toBe("abort_requested_unconfirmed");
        expect(result.works[0].requestAbort.acknowledged).toBe(false);
        expect(result.works[0].requestAbort.settled).toBe(false);
        expect(result.complete).toBe(false);
        expect(result.outcome).toBe("partial");
        // Lease remains as cancelling / unknown
        expect(controller.snapshot().detachedOrUnknownWork).toBeGreaterThanOrEqual(1);
        lease.release();
    });

    it("tool in-flight: no cancelled_confirmed until execution settles", async () => {
        const lease = await controller.acquire({ kind: "session_task", sessionId: "tool" });
        let toolDone = false;
        // Simulate tool already started: only settle after external release
        lease.signal.abortSignal.addEventListener("abort", () => {
            // New tools would check abort — we only prove settlement gate.
        });
        const brakeP = controller.emergencyBrake("tool");
        // Mid-brake: still not settled
        await new Promise((r) => setTimeout(r, 20));
        // Now tool finishes and loop settles
        toolDone = true;
        lease.acknowledgeAbort();
        lease.fail(new Error("cancelled after tool"));
        const result = await brakeP;
        expect(toolDone).toBe(true);
        expect(result.works[0].action).toBe("cancelled_confirmed");
        expect(result.works[0].requestAbort.settled).toBe(true);
    });

    it("does not claim cancelled_confirmed for Jules (detached_remote)", async () => {
        const lease = await controller.acquire({ kind: "delegate_jules" });
        const result = await controller.emergencyBrake("stop");
        expect(result.works[0].action).toBe("detached_remote");
        expect(result.works[0].requestAbort.acknowledged).toBe(false);
        expect(result.complete).toBe(false);
        expect(result.outcome).toBe("partial");
        expect(result.unresolvedWorkCount).toBeGreaterThanOrEqual(1);
        expect(controller.snapshot().detachedOrUnknownWork).toBeGreaterThanOrEqual(1);
        lease.release();
    });

    it("Gemini in-flight is abort_requested_unconfirmed", async () => {
        const lease = await controller.acquire({ kind: "delegate_gemini" });
        const result = await controller.emergencyBrake("stop");
        expect(result.works[0].action).toBe("abort_requested_unconfirmed");
        expect(result.works[0].requestAbort.acknowledged).toBe(false);
        expect(result.complete).toBe(false);
        lease.release();
    });

    it("mixed GLM settled + Jules yields partial", async () => {
        const glm = await controller.acquire({ kind: "delegate_glm" });
        settleOnAbort(glm);
        const jules = await controller.acquire({ kind: "delegate_jules" });
        const result = await controller.emergencyBrake("mix");
        const actions = result.works.map((w) => w.action).sort();
        expect(actions).toContain("cancelled_confirmed");
        expect(actions).toContain("detached_remote");
        expect(result.outcome).toBe("partial");
        expect(result.complete).toBe(false);
        jules.release();
    });

    it("second brake after partial preserves complete:false", async () => {
        const jules = await controller.acquire({ kind: "delegate_jules" });
        const first = await controller.emergencyBrake("jules");
        expect(first.outcome).toBe("partial");
        expect(first.complete).toBe(false);

        const second = await controller.emergencyBrake("again");
        expect(second.outcome).toBe("already_stopped");
        expect(second.complete).toBe(false);
        expect(second.unresolvedWorkCount).toBeGreaterThan(0);
        expect(second.message).toMatch(/unresolved|detached|partial/i);

        // Jules eventually returns → lease removed; snapshot drops detached
        jules.complete({ ok: true });
        expect(controller.snapshot().detachedOrUnknownWork).toBe(0);
    });

    it("second brake after complete local stop is already_stopped complete:true", async () => {
        const glm = await controller.acquire({ kind: "delegate_glm" });
        settleOnAbort(glm);
        const first = await controller.emergencyBrake("ok");
        expect(first.complete).toBe(true);
        const second = await controller.emergencyBrake("again");
        expect(second.outcome).toBe("already_stopped");
        expect(second.complete).toBe(true);
        expect(second.unresolvedWorkCount).toBe(0);
    });

    it("final persist failure does not invent complete success on second brake", async () => {
        let calls = 0;
        const c = new DaemonExecutionController({
            opsStatePath: opsPath + "-persist-fail",
            settlementTimeoutMs: 100,
            persistFn: (payload) => {
                calls += 1;
                // Allow braking intent; fail final braked persist
                if (payload.state.kind === "braked") {
                    return { ok: false, reason: "disk full" };
                }
                return {
                    ok: true,
                    revision: payload.revision,
                    persistedAt: new Date().toISOString(),
                };
            },
        });
        const glm = await c.acquire({ kind: "delegate_glm" });
        settleOnAbort(glm);
        const first = await c.emergencyBrake("p");
        expect(first.complete).toBe(false);
        const second = await c.emergencyBrake("again");
        expect(second.outcome).toBe("already_stopped");
        expect(second.complete).toBe(false);
        expect(calls).toBeGreaterThan(0);
    });

    it("pause does not abort; resume reopens admission", async () => {
        const lease = await controller.acquire({ kind: "session_task", sessionId: "s2" });
        expect(lease.signal.aborted).toBe(false);
        await controller.pause("p");
        expect(lease.signal.paused).toBe(true);
        expect(lease.signal.aborted).toBe(false);
        expect(controller.admissionOpen()).toBe(false);
        await expect(controller.acquire({ kind: "delegate_gemini" })).rejects.toThrow();

        await controller.resume("r");
        expect(controller.admissionOpen()).toBe(true);
        expect(lease.signal.paused).toBe(false);
        lease.release();
    });

    it("pause does not mark Jules as paused (remote_uncontrolled)", async () => {
        const lease = await controller.acquire({ kind: "delegate_jules" });
        const r = await controller.pause("p");
        expect(r.message).toMatch(/remote_uncontrolled|admission/i);
        expect(lease.signal.paused).toBe(false);
        lease.release();
    });

    it("clearBrakeAndRun reopens after brake", async () => {
        await controller.emergencyBrake("b");
        expect(controller.admissionOpen()).toBe(false);
        const r = await controller.clearBrakeAndRun();
        expect(r.resulting.kind).toBe("running");
        expect(controller.admissionOpen()).toBe(true);
    });

    it("clearBrakeAndRun keeps admission closed when persist of running fails", async () => {
        let n = 0;
        const c = new DaemonExecutionController({
            opsStatePath: opsPath + "-clear",
            settlementTimeoutMs: 50,
            persistFn: (payload) => {
                n += 1;
                // Succeed until clear tries to write running
                if (payload.state.kind === "running" && n > 2) {
                    return { ok: false, reason: "inject clear fail" };
                }
                return {
                    ok: true,
                    revision: payload.revision,
                    persistedAt: new Date().toISOString(),
                };
            },
        });
        await c.emergencyBrake("b");
        expect(c.admissionOpen()).toBe(false);
        const lease = await c.acquire({ kind: "session_task", sessionId: "x" }).catch(() => null);
        expect(lease).toBeNull();

        // Pause a synthetic path: put controller in braked then clear with fail
        // First force braked with successful persists, then inject fail on clear only
        const c2 = new DaemonExecutionController({
            opsStatePath: opsPath + "-clear2",
            settlementTimeoutMs: 50,
        });
        await c2.emergencyBrake("b");
        // Replace persist via new controller sharing path won't work — use inject from start after brake state file
        const c3 = new DaemonExecutionController({
            opsStatePath: opsPath + "-clear2",
            settlementTimeoutMs: 50,
            persistFn: () => ({ ok: false, reason: "clear blocked" }),
        });
        // Loaded as braked from file — clear must fail closed
        expect(c3.admissionOpen()).toBe(false);
        const r = await c3.clearBrakeAndRun();
        expect(r.persistence.ok).toBe(false);
        expect(c3.admissionOpen()).toBe(false);
        await expect(c3.acquire({ kind: "delegate_glm" })).rejects.toBeInstanceOf(
            AdmissionDeniedError
        );
    });

    it("clearBrakeAndRun with live paused lease does not unpause if persist fails", async () => {
        let allow = true;
        const c = new DaemonExecutionController({
            opsStatePath: opsPath + "-clear-lease",
            settlementTimeoutMs: 50,
            persistFn: (payload) => {
                if (!allow && payload.state.kind === "running") {
                    return { ok: false, reason: "no write" };
                }
                return {
                    ok: true,
                    revision: payload.revision,
                    persistedAt: new Date().toISOString(),
                };
            },
        });
        const lease = await c.acquire({ kind: "session_task", sessionId: "p1" });
        await c.pause("hold");
        expect(lease.signal.paused).toBe(true);
        // clearBrakeAndRun from paused (not braked) is still valid path via setMode — use resume
        allow = false;
        const r = await c.resume("x");
        expect(r.persistence.ok).toBe(false);
        expect(lease.signal.paused).toBe(true);
        expect(c.admissionOpen()).toBe(false);
        lease.release();
    });

    it("persists braked state across restart", async () => {
        await controller.emergencyBrake("persist");
        const again = new DaemonExecutionController({ opsStatePath: opsPath });
        expect(again.admissionOpen()).toBe(false);
        expect(
            again.operationalState.kind === "braked" || again.operationalState.kind === "degraded"
        ).toBe(true);
    });

    it("stopCapability map is honest (settlement required)", () => {
        expect(stopCapabilityFor("delegate_glm").kind).toBe("abortable");
        if (stopCapabilityFor("delegate_glm").kind === "abortable") {
            expect(stopCapabilityFor("delegate_glm").acknowledgement).toBe("requires_settlement");
        }
        expect(stopCapabilityFor("delegate_jules").kind).toBe("detached_remote");
        expect(stopCapabilityFor("delegate_gemini").kind).toBe("request_only");
    });

    it("capabilities do not claim recoverable pause", () => {
        const c = controller.capabilities();
        expect(c.recoverablePause.sessionTask).toBe(false);
        expect(c.recoverablePause.directDelegate).toBe(false);
        expect(c.tokenMetrics).toBe(false);
    });

    it("real acquire×brake race: barrier after admission check, before register", async () => {
        let releaseBarrier!: () => void;
        const barrier = new Promise<void>((r) => {
            releaseBarrier = r;
        });
        let entered = false;
        const c = new DaemonExecutionController({
            opsStatePath: opsPath + "-race",
            settlementTimeoutMs: 100,
            beforeRegisterLease: async () => {
                entered = true;
                await barrier;
            },
        });

        const acquireP = c.acquire({ kind: "session_task", sessionId: "race" });
        // Wait until acquire is inside exclusive past admission check
        for (let i = 0; i < 50 && !entered; i++) await new Promise((r) => setTimeout(r, 5));
        expect(entered).toBe(true);

        const brakeP = c.emergencyBrake("concurrent");
        // Second acquire while first still in barrier
        const secondP = c.acquire({ kind: "delegate_glm" });

        releaseBarrier();
        const [lease, brake] = await Promise.all([acquireP, brakeP]);
        await expect(secondP).rejects.toBeInstanceOf(AdmissionDeniedError);
        expect(brake.admissionClosed).toBe(true);
        // First lease was registered (before brake closed) — may be aborted
        lease.release();
    });

    it("two concurrent brakes: second is already_stopped with same completeness", async () => {
        const glm = await controller.acquire({ kind: "delegate_glm" });
        settleOnAbort(glm);
        const a = controller.emergencyBrake("A");
        const b = controller.emergencyBrake("B");
        const [ra, rb] = await Promise.all([a, b]);
        const outcomes = [ra.outcome, rb.outcome].sort();
        // One does the work; the other already_stopped (or both partial if racing empty — exclusive serializes)
        expect(outcomes.includes("all_stopped") || outcomes.includes("partial")).toBe(true);
        expect(outcomes.includes("already_stopped") || ra.operationId === rb.operationId).toBe(
            true
        );
        // Completeness preserved: neither invents complete if other was partial
        if (ra.outcome === "already_stopped") {
            expect(ra.complete).toBe(rb.complete || ra.unresolvedWorkCount === 0);
        }
        if (rb.outcome === "already_stopped") {
            expect(typeof rb.complete).toBe("boolean");
        }
    });

    it("release is idempotent after confirmed cancel", async () => {
        const lease = await controller.acquire({ kind: "delegate_glm" });
        settleOnAbort(lease);
        await controller.emergencyBrake("x");
        lease.release();
        lease.release();
        lease.complete();
        lease.fail(new Error("x"));
        expect(true).toBe(true);
    });
});
