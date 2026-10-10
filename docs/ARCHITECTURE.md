# Ouroboros Architecture

> **Status**: Current (Direction) — Esta documentação reflete a direção arquitetural
> do Ouroboros conforme a epic #60 e o repositório `Anakyklos/architecture`.
> Conteúdo que descreve comportamento já implementado está em *Current*.
> Conteúdo que descreve onde o produto está indo está em *Direction*.
> Código existente que não representa mais a direção está em *Legacy*.
> Decisões dependentes de POC/benchmark estão em *Hypothesis*.
>
> **Hierarquia de autoridade**:
> - **Para comportamento/current reality**: `code + tests + observation > documentação`
> - **Para direção/boundaries**: `Anakyklos/architecture + decisões aprovadas > documentação legada do produto`
> - **Current ≠ Direction ≠ Legacy ≠ Hypothesis** — nunca apresentar Direction como implementada, nem Hypothesis como compromisso.
> (Fonte: `Anakyklos/architecture/README.md`.)

---

## Identity

Ouroboros é o **executive runtime / sistema nervoso do Anakyklos**.

**Responsabilidades-alvo** (SYSTEM-MAP.md, RFC 0001):
- Receber e preservar intent original do usuário + constraints explícitas
- Decompor objetivos maiores em tarefas delimitadas (mission decomposition)
- Descobrir capabilities disponíveis dos módulos (capability discovery)
- Compilar pacotes de contexto mínimo para executors downstream
- Coordenar dependências e task graphs
- Reagir a eventos do sistema sem polling cego
- Rastrear progresso em nível de mission
- Determinar quando o usuário deve ser consultado
- Identificar capability gaps recorrentes
- Fazer mission-level verification (não substitui verificação do módulo executor)

**O que Ouroboros NÃO é** (SYSTEM-MAP.md, #60):
- **Não** é coding agent concorrente do Runstead
- **Não** é capability factory / autônoma concorrente do Cadinho
- **Não** é self-modifying runtime (não altera/promove silenciosamente o próprio código;
  SYSTEM-MAP.md: "silently self-promoting changes" é non-responsibility explícita)
- **Não** é arquitetura de Council/personas (não coleção fixa de personas internas)
- **Não** é executor irrestrito de Python/shell
- **Não** é banco universal de memória/personal data
- **Não** é dono das invariantes/internals de LifeOS, Tecer, device modules
- **Não** é chatbot concorrente da Katherine
- **Não** substitui verificação técnica do módulo executor (Runstead)
- **Não** ganha autoridade ilimitada meramente por coordenar o sistema
  (RFC 0001: "No module gains authority merely because it coordinates another")

---

## Authoritative Flow

```
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
Plan candidate
        ↓
Deterministic validator/policy
        ↓
Capability Registry
        ↓
Capability Invocation (versioned Connector)
        ↓
Module Owner (Runstead, LifeOS, Tecer, etc.)
        ↓
evidence + domain verification
        ↓
Ouroboros mission-level verification
        ↓
result / approval / next decision
        ↓
operator / Katherine / next mission
```

### `MissionIntent != Mission`

`MissionIntent` é a entrada de intenção fornecida por uma interface autorizada
(Katherine, Mission Control desktop, CLI, API). Katherine pode resolver
ambiguidade conversacional e anexar constraints, escolhas e context refs
autorizados, mas não entrega uma Mission já planejada. Mission Control
standalone também não cria state autoritativo na UI: captura intent e envia
ao mesmo pipeline. A Mission autoritativa nasce **dentro do Ouroboros** a
partir de interpretação + criação durável.

### Planning é advisory; policy autoriza effects

O modelo (LLM) pode propor: interpretação, decomposição, plano, capability
candidates, contexto necessário, hipótese de satisfação. **O modelo não
concede a si mesmo authority para executar effects.**

Código/policy persistível decide: capability permitida, approval necessário,
budgets, dispatch, retries permitidos, state transitions, cancellation,
evidence acceptance, recovery/idempotency. (RFC 0001: "Ouroboros agentic
planning must not be the final source of authorization. Deterministic policy
and downstream module validation remain required.")

---

## Self-improving ≠ Self-modifying (#69)

Self-improving Anakyklos permanece válido como direção. O que é descartado
como arquitetura do core é o modelo histórico de **self-modifying Ouroboros**.

Ouroboros não deve reescrever/promover silenciosamente seu próprio código em
produção. A melhoria deve acontecer como um ciclo distribuído, observável e
governado entre os módulos do Anakyklos.

**Fluxo de melhoria:**
```
Ouroboros observes outcomes
        ↓
learns operational evidence / detects recurring gaps
        ↓
policy decides whether adaptation or capability-gap proposal is allowed
        ↓
Cadinho specifies / experiments / benchmarks candidate
        ↓
Runstead implements software when needed
        ↓
owner tests + benchmarks + verification
        ↓
explicit promotion authority
        ↓
Capability Registry exposes approved version
        ↓
future missions benefit from evidence
```

---

## Topologia do Produto (#70)

```
   Mission Control desktop     CLI     Katherine
             \                   |        /
              \                  |       /
               \                 |      /
                local/versioned contract (IPC)
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

### Princípios da topologia

1. **Runtime é o produto autoritativo.** Nenhuma interface gráfica é source
   of truth. Fechar/reiniciar a interface NÃO cancela Mission durável.
2. **Mission Control desktop é a interface principal.** Operacional: visualizar
   Missions, progresso baseado em fatos, approvals, evidence, degradation.
   Não é chatbot, não replica Katherine.
3. **CLI pequena permanece para admin/recovery.** `ouroboros status`,
   `ouroboros missions`, `ouroboros mission show/pause/resume/cancel`,
   `ouroboros capabilities`. Fala com o mesmo daemon/contracts.
4. **Katherine é interface humana opcional.** Presença conversacional.
   Ouroboros Mission Control é operacional. Não duplicar personalidade/chat.
5. **Electron não é default arquitetural.** Web stack histórico não obriga
   continuidade. Framework desktop escolhido após contracts + POC/benchmark.
6. **TUI completa não compete como segunda UI principal.** Decision na
   matriz: **RETIRE** como produto principal. Componentes realmente úteis
   para debug/recovery podem ser reaproveitados e uma CLI pequena permanece
   (`ouroboros status/missions/...`); isso não altera a Decision da TUI
   completa.
7. **IPC local em vez de web server como default.** Unix domain socket
   candidato. HTTP/WebSocket remoto só introduzido se caso real de cliente
   remoto surgir.
8. **`Create Mission in Mission Control: On | Off`** — controla somente a
   superfície de entrada de MissionIntent. Não cria duas máquinas de Mission
   distintas. `On`: adequado ao standalone; `Off`: Katherine é superfície
   preferida. Esconder entrada não desativa pipeline de criação do runtime.

---

## Mission Canvas direction

Status: Direction. This is a Mission Control projection, not a new execution engine.

Mission Control may adopt a spatial/canvas interaction model inspired by visual agent workbenches, but the semantics are constrained by Ouroboros authority:

~~~text
authoritative Ouroboros Mission / CapabilityInvocation state
                       |
                       v
             versioned event/projection contract
                       |
                       v
                Mission Control
                 Mission Canvas
~~~

The canvas may visualize Missions, plan steps, capability invocations, owners, waits/blockers, approvals, evidence and results. It may also provide bounded operator actions when the runtime contract explicitly supports them.

Hard boundaries:

- node position, edges, visual grouping, terminal panes and drag/drop are never authority;
- the UI never owns a second Mission graph or scheduler;
- a node marked completed visually is not evidence unless the authoritative runtime says the underlying state/evidence gate passed;
- the UI does not invoke Runstead or shell/processes behind Ouroboros policy;
- the UI does not read Runstead private state or another module database;
- closing/restarting Mission Control does not cancel durable Missions;
- reconnect must rebuild the complete meaningful view from runtime/module contracts;
- hidden chain-of-thought, raw provider responses, secrets and private module internals are not canvas data.

### Runstead boundary

For software work, Ouroboros consumes a Runstead-owned versioned capability contract. Runstead remains responsible for its task lifecycle, repository effects, provider use, recovery and technical verification. Ouroboros remains responsible for deciding whether that verified software result satisfies the larger Mission.

Ouroboros must not create a duplicate coding runtime or call Codex CLI, Claude Code, OpenCode, Antigravity or other coding CLIs as an internal shortcut around Runstead. If Runstead is unavailable, software-work capability is unavailable/degraded until policy can choose another explicitly owned capability; absence is not permission to duplicate the owner.

### Unlock gate for Mission Canvas

Canvas implementation remains blocked until the runtime exposes enough stable facts to make the UI reconstructable and honest. At minimum:

1. durable Mission identity/state;
2. Capability Registry + versioned CapabilityInvocation semantics;
3. event/state projection with reconnect/reconciliation;
4. typed waits, approvals, blockers, cancellation and results;
5. evidence/result references with owner provenance;
6. versioned local interface/IPC;
7. failure/degraded states that do not require UI inference.

The foundational Mission, Capability and event contracts tracked by #62/#63/#38
are implemented in `main`; they are no longer pending dependencies. M1/#70 is
still completing the local-control facts needed for an honest interface, and
the Mission Control experience remains future/gated work under M2/#68.

The cross-project normative decision is Anakyklos/architecture ADR 0004.

---

## Current (comportamento comprovado hoje)

O que o repositório implementa e testa atualmente:

- **Mission durável** e CapabilityInvocation, policy determinística, SQLite
  persistence, scheduler/recovery/reconciliation (#50/#62)
- **Capability Registry** e dispatch seam (#63)
- **Context Compiler** com provenance, Context Packs bounded/progressivos e
  planner coordinator (#64/#78)
- **Provider boundary/resilience** (#44/#47), projection/reconnect de eventos
  do daemon (#38) e trust-model containment
- **Daemon server** com RPC gateway (JSON-RPC 2.0 sobre Fastify + WebSocket).
  A composição default é headless/provider-independent: serve health/status,
  `local_control.read` e projeções duráveis de Mission/Invocation sem construir
  o `GatewayOrchestrator`. A superfície direta `agent.*`/`daemon.delegate`
  permanece disponível somente ao compor explicitamente o gateway legacy;
  esse adapter continua legado e não é parte do caminho default.
- **SessionManager** com lifecycle de sessões
- **EventBus** para comunicação cross-module
- **GatewayOrchestrator** integrando bridges (Antigravity, Gemini, Jules,
  inference, Architect, MemoryRetriever, WaveExecutor)
- **WaveExecutor** para paralelização de tasks
- **Orchestrator** com personas, escalation chain, loopUntilSuccess,
  Anti-Vibe phases
- **MemoryManager** / **MemoryRetriever** (Markdown file-first em .agent/memory)
- **SQLite storage** (better-sqlite3, WAL mode, prepared statements)
- **Web frontend** Vite/React (Mission Control, Swiss, settings, terminal pane,
  memory panel, Council quadrants)
- **PromotionManager** / **Anti-Vibe workflow** (playground → src gates)
- **Bridges** diretas: Antigravity, Gemini CLI, Jules, local inference
- **Ralph loop** (opencode automation)
- **MCP** / **SkillLoader** / **skills** em .agent/skills/
- **Concierge** intent classification
- **Daemon controls** (status, mode, emergencyBrake)
- **Inference subsystem** (local inference, embedding, model routing)
- **Baseline CI** (#35): `bun install --frozen-lockfile`, `bun run check`
  (install integrity, tsc, web build, mandatory tests)

**Nota:** Parte substancial deste código é **Legacy** — não representa a
direção futura do produto. Ver classificação detalhada em
[LEGACY_MATRIX.md](LEGACY_MATRIX.md).

---

## Direction (executive coordination desejada)

As decisões aceitas em `Anakyklos/architecture` (README.md, SYSTEM-MAP.md,
RFC 0001, VISION.md, policies) continuam orientando o produto. Mission (#62),
Capability Registry (#63), Context Compiler (#64) e policy determinística já
têm implementação comprovada em `main`; não são apenas componentes futuros.

O trabalho de produto ainda em direção inclui:

- **Composition root headless/local control plane** (#70, M1), com boundary
  local versionada, daemon como autoridade e CLI factual de admin/recovery;
- **Mission Control desktop** como interface principal, ainda gated por M1 e
  tracked em #68/M2;
- **Planning agentic** advisory; **policy determinística** autoritativa;
- **Mission-level verification** separada de domain/technical verification
  (SYSTEM-MAP.md: "No higher layer may erase a lower layer's safety or
  correctness checks")
- **Self-improving** governado: o limite arquitetural foi fechado em #69
  (self-modification do Ouroboros é proibida); o ciclo entre módulos ainda é
  direção e não deve ser descrito como funcionalidade runtime implementada.
- **Supervisão e lifecycle bounded** (#59), sobre primitives de execução
  durável já entregues em #50;
- **Contexto compilado** sob orçamento, com provenance, sem universal memory
  (policies/resource-efficiency.md: "Ouroboros should coordinate context
  without duplicating all module state")
- **Headless daemon** (ouroborosd) como autoridade
- **Mission Control desktop** leve como interface principal
- **IPC local** (Unix socket) como transporte default
- **CLI pequena** para admin/recovery
- **Katherine** como interface opcional via contract público
  (policies/module-autonomy.md: companion mode remains useful without Ouroboros;
  Anakyklos interface mode é adicional)
- **Capability discovery** substitui bridges hardcoded no orchestrator
- **Runstead** boundary explícita: software work pertence ao Runstead
  (SYSTEM-MAP.md: "Runstead retains responsibility for proving that its own
  technical work was actually performed correctly")
- **Cadinho** boundary: capability-gap evolution explícita
  (RFC 0001: "a new capability does not imply a new agent")
- **Domain modules** (LifeOS, Tecer, devices) mantêm state ownership
  (SYSTEM-MAP.md: "No direct cross-module database access")
- **Verificação em camadas**: Runstead technical verification → domain
  verification → Ouroboros mission verification (SYSTEM-MAP.md)
- **Knowledge ownership**: Katherine owns conversational memory; LifeOS owns
  life-domain facts; Tecer owns health/wellness; device modules own device
  state; Ouroboros routes, references, and compiles rather than becoming
  universal source of truth (SYSTEM-MAP.md)

### Roadmap de milestones

- **M0 — Executive Foundation: concluída**. O milestone tem 19 issues
  fechadas e 0 abertas, incluindo baseline/CI, zero quarantines, Mission e
  Invocation duráveis, scheduler/recovery/reconciliation, Capability Registry
  e dispatch, Context Compiler/Context Packs, provider resilience, event
  projection/reconnect e trust-model containment.
- **M1 — Local Control Plane: fase atual**. #70 e #59 são os principais
  epics; child work está decomposto e rastreado em #94–#105. Consulte o GitHub
  para os estados vivos `ready`, `blocked` e `closed`; M1 não está completo e
  este documento não seleciona a próxima child nem presume conclusão de #97/#98.
- **Evidência M1 posterior à decomposição:** PRs #127, #128, #134, #136 e
  #138 foram integradas à `main`, adicionando limites e accounting de slots
  WebSocket, paginação SQLite e fatos de decisão do scheduler, retenção
  limitada de IDs dos relatórios residentes e admissão RPC autenticada
  limitada. São fatias verificadas, não conclusão de #59/#70. #131 permanece
  **OPEN/BLOCKED**; #132 fechou `not_planned` sem produtor confiável de
  `safe_to_retry`, portanto nenhuma repetição automática de `runOnce()` foi
  autorizada. O HTTP/WebSocket autenticado em loopback permanece o transporte
  atual; o experimento #100 não promoveu Unix socket a transporte de produção.
- **M2 — Mission Control Experience: futura/gated** (#68), condicionada a
  fatos suficientes do Local Control Plane.
- **M3 — Cross-project Capability Boundaries: futura/gated**. #65 Katherine
  está deferred; #66/#67 e #82 permanecem blocked/gated.
- **Research sem milestone**: #31/#58/#79/#80 aguardam seus gates explícitos
  de evidência; Go (#58) e IPC local ainda não são Current.

---

## Legacy (código existente que não define mais direção)

Código e documentação que preservam a identidade histórica de "self-modifying
multi-agent runtime" e não representam a direção futura. A classificação
vinculante de cada subsistema está em [LEGACY_MATRIX.md](LEGACY_MATRIX.md).

**Exemplos de conceitos legados:**
- Self-modifying engine (SelfModifyingEngine, modifySelf())
- Python sandbox como capacidade central (SandboxRunner/SandboxTool removidos
  em #83; PersistentPythonREPL removido do core em #96)
- Council/personas como arquitetura central (Vision, Architect, Guardian,
  Kinetic)
- Fixed persona ArchitectClient
- Agentic "waves" como metáfora central de paralelismo
- Anti-Vibe Protocol como gate de promoção de código
- Ralph loop autônomo
- MCP/skills como expansão do próprio agente
- Electron como shell desktop
- TUI React/Ink como segunda interface principal (código/entrypoint removidos em #104)
- Web server (Fastify/WebSocket) como transporte default
- Direct bridges (Antigravity, Gemini, Jules) como API central do orchestrator
- GatewayOrchestrator como god orchestrator de integrações concretas
- Agent memory universal (MemoryManager Markdown, MemoryRetriever)

---

## Hypothesis (decisões dependentes de POC/benchmark)

Decisões que dependem de pesquisa, POC ou benchmark antes de serem
incorporadas à direção:

- **Migração Go para ouroborosd** (#58): Go é CORE na Technology Palette
  (`Anakyklos/architecture/languages/go.md`) para "infrastructure runtimes,
  agents, complex CLIs, local services, moderate daemons and I/O-heavy control
  planes". A migração do runtime atual (TypeScript/Bun) para Go depende de
  semântica estabilizada (Mission, Capability, Context contracts) e de
  avaliação de custo/benefício. Não migrar primeiro e depois descobrir o que
  o core deveria fazer.
- **Zig/Rust para boundaries especializadas**: SPECIALIST na Technology
  Palette; reservar para boundaries de segurança/performance quando justificado.
- **Framework desktop**: Tauri, Wails, pywebview, WebKitGTK, system WebView
  — decidir após contracts estabilizados e POC de IPC local.
- **IPC protocol**: Unix domain socket vs outros — decidir após benchmark
  com Mission/Capability contracts.
- **Service lifecycle**: systemd user service, crash recovery, upgrade
  semantics — avaliar após definição do runtime.
- **Cadinho repository**: SYSTEM-MAP.md registra que localização exata do
  repositório do Cadinho ainda precisa ser registrada.

---

## Proveniência e fontes primárias

Este documento foi reconciliado com as seguintes fontes do repositório
`Anakyklos/architecture` (privado, acessível via GitHub autenticado):

| Fonte | Conteúdo |
|---|---|
| [`README.md`](https://github.com/Anakyklos/architecture) | Authority hierarchy, status vocabulary, first principles |
| [`SYSTEM-MAP.md`](https://github.com/Anakyklos/architecture/blob/main/SYSTEM-MAP.md) | System boundaries, verification layers, knowledge ownership |
| [`VISION.md`](https://github.com/Anakyklos/architecture/blob/main/VISION.md) | Long-term direction, module autonomy, Katherine envelopes |
| [`policies/resource-efficiency.md`](https://github.com/Anakyklos/architecture/blob/main/policies/resource-efficiency.md) | Resource efficiency priority, context coordination |
| [`policies/module-autonomy.md`](https://github.com/Anakyklos/architecture/blob/main/policies/module-autonomy.md) | Standalone-first rule, graceful degradation |
| [`RFC 0001`](https://github.com/Anakyklos/architecture/blob/main/rfcs/0001-system-boundaries.md) | System boundaries, cross-system invariants |
| [`languages/`](https://github.com/Anakyklos/architecture/blob/main/languages/README.md) | Technology Palette (Go CORE, TypeScript CORE, Python CORE) |
| [`STATUS.md`](https://github.com/Anakyklos/architecture/blob/main/STATUS.md) | Architectural maturity snapshot |

**Regra de authority** (fonte: `Anakyklos/architecture/README.md`):
> **Para comportamento/current reality**:
> `code + tests + observed behavior > product documentation > architecture repository`
>
> **Para direção/boundaries**:
> `Anakyklos/architecture + decisões aprovadas > documentação legada do produto`
>
> **Current ≠ Direction ≠ Legacy ≠ Hypothesis** — README antigo ou código
> legado não definem a direção apenas por existirem; Architecture não prova
> feature implementada.

---

## Referências

| Issue | Título | Status |
|-------|--------|--------|
| #60 | [P0][EPIC][REALIGN] Reorientar Ouroboros para executive coordination | Open program |
| #61 | [P0][REALIGN] Corrigir source of truth e classificar subsistemas legados | Closed (M0) |
| #62 | [P0][ARCH] Definir Mission como entidade durável | Closed; implemented (M0) |
| #63 | [P0][ARCH] Definir Capability Registry e connector contract | Closed; implemented (M0) |
| #64 | [P0][ARCH] Definir Context Compiler com provenance | Closed; implemented (M0) |
| #69 | [P1][ARCH] Self-improving Anakyklos sem self-modifying Ouroboros | Closed decision; runtime cycle remains Direction |
| #70 | [P1][ARCH][APP] Ouroboros como daemon headless + Mission Control + CLI | Open; current M1 epic |
| #35 | Baseline reproduzível e CI | Closed; current baseline |
| #41 | Resolver quarentenas após classificação do legado | Closed; resolved, 0 current quarantines |
| #50 | Execução durável de missões e capability invocations | Closed; implemented (M0) |
| #58 | Avaliar Go como runtime core | Open; research-gated (no milestone) |
| #78 | Context Packs bounded/progressivos | Closed; implemented (M0), with documented limits |
| #94 | Reconciliação de status após M0 | Reconciliação documentada por esta mudança; estado vivo no GitHub |
