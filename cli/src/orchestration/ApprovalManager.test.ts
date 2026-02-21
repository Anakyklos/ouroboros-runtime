/**
 * 🔐 ApprovalManager Unit Tests
 *
 * Tests for the approval workflow system.
 * Tests request creation, queuing, approval/rejection, history tracking.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { ApprovalManager } from "./ApprovalManager.js";
import { ApprovalStatus, ApprovalPriority } from "./approval-types.js";
import type { ApprovalConfig } from "./approval-types.js";

// --- TEST SETUP ---

interface TestSetup {
    tempDir: string;
    approvalManager: ApprovalManager;
    cleanup: () => void;
}

function setupTest(): TestSetup {
    const tempDir = path.join(tmpdir(), `approval-test-${Date.now()}`);

    fs.mkdirSync(tempDir, { recursive: true });

    const config: Partial<ApprovalConfig> = {
        projectRoot: tempDir,
        approvalTimeoutMs: 60000,
        maxPendingRequests: 100,
        verbose: false,
    };

    const approvalManager = new ApprovalManager(config);

    return {
        tempDir,
        approvalManager,
        cleanup: () => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        },
    };
}

// --- TEST SUITES ---

describe("ApprovalManager", () => {
    describe("Request Creation", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should create approval request with minimal parameters", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/test.ts",
                "src/utils/test.ts"
            );

            expect(request.id).toBeDefined();
            expect(request.sourcePath).toBe("utils/test.ts");
            expect(request.targetPath).toBe("src/utils/test.ts");
            expect(request.status).toBe(ApprovalStatus.PENDING);
            expect(request.priority).toBe(ApprovalPriority.NORMAL);
            expect(request.createdAt).toBeDefined();
            expect(request.updatedAt).toBeDefined();
        });

        it("should create approval request with all parameters", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/full.ts",
                "src/utils/full.ts",
                "task-123",
                ApprovalPriority.HIGH,
                ["TEST passed", "TYPE_CHECK passed"]
            );

            expect(request.id).toBeDefined();
            expect(request.sourcePath).toBe("utils/full.ts");
            expect(request.targetPath).toBe("src/utils/full.ts");
            expect(request.taskId).toBe("task-123");
            expect(request.priority).toBe(ApprovalPriority.HIGH);
            expect(request.validationResults).toEqual(["TEST passed", "TYPE_CHECK passed"]);
            expect(request.status).toBe(ApprovalStatus.PENDING);
        });

        it("should add request to pending queue", async () => {
            await setup.approvalManager.createRequest(
                "utils/pending.ts",
                "src/utils/pending.ts"
            );

            const state = setup.approvalManager.getState();
            expect(state.pending).toHaveLength(1);
            expect(state.requests).toHaveLength(1);
            expect(state.pending[0].status).toBe(ApprovalStatus.PENDING);
        });

        it("should generate unique request IDs", async () => {
            const request1 = await setup.approvalManager.createRequest("file1.ts", "src/file1.ts");
            const request2 = await setup.approvalManager.createRequest("file2.ts", "src/file2.ts");

            expect(request1.id).not.toBe(request2.id);
        });

        it("should throw error when max pending requests reached", async () => {
            const config: Partial<ApprovalConfig> = {
                projectRoot: setup.tempDir,
                maxPendingRequests: 2,
                verbose: false,
            };

            const manager = new ApprovalManager(config);

            await manager.createRequest("file1.ts", "src/file1.ts");
            await manager.createRequest("file2.ts", "src/file2.ts");

            await expect(
                manager.createRequest("file3.ts", "src/file3.ts")
            ).toThrow("Maximum pending requests reached");
        });
    });

    describe("Request Queuing", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should return pending requests sorted by priority", async () => {
            await setup.approvalManager.createRequest(
                "low.ts",
                "src/low.ts",
                "task-1",
                ApprovalPriority.LOW
            );

            await setup.approvalManager.createRequest(
                "urgent.ts",
                "src/urgent.ts",
                "task-2",
                ApprovalPriority.URGENT
            );

            await setup.approvalManager.createRequest(
                "normal.ts",
                "src/normal.ts",
                "task-3",
                ApprovalPriority.NORMAL
            );

            const pending = setup.approvalManager.getPending();

            expect(pending).toHaveLength(3);
            expect(pending[0].priority).toBe(ApprovalPriority.URGENT);
            expect(pending[1].priority).toBe(ApprovalPriority.NORMAL);
            expect(pending[2].priority).toBe(ApprovalPriority.LOW);
        });

        it("should sort by priority then by date", async () => {
            // Create requests with same priority, different times
            await setup.approvalManager.createRequest(
                "older.ts",
                "src/older.ts",
                "task-1",
                ApprovalPriority.NORMAL
            );

            await new Promise(resolve => setTimeout(resolve, 10)); // Small delay

            await setup.approvalManager.createRequest(
                "newer.ts",
                "src/newer.ts",
                "task-2",
                ApprovalPriority.NORMAL
            );

            const pending = setup.approvalManager.getPending();

            expect(pending).toHaveLength(2);
            // Newer should come first (more recent)
            expect(pending[0].sourcePath).toBe("newer.ts");
            expect(pending[1].sourcePath).toBe("older.ts");
        });
    });

    describe("Approval Workflow", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should approve pending request", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/approve.ts",
                "src/utils/approve.ts"
            );

            const result = await setup.approvalManager.approveRequest(
                request.id,
                "reviewer-user",
                "Looks good!"
            );

            expect(result.success).toBe(true);

            const updated = setup.approvalManager.getRequest(request.id);
            expect(updated?.status).toBe(ApprovalStatus.APPROVED);
            expect(updated?.reviewedBy).toBe("reviewer-user");
            expect(updated?.reviewerComments).toBe("Looks good!");
            expect(updated?.reviewedAt).toBeDefined();
        });

        it("should move approved request from pending to approved", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/move.ts",
                "src/utils/move.ts"
            );

            let state = setup.approvalManager.getState();
            expect(state.pending).toHaveLength(1);
            expect(state.approved).toHaveLength(0);

            await setup.approvalManager.approveRequest(request.id, "reviewer");

            state = setup.approvalManager.getState();
            expect(state.pending).toHaveLength(0);
            expect(state.approved).toHaveLength(1);
            expect(state.approved[0].id).toBe(request.id);
        });

        it("should not approve already approved request", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/double.ts",
                "src/utils/double.ts"
            );

            await setup.approvalManager.approveRequest(request.id, "reviewer1");

            const result = await setup.approvalManager.approveRequest(
                request.id,
                "reviewer2",
                "Second approval"
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain("not pending");
        });

        it("should return error for non-existent request", async () => {
            const result = await setup.approvalManager.approveRequest(
                "non-existent-id",
                "reviewer"
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain("Request not found");
        });
    });

    describe("Rejection Workflow", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should reject pending request with reason", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/reject.ts",
                "src/utils/reject.ts"
            );

            const result = await setup.approvalManager.rejectRequest(
                request.id,
                "reviewer-user",
                "Not ready",
                "Needs more tests"
            );

            expect(result.success).toBe(true);

            const updated = setup.approvalManager.getRequest(request.id);
            expect(updated?.status).toBe(ApprovalStatus.REJECTED);
            expect(updated?.reviewedBy).toBe("reviewer-user");
            expect(updated?.rejectionReason).toBe("Not ready");
            expect(updated?.reviewerComments).toBe("Needs more tests");
            expect(updated?.reviewedAt).toBeDefined();
        });

        it("should move rejected request from pending to rejected", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/reject-move.ts",
                "src/utils/reject-move.ts"
            );

            let state = setup.approvalManager.getState();
            expect(state.pending).toHaveLength(1);
            expect(state.rejected).toHaveLength(0);

            await setup.approvalManager.rejectRequest(request.id, "reviewer", "No");

            state = setup.approvalManager.getState();
            expect(state.pending).toHaveLength(0);
            expect(state.rejected).toHaveLength(1);
            expect(state.rejected[0].id).toBe(request.id);
        });

        it("should not reject already rejected request", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/double-reject.ts",
                "src/utils/double-reject.ts"
            );

            await setup.approvalManager.rejectRequest(request.id, "reviewer1", "No");

            const result = await setup.approvalManager.rejectRequest(
                request.id,
                "reviewer2",
                "Still no"
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain("not pending");
        });
    });

    describe("Cancellation", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should cancel pending request", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/cancel.ts",
                "src/utils/cancel.ts"
            );

            const result = await setup.approvalManager.cancelRequest(
                request.id,
                "Withdrawn by user"
            );

            expect(result.success).toBe(true);

            const updated = setup.approvalManager.getRequest(request.id);
            expect(updated?.status).toBe(ApprovalStatus.CANCELLED);
            expect(updated?.rejectionReason).toBe("Withdrawn by user");
        });

        it("should remove cancelled request from pending", async () => {
            const request = await setup.approvalManager.createRequest(
                "utils/cancel-move.ts",
                "src/utils/cancel-move.ts"
            );

            let state = setup.approvalManager.getState();
            expect(state.pending).toHaveLength(1);

            await setup.approvalManager.cancelRequest(request.id);

            state = setup.approvalManager.getState();
            expect(state.pending).toHaveLength(0);
        });
    });

    describe("Request Retrieval and Filtering", () => {
        let setup: TestSetup;

        beforeEach(async () => {
            setup = setupTest();

            // Create test requests
            await setup.approvalManager.createRequest(
                "file1.ts",
                "src/file1.ts",
                "task-1",
                ApprovalPriority.URGENT
            );

            await setup.approvalManager.createRequest(
                "file2.ts",
                "src/file2.ts",
                "task-2",
                ApprovalPriority.NORMAL
            );

            await setup.approvalManager.createRequest(
                "file3.ts",
                "src/file3.ts",
                "task-1",
                ApprovalPriority.HIGH
            );

            // Approve one request
            const req1 = setup.approvalManager.getState().requests[0];
            await setup.approvalManager.approveRequest(req1.id, "reviewer");
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should retrieve request by ID", () => {
            const state = setup.approvalManager.getState();
            const request = state.requests[0];

            const retrieved = setup.approvalManager.getRequest(request.id);

            expect(retrieved).toEqual(request);
        });

        it("should return undefined for non-existent ID", () => {
            const retrieved = setup.approvalManager.getRequest("non-existent");

            expect(retrieved).toBeUndefined();
        });

        it("should filter requests by status", () => {
            const pending = setup.approvalManager.listRequests({
                status: ApprovalStatus.PENDING,
            });

            expect(pending).toHaveLength(2);
            expect(pending.every(r => r.status === ApprovalStatus.PENDING)).toBe(true);

            const approved = setup.approvalManager.listRequests({
                status: ApprovalStatus.APPROVED,
            });

            expect(approved).toHaveLength(1);
            expect(approved[0].status).toBe(ApprovalStatus.APPROVED);
        });

        it("should filter requests by priority", () => {
            const urgent = setup.approvalManager.listRequests({
                priority: ApprovalPriority.URGENT,
            });

            expect(urgent).toHaveLength(1);
            expect(urgent[0].priority).toBe(ApprovalPriority.URGENT);
        });

        it("should filter requests by task ID", () => {
            const task1Requests = setup.approvalManager.listRequests({
                taskId: "task-1",
            });

            expect(task1Requests).toHaveLength(2);
            expect(task1Requests.every(r => r.taskId === "task-1")).toBe(true);
        });

        it("should filter requests by date range", async () => {
            const now = new Date();
            const past = new Date(now.getTime() - 10000);

            const recent = setup.approvalManager.listRequests({
                createdAfter: past,
            });

            expect(recent.length).toBeGreaterThan(0);
        });

        it("should limit results", () => {
            const limited = setup.approvalManager.listRequests({
                limit: 2,
            });

            expect(limited).toHaveLength(2);
        });

        it("should combine multiple filters", () => {
            const results = setup.approvalManager.listRequests({
                status: ApprovalStatus.PENDING,
                taskId: "task-1",
            });

            expect(results).toHaveLength(1);
            expect(results[0].taskId).toBe("task-1");
            expect(results[0].status).toBe(ApprovalStatus.PENDING);
        });
    });

    describe("Statistics", () => {
        let setup: TestSetup;

        beforeEach(async () => {
            setup = setupTest();

            // Create test data
            await setup.approvalManager.createRequest("file1.ts", "src/file1.ts", "task-1");
            await setup.approvalManager.createRequest("file2.ts", "src/file2.ts", "task-2");
            await setup.approvalManager.createRequest("file3.ts", "src/file3.ts", "task-3");

            // Approve one
            const req1 = setup.approvalManager.getState().requests[0];
            await setup.approvalManager.approveRequest(req1.id, "reviewer1");

            // Reject one
            const req2 = setup.approvalManager.getState().requests[1];
            await setup.approvalManager.rejectRequest(req2.id, "reviewer2", "Not good");

            // Cancel one
            const req3 = setup.approvalManager.getState().requests[2];
            await setup.approvalManager.cancelRequest(req3.id, "Timeout");
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should calculate correct statistics", () => {
            const stats = setup.approvalManager.getStats();

            expect(stats.total).toBe(3);
            expect(stats.pending).toBe(0);
            expect(stats.approved).toBe(1);
            expect(stats.rejected).toBe(1);
            expect(stats.cancelled).toBe(1);
        });

        it("should calculate approval rate", () => {
            const stats = setup.approvalManager.getStats();

            const expectedRate = (1 / 2) * 100; // 1 approved out of 2 decisions (approved + rejected)
            expect(stats.approvalRate).toBeCloseTo(expectedRate);
        });

        it("should calculate average approval time", async () => {
            const manager = setup.approvalManager;

            const request = await manager.createRequest("timing.ts", "src/timing.ts");
            await new Promise(resolve => setTimeout(resolve, 50));
            await manager.approveRequest(request.id, "reviewer");

            const stats = manager.getStats();
            expect(stats.avgApprovalTime).toBeGreaterThan(0);
        });
    });

    describe("State Persistence", () => {
        let setup: TestSetup;

        beforeEach(() => {
            setup = setupTest();
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should save state to disk", async () => {
            await setup.approvalManager.createRequest("file1.ts", "src/file1.ts");

            const statePath = path.join(setup.tempDir, ".agent", "approval", "approval-state.json");
            expect(fs.existsSync(statePath)).toBe(true);

            const content = fs.readFileSync(statePath, "utf-8");
            const data = JSON.parse(content);
            expect(data.requests).toHaveLength(1);
        });

        it("should load state from disk", async () => {
            await setup.approvalManager.createRequest("file1.ts", "src/file1.ts", "task-1");
            await setup.approvalManager.createRequest("file2.ts", "src/file2.ts", "task-2");

            // Create new manager - should load existing state
            const newManager = new ApprovalManager({
                projectRoot: setup.tempDir,
                verbose: false,
            });

            const state = newManager.getState();
            expect(state.requests).toHaveLength(2);
            expect(state.requests[0].sourcePath).toBe("file1.ts");
            expect(state.requests[1].sourcePath).toBe("file2.ts");
        });

        it("should handle corrupted state file", () => {
            const statePath = path.join(setup.tempDir, ".agent", "approval", "approval-state.json");
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, "invalid json", "utf-8");

            const manager = new ApprovalManager({
                projectRoot: setup.tempDir,
                verbose: false,
            });

            const state = manager.getState();
            expect(state.requests).toHaveLength(0); // Should start fresh
        });
    });

    describe("Cleanup Operations", () => {
        let setup: TestSetup;

        beforeEach(async () => {
            setup = setupTest();

            // Create some old completed requests
            await setup.approvalManager.createRequest("old1.ts", "src/old1.ts");
            await setup.approvalManager.createRequest("old2.ts", "src/old2.ts");

            const req1 = setup.approvalManager.getState().requests[0];
            const req2 = setup.approvalManager.getState().requests[1];

            await setup.approvalManager.approveRequest(req1.id, "reviewer");
            await setup.approvalManager.rejectRequest(req2.id, "reviewer", "No");
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should mark approved request as promoted", () => {
            const state = setup.approvalManager.getState();
            const approvedReq = state.approved[0];

            const marked = setup.approvalManager.markAsPromoted(approvedReq.id);

            expect(marked).toBe(true);

            const newState = setup.approvalManager.getState();
            expect(newState.approved).toHaveLength(0);
        });

        it("should return false when marking non-approved request", () => {
            const state = setup.approvalManager.getState();
            const rejectedReq = state.rejected[0];

            const marked = setup.approvalManager.markAsPromoted(rejectedReq.id);

            expect(marked).toBe(false);
        });

        it("should cleanup old completed requests", () => {
            const stateBefore = setup.approvalManager.getState();
            expect(stateBefore.requests.length).toBeGreaterThan(0);

            // Remove all completed requests (0 max age)
            const cleaned = setup.approvalManager.cleanupOld(0);

            expect(cleaned).toBeGreaterThan(0);

            const stateAfter = setup.approvalManager.getState();
            // Only pending should remain
            expect(stateAfter.requests.length).toBeLessThan(stateBefore.requests.length);
        });
    });

    describe("Promotion Tracking", () => {
        let setup: TestSetup;

        beforeEach(async () => {
            setup = setupTest();

            await setup.approvalManager.createRequest("promote.ts", "src/promote.ts");
            const request = setup.approvalManager.getState().requests[0];
            await setup.approvalManager.approveRequest(request.id, "reviewer");
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should remove request from approved after marking as promoted", () => {
            const state = setup.approvalManager.getState();
            expect(state.approved).toHaveLength(1);

            const approvedReq = state.approved[0];
            setup.approvalManager.markAsPromoted(approvedReq.id);

            const newState = setup.approvalManager.getState();
            expect(newState.approved).toHaveLength(0);
        });
    });

    describe("Notification Callback", () => {
        let setup: TestSetup;
        let notifications: any[] = [];

        beforeEach(() => {
            setup = setupTest();
            notifications = [];

            const config: Partial<ApprovalConfig> = {
                projectRoot: setup.tempDir,
                verbose: false,
            };

            const notificationCallback = async (request: any) => {
                notifications.push(request);
            };

            setup.approvalManager = new ApprovalManager(config, undefined, notificationCallback);
        });

        afterEach(() => {
            setup.cleanup();
        });

        it("should call notification callback when request is created", async () => {
            await setup.approvalManager.createRequest("notify.ts", "src/notify.ts");

            expect(notifications).toHaveLength(1);
            expect(notifications[0].sourcePath).toBe("notify.ts");
        });

        it("should handle notification callback errors gracefully", async () => {
            const config: Partial<ApprovalConfig> = {
                projectRoot: setup.tempDir,
                verbose: false,
            };

            const errorCallback = async () => {
                throw new Error("Notification failed");
            };

            const manager = new ApprovalManager(config, undefined, errorCallback);

            // Should not throw
            const request = await manager.createRequest("error.ts", "src/error.ts");

            expect(request).toBeDefined();
        });
    });

    describe("Expiry and Cleanup", () => {
        it("should cleanup expired requests on initialization", async () => {
            const tempDir = path.join(tmpdir(), `expiry-test-${Date.now()}`);
            fs.mkdirSync(tempDir, { recursive: true });

            // Create a state file with an old expired request
            const stateDir = path.join(tempDir, ".agent", "approval");
            fs.mkdirSync(stateDir, { recursive: true });

            const statePath = path.join(stateDir, "approval-state.json");

            const oldRequest = {
                id: "old-request",
                sourcePath: "old.ts",
                targetPath: "src/old.ts",
                status: ApprovalStatus.PENDING,
                priority: ApprovalPriority.NORMAL,
                createdAt: new Date(Date.now() - 120000).toISOString(), // 2 minutes ago
                updatedAt: new Date(Date.now() - 120000).toISOString(),
            };

            fs.writeFileSync(statePath, JSON.stringify({
                requests: [oldRequest],
                pending: [oldRequest],
                approved: [],
                rejected: [],
            }, null, 2), "utf-8");

            // Create manager with 60 second timeout
            const manager = new ApprovalManager({
                projectRoot: tempDir,
                approvalTimeoutMs: 60000,
                verbose: false,
            });

            // Should have cleaned up the expired request
            const state = manager.getState();
            expect(state.pending).toHaveLength(0);

            fs.rmSync(tempDir, { recursive: true, force: true });
        });
    });
});
