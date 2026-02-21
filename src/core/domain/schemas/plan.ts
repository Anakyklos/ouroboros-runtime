import { z } from "zod";

export const BuildProgressSchema = z.object({
    session_number: z.number().default(1),
    total_subtasks: z.number().default(0),
    completed_subtasks: z.number().default(0),
    failed_subtasks: z.number().default(0),
    qa_iterations: z.number().default(0)
});

export const QAStatusSchema = z.enum(["pending", "in_review", "approved", "rejected", "fixes_applied"]);

export const QASignOffSchema = z.object({
    status: QAStatusSchema.default("pending"),
    qa_session: z.number().default(0),
    timestamp: z.string().optional(),
    report_file: z.string().optional(),
    fix_request_file: z.string().optional(),
    verified_by: z.string().optional(),
    issues_found: z.array(z.object({
        type: z.enum(["critical", "major", "minor"]).optional(),
        title: z.string().optional(),
        location: z.string().optional(),
        fix_required: z.string().optional()
    })).optional(),
    tests_passed: z.record(z.string(), z.any()).optional(),
    ready_for_qa_revalidation: z.boolean().default(false),
});

export const SubtaskStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);

export const SubtaskSchema = z.object({
    id: z.string(),
    description: z.string(),
    status: SubtaskStatusSchema.default("pending"),
    notes: z.string().optional(),
    updated_at: z.string().optional(),
});

export const PhaseSchema = z.object({
    id: z.string().optional(),
    phase: z.string().optional(),
    name: z.string(),
    subtasks: z.array(SubtaskSchema),
});

export const ImplementationPlanSchema = z.object({
    phases: z.array(PhaseSchema),
    last_updated: z.string().optional(),
    qa_signoff: QASignOffSchema.optional(),
});

export type BuildProgress = z.infer<typeof BuildProgressSchema>;
export type QAStatus = z.infer<typeof QAStatusSchema>;
export type QASignOff = z.infer<typeof QASignOffSchema>;
export type SubtaskStatus = z.infer<typeof SubtaskStatusSchema>;
export type Subtask = z.infer<typeof SubtaskSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type ImplementationPlan = z.infer<typeof ImplementationPlanSchema>;
