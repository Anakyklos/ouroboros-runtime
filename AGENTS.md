# 🐍 Ouroboros — Guia de Desenvolvimento

> **Ouroboros é o executive runtime / sistema nervoso do Anakyklos.**
> Este guia direciona agentes e executores para a arquitetura autoritativa.
> **Direção**: epic #60 + [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
> **Classificação de legado**: [docs/LEGACY_MATRIX.md](docs/LEGACY_MATRIX.md).

---

## Antes de qualquer trabalho

1. Leia [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — identidade, fluxo
   autoritativo, Current/Direction/Legacy/Hypothesis.
2. Consulte [docs/LEGACY_MATRIX.md](docs/LEGACY_MATRIX.md) antes de tocar em
   qualquer subsistema classificado (RETIRE/ADAPT/MOVE/DEFER).
3. **Não amplie por default**: self-modification, Council/personas, waves,
   Ralph, MCP/skills, bridges diretas e Python sandbox **não são direção**.
   São legado classificado.

### Fluxo autoritativo (não negocie)

```text
Intent source → MissionIntent → Ouroboros cria/persiste Mission
→ Planner proposal → Deterministic policy → Capability Registry
→ Capability Invocation → Module Owner → evidence + verification
→ mission verification
```

- `MissionIntent != Mission`. A Mission nasce dentro do Ouroboros.
- Planning/LLM é **advisory**. Código/policy autoriza effects.
- Self-improving Anakyklos é válido; **self-modifying Ouroboros não é**
  (#69). Proibido `modifySelf()` / promoção silenciosa.

---

## Baseline obrigatório (issue #35)

**Use `bun run check` como prova de integridade.** Detalhes:
[`docs/BASELINE.md`](docs/BASELINE.md).

```bash
# Bun 1.3.9+ (CI pin: 1.3.9)
bun install --frozen-lockfile
cd web && bun install --frozen-lockfile && cd ..

# Gate completo: install integrity + runtime compile + web build + tests
bun run check

# Ou passo a passo:
bun run check:install   # frozen lockfiles; falha se a árvore mudar
bun run check:runtime   # tsc (runtime/CLI)
bun run check:web       # web/ production build
bun run check:tests     # testes obrigatórios (imprime quarentena)
```

CI: `.github/workflows/ci.yml` roda o mesmo gate em `pull_request` e `push`
para `main` (sem API keys).

Suites em quarentena (não executadas por `check:tests`, **não** contam como
verde): `scripts/quarantine-manifest.json`. Dívida de recuperação: issue **#41**.

> ⚠️ **Não** use `bun run test` sozinho como prova de integridade: use
> `bun run check`. Não use `skip`/`todo`/`only`/`|| true` para esconder falhas.

---

## Arquitetura (resumo para executores)

### Current (comportamento comprovado hoje)

- Daemon server com RPC gateway (JSON-RPC 2.0 sobre Fastify/WebSocket)
- SessionManager, EventBus, SQLite storage (better-sqlite3, WAL)
- Daemon controls (status/mode/emergencyBrake)
- Web frontend (Vite/React) + TUI React/Ink + bridges + Orchestrator com
  personas + WaveExecutor + MemoryManager/MemoryRetriever + SelfModifyingEngine
  + Sandbox* + PromotionManager/Anti-Vibe + local inference
- Baseline CI (#35)

> Grande parte do código "Current" é **Legacy** na direção do produto. Antes
> de modificar qualquer subsistema, consulte a matriz de legado.

### Direction (executive coordination)

- Mission durável first-class (#62), Capability Registry + connectors (#63),
  Context Compiler com provenance (#64), policy determinística
- Headless daemon (ouroborosd) autoridade; Mission Control desktop interface
  principal; CLI pequena para admin/recovery; Katherine interface opcional (#70)
- Self-improving governado: Ouroboros observa → bounded adaptation OR
  CapabilityGap → Cadinho trial → Runstead implementation → verification →
  promoção explícita (#69)

### Legacy (não é direção)

SelfModifyingEngine, PersistentPythonREPL, SandboxRunner/SandboxTool,
Council/personas, ArchitectClient (persona), WaveExecutor ("agent wave"),
Anti-Vibe como code gate, bridges diretas (Antigravity/Gemini/Jules), Ralph,
MCP/SkillLoader, Council/Memory/Terminal UI, Electron (direção), TUI React/Ink.
Classificação completa: [docs/LEGACY_MATRIX.md](docs/LEGACY_MATRIX.md).

### Hypothesis (aguarda POC/benchmark)

Migração Go (#58), boundaries Zig/Rust, framework desktop, IPC protocol,
service lifecycle.

---

## Regras de código

- TypeScript strict (ES2022, NodeNext), imports nomeados, paths absolutos
  a partir de `cli/src/`
- Interfaces públicas como `interface`, shapes internos como `type`
- Erros: `e instanceof Error ? e.message : String(e)`; nunca string vazia
- `StoragePort` para operações de dados; prepared statements em SQLite
- EventBus para eventos estruturados: `{ level, message, source, timestamp }`
- JSDoc em funções/classes exportadas

### Organização de arquivos

```
cli/src/
├── adapters/       # Adapters externos (channels, sqlite, budget)
├── boot/           # Boot wizard (LEGACY: setup legado)
├── bridges/        # Bridges diretas (LEGACY: classificar antes de tocar)
├── commands/       # Command handlers
├── concierge/      # Intent classification (LEGACY: reavaliar)
├── daemon/         # Server, RPC gateway, session, event bus (KEEP)
├── inference/      # Local inference (ADAPT/DEFER)
├── orchestration/  # Orchestrator, WaveExecutor, Memory, Promotion (classificar)
├── ports/          # Interface definitions (hexagonal)
├── providers/      # Agent execution engines
├── runtime/        # SelfModifyingEngine, Sandbox* (LEGACY: RETIRE)
└── tui/            # React/Ink TUI (LEGACY: RETIRE/DEFER)
```

> ⚠️ Antes de editar arquivos em `bridges/`, `runtime/`, `orchestration/`,
> `tui/`, `inference/` ou `scripts/ralph/`, leia a linha correspondente na
> matriz de legado e respeite a decisão (não amplie feature de subsistema
> RETIRE/DEFER).

---

## Workflow de trabalho

1. Sempre parta de `main` atualizada (`git checkout main && git pull
   --ff-only origin main`).
2. Crie branch por issue.
3. Use Spec Kit quando disponível (`.specify/`) para spec → plan → tasks.
4. Valide com `bun run check` + `git diff --check` antes de commitar.
5. Commits pequenos e coerentes; PR única contra `main` vinculada à issue.
6. Registre follow-ups na PR para o mantenedor; **não** abra issues por conta
   própria.

---

## Status do projeto

**Estado**: realinhamento arquitetural em andamento (epic #60).
Primeiro leaf executável: #61 (source of truth + matriz de legado).

**Implementado (Current)**: baseline reproduzível (#35), daemon/RPC,
session manager, event bus, SQLite storage, daemon controls, web frontend,
contracts de eventos/provider, inferência local, orchestration legada.

**Em direção (Direction)**: Mission durável (#62), Capability Registry (#63),
Context Compiler (#64), policy determinística, topologia headless + Mission
Control + CLI (#70), self-improving governado (#69).

**Legado classificado**: ver [docs/LEGACY_MATRIX.md](docs/LEGACY_MATRIX.md).

---

## Referências

| Issue | Tema | Status |
|---|---|---|
| #60 | Epic realinhamento executive coordination | Direction |
| #61 | Source of truth + matriz de legado | Esta PR |
| #62 | Mission durável | Blocked by #61 |
| #63 | Capability Registry + connectors | Blocked by #62 |
| #64 | Context Compiler com provenance | Blocked by #62/#63 |
| #69 | Self-improving != self-modifying | Direction |
| #70 | Headless daemon + Mission Control + CLI | Direction |
| #35 | Baseline reproduzível e CI | Current |
| #41 | Resolver quarentenas após classificação | Blocked by #61 |
| #50 | Execução durável | Current/Direction |
| #58 | Avaliar Go como runtime core | Hypothesis |
