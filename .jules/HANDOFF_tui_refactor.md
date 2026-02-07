# 🤖 Jules Handoff: TUI Core Refactoring

> **Status:** Ready for Jules
> **Priority:** High
> **Type:** Implementation/Refactor
> **Track:** tui_stabilization_20260207

---

## 📋 Context
We are stabilizing the Ouroboros TUI to support multi-agent orchestration. The current TUI is monolithic and lacks robust state representation. We have defined new component specifications in `conductor/tracks/tui_stabilization_20260207/component_specs.md`.

## 🎯 Objective
Implement the core UI components (`LogViewer`, `StatusPanel`) and refactor the `Layout` to use them, ensuring all new code is covered by unit tests.

---

## ✅ Tasks for Jules

### Task 1: Update Types
**File:** `cli/src/tui/types.ts`
- Update `TuiStatus` to include `'dispatching'`.
- Add `currentTask?: string` to `TuiState` (or wherever appropriate to track active task).

### Task 2: Implement LogViewer
**File:** `cli/src/tui/components/LogViewer.tsx`
**Reference:** `conductor/tracks/tui_stabilization_20260207/component_specs.md` (Section 2.1)
- Use `ink-scroll` (if available/compatible) or manual slice logic for performance.
- Requirements: >100 logs support, auto-scroll, color-coding.
- **Test:** Create `cli/src/tui/components/LogViewer.test.tsx`.

### Task 3: Implement StatusPanel
**File:** `cli/src/tui/components/StatusPanel.tsx`
**Reference:** `conductor/tracks/tui_stabilization_20260207/component_specs.md` (Section 2.2)
- Visuals: 'idle' (green), 'thinking' (spinner), 'dispatching' (purple).
- Show metrics.
- **Test:** Create `cli/src/tui/components/StatusPanel.test.tsx`.

### Task 4: Refactor Layout
**File:** `cli/src/tui/components/Layout.tsx`
**Reference:** `conductor/tracks/tui_stabilization_20260207/component_specs.md` (Section 2.3)
- Compose the new `LogViewer` and `StatusPanel`.
- Use `boxen` for panels.
- **Test:** Create `cli/src/tui/components/Layout.test.tsx`.

---

## 🧪 Checklist & Validation
- [ ] `bun test cli/src/tui` must pass.
- [ ] No regression in TUI startup (`bun run tui` should still render, even if logic isn't fully hooked up yet).
