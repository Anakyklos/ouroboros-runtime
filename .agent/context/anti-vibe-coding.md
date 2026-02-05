# Spec-Driven Development (SDD) - The Anti-Vibe Coding Workflow

*Source: Deb GPT Blog - "Como eu uso o Claude Code"*

## The Core Philosophy
**"Vibe Coding"** (random prompts, hoping for the best) leads to:
- Over-engineering
- Reinventing the wheel
- Hallucinations (outdated docs)
- Code duplication
- Monolithic files
- Context Window Overflow

**Spec-Driven Development (SDD)** is a structured method to explain *exactly* what needs to be done, treating the AI as a junior engineer that needs explicit instructions.

---

## 5 Patterns of AI Failure
1. **Over-engineering:** Complicating simple tasks.
2. **Reinventing the wheel:** Creating custom solutions instead of using existing libs (e.g., building a Markdown editor vs using Tiptap).
3. **Outdated Knowledge:** Training data cutoffs cause implementation errors with new libs.
4. **Code Duplication:** Forgetting existing components (e.g., buttons) and creating duplicates.
5. **Responsibility Mixing:** Combining distinct logic in single files.

**Root Cause:** Context Window Overload.
**Solution:** Optimize Input/Output ratio.

---

## The Workflow: 3 Stages

### 1. Research (The Funnel)
**Goal:** Gather context, filter noise, and generate a PRD.

*   **Prompt Strategy:**
    - Identify affecting files in codebase.
    - Find implementation patterns (internal & external).
    - Read external documentation (URLs).
    - *Tip:* Import reference GitHub repos into a `.temp` folder for analysis, then delete.

*   **Output:** `PRD.md` containing:
    - Relevant codebase files.
    - Key documentation excerpts.
    - Proven code snippets/patterns.

*   **Action:** `/clear` context.

### 2. Planning (The Tactics)
**Goal:** Translate PRD into a tactical implementation plan.

*   **Prompt Strategy:**
    - "Read this `PRD.md`."
    - "Generate a SPEC detailing exactly which files to modify/create."
    - "Specify WHAT to change in each file."

*   **Critical Structure:**
    - File Path
    - Changes Required
    - Code Snippets (if applicable)

*   **Output:** `Spec.md` (The "implementation prompt").

*   **Action:** `/clear` context.

### 3. Implementation (The Code)
**Goal:** Execute the plan with maximum context availability.

*   **Prompt Strategy:**
    - "Implement this `Spec.md`."

*   **Benefit:** The entire context window is available for coding, as the "thinking" and "searching" context has been cleared.

---

## Results
- **Less Duplication:** Research identifies existing code.
- **Simpler Code:** Proven patterns prevent over-engineering.
- **One-Shot Success:** Correct documentation prevents hallucinations.
- **Modularization:** Explicit file targets prevent monolithic blobs.

## References
- **Research Prompt:** [Link](https://github.com/humanlayer/humanlayer/blob/main/.claude/commands/research_codebase.md)
- **Spec Prompt:** [Link](https://github.com/humanlayer/humanlayer/blob/main/.claude/commands/create_plan.md)
- **Code Prompt:** [Link](https://github.com/humanlayer/humanlayer/blob/main/.claude/commands/implement_plan.md)
