import { z } from "zod";

export const AttemptSchema = z.object({
    session: z.number(),
    timestamp: z.string(),
    approach: z.string(),
    success: z.boolean(),
    error: z.string().nullable()
});

export const SubtaskHistorySchema = z.object({
    attempts: z.array(AttemptSchema),
    status: z.enum(["pending", "completed", "failed", "stuck"])
});

export const StuckSubtaskSchema = z.object({
    subtask_id: z.string(),
    reason: z.string(),
    escalated_at: z.string(),
    attempt_count: z.number()
});

export const RecoveryHistorySchema = z.object({
    subtasks: z.record(z.string(), SubtaskHistorySchema),
    stuck_subtasks: z.array(StuckSubtaskSchema).optional(),
    metadata: z.record(z.string(), z.any()).optional()
});

export type Attempt = z.infer<typeof AttemptSchema>;
export type SubtaskHistory = z.infer<typeof SubtaskHistorySchema>;
export type StuckSubtask = z.infer<typeof StuckSubtaskSchema>;
export type RecoveryHistory = z.infer<typeof RecoveryHistorySchema>;
