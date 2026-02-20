# Plan: RE-02 Auto-Claude Prompt and Tool Extraction

## Phase 1: Preparation
- [ ] Task: Update `STATUS.md` to phase EXTRACT
- [ ] Task: Create destination directories in `_extracted/`
    - [ ] `Auto-Claude/_extracted/prompts`
    - [ ] `Auto-Claude/_extracted/tools`
- [ ] Task: Conductor - User Manual Verification 'Preparation' (Protocol in workflow.md)

## Phase 2: Prompt Extraction
- [ ] Task: List available prompts in `apps/backend/prompts/`
- [ ] Task: Copy prompts to `_extracted/prompts/`
    - [ ] Copy `planner.md`, `coder.md`, `qa_reviewer.md`, etc.
    - [ ] Copy `followup_planner.md`
- [ ] Task: Update `MANIFEST.md` with extracted prompts
- [ ] Task: Conductor - User Manual Verification 'Prompt Extraction' (Protocol in workflow.md)

## Phase 3: Tool Extraction
- [ ] Task: Analyze `apps/backend/agents/tools_pkg/` structure
- [ ] Task: Extract tool definitions to `_extracted/tools/`
    - [ ] Copy relevant Python files as reference (for later adaptation to TS)
    - [ ] Focus on `models.py` (tool definitions) and `registry.py`
- [ ] Task: Update `MANIFEST.md` with extracted tools
- [ ] Task: Conductor - User Manual Verification 'Tool Extraction' (Protocol in workflow.md)

## Phase 4: Completion
- [ ] Task: Finalize `MANIFEST.md`
- [ ] Task: Update `STATUS.md` to phase ADAPT (ready for adaptation)
- [ ] Task: Conductor - User Manual Verification 'Completion' (Protocol in workflow.md)
