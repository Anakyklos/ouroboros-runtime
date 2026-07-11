# 🐍 Ouroboros - Agentic Development Guide

> **"Self-modifying AI agent with isolated Python environment"**

Essential guidelines for AI agents working in the Ouroboros repository.

---

## 🚀 Essential Commands

### Repository validation (baseline — issue #35)

**Use this for PR confidence.** Full details: [`docs/BASELINE.md`](docs/BASELINE.md).

```bash
# Bun 1.3.9+ required (CI pins 1.3.9)
bun install --frozen-lockfile
cd web && bun install --frozen-lockfile && cd ..

# Single command: install integrity + runtime compile + web build + mandatory tests
bun run check

# Or stepwise:
bun run check:install   # frozen lockfiles; fail if tree mutates
bun run check:runtime   # root tsc (CLI/runtime/scripts)
bun run check:web       # web/ production build
bun run check:tests     # mandatory unit tests (prints quarantine list)
```

CI: `.github/workflows/ci.yml` runs the same gate on `pull_request` and `push` to `main` (no API keys).

Quarantined suites (not executed by `check:tests`, **not** counted as green): see `scripts/quarantine-manifest.json`. Recovery debt: issue **#41** (`tracking_issue`).

### Development & Building
```bash
# Build TypeScript (runtime/CLI only — does NOT build web/)
bun run build

# Main TUI entry point
bun run tui

# Daemon mode (background service)
bun run daemon

# Initial setup wizard
bun run setup

# Web UI (separate package)
cd web && bun run dev     # development
cd web && bun run build   # production (also: bun run check:web from root)
```

### Testing
```bash
# Mandatory unit gate (preferred)
bun run check:tests

# Raw suite (includes quarantined files — may fail)
bun run test

# Run specific test file
bun test cli/src/orchestration/WaveExecutor.test.ts

# Test Antigravity bridge
bun run test:bridge
```

### Running Scripts
```bash
# Run agent with specific script
bun run run:agent scripts/run_agent.ts
```

---

## 📝 Code Style Guidelines

### Imports & Dependencies
- Use ES2022 target with `NodeNext` module resolution
- Group imports: external libs → internal modules → types
- Prefer named imports over defaults
- No relative imports beyond `../` - use absolute paths from `cli/src/`
- Always check `package.json` before adding new dependencies

### TypeScript
- **Strict mode enabled**: `strict: true`
- Use proper type annotations for all function parameters
- Prefer `interface` for public contracts, `type` for internal shapes
- Use `Record<string, unknown>` over object for generic dictionaries
- Always use `unknown` instead of `any` for untyped values
- Use Omit/Pick utility types for derived interfaces

### Naming Conventions
```
Classes        → PascalCase (e.g., Orchestrator, SqliteAdapter)
Files          → kebab-case.ts (e.g., wave-executor.ts, storage.port.ts)
Interfaces      → PascalCase (e.g., StoragePort, AuditEntry)
Functions/Const → camelCase (e.g., createOrchestrator, defaultConfig)
Private Fields → prefix with `private` keyword
DB Columns     → snake_case (e.g., created_at, context_snapshot)
```

### Error Handling
- Always wrap async operations in try/catch
- Use instanceof checks: `e instanceof Error ? e.message : String(e)`
- Provide context in error messages: `"Phase gate failed: ${message}"`
- Throw with Error objects, never plain strings
- Log errors with appropriate level via EventBus

### File Organization
```
cli/src/
├── adapters/       - External service adapters (Gemini, SQLite)
├── boot/           - Boot wizard & initialization
├── bridges/        - Bridge to external tools (Gemini, Antigravity)
├── commands/       - Command handlers
├── concierge/      - Intent classification
├── daemon/         - Server & RPC gateway
├── orchestration/   - Agent coordination & waves
├── ports/          - Interface definitions (hexagonal)
├── providers/      - Agent execution engines
├── tui/           - React/Ink UI components
└── utils/          - Shared utilities
```

### Comment Style
- Use JSDoc for all exported functions and classes
- Include emoji prefix matching module purpose: `/** * 🐍 Ouroboros Daemon */`
- Keep inline comments minimal - code should be self-documenting
- Document parameters, return types, and side effects

---

## 🎯 Architecture Patterns

### Hexagonal Architecture
- **Ports**: Interface contracts in `cli/src/ports/`
- **Adapters**: External service implementations in `cli/src/adapters/`
- Never depend on concrete implementations from core logic

### Storage & Persistence
- Use `StoragePort` interface for all data operations
- SQLite via `better-sqlite3` (WAL mode enabled)
- Prepared statements cached for performance
- Timestamps stored as ISO strings, converted to Date on retrieval

### Event-Driven
- Use `globalEventBus` for cross-module communication
- Emit structured events: `{ level, message, source, timestamp }`
- Log levels: debug, info, warn, error
- Wire EventBus to TUI for real-time feedback

---

## 🧪 Anti-Vibe Protocol

Critical workflow for implementing features:

1. **Spec Phase** - Create spec via Architect or direct input
2. **Validation** - Gate blocks execution without approved spec
3. **Implementation** - Two-stage: spec review → code generation
4. **Verification** - Programmatic validation + human review

See: `.agent/rules.md` and `SKILL_ACTIVATION_MAP.md` for complete protocol

---

## ⚠️ Critical Constraints

### Sandbox Boundaries
- **CAN EDIT**: Any file in `/Ouroboros` root
- **CAN CREATE**: Files in `.ouroboros/` (skills, venv scripts)
- **CANNOT**: Install global packages, modify system configs
- **MUST**: Use `.ouroboros/venv` for Python execution (isolated)

### State Management
- Daemon state: `.ouroboros/daemon.db` (SQLite)
- Workspace: `.ouroboros/workspace/` (temporary files)
- Memory: `.agent/memory/` (persistent agent context)
- **NEVER** commit `.env` files or API keys

---

## 🎨 TUI Design (DESIGN.md)

Use theme constants from `cli/src/tui/theme.ts`:
- Emerald: Primary accent, success
- Gold: Highlights, prompts, warnings
- Obsidian/Slate: Backgrounds
- Pearl: Primary text
- Ruby: Errors

Use chalk helpers: `theme.success()`, `theme.error()`, `theme.text()`

---

## 🔧 Key Config Files

- `.env.example` - Environment template
- `tsconfig.json` - TypeScript strict mode, ES2022
- `.agent/rules.md` - Workspace rules & Anti-Vibe protocol
- `DESIGN.md` - Visual design system
- `package.json` - All scripts and dependencies

---

## 📚 Skills Integration

Create skills in `.agent/skills/[skill-name]/`:
```
.agent/skills/[name]/
├── SKILL.md       # Main instructions (required)
├── scripts/        # Helper scripts
├── examples/       # Usage examples
└── resources/       # Reference docs
```

Use `core/mcp-builder` skill for tool creation patterns.

---

## 🧪 Running a Single Test

```bash
# Specific test file
bun test cli/src/orchestration/WaveExecutor.test.ts

# With verbose output
bun test cli/src/utils/anti-vibe.test.ts --verbose
```

---

## 🔄 Ralph Loop (Autonomous Agent)

Ralph is an autonomous AI agent loop that runs opencode repeatedly until all PRD items are complete.

### Workflow
```bash
# 1. Create a PRD for your feature
# Use the prd skill or manually create tasks/prd-[feature].md

# 2. Convert PRD to Ralph format
# Use the ralph skill to create scripts/ralph/prd.json

# 3. Run Ralph loop
./scripts/ralph/ralph.sh [max_iterations]  # Default: 10 iterations
```

### Key Files
- `scripts/ralph/prd.json` - User stories with `passes` status
- `scripts/ralph/progress.txt` - Learnings from each iteration
- `scripts/ralph/OPENCODE.md` - Instructions for each iteration
- `tasks/` - PRD markdown files

### Rules
- Each story must be completable in ONE context window
- Stories ordered by dependency (schema → backend → UI)
- Quality gates: `bun run build && bun run test` must pass
- Update AGENTS.md with discovered patterns after each iteration

---

## 📌 Project Status

**Estado Atual**: Self-modifying agent runtime em desenvolvimento ativo
**O que já foi implementado**:
  ✅ Daemon server com RPC gateway
  ✅ GatewayOrchestrator para coordenação
  ✅ Wave executor (paralelização de tasks)
  ✅ SQLite storage com prepared statements
  ✅ TUI com Ink/React
  ✅ Concierge intent classification
  ✅ Integrações: Gemini, Antigravity, Jules
  ✅ Memória persistente (MemoryManager)
  ✅ Anti-Vibe protocol básico
  ✅ Web UI completa (Snake + Swiss themes)
  ✅ WebSocket com reconexão exponencial
  ✅ Painel de detalhes de tarefas
  ✅ Terminal integrado com xterm.js
  ✅ Council debate viewer com animação
  ✅ Memory panel com busca/filtro
  ✅ Emergency brake confirmation
  ✅ Keyboard shortcuts modal

**O que falta implementar**:
  ⏳ Validação programática avançada
  ⏳ Skills integration workflow
  ⏳ MCP server deployment
  ⏳ Enhanced recovery strategies
  ⏳ Session persistence completo
  ⏳ Wave visualization no TUI
  ⏳ Memory retrieval com embeddings

**Estado ideal**: Sistema totalmente funcional onde:
  - Tasks são executados via waves com paralelização automática
  - Sistema self-healing com retry inteligente e escalation
  - Memória cross-session com embeddings semantic search
  - Skills extensíveis via MCP integration
  - TUI mostra progress em tempo real com visualização de waves
  - Daemon persiste sessions e permite resumption
  - Anti-Vibe protocol enforce quality gates em todo workflow


---

## 🩺 Health Check & Bug Fixes (Feb 2026)

### O que estava quebrado

Após sync com o GitHub, foram identificados e corrigidos os seguintes problemas:

| Arquivo | Problema | Gravidade |
|---|---|---|
| `cli/src/providers/tool-executor.ts` | Constructor duplicado por merge conflitado + campos de interface soltos (173 erros TS) | 🔴 Crítico |
| `cli/src/runtime/SelfModifyingEngine.test.ts` | `import` da 2ª suite injetado dentro de bloco `try` aberto — crash antes de qualquer teste | 🔴 Crítico |
| `cli/src/runtime/SelfModifyingEngine.ts` | `fs.Dirent` não existe em `fs/promises` — usar `import type { Dirent } from 'node:fs'` | 🟡 Erro |
| `cli/src/adapters/channels/TelegramAdapter.ts` | 5 parâmetros com `any` implícito; `ctx.callbackQuery` sem optional chaining | 🟡 Erro |
| `cli/src/adapters/channels/LarkAdapter.ts` | Parâmetro `err` sem tipo no catch | 🟡 Erro |
| `cli/src/runtime/SandboxTool.ts` | Import path errado (`../../../core/ports/ITool.js` → 3 níveis acima do real) | 🟡 Erro |
| `cli/src/workflows/VariableStore.ts` | Indexação `outputs[stepId]` sem cast — TS7053 | 🟡 Erro |
| `cli/src/providers/agent-loop.ts` | Chamava `executor.getToolDefinitions()` que não existia | 🟡 Erro |
| `scripts/agy-bridge.ts` | Import de `bun` sem `bun-types`; erro de comparação na linha de usage | 🟠 Erro |
| `scripts/dev-tools/benchmark-read.ts` | Import sem extensão `.js` (obrigatório no NodeNext) | 🟠 Erro |
| `setup_ouroboros.ts` | `gemini-chat-cli` não existe no PyPI — setup falhava ao criar venv | 🟠 Erro |
| `@types/node`, `@types/react` | Type definitions ausentes — quebrava o build inteiro | 🔴 Crítico |
| `grammy`, `@larksuiteoapi/node-sdk` | Pacotes usados pelos adapters não estavam instalados | 🟡 Erro |
| `cli/src/ports/ITool.ts` | Arquivo ausente — `SandboxTool.ts` não conseguia importar o port | 🟡 Erro |

### Resultado após correção

```
TypeScript build (tsc): 173 erros → 0 erros ✅
Python venv (.ouroboros/venv): ausente → criado ✅
SelfModifyingEngine.test.ts: crash → executa normalmente ✅
test-glm-integration.test.ts: 1 pass, 0 fail ✅
```

### Arquivos criados

- `cli/src/ports/ITool.ts` — interface `ITool<TInput, TOutput>` usada pelo `SandboxTool`

### Conhecidos não corrigidos / quarentena (baseline #35)

Authoritative list: `scripts/quarantine-manifest.json` and `docs/BASELINE.md`.  
Recovery tracking: **#41** (not #35 after baseline closes).

- `SandboxE2E.test.ts` — TDZ em `existsSync` + venv Python ausente no temp dir (environment + test bug)
- `SandboxRunner.test.ts`, `SandboxEscapeTests.test.ts`, `SandboxResourceLimits.test.ts`, `SandboxSecurity.test.ts` — dependem de `.ouroboros/venv`; incompatíveis com CI limpa sem setup hermético
- `AntiVibeWorkflow.test.ts`, `PromotionManager.test.ts`, `QualityGateRegistry.test.ts` — falhas parciais de produto/contrato de status (não removidos; fora do gate obrigatório)
- `SkillLoader.test.ts` — path externo fora do repositório (`engenharia reversa /AionUi/...`)
- `tool-executor.test.ts` — arquivo com corrupção de merge (sintaxe inválida)
- `web/.../mission-control-store.test.ts` — 2 asserções desalinhadas com o store atual

**Não** use `bun run test` sozinho como prova de integridade do repositório: use `bun run check`.