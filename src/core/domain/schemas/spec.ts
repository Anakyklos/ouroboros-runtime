import { z } from "zod";

export const ProjectIndexSchema = z.object({
    project_name: z.string(),
    project_type: z.string(),
    primary_language: z.string(),
    framework: z.string(),
    services: z.array(z.object({
        name: z.string(),
        path: z.string(),
        run_command: z.string(),
        test_command: z.string(),
        port: z.number().optional()
    })).optional()
});

export const RequirementsSchema = z.object({
    task_description: z.string(),
    workflow_type: z.enum(["feature", "refactor", "investigation", "migration", "simple"]),
    acceptance_criteria: z.array(z.string())
});

export const TaskContextSchema = z.object({
    files_to_modify: z.array(z.string()).optional(),
    files_to_reference: z.array(z.string()).optional(),
    patterns: z.array(z.string()).optional()
});

export type ProjectIndex = z.infer<typeof ProjectIndexSchema>;
export type Requirements = z.infer<typeof RequirementsSchema>;
export type TaskContext = z.infer<typeof TaskContextSchema>;
