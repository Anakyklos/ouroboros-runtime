import { z } from "zod";

export const UpdateSubtaskStatusArgsSchema = z.object({
    subtask_id: z.string().describe("ID of the subtask to update"),
    status: z.enum(["pending", "in_progress", "completed", "failed"]).describe("New status of the subtask"),
    notes: z.string().optional().describe("Optional notes to add to the subtask updates"),
});

export const UpdateQAStatusArgsSchema = z.object({
    status: z.enum(["pending", "in_review", "approved", "rejected", "fixes_applied"]).describe("QA status"),
    issues: z.string().optional().describe("JSON string of issues found"),
    tests_passed: z.string().optional().describe("JSON string of tests passed map"),
});

export const RecordDiscoveryArgsSchema = z.object({
    file_path: z.string().describe("Path of the file discovered"),
    description: z.string().describe("Description of what was discovered"),
    category: z.string().optional().describe("Category of the discovery (e.g. general, architecture)"),
});

export const RecordGotchaArgsSchema = z.object({
    gotcha: z.string().describe("Description of the gotcha or pitfall"),
    context: z.string().optional().describe("Context in which it occurred"),
});

export type UpdateSubtaskStatusArgs = z.infer<typeof UpdateSubtaskStatusArgsSchema>;
export type UpdateQAStatusArgs = z.infer<typeof UpdateQAStatusArgsSchema>;
export type RecordDiscoveryArgs = z.infer<typeof RecordDiscoveryArgsSchema>;
export type RecordGotchaArgs = z.infer<typeof RecordGotchaArgsSchema>;
