# Specification: Hardening & Cleanup

## Context
Feedback from Antigravity highlighted a security vulnerability in `scripts/agy-bridge.ts` (naive argument parsing) and an empty directory `gemini-bridge/`.

## Objectives
1.  **Secure `agy-bridge.ts`:** Replace naive `.split(" ")` with a robust argument parser that handles quotes correctly.
2.  **Clean Project Structure:** Remove or document empty directories (`gemini-bridge/`).
3.  **Validate Security:** Ensure the bridge handles quoted arguments correctly (e.g., `bun run agy "echo 'Hello World'"`).

## Constraints
- Do not introduce heavy dependencies for argument parsing if possible.
