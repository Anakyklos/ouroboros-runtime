# Plan: RE-03 Auto-Claude Native Integration (Ouroboros)

This track focuses on reimplementing Auto-Claude's core logic as a native module for the Ouroboros Runtime, leveraging TypeScript, Bun, and Hexagonal Architecture.

## Phase 1: Foundation & Architecture
- [ ] Task: Initialize `Auto-Claude/_adapted` as a Bun project (`bun init -y`)
- [ ] Task: Configure `tsconfig.json` (strict mode, path aliases)
- [ ] Task: Create directory structure:
    - [ ] `src/core/domain` (Entities: Agent, Task, Result)
    - [ ] `src/core/ports` (Interfaces: Tool, LLM, FileSystem)
    - [ ] `src/infrastructure/adapters` (Implementations: BunFile, BunShell, Anthropic)
- [ ] Task: Set up testing with `bun:test`
- [ ] Task: Conductor - User Manual Verification 'Foundation' (Protocol in workflow.md)

## Phase 2: Schema Migration (Python -> Zod)
- [ ] Task: Analyze `_extracted/tools/models.py` (Pydantic models)
- [ ] Task: Create Zod schemas in `src/core/domain/schemas/` covering:
    - [ ] Tool definitions and arguments
    - [ ] Task/Subtask structures
    - [ ] Agent configuration
- [ ] Task: Implement `PromptManager` in `src/infrastructure/adapters/prompts` to load/render extracted templates
- [ ] Task: Conductor - User Manual Verification 'Schema Migration' (Protocol in workflow.md)

## Phase 3: Tool Implementation (Adapters)
- [ ] Task: Implement `FileSystemTool` adapter using Bun native APIs
- [ ] Task: Implement `GitTool` adapter using `Bun.spawn`
- [ ] Task: Implement `ShellTool` adapter for safe command execution
- [ ] Task: Verify tool execution with unit tests
- [ ] Task: Conductor - User Manual Verification 'Tool Implementation' (Protocol in workflow.md)

## Phase 4: Agent Core (Brain)
- [ ] Task: Implement `AgentLoop` (Perceive -> Think -> Act)
- [ ] Task: Implement `ResponseParser` to handle LLM output (XML/JSON) and invoke tools
- [ ] Task: Connect `PromptManager` to `AgentLoop`
- [ ] Task: Conductor - User Manual Verification 'Agent Core' (Protocol in workflow.md)

## Phase 5: Integration & Public API
- [ ] Task: Expose `AutoClaudeAgent` class for Ouroboros runtime consumption
- [ ] Task: Create integration test: "Create a hello world file"
- [ ] Task: Update `Auto-Claude/STATUS.md` to `INTEGRATED`
- [ ] Task: Conductor - User Manual Verification 'Integration' (Protocol in workflow.md)
