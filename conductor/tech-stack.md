# Technology Stack

## Core Runtime
- **Runtime Environment:** Bun
- **Language:** TypeScript 5.9+

## Terminal User Interface (TUI)
- **Framework:** React 18.3 (via Ink)
- **Library:** Ink 6.x
- **Components:** 
  - `ink-spinner`
  - `ink-text-input`
  - `boxen`
  - `gradient-string` (for visuals)
  - `ora`
  - `chalk`
- **State Management:** Zustand 5.x

## Backend & Services
- **Daemon Framework:** Fastify 5.7
- **Database:** SQLite (via `better-sqlite3`)
- **Python Integration:** Isolated Python Environment (Antigravity System)

## Development & Testing
- **Test Runner:** Bun Test
- **Build System:** TypeScript Compiler (`tsc`)
- **Orchestration:** Gemini CLI (Conductor + Jules Extensions)
- **Linting/Formatting:** (Infer: Biome or ESLint/Prettier compatible with Bun)
