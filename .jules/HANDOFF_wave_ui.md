# 🤖 Jules Handoff: Wave Visualization UI

> **Status:** Ready for Jules
> **Priority:** Medium
> **Type:** Feature/UI
> **Track:** wave_visualization_20260207

---

## 📋 Context
We are enhancing the TUI to visualize the "Wave" execution model. The state (`WaveState`) has been defined in `types.ts` and added to `store.ts`. Now we need to render it in the `StatusPanel`.

## 🎯 Objective
Update `StatusPanel` to display the active wave progress and list of tasks.

---

## ✅ Tasks for Jules

### Task 1: Update StatusPanel Component
**File:** `cli/src/tui/components/StatusPanel.tsx`
**Reference:** `conductor/tracks/wave_visualization_20260207/spec.md`

1.  **Props:** Update `StatusPanelProps` to include `activeWave?: WaveState`.
2.  **Render Logic:**
    - If `activeWave` is present, render a section below the metrics.
    - Show Wave Header: "Wave {index}/{total}"
    - Show Progress Bar: Visual representation (e.g., `[████░░░░]`).
    - Show Task List: List tasks in `activeWave.tasks`. Use icons for status (✓, ⟳, ⏳, ✖).

### Task 2: Update StatusPanel Tests
**File:** `cli/src/tui/components/StatusPanel.test.tsx`

1.  Add test case: "renders active wave info".
2.  Mock `WaveState` data.
3.  Verify progress bar and task list text are present.
4.  **Important:** Use `stripAnsi` from `../../test-utils.js` for assertions to avoid color code issues.

---

## 🧪 Checklist & Validation
- [ ] `bun test cli/src/tui/components/StatusPanel.test.tsx` must pass.
- [ ] Visual layout should use `boxen` or simple text formatting.
