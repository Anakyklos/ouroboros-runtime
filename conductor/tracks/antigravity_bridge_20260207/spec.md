# Specification: Conductor-Antigravity Bridge

## Context
The "Triforce" strategy (Conductor + Jules + Antigravity) requires Conductor to be able to execute commands and tests securely via Antigravity. Currently, Conductor lacks a direct tool to invoke the Antigravity runtime, limiting its ability to verify code changes (e.g., running `bun test`).

## Objectives
1.  **Create a CLI Bridge:** Implement a lightweight wrapper (e.g., `scripts/agy-bridge.ts` or `bin/agy`) that allows executing shell commands inside the Antigravity context.
2.  **Expose Interface:** The bridge should accept a command string and return stdout/stderr/exit code in a format Conductor can parse easily.
3.  **Verification:** Validate that Conductor can call this bridge via `run_shell_command` to execute `bun test` successfully.

## Architecture
- **Wrapper:** A TypeScript script (`scripts/bridge.ts`) or a Shell script.
- **Invocation:** `bun run bridge <command>`
- **Security:** The bridge should ideally respect the sandbox constraints of Antigravity (though for this iteration, we focus on *execution access* first).

## Constraints
- Must use existing dependencies (Bun).
- Must be callable via `run_shell_command`.
