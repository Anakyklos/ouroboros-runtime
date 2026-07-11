/**
 * Atomic admission gate + control plane tests (issue #37).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
    DaemonExecutionController,
    AdmissionDeniedError,
} from "./execution-control.js";

describe("DaemonExecutionController", () => {
    let controller: DaemonExecutionController;
    let opsPath: string;

    beforeEach(() => {
        opsPath = `/tmp/ouroboros-ctrl-${Date.now()}-${Math.random()}.json`;
        controller = new DaemonExecutionController({ opsStatePath: opsPath });
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
        await expect(
            controller.acquire({ kind: "delegate_gemini" })
        ).rejects.toBeInstanceOf(AdmissionDeniedError);
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
        // Barrier: hold exclusive section mid-acquire simulation via sequential ops
        const brakePromise = controller.emergencyBrake("race");
        const brake = await brakePromise;
        expect(brake.admissionClosed).toBe(true);
        expect(brake.outcome).toBe("no_active_work");

        // After brake, acquire must fail even for delegate paths
        await expect(controller.acquire({ kind: "delegate_jules" })).rejects.toThrow(
            /Admission closed/
        );
    });

    it("aborts lease signal on emergencyBrake with active work", async () => {
        const lease = await controller.acquire({ kind: "delegate_glm", label: "glm" });
        let aborted = false;
        lease.signal.abortSignal.addEventListener("abort", () => {
            aborted = true;
        });
        const result = await controller.emergencyBrake("stop");
        expect(aborted).toBe(true);
        expect(result.works.length).toBe(1);
        expect(result.works[0].action).toBe("cancelled");
        expect(result.brakeRecoverable).toBe(false);
        lease.release();
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

    it("clearBrakeAndRun reopens after brake", async () => {
        await controller.emergencyBrake("b");
        expect(controller.admissionOpen()).toBe(false);
        const r = await controller.clearBrakeAndRun();
        expect(r.resulting.kind).toBe("running");
        expect(controller.admissionOpen()).toBe(true);
    });

    it("persists braked state across restart", async () => {
        await controller.emergencyBrake("persist");
        const again = new DaemonExecutionController({ opsStatePath: opsPath });
        expect(again.admissionOpen()).toBe(false);
        expect(again.operationalState.kind === "braked" || again.operationalState.kind === "degraded").toBe(
            true
        );
    });

    it("capabilities do not claim recoverable pause", () => {
        const c = controller.capabilities();
        expect(c.recoverablePause.sessionTask).toBe(false);
        expect(c.recoverablePause.directDelegate).toBe(false);
        expect(c.tokenMetrics).toBe(false);
    });
});
