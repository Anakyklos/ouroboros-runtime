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

## Quickstart (baseline)

```bash
# Bun 1.3.9+ (CI pin: 1.3.9)
bun install --frozen-lockfile
cd web && bun install --frozen-lockfile && cd ..

# Baseline completo: install integrity + runtime tsc + web build + tests
bun run check
```

Baseline: [`docs/BASELINE.md`](docs/BASELINE.md) | CI:
`.github/workflows/ci.yml` | Testes em quarentena: `scripts/quarantine-manifest.json` (#41).

---

## Arquitetura e direção

| Documento | Conteúdo |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Identidade, fluxo, Current/Direction/Legacy/Hypothesis, #69, #70 |
| [docs/LEGACY_MATRIX.md](docs/LEGACY_MATRIX.md) | Classificação vinculante de subsistemas legados (#61) |
| [AGENTS.md](AGENTS.md) | Guia para executores/agentes |
| [docs/BASELINE.md](docs/BASELINE.md) | Gate de validação reproduzível (#35) |
| [docs/MODEL_PROVIDER_CONTRACT.md](docs/MODEL_PROVIDER_CONTRACT.md) | Contract de provider (planejamento) |

---

## Current / Direction / Legacy / Hypothesis

- **Current** — comportamento comprovado hoje: daemon/RPC, session manager,
  event bus, SQLite storage, daemon controls, web frontend (Vite/React),
  baseline CI, contracts de eventos/provider.
- **Direction** — executive coordination: Mission durável (#62), Capability
  Registry (#63), Context Compiler (#64), policy determinística, headless
  daemon + Mission Control desktop + CLI (#70), self-improving governado (#69).
- **Legacy** — código que não define mais a direção: SelfModifyingEngine,
  Python sandbox, Council/personas, ArchitectClient, waves, Ralph,
  MCP/SkillLoader, bridges diretas, TUI React/Ink, Council/Memory/Terminal UI.
  Classificação completa em [docs/LEGACY_MATRIX.md](docs/LEGACY_MATRIX.md).
- **Hypothesis** — decisões pendentes de POC/benchmark: migração Go (#58),
  boundaries Zig/Rust, framework desktop, IPC protocol, service lifecycle.

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

> ⚠️ Comandos legados (`bun run setup`, `bun run daemon`, `bun run tui`)
> referem-se a componentes classificados na matriz de legado. Não os use como
> referência de direção do produto.

---

## Licença

ISC (ver `package.json`).
