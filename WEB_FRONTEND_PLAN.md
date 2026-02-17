# 🐍 Ouroboros Web Frontend — Implementation Plan

## 1. Overview
A modern, dark-themed Web Dashboard for the Ouroboros runtime, designed to visualize agent states, tasks, and memory in real-time. It communicates with the existing Daemon via WebSocket (for events) and JSON-RPC (for actions).

**Aesthetic**: Cyberpunk/Snake (Emerald/Gold/Obsidian).
**Location**: `/web` (New root directory).

## 2. Tech Stack
- **Build Tool**: Vite (Fast, modern)
- **Framework**: React 18+ (TSX)
- **Styling**: Tailwind CSS + `clsx` + `tailwind-merge`
- **Icons**: Lucide React
- **State Management**: Zustand (Minimalist, matches TUI)
- **Data Fetching**: TanStack Query (React Query)
- **Protocol**: WebSocket (Log streaming) + JSON-RPC (Commands)

## 3. Architecture & Integration
The Web Frontend will be a standalone SPA (Single Page Application) served by Vite during dev, and eventually served by the Daemon (static files) in production.

### Communication Bridge
1.  **WebSocket Server**: The Daemon (`cli/src/daemon/server.ts`) needs to be upgraded to support `fastify-websocket` to stream `EventBus` events to the browser.
2.  **RPC Client**: The frontend will use a typed RPC client to call existing Daemon methods (e.g., `list_agents`, `get_memory`).

## 4. UI/UX Design (Cyberpunk/Snake Theme)
-   **Colors**:
    -   Background: Obsidian (`#09090b`)
    -   Primary: Emerald (`#10b981`)
    -   Accent: Gold (`#fbbf24`)
    -   Error: Ruby (`#ef4444`)
-   **Layout**:
    -   **Sidebar**: Navigation (Dashboard, Agents, Memory, Settings).
    -   **Top Bar**: Connection Status, System Health (CPU/RAM).
    -   **Main Content**: Grid layout with widgets.
-   **Widgets**:
    -   **Live Log**: Terminal-like scrolling log of system events.
    -   **Wave Visualizer**: Graph/List of active parallel tasks.
    -   **Agent Matrix**: Cards showing active agents and their current status.
    -   **Memory Inspector**: Searchable table of SQLite memory entries.

## 5. Implementation Steps (TODO List)

### Phase 1: Foundation (The Skeleton)
1.  **Scaffold Project**: Initialize `/web` with Vite + React + TS.
2.  **Configure Tailwind**: Set up the custom Ouroboros color palette in `tailwind.config.js`.
3.  **Setup Router**: Install `react-router-dom` and create basic routes.
4.  **Shared Types**: Symlink or copy `cli/src/ports` types to `web/src/types` to ensure protocol consistency.

### Phase 2: Daemon Upgrade (The Bridge)
5.  **Install WebSocket Support**: Add `@fastify/websocket` to `cli/src`.
6.  **Upgrade Daemon**: Modify `DaemonServer` to broadcast `EventBus` events over WebSocket (`/ws`).
7.  **CORS Setup**: Configure Fastify CORS to allow requests from `localhost:5173` (Vite dev server).

### Phase 3: Core Features (The Flesh)
8.  **RPC Client Hook**: Create a `useRpc` hook in React to wrap JSON-RPC calls.
9.  **WebSocket Hook**: Create a `useEventStream` hook to listen for real-time updates.
10. **Dashboard Layout**: Build the Sidebar and Shell component.
11. **Log Widget**: Implement the auto-scrolling log viewer with colored levels.

### Phase 4: Visualization (The Soul)
12. **Agent Cards**: Display agent status (Idle, Thinking, Acting).
13. **Task Queue**: Visual list of pending/active Wave tasks.
14. **Memory Browser**: Simple data table to view persistent storage.

## 6. Directory Structure
```
web/
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── src/
    ├── assets/
    ├── components/
    │   ├── ui/           # Buttons, Cards, Inputs
    │   ├── layout/       # Sidebar, Shell
    │   └── widgets/      # LogViewer, AgentMatrix
    ├── hooks/            # useRpc, useSocket
    ├── lib/              # api.ts, utils.ts
    ├── pages/
    └── types/            # Shared types
```
