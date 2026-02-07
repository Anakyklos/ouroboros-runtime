# TUI Component Specifications

## 1. Overview
This document defines the interface and behavioral specifications for the TUI refactoring. The goal is to modularize the interface into distinct, high-performance components.

## 2. Components

### 2.1 `LogViewer`
**Purpose:** Efficiently display high-volume scrolling logs.
**Path:** `cli/src/tui/components/LogViewer.tsx`

**Props:**
```typescript
interface LogViewerProps {
  logs: LogEntry[];
  maxHeight?: number;
  autoScroll?: boolean;
}
```

**Requirements:**
- Must handle >100 visible logs without flickering.
- Stick to bottom behavior when `autoScroll` is true.
- Color-code logs based on level (`info`=blue, `warn`=yellow, `error`=red).
- Show timestamp and source.

### 2.2 `StatusPanel`
**Purpose:** Display the current operational state of the agent.
**Path:** `cli/src/tui/components/StatusPanel.tsx`

**Props:**
```typescript
interface StatusPanelProps {
  status: TuiStatus; // 'idle' | 'thinking' | 'running' | 'dispatching'
  metrics: TuiMetrics;
  currentTask?: string; // Optional: Display what the agent is currently doing
}
```

**Requirements:**
- **Idle:** Green indicator.
- **Thinking:** Pulsing/Spinner (use `ink-spinner`).
- **Running:** Active progress bar or animated indicator.
- **Dispatching:** Distinct icon/color (e.g., Purple for Jules).
- Display Token Usage and Cost metrics clearly.

### 2.3 `Layout` (Refactor)
**Purpose:** Grid container for the application.
**Path:** `cli/src/tui/components/Layout.tsx`

**Structure:**
```
+------------------------------------------+
|  Header (Ouroboros v1.0)                 |
+------------------------------------------+
|  StatusPanel (Top)                       |
+------------------------------------------+
|  LogViewer (Middle - Flexible Height)    |
|                                          |
+------------------------------------------+
|  InputBar (Bottom - Fixed)               |
+------------------------------------------+
```

## 3. Store Updates (`cli/src/tui/store.ts`)

**Updates Needed:**
1.  **Extended Status:** Update `TuiStatus` to include `dispatching`.
2.  **Task Tracking:** Add `currentTask` (string) to state.
3.  **Action:** `setCurrentTask(task: string)`.

## 4. Design Assets
- Use `boxen` with `borderStyle: 'round'` for panels.
- Use `gradient-string` for the Header.
