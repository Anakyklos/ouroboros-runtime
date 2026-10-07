# 🐍 Ouroboros — Guia de Desenvolvimento

> **Ouroboros é o executive runtime / sistema nervoso do Anakyklos.**
> Este guia direciona agentes e executores para a arquitetura autoritativa.
> **Direção**: epic #60 + [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
> **Classificação de legado**: [docs/LEGACY_MATRIX.md](docs/LEGACY_MATRIX.md).
> **Fonte arquitetural primária**: `Anakyklos/architecture` (privado) —
> `README.md`, `SYSTEM-MAP.md`, `VISION.md`, `policies/`,
> `rfcs/0001-system-boundaries.md`, `languages/` (Technology Palette).
> **Hierarquia de autoridade**:
> - **Para comportamento/current reality**: `code + tests + observation > documentação`
> - **Para direção/boundaries**: `Anakyklos/architecture + decisões aprovadas > documentação legada do produto`
> - **Current ≠ Direction ≠ Legacy ≠ Hypothesis** — nunca apresentar Direction como implementada, nem Hypothesis como compromisso.

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

O mecanismo e o manifesto de quarentena permanecem documentados em
`scripts/quarantine-manifest.json`; hoje a lista `files` está vazia e há
**0 suites em quarentena**. A dívida da issue **#41 foi resolvida**. Uma
quarentena futura exige uma issue de acompanhamento explícita e atualizada.

> ⚠️ **Não** use `bun run test` sozinho como prova de integridade: use
> `bun run check`. Não use `skip`/`todo`/`only`/`|| true` para esconder falhas.

---

## Arquitetura (resumo para executores)

### Current (comportamento comprovado hoje)

- Daemon server com RPC gateway (JSON-RPC 2.0 sobre Fastify/WebSocket)
- SessionManager, EventBus, SQLite storage (better-sqlite3, WAL)
- Daemon controls (status/mode/emergencyBrake)
- Mission durável e CapabilityInvocation, policy determinística e persistência
  SQLite (#62/#50)
- Capability Registry e dispatch seam (#63)
- Context Compiler com provenance e Context Packs bounded/progressivos
  (#64/#78); o planner recebe packs bounded antes de propor planos
- Scheduler/recovery/reconciliation e projeção/reconexão de eventos (#50/#38)
- Web frontend (Vite/React) + bridges + Orchestrator com
  personas + WaveExecutor + MemoryManager/MemoryRetriever
  + Sandbox* + PromotionManager/Anti-Vibe + local inference
- Baseline CI (#35)

> Grande parte do código "Current" é **Legacy** na direção do produto. Antes
> de modificar qualquer subsistema, consulte a matriz de legado.

### Direction (executive coordination)

- M0 (Executive Foundation) está concluída: contracts e primitives duráveis
  de Mission, Capability, Context, execução e eventos estão em `main`.
- M1 (Local Control Plane) é a fase executável atual: compor o daemon
  headless como autoridade, estabelecer boundary local versionada e CLI factual
  de administração/recovery (#70, #59).
- Mission Control desktop segue gated para M2 (#68). Integrações Katherine,
  Runstead e Cadinho seguem gated/deferred em M3 (#65–#67/#82).
- #69 fechou a decisão arquitetural: self-improving governado não autoriza
  self-modification. O ciclo de evolução entre módulos continua direção, não
  comportamento implementado do runtime.

### Legacy (não é direção)

SelfModifyingEngine (retired in #95), PersistentPythonREPL (retired in #96), Council/personas, ArchitectClient (persona), WaveExecutor ("agent wave"),
Anti-Vibe como code gate, bridges diretas (Antigravity/Gemini/Jules), Ralph,
MCP/SkillLoader, Council/Memory/Terminal UI, Electron (direção), TUI React/Ink (removida em #104).
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
├── inference/      # Local inference (ADAPT — planner backend opcional)
├── orchestration/  # Orchestrator, WaveExecutor, Memory, Promotion (classificar)
├── ports/          # Interface definitions (hexagonal)
├── providers/      # Agent execution engines
├── runtime/        # runtime adapters; Python REPL and Sandbox* retired
```

> ⚠️ Antes de editar arquivos em `bridges/`, `runtime/`, `orchestration/`,
> `inference/` ou `scripts/ralph/`, leia a linha correspondente na
> matriz de legado e respeite a Decision única registrada (não amplie feature
> de subsistema classificado `RETIRE`/`DEFER`).

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

**Estado**: o programa de realinhamento #60 continua em andamento. M0
(Executive Foundation) está concluída; M1 (Local Control Plane) é a fase
executável atual. Esta mudança documenta a reconciliação pós-M0 solicitada
pela #94.

**M0 concluída**: 19 issues fechadas e 0 abertas no milestone M0. Inclui
baseline reproduzível, zero quarantines, Mission/CapabilityInvocation
duráveis, scheduler/recovery/reconciliation, Capability Registry/dispatch,
Context Compiler/Context Packs, provider boundary/resilience, projeção de
eventos e trust-model containment.

**Current** também inclui daemon/RPC, session manager, event bus, SQLite,
daemon controls, web frontend, contracts de eventos/provider, inferência local
e subsistemas de orchestration legados. Current descreve comportamento; código
legado não se torna Direction por estar presente.

**M1 atual**: #70 e #59 são os principais epics; o child work está decomposto
e rastreado em #94–#105. Consulte o GitHub para os estados vivos `ready`,
`blocked` e `closed` de cada issue; este documento não seleciona a próxima
child nem presume conclusão de #97/#98 ou das demais.

**M2 futura/gated**: #68, Mission Control Experience, depende dos fatos do
Local Control Plane. **M3 futura/gated**: #65 Katherine (deferred), #66/#67
Cadinho/Runstead e #82 (blocked). **Research sem milestone**: #31/#58/#79/#80,
avançam somente após seus gates de evidência.

**Legado classificado**: ver [docs/LEGACY_MATRIX.md](docs/LEGACY_MATRIX.md).

---

## Referências

| Issue | Tema | Status |
|---|---|---|
| #60 | Epic realinhamento executive coordination | Open program |
| #61 | Source of truth + matriz de legado | Closed (M0) |
| #62 | Mission durável | Closed; implemented (M0) |
| #63 | Capability Registry + connectors | Closed; implemented (M0) |
| #64 | Context Compiler com provenance | Closed; implemented (M0) |
| #69 | Self-improving != self-modifying | Closed decision (M0); runtime cycle remains Direction |
| #70 | Headless daemon + Mission Control + CLI | Open; current M1 epic |
| #35 | Baseline reproduzível e CI | Closed; current baseline |
| #41 | Resolver quarentenas após classificação | Closed; resolved, 0 current quarantines |
| #50 | Execução durável | Closed; implemented (M0) |
| #58 | Avaliar Go como runtime core | Open; research-gated (no milestone) |
| #78 | Context Packs bounded/progressivos | Closed; implemented (M0), with documented limits |
| #94 | Reconciliação de status após M0 | Reconciliação documentada por esta mudança; estado vivo no GitHub |
