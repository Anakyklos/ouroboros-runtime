# Specification: TUI Stabilization & Multi-Agent Prep

## Context
The current Ouroboros Runtime features a TUI built with Ink/React. To support the advanced "Conductor + Jules" workflow and the self-modifying capabilities, the TUI needs to be robust, modular, and capable of displaying complex agent states (thinking, dispatching, creating files) without visual clutter or race conditions.

## Objectives
1.  **Refactor TUI Entry Point:** Ensure a clean separation between the TUI rendering loop and the Agent logic loop.
2.  **Component Modularization:** Break down the main UI into reusable components (LogViewer, StatusPanel, InputBox) if not already done.
3.  **State Management Integration:** Verify and strengthen the Zustand store integration for real-time updates from the Agent Core.
4.  **Prepare for Jules:** Create clear patterns for delegating heavy implementation tasks to Jules during this track.

## Operational Strategy (Conductor + Jules)
- **Conductor (Me):** Will handle analysis, design, specification of component interfaces, and final integration/review.
- **Jules (Sub-agent):** Will be dispatched to handle bulk refactoring of components, type definitions updates, and writing unit tests for UI logic.

## Constraints
- Must maintain existing look and feel (Neon/Cyberpunk).
- Must use existing stack (Bun, Ink, React, Zustand).
