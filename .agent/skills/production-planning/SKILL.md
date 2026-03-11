---
name: production-planning
description: "Enforces a structured planning protocol before any coding begins. Ensures all features are designed with production-readiness, clear function boundaries, and architectural consistency. Use this whenever starting a new feature or when the user requests a structured plan."
version: 1.0.0
author: Antigravity
category: planning
tags: [planning, architecture, production, functions]
risk: safe
---

# Production Planning Protocol

## Purpose

To eliminate "random and messy" development by enforcing a strict, structured planning phase before any code is written. This skill guarantees that every implementation is production-ready, with well-defined functions, clear inputs/outputs, and proper error handling.

## When to Use This Skill

This skill MUST be triggered when:
- Starting a new feature, complex bug fix, or major refactoring.
- The user feels the codebase or the current approach is getting "messy" or "random".
- The user requests a "plan", "architecture", "design", or "planning skill".

## Core Principles

1. **Think Before Coding**: Code is a liability. Architecture is the asset. Never write code without an approved plan.
2. **Production-First**: Design for failure. Every function must have explicit error handling, validation, and tracing/logging considerations.
3. **Function-Centric Design**: Break down complex problems into pure, single-responsibility functions with clear input/output signatures.

## Workflow: The Planning Protocol

When this skill is activated, you MUST follow these exact steps:

### Phase 1: Requirement Gathering & Context
1. Review the requested feature or problem.
2. Identify existing skills or knowledge items (KIs) that apply.
3. If requirements are ambiguous, **STOP** and ask the user for clarification. Do not guess.

### Phase 2: Function & Production Design (The Spec)
Draft the solution in `implementation_plan.md`. The plan MUST include:

#### A. Architecture & Data Flow
- How does data flow through the system?
- Which existing modules will be modified, and which will be created?

#### B. Function Specifications
For every major new function or class method, define:
- **Name & Purpose**: What it does.
- **Inputs (Parameters & Types)**: What it takes.
- **Outputs (Return Types)**: What it returns.
- **Side Effects**: Does it mutate state? Does it call an external API?

#### C. Production Readiness (Crucial)
- **Error Handling**: How will this fail? What errors are thrown?
- **Validation**: How are inputs sanitized or validated?
- **Logging/Tracing**: Where should logs be placed for observability?
- **Performance/Scalability**: Are there loop overlaps or memory leaks to avoid?

### Phase 3: Task Breakdown
Translate the approved plan into actionable, sequential steps in `task.md`.
- Break work into small, independent sub-tasks.
- Ensure each task can be tested independently.

### Phase 4: User Approval
1. Use the `notify_user` tool to present the `implementation_plan.md` to the user.
2. Ask for explicit approval.
3. **DO NOT** proceed to `EXECUTION` mode until the user approves the plan.

## Integration with Other Skills

- After planning is approved, you can utilize `subagent-development` to execute the tasks systematically.
- If architectural decisions are complex, use `consult-architect` to get the Architect Gem's feedback on the plan.
