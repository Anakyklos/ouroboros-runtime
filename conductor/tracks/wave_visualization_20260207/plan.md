# Implementation Plan - Wave Visualization

## Phase 1: Event & State Modeling [checkpoint: 7f8d9e]
- [x] Task: Define `WaveEvent` in `cli/src/daemon/event-bus.ts` to expose Wave execution details. 3a1b2c
- [x] Task: Update `TuiState` in `cli/src/tui/types.ts` to store Wave data. 4b5c6d
- [x] Task: Conductor - User Manual Verification 'Modeling' (Protocol in workflow.md) 7f8d9e

## Phase 2: UI Implementation (Jules)
- [~] Task: Update `StatusPanel` to render Wave Progress Bar and Active Tasks list.
    - [ ] Write Tests
    - [ ] Implement UI
- [ ] Task: Conductor - User Manual Verification 'UI' (Protocol in workflow.md)

## Phase 3: Integration
- [ ] Task: Update `WaveExecutor` to emit fine-grained Wave events.
- [ ] Task: Update `connectTuiToEventBus` adapter to map Wave events to Store.
- [ ] Task: Conductor - User Manual Verification 'Integration' (Protocol in workflow.md)
