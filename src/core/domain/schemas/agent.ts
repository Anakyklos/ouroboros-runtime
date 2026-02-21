import { z } from "zod";

export const AgentTypeSchema = z.enum(["planner", "coder", "qa_reviewer", "qa_fixer"]);

export const AgentConfigSchema = z.object({
    agent_type: AgentTypeSchema,
    model: z.string().default("claude-3-5-sonnet-20241022"),
    thinking_budget: z.number().optional(),
    max_iterations: z.number().default(10),
    tools_enabled: z.array(z.string()).default([]),
});

export type AgentType = z.infer<typeof AgentTypeSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
