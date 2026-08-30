# PRD: Web Interface Completion

## Introduction

Complete the Ouroboros web interface with full daemon integration, real-time updates, and all missing features. The web UI already has two themes (Snake cyberpunk and Swiss minimalist) but needs completion of daemon integration, task management, and visualization features.

## Goals

- Full daemon ↔ web UI integration via WebSocket
- Real-time wave and task visualization
- Complete settings page with all preferences
- Terminal integration with xterm.js
- Memory/context visualization
- Council debate viewer

## User Stories

### US-001: WebSocket reconnection with exponential backoff
**Description:** As a user, I want the web UI to automatically reconnect to the daemon when connection drops.

**Acceptance Criteria:**
- [ ] Exponential backoff: 1s, 2s, 4s, 8s, max 30s
- [ ] Show "Reconnecting..." status in header
- [ ] Display connection status indicator (green=connected, red=disconnected, yellow=reconnecting)
- [ ] Max 10 reconnection attempts before showing "Daemon offline" message
- [ ] Automatically resume when daemon comes back online
- [ ] bun run build passes

### US-002: Real-time wave progress visualization
**Description:** As a user, I want to see wave execution progress in real-time on The Coil component.

**Acceptance Criteria:**
- [ ] Each wave card shows progress bar with percentage
- [ ] Task count updates as tasks complete
- [ ] Status badges update: pending → active → done/failed
- [ ] Wave cards animate when status changes
- [ ] bun run build passes

### US-003: Task detail panel
**Description:** As a user, I want to click a task to see its details in a side panel.

**Acceptance Criteria:**
- [ ] Click task opens slide-in panel from right
- [ ] Panel shows: task ID, description, status, created/updated timestamps
- [ ] Panel shows execution logs for the task
- [ ] Panel has "Retry" button for failed tasks
- [ ] Panel closes on ESC key or click outside
- [ ] bun run build passes

### US-004: Settings page - theme selector
**Description:** As a user, I want to switch between Snake and Swiss themes from settings.

**Acceptance Criteria:**
- [ ] Settings page has theme radio buttons: Snake | Swiss
- [ ] Theme preference saved to localStorage
- [ ] Theme persists across page reloads
- [ ] Immediate visual update on selection
- [ ] bun run build passes

### US-005: Settings page - daemon configuration
**Description:** As a user, I want to configure daemon connection settings.

**Acceptance Criteria:**
- [ ] Input field for daemon WebSocket URL (default: ws://localhost:7777)
- [ ] Input field for API key (optional)
- [ ] "Test Connection" button with success/error feedback
- [ ] Settings saved to localStorage
- [ ] bun run build passes

### US-006: Terminal integration with PTY
**Description:** As a user, I want to interact with a terminal inside the web UI.

**Acceptance Criteria:**
- [ ] Terminal component using xterm.js
- [ ] Terminal connects to daemon PTY via WebSocket
- [ ] Keyboard input works correctly
- [ ] Terminal resizes properly
- [ ] Terminal can be toggled with keyboard shortcut (`)
- [ ] bun run build passes

### US-007: Council debate viewer
**Description:** As a user, I want to see council debates in real-time.

**Acceptance Criteria:**
- [ ] TheCouncil component shows active debate
- [ ] Each agent's position shown as card
- [ ] Vote counts update in real-time
- [ ] Consensus reached animation
- [ ] bun run build passes

### US-008: Memory/context panel
**Description:** As a user, I want to see what the agent remembers.

**Acceptance Criteria:**
- [ ] New panel shows recent memory entries
- [ ] Memory entries displayed as list with timestamps
- [ ] Filter by memory type (fact, decision, context)
- [ ] Search through memories
- [ ] bun run build passes

### US-009: Emergency brake confirmation
**Description:** As a user, I want confirmation before triggering emergency brake.

**Acceptance Criteria:**
- [ ] Click emergency brake shows confirmation dialog
- [ ] Dialog: "Stop all execution? This cannot be undone."
- [ ] Cancel and Confirm buttons
- [ ] Red styling for confirm button
- [ ] bun run build passes

### US-010: Keyboard shortcuts help modal
**Description:** As a user, I want to see all keyboard shortcuts in a help modal.

**Acceptance Criteria:**
- [ ] Press ? shows keyboard shortcuts modal
- [ ] Modal lists all shortcuts with descriptions
- [ ] Modal closes on ESC or click outside
- [ ] bun run build passes

## Functional Requirements

- FR-1: WebSocket connection must auto-reconnect with exponential backoff
- FR-2: All real-time updates must use EventBus pattern
- FR-3: All settings must persist in localStorage
- FR-4: All modals must be accessible via keyboard
- FR-5: All components must support both themes

## Non-Goals

- Mobile-first responsive (desktop-first for now)
- Offline mode
- Multiple daemon connections
- User authentication

## Technical Considerations

- Use existing hooks: useEventBus, useDaemonAPI
- Use Zustand stores for state management
- Follow existing component patterns in quadrants/
- Use Radix UI for modals and dialogs

## Success Metrics

- Connection stays alive during typical 1-hour session
- Zero console errors during normal operation
- All keyboard shortcuts work correctly

---
> **Status: Legacy** — Classificado em [docs/LEGACY_MATRIX.md](../docs/LEGACY_MATRIX.md)
> (web frontend: ADAPT/DEFER, item 25). PRD da web UI legada. A direção é
> Mission Control desktop leve; frontend é projection (#70).
> Ver [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
