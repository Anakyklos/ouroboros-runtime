/**
 * Unit tests for daemon control contracts (issue #37).
 */

import { describe, it, expect } from "bun:test";
import {
    isDaemonMode,
    canTransitionMode,
    DAEMON_CAPABILITIES,
    buildMetric,
    unavailableMetric,
} from "./daemon-controls.js";

describe("daemon-controls contracts", () => {
    it("accepts only known modes (no scenic frenzy)", () => {
        expect(isDaemonMode("running")).toBe(true);
        expect(isDaemonMode("pause")).toBe(true);
        expect(isDaemonMode("frenzy")).toBe(false);
        expect(isDaemonMode("turbo")).toBe(false);
        expect(isDaemonMode(null)).toBe(false);
        expect(isDaemonMode(undefined)).toBe(false);
        expect(isDaemonMode(1)).toBe(false);
    });

    it("allows documented transitions including no-ops", () => {
        expect(canTransitionMode("running", "pause")).toBe(true);
        expect(canTransitionMode("pause", "running")).toBe(true);
        expect(canTransitionMode("running", "running")).toBe(true);
    });

    it("declares honest capabilities", () => {
        expect(DAEMON_CAPABILITIES.tokenMetrics).toBe(false);
        expect(DAEMON_CAPABILITIES.statusMetrics).toBe(true);
        expect(DAEMON_CAPABILITIES.modeSwitching).toBe(true);
        expect(DAEMON_CAPABILITIES.emergencyBrake).toBe(true);
        expect(DAEMON_CAPABILITIES.brakeRecoverable).toBe(false);
        expect(DAEMON_CAPABILITIES.modePersistence).toBe(true);
        expect([...DAEMON_CAPABILITIES.supportedModes]).toEqual(["running", "pause"]);
    });

    it("distinguishes real zero from unavailable metrics", () => {
        const zero = buildMetric(0, "count");
        const missing = unavailableMetric("no source");
        expect(zero.available).toBe(true);
        if (zero.available) expect(zero.value).toBe(0);
        expect(missing.available).toBe(false);
        if (!missing.available) expect(missing.reason).toContain("no source");
    });
});
