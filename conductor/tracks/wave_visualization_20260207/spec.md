# Specification: Wave Visualization

## Context
The Ouroboros Runtime uses a "Wave" execution model (defined in `WaveExecutor.ts`) to run tasks in parallel layers. Currently, the TUI `StatusPanel` only shows a simple state (Idle/Running). It does not visualize the wave structure (parallel vs. sequential tasks).

## Objectives
1.  **Enhance `StatusPanel`:** Display active waves and tasks visually.
2.  **Wave Metrics:** Show progress bar for the current wave (e.g., "Wave 1/3: [====..] 2/3 tasks").
3.  **Task Details:** List currently running tasks within the wave.

## Requirements
- **Integration:** Must connect to `WaveExecutor` events via `EventBus`.
- **UI:** Use `ink-progress-bar` (or custom character-based bar) and a list of active tasks.
- **State:** Update `TuiState` to include `activeWave` information (id, progress, totalTasks, completedTasks).

## Constraints
- Keep the TUI responsive.
- Do not clutter the interface (maybe a collapsible view or a dedicated section in StatusPanel).
