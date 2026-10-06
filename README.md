# 🐍 Ouroboros Runtime

> **Executive runtime / sistema nervoso do Anakyklos**

Ouroboros é o runtime executivo do Anakyklos: ele recebe intenções, cria e
persiste **Missions**, propõe/decompõe trabalho com planning advisory, aplica
**policy determinística**, descobre capabilities e coordena **module owners**
(Runstead, LifeOS, Tecer, device modules, etc.), coletando evidência e fazendo
**mission-level verification**.

> ⚠️ **Realinhamento arquitetural (epic #60)**: esta documentação foi
> realinhada. Conteúdo histórico sobre "self-modifying agent", Council/personas,
> Python sandbox como capacidade central, waves, Ralph e Electron **não
> representa a direção futura** e está marcado como `Legacy`.
> Ver [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) e
> [docs/LEGACY_MATRIX.md](docs/LEGACY_MATRIX.md).
>
> **Fonte arquitetural primária**: `Anakyklos/architecture` (privado) —
> [`README.md`](https://github.com/Anakyklos/architecture),
> [`SYSTEM-MAP.md`](https://github.com/Anakyklos/architecture/blob/main/SYSTEM-MAP.md),
> [`VISION.md`](https://github.com/Anakyklos/architecture/blob/main/VISION.md),
> [policies](https://github.com/Anakyklos/architecture/tree/main/policies),
> [RFC 0001](https://github.com/Anakyklos/architecture/blob/main/rfcs/0001-system-boundaries.md),
> [Technology Palette](https://github.com/Anakyklos/architecture/tree/main/languages).
> **Hierarquia de autoridade**:
> - **Para comportamento/current reality**: `code + tests + observation > documentação`
> - **Para direção/boundaries**: `Anakyklos/architecture + decisões aprovadas > documentação legada do produto`
> - **Current ≠ Direction ≠ Legacy ≠ Hypothesis** — nunca apresentar Direction como implementada, nem Hypothesis como compromisso.
> (Fonte: `Anakyklos/architecture/README.md`.)

---

## Fluxo autoritativo

```text
Intent source
(Katherine / Mission Control / CLI / API)
        ↓
MissionIntent
        ↓
Ouroboros interpretation + durable creation
        ↓
Mission
        ↓
Planner (agentic proposal)
        ↓
Deterministic validator/policy
        ↓
Capability Registry
        ↓
Capability Invocation (versioned Connector)
        ↓
Module Owner
        ↓
evidence + domain verification
        ↓
Ouroboros mission-level verification
        ↓
result / approval / next decision
```

### `MissionIntent != Mission`

Katherine, Mission Control, CLI ou API fornecem **MissionIntent**. A Mission
autoritativa nasce **dentro do Ouroboros** (interpretação + criação durável).

### Planning é advisory; policy autoriza effects

O modelo (LLM) propõe interpretação, decomposição e plano. Código/policy
persistível decide capability, approvals, budgets, retries, dispatch, state
transitions, cancellation e acceptance. O modelo não concede authority a si
mesmo.

---

## O que Ouroboros é / não é

**Ouroboros é:**
- Preservador de intent original, constraints e acceptance
- Criador/mantenedor de Missions duráveis
- Compilador de contexto mínimo autorizado
- Proponente/decompositor de trabalho (Planner advisory)
- Descobridor de capabilities (Capability Registry)
- Aplicador de policy determinística
- Coordenador de module owners
- Mantenedor de execução durável e checkpoints
- Coletor de evidence e resultados
- Verificador em nível de mission

**Ouroboros não é:**
- Coding agent concorrente do Runstead
- Capability factory concorrente do Cadinho
- Self-modifying runtime (não altera/promove silenciosamente o próprio código)
- Arquitetura de Council/personas
- Executor irrestrito de Python/shell
- Banco universal de memória
- Dono de databases/invariants de outros módulos
- Chatbot concorrente da Katherine

---

## Self-improving ≠ Self-modifying

**Self-improving Anakyklos permanece válido** como ciclo governado:

```text
Ouroboros observes
        ↓
bounded adaptation OR CapabilityGap
        ↓
Cadinho candidate/trial
        ↓
Runstead implementation when needed
        ↓
verification
        ↓
explicit promotion
        ↓
Capability Registry
```

**Self-edit / promoção silenciosa pelo Ouroboros não é permitida.**
Detalhes em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (#69).

---

## Forma do produto (#70)

```text
Mission Control desktop     CLI     Katherine
             \                |       /
              \               |      /
               \              |     /
                local/versioned IPC
                          |
                  +----------------+
                  |  ouroborosd    |
                  | headless core  |
                  +-------+--------+
                          |
                capability contracts
                          |
          Runstead / LifeOS / Tecer / devices / ...
```

- Daemon/headless runtime é autoridade
- Fechar Mission Control **não** cancela Mission
- Mission Control é operacional (não chatbot)
- Katherine é interface humana **opcional**
- CLI pequena permanece para admin/recovery
- Electron **não** é default arquitetural
- Web server local não é requisito
- TUI completa não compete como segunda UI principal
- Framework desktop decidido após contracts + POC/benchmark

### `Create Mission in Mission Control: On | Off`

Configuração de superfície: controla **somente a entrada de MissionIntent** na
UI. Não cria duas máquinas de Mission. `On` adequa ao uso standalone; `Off`
quando Katherine é a superfície preferida. Esconder a entrada não desativa o
pipeline de criação do runtime.

---

## Mission Canvas boundary

Mission Control may evolve toward a spatial Mission Canvas for visualizing Mission structure, capability execution, waits, approvals and evidence. The canvas is strictly a projection/input surface over Ouroboros contracts: it is not a scheduler, second state store, coding runtime or source of execution truth.

For software work, the owner remains Runstead. Ouroboros invokes the public Runstead capability contract and consumes its verified result/evidence; it does not bypass Runstead through direct vendor coding CLIs or private Runstead state.

The durable Mission, Capability and event contracts from #62/#63/#38 are
implemented in `main`. Mission Canvas remains future work: the local-control
facts tracked by M1/#70 are still being completed, and the experience itself
is tracked by the gated M2 issue #68. See docs/ARCHITECTURE.md and
Anakyklos/architecture ADR 0004.

## Quickstart (baseline)

```bash
# Bun 1.3.9+ (CI pin: 1.3.9)
bun install --frozen-lockfile
cd web && bun install --frozen-lockfile && cd ..

# Baseline completo: install integrity + runtime tsc + web build + tests
bun run check
```

Baseline: [`docs/BASELINE.md`](docs/BASELINE.md) | CI:
`.github/workflows/ci.yml` | Manifesto de quarentena:
`scripts/quarantine-manifest.json` (0 suites atuais; dívida #41 resolvida).

---

## Arquitetura e direção

| Documento | Conteúdo |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Identidade, fluxo, Current/Direction/Legacy/Hypothesis, #69, #70 |
| [docs/LEGACY_MATRIX.md](docs/LEGACY_MATRIX.md) | Classificação vinculante de subsistemas legados (#61) |
| [docs/MISSION_CONTRACT.md](docs/MISSION_CONTRACT.md) | Contrato first-class de Mission, policy determinística e persistência (#62) |
| [docs/CONTEXT_PACK_RUNTIME.md](docs/CONTEXT_PACK_RUNTIME.md) | Packs bounded, expansão progressiva, ResultArtifact e accounting (#78) |
| [docs/ORCHESTRATOR_MIGRATION_MAP.md](docs/ORCHESTRATOR_MIGRATION_MAP.md) | Mapa de migração do Orchestrator legado para Mission/Invocation (#62) |
| [AGENTS.md](AGENTS.md) | Guia para executores/agentes |
| [docs/BASELINE.md](docs/BASELINE.md) | Gate de validação reproduzível (#35) |
| [docs/MODEL_PROVIDER_CONTRACT.md](docs/MODEL_PROVIDER_CONTRACT.md) | Contract de provider (planejamento) |

---

## Current / Direction / Legacy / Hypothesis

- **Current** — comportamento comprovado hoje: daemon/RPC, session manager,
  event bus, SQLite storage, daemon controls, web frontend (Vite/React),
  baseline CI e contracts de eventos/provider; Mission e invocations duráveis,
  policy determinística, Capability Registry/dispatch, Context Compiler e
  Context Packs bounded/progressivos (#50/#62/#63/#64/#78).
- **Direction** — a arquitetura-alvo continua maior que o runtime atual.
  M1 (#70/#59) compõe o daemon headless e completa a boundary local e a CLI
  factual. #69 fechou a decisão que proíbe self-modification; o ciclo
  governado entre módulos continua direção, não comportamento implementado.
  Não declarar completo o composition root local-control.
- **Legacy** — código que não define mais a direção: SelfModifyingEngine,
  Python sandbox, Council/personas, ArchitectClient, waves, Ralph,
  MCP/SkillLoader, bridges diretas, TUI React/Ink, Council/Memory/Terminal UI.
  Classificação completa em [docs/LEGACY_MATRIX.md](docs/LEGACY_MATRIX.md).
- **Hypothesis** — decisões pendentes de POC/benchmark: migração Go (#58),
  boundaries Zig/Rust, framework desktop, IPC protocol, service lifecycle.

### Roadmap de milestones

- **M0 — Executive Foundation: concluída** (19 issues fechadas, 0 abertas).
- **M1 — Local Control Plane: fase atual**; #94 é a leaf P0 selecionada.
  Outras leaves #94–#105 permanecem em seus estados individuais no GitHub.
- **M2 — Mission Control Experience: futura/gated** (#68), após os fatos de M1.
- **M3 — Cross-project Capability Boundaries: futura/gated** (#65–#67/#82);
  Katherine está deferred e integrações Runstead/Cadinho continuam gated.
- **Research sem milestone**: #31/#58/#79/#80 permanecem research-gated.

---

## Desenvolvimento

Comandos operacionais corretos (baseline #35):

```bash
bun run check          # gate completo
bun run check:install  # frozen installs + tree integrity
bun run check:runtime  # tsc (runtime/CLI)
bun run check:web      # web/ production build
bun run check:tests    # testes obrigatórios
```

> ⚠️ Classificação dos entrypoints:
>
> - `bun run setup` → **workflow/setup legado** (BootWizard da fase
>   "self-modifying runtime"; classificado na matriz de legado).
> - `bun run tui` → **TUI legada** (React/Ink; classificada `RETIRE` na
>   matriz de legado — não compete como segunda UI principal).
> - `bun run daemon` → **entrypoint atual válido** do daemon/headless runtime.
>   O daemon é parte da direção preservada (core `KEEP` na matriz). O entrypoint
>   atual não deve ser confundido com a arquitetura-alvo `ouroborosd` do #70:
>   o **daemon/headless core atual, incluindo o RPC gateway**, permanece
>   `KEEP` (foundation da direção até sua boundary evoluir pelos contracts
>   futuros). O **transporte atual (Fastify/WebSocket)** é classificado
>   `ADAPT` na matriz — pode ser adaptado ou substituído por IPC local
>   posteriormente, sem alterar a decisão `KEEP` do core.
>
> **Entrypoint atual ≠ arquitetura-alvo.** O daemon atual é comportamento
> comprovado (`Current`); `ouroborosd` headless com Mission Engine, Capability
> Registry e IPC local é a direção (`Direction`, #70) — não está implementado.

---

## Licença

ISC (ver `package.json`).
