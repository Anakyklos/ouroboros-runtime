# 🐍 Ouroboros Web UI

Mission Control dashboard for the Ouroboros autonomous coding agent.

## Features

- **🔮 The Eye** - Real-time code analysis and ideation
- **🐍 The Coil** - Wave-based task queue with drag-and-drop
- **🏛️ The Council** - Multi-agent debate and consensus
- **⚡ The Strike** - Parallel task execution visualization
- **🖥️ Terminal** - xterm.js terminal integration
- **⚙️ Settings** - Theme, keyboard shortcuts, preferences

## Quick Start

### Development

```bash
# Start the daemon (terminal 1)
bun run daemon

# Start the web UI dev server (terminal 2)
cd web
bun run dev

# Open http://localhost:3000
```

### Production

```bash
# Build web UI
bun run web:build

# Start enhanced daemon with static files
bun run daemon:enhanced

# Access at http://localhost:7777
```

## Architecture

```
┌─────────────────┐     WebSocket/SSE      ┌─────────────────┐
│   Web UI        │ ◄────────────────────► │  Ouroboros      │
│   (React 19)    │                        │  Daemon         │
│                 │     JSON-RPC 2.0       │  (Fastify)      │
│  ┌───────────┐  │ ◄────────────────────► │                 │
│  │ 4 Quadrants│  │                        │  ┌───────────┐  │
│  │ HUD Bar   │  │     PTY (xterm.js)     │  │ EventBus  │  │
│  │ Terminal  │  │ ◄────────────────────► │  │ WaveExec  │  │
│  └───────────┘  │                        │  │ Council   │  │
└─────────────────┘                        └─────────────────┘
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Pause/Resume |
| `Esc` | Emergency Brake |
| `Ctrl+L` | Toggle Logs |
| `` ` `` | Focus Terminal |
| `Shift+F` | Frenzy Mode |

## Tech Stack

- **Framework:** React 19 + Vite
- **Styling:** Tailwind CSS v4
- **State:** Zustand
- **Components:** Radix UI
- **Animations:** Framer Motion
- **Terminal:** xterm.js
- **Icons:** Lucide React

## Development

```bash
# Install dependencies
cd web
bun install

# Run dev server
bun run dev

# Type check
bunx tsc --noEmit

# Build for production
bun run build
```

## Environment Variables

```env
VITE_DAEMON_URL=ws://localhost:7777  # Daemon WebSocket URL
```
