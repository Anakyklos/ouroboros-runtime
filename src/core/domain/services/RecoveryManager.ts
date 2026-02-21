import type { RecoveryHistory, Attempt } from "../schemas/recovery";
import { join } from "path";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";

export class RecoveryManager {
    private historyPath: string;
    private currentApproachPath: string;

    constructor(private workspaceDir: string) {
        const memoryDir = join(this.workspaceDir, "memory");
        if (!existsSync(memoryDir)) {
            mkdirSync(memoryDir, { recursive: true });
        }
        this.historyPath = join(memoryDir, "attempt_history.json");
        this.currentApproachPath = join(memoryDir, "current_approach.txt");
    }

    private loadHistory(): RecoveryHistory {
        if (!existsSync(this.historyPath)) {
            return {
                subtasks: {},
                stuck_subtasks: [],
                metadata: {
                    created_at: new Date().toISOString()
                }
            };
        }
        return JSON.parse(readFileSync(this.historyPath, "utf8"));
    }

    private saveHistory(history: RecoveryHistory) {
        history.metadata = history.metadata || {};
        history.metadata.last_updated = new Date().toISOString();
        writeFileSync(this.historyPath, JSON.stringify(history, null, 2), "utf8");
    }

    /**
     * Reads past attempts for a given subtask to form a context string.
     */
    getHistoryContext(subtaskId: string): string {
        const history = this.loadHistory();
        const subtask = history.subtasks[subtaskId];

        if (!subtask || !subtask.attempts || subtask.attempts.length === 0) {
            return "✓ First attempt at this subtask - no recovery context needed.";
        }

        let context = `⚠️⚠️⚠️ THIS SUBTASK HAS BEEN ATTEMPTED BEFORE! ⚠️⚠️⚠️\n\nPrevious attempts:\n`;
        subtask.attempts.forEach((att, idx) => {
            context += `\nAttempt #${idx + 1}:\n- Approach: ${att.approach}\n- Success: ${att.success}\n- Error: ${att.error || "None"}\n`;
        });

        context += `\nCRITICAL REQUIREMENT: You MUST try a DIFFERENT approach!\n`;
        context += `Review what was tried above and explicitly choose a different strategy.\n`;

        if (subtask.attempts.length >= 2) {
            context += `\n⚠️ HIGH RISK: Multiple attempts already. Consider completely different patterns or simplifying.\n`;
        }

        return context;
    }

    /**
     * Records the approach the agent intends to take before implementation.
     */
    recordApproach(subtaskId: string, approach: string) {
        const entry = `\n--- ${subtaskId} at ${new Date().toISOString()} ---\n${approach}\n`;
        // Append to current_approach.txt
        let currentText = "";
        if (existsSync(this.currentApproachPath)) {
            currentText = readFileSync(this.currentApproachPath, "utf8");
        }
        writeFileSync(this.currentApproachPath, currentText + entry, "utf8");
    }

    /**
     * Logs the outcome of an attempt in the history file.
     * Returns true if the subtask is now marked as STUCK (>= 3 failures).
     */
    recordAttemptResult(subtaskId: string, approach: string, success: boolean, error?: string): boolean {
        const history = this.loadHistory();

        if (!history.subtasks[subtaskId]) {
            history.subtasks[subtaskId] = { attempts: [], status: "pending" };
        }

        const newAttempt: Attempt = {
            session: 1, // Simplified for now
            timestamp: new Date().toISOString(),
            approach,
            success,
            error: error || null
        };

        history.subtasks[subtaskId].attempts.push(newAttempt);

        if (success) {
            history.subtasks[subtaskId].status = "completed";
            this.saveHistory(history);
            return false;
        }

        // Failure case
        history.subtasks[subtaskId].status = "failed";
        const failCount = history.subtasks[subtaskId].attempts.filter(a => !a.success).length;

        let isStuck = false;
        if (failCount >= 3) {
            isStuck = true;
            history.subtasks[subtaskId].status = "stuck";
            history.stuck_subtasks = history.stuck_subtasks || [];

            // Check if not already added to stuck list
            if (!history.stuck_subtasks.find(s => s.subtask_id === subtaskId)) {
                history.stuck_subtasks.push({
                    subtask_id: subtaskId,
                    reason: `Failed ${failCount} times. Last error: ${error}`,
                    escalated_at: new Date().toISOString(),
                    attempt_count: history.subtasks[subtaskId].attempts.length
                });
            }
        }

        this.saveHistory(history);
        return isStuck;
    }
}
