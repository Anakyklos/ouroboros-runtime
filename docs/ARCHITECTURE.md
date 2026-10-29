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
   `ouroboros invocations`, `ouroboros invocation show`,
   `ouroboros diagnostics` e `ouroboros capabilities`. Fala com o mesmo
   daemon/contracts.
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
  esse adapter continua legado e não é parte do caminho default. O entrypoint
  atual exige credencial local ativa, aplica autenticação e scopes por operação,
  e é iniciado pela CLI factual; seu bind é loopback.
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

- **Critérios restantes do local control plane** (#70, M1). A composição
  headless, RPC autenticado em loopback e CLI factual já são Current; a epic
  continua aberta para completar e validar a boundary local/versionada e os
  demais critérios M1. Isso não declara #70 concluída;
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
  este documento não seleciona a próxima child. As issues #97 e #98 estão
  concluídas e integradas à `main` pelas PRs [#107](https://github.com/Anakyklos/ouroboros-runtime/pull/107)
  e [#108](https://github.com/Anakyklos/ouroboros-runtime/pull/108),
  respectivamente.
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

### M1 Local Control Plane — Exit-gate reconciliation (issue #160)

**Status: M1 NÃO concluído.** Esta seção reconcilia individualmente os critérios
originais de #70 (12 itens) e #59 (9 itens) com código, testes e evidência
executada. Ela não altera o texto normativo das issues, não promove direção
M2/M3 a CURRENT e não declara M1 concluído. Base auditada: `origin/main`
`75fdf5a0bf1a2acf45bbf1b17d12ad4f2dab3efd`; árvore da branch reconciliada:
`aa2a15a85aa44fc59eb742b4c17fd41816b2e1cd` (as alterações documentais desta PR
vêm depois desse SHA e não alteram código de runtime).

#### Vocabulário de classificação

- `PASS`: o critério possui comportamento e evidência verificável na árvore auditada.
- `PARTIAL`: parte do comportamento existe; o requisito completo não está atendido.
- `BLOCKED`: dependência ou restrição comprovada impede conclusão segura.
- `NOT_CURRENT`: requisito de fase posterior, decisão não implementada ou direção futura.
- `UNPROVEN`: evidência insuficiente para determinar implementação ou comportamento.

`PASS` abaixo sempre aponta para um teste executado ou para uma verificação
estrutural explícita. Presença de arquivo de teste, checkbox de issue ou CI de
outro SHA não é tratada como prova.

#### Evidência executada

Todas as execuções direcionadas abaixo ocorreram na árvore `aa2a15a` (mesmo
código de `75fdf5a` mais o commit documental anterior). O gate completo foi
executado com o Bun local **1.4.2** e também com o Bun fixado no CI **1.3.9**,
obtido efemeramente via `npm exec --yes --package=bun@1.3.9 -- bun ...` sem
alterar `package.json` ou lockfiles.

| ID | Comando | Runtime | Resultado |
|---|---|---|---|
| E1 | `bun test cli/src/daemon/headless-composition.test.ts cli/src/daemon/main-lifecycle.test.ts cli/src/daemon/shutdown-coordinator.test.ts cli/src/daemon/daemon-shutdown-race.test.ts` | Bun 1.4.2 | 17 pass, 0 fail, 87 expect, 4 files |
| E2 | `bun test cli/src/daemon/mission-scheduler-driver.test.ts cli/src/mission/mission-scheduler.test.ts cli/src/mission/sqlite-mission-store.test.ts` | Bun 1.4.2 | 70 pass, 0 fail, 576 expect, 3 files |
| E3 | `bun test cli/src/daemon/headless-shutdown.e2e.test.ts` | Bun 1.4.2 | 2 pass, 0 fail, 18 expect, 1 file |
| E4 | `bun test cli/src/daemon/mission-scheduler-daemon.e2e.test.ts` | Bun 1.4.2 | 7 pass, 0 fail, 82 expect, 1 file |
| E5 | `bun test cli/src/daemon/local-control-auth.test.ts cli/src/daemon/local-control-auth.e2e.test.ts` | Bun 1.4.2 | 30 pass, 0 fail, 275 expect, 2 files |
| E6 | `bun test cli/src/daemon/rpc-admission.test.ts cli/src/daemon/rpc-admission.e2e.test.ts` | Bun 1.4.2 | 5 pass, 0 fail, 35 expect, 2 files |
| E7 | `bun test cli/src/commands/admin-cli.test.ts cli/src/commands/admin-cli.e2e.test.ts cli/src/commands/local-control-command-client.test.ts` | Bun 1.4.2 | 62 pass, 0 fail, 238 expect, 3 files |
| E8 | `bun test cli/src/daemon/daemon-projection.test.ts cli/src/daemon/durable-projection.test.ts` | Bun 1.4.2 | 21 pass, 0 fail, 190 expect, 2 files |
| E9 | `bun test cli/src/context/context-compiler.test.ts cli/src/context/progressive-context.test.ts cli/src/context/planner.test.ts` | Bun 1.4.2 | 89 pass, 0 fail, 469 expect, 3 files |
| E10 | `bun test cli/src/mission/mission-engine.test.ts cli/src/mission/policy.test.ts cli/src/mission/durable-mission-execution.test.ts` | Bun 1.4.2 | 93 pass, 0 fail, 359 expect, 3 files |
| E11 | `bun test cli/src/capabilities/dispatch-seam.test.ts cli/src/capabilities/capabilities.test.ts cli/src/capabilities/integration.test.ts` | Bun 1.4.2 | 95 pass, 0 fail, 386 expect, 3 files |
| E12 | `bun test cli/src/daemon/local-control-uds.test.ts cli/src/daemon/local-control-command.test.ts cli/src/daemon/local-control-read.test.ts cli/src/daemon/rpc-gateway-lifecycle.test.ts` | Bun 1.4.2 | 45 pass, 0 fail, 196 expect, 4 files |
| E13 | `bun run check` | Bun 1.4.2 | 83 mandatory files, 0 failed, 0 quarantined; tree unchanged |
| E14 | `npm exec --yes --package=bun@1.3.9 -- bun test` com os 7 arquivos não-E2E de E1/E2 | Bun 1.3.9 | 87 pass, 0 fail, 667 expect |
| E15 | `npm exec --yes --package=bun@1.3.9 -- bun test` com os 11 arquivos E2E/auth/CLI/projeção de E3–E8 | Bun 1.3.9 | 127 pass, 0 fail, 838 expect |
| E16 | `npm exec --yes --package=bun@1.3.9 -- bun run check` | Bun 1.3.9 | 83 mandatory files, 0 failed, 0 quarantined; tree unchanged |
| E17 | `python3 -m unittest discover -s scripts -p 'test_headless_lifecycle_baseline.py' -v` | Python 3.12.3 | 17 tests OK |
| E18 | `python3 scripts/headless-lifecycle-baseline.py --repetitions 1 --idle-seconds 5 --transport-seconds 3 --output /tmp/opencode/headless-baseline-current.json` | Bun 1.4.2 | completed; 1 processo; RSS 62.988→62.596 KiB; CPU 0,2%; 24 threads; wakeups indisponíveis; cold start 0,180 s; SIGTERM 0,032 s exit 0 |
| E19 | `grep -RIn electron package.json web/package.json bun.lock web/bun.lock`; `grep -RIn 'from "ink"' cli scripts bin web/src` | shell | nenhum runtime/entrypoint Electron ou Ink; apenas `electron-to-chromium` como metadado transitivo de browserslist no lockfile web |

Limites da evidência:

- Nenhum suite direcionado reportou `skip`, `todo` ou `only`; o gate obrigatório
  reportou **0 quarentenas**.
- E3–E7 usam Fastify/WebSocket/SQLite reais, mas **nenhum connector de produção**.
  E4 injeta connectors tipados de teste via `configureCapabilitiesForTests`; isso
  prova composição e idempotência, não integração externa real.
- E18 é uma amostra única de 5 s no host atual, não o artefato de cinco
  repetições de #105. O host nega tracepoints de `sched_wakeup`; contagem de
  wakeups não é afirmada.
- E1–E19 foram executados antes da edição documental. Como a mudança é
  docs-only, o comportamento de runtime não muda; ainda assim, o CI do HEAD
  exato da PR é a prova autoritativa e fica registrado na PR, não nesta tabela.
- O Bun local (1.4.2) difere do pin de CI (1.3.9). Ambos foram exercitados;
  nenhuma conclusão abaixo depende exclusivamente da versão local.

#### #70 — critérios de aceite individuais

| # | Critério original | Classificação | Owner | Comportamento atual | Implementação | Teste | Evidência | Dependência/blocker | Limitação residual |
|---|---|---|---|---|---|---|---|---|---|
| #70.1 | [M1] runtime headless é source of truth | PASS | Daemon lifecycle owner (composition root) | `startHeadlessDaemon()` compõe storage, MissionStore, auth local, registry, engine, seam, scheduler e server; a composição default não importa o gateway/agente legado | `cli/src/daemon/main.ts` (`startHeadlessDaemon`); `cli/src/daemon/server.ts` | `headless-composition.test.ts`, `main-lifecycle.test.ts` | E1, E14, E13/E16 | #98 (done), #70 | A superfície legada `agent.*` só existe se o gateway for composto explicitamente; não é autoridade default |
| #70.2 | [M2] fechar desktop não cancela Missions | NOT_CURRENT | Interface futura (M2) + daemon lifecycle | Não existe desktop. Para as interfaces atuais, desconectar CLI/WS não cancela Mission durável; o cenário “fechar desktop” não é testável | `cli/src/daemon/server.ts`; `cli/src/daemon/durable-projection.ts`; UI futura em #68 | `local-control-auth.e2e.test.ts`, `daemon-projection.test.ts` | E5, E8 | #68/M2 | Comportamento de desktop permanece UNPROVEN até M2; evidência CLI/WS não substitui teste de desktop |
| #70.3 | [M2/M3] desktop/CLI/Katherine são projections/interfaces distintas | NOT_CURRENT | Interface futura + boundary cross-project | CLI é projeção fina sobre o contrato local; desktop e Katherine não existem | `cli/src/commands/admin-cli.ts`; `cli/src/commands/local-control-client.ts`; `shared/local-control-read-contract.ts` | `admin-cli.test.ts`, `admin-cli.e2e.test.ts`, `local-control-command-client.test.ts` | E7 | #68 (M2), #65 (Katherine, deferred) | Só a projeção CLI existe; a distinção entre as três interfaces não é verificável hoje |
| #70.4 | [M2] Mission Control é interface principal própria do Ouroboros | NOT_CURRENT | Interface futura (M2) | Não existe Mission Control desktop; o web frontend legado não é a interface M2 | Nenhuma implementação CURRENT; #68/M2 | Nenhum teste aplicável | Nenhuma | #68/M2 | Requisito de fase posterior; não contar o frontend web legado como cumprimento |
| #70.5 | [M1] CLI mínima permanece disponível para recovery/automation | PASS | Local-control boundary + CLI projection | `status`, `missions`, `mission show/pause/resume/cancel`, `invocations`, `invocation show`, `diagnostics`, `capabilities`, `auth provision/rotate/revoke`; CLI usa RPC do daemon, sem scheduler/store paralelo | `cli/src/commands/admin-cli.ts` (`runAdminCli`); `cli/src/commands/local-control-client.ts`; `bin/ouroboros.js` | `admin-cli.test.ts`, `admin-cli.e2e.test.ts`, `local-control-command-client.test.ts` | E7, E15 | #99/#103 (done) | Operações limitadas ao contrato e aos scopes de auth; não há autoridade offline |
| #70.6 | [M1/direção] web server não é requisito para IPC local | PARTIAL | Local-control boundary / transporte | Produção ainda usa Fastify HTTP/JSON-RPC + WebSocket em loopback; existe adaptador UDS read-only com paridade v1, não ligado à produção | `shared/local-control-read-contract.ts` (contrato transport-neutral); `cli/src/daemon/local-control-uds.ts` (experimental) | `local-control-uds.test.ts` | E12 | #100 (spike HYBRID); migração de transporte não aprovada | Comandos e eventos WS ainda exigem loopback; UDS não é transporte de produção |
| #70.7 | [M1/M2] Electron não é default arquitetural | PASS | Interface futura / decisão arquitetural | Nenhuma dependência ou entrypoint Electron; daemon headless e CLI são os entrypoints atuais | `package.json`, `web/package.json`, `bin/ouroboros.js`; decisão em `docs/ARCHITECTURE.md` | Verificação estrutural de manifestos (sem teste de runtime) | E19 | #68 (escolha futura de framework) | `electron-to-chromium` aparece como metadado transitivo de browserslist no lockfile web, não como runtime Electron; ausência atual não vincula a escolha M2 |
| #70.8 | [M1] TUI não compete como segunda UI principal | PASS | Interface futura / CLI | Entrypoint React/Ink removido em #104; scripts do pacote expõem daemon e CLI, sem TUI principal | `package.json` (scripts); `bin/ouroboros.js`; remoção #104 | `admin-cli.test.ts`; verificação estrutural de dependências | E7, E19 | #104 (done) | Frontend web legado continua no repositório, mas não é segunda TUI principal; componentes podem ser reutilizados em M2 |
| #70.9 | [M1] local IPC possui contract versionado e security model | PASS | Local-control boundary | Contratos v1 de leitura/comando em `shared/`; auth com hash-only, scopes, Origin, revoke/rotate e startup fail-closed | `shared/local-control-read-contract.ts`, `shared/local-control-command-contract.ts`, `shared/local-control-auth-contract.ts`; `cli/src/daemon/local-control-auth.ts` | `local-control-auth.test.ts`, `local-control-auth.e2e.test.ts`, `local-control-read.test.ts` | E5, E12, E15 | #97/#100/#142 (done) | Contrato versionado, mas transporte atual é loopback HTTP/WS (ver #70.6); UDS experimental não tem peer credentials além do mesmo UID |
| #70.10 | [M1] UI não contém policy/mission state autoritativo | PASS | Local-control boundary + interface futura | CLI apenas transporta leituras/comandos tipados; policy, estado de Mission, registry e scheduler permanecem no daemon; não há store/scheduler no CLI | `cli/src/commands/admin-cli.ts`; `cli/src/commands/local-control-client.ts`; `cli/src/daemon/local-control-command.ts` | `admin-cli.test.ts`, `admin-cli.e2e.test.ts`, `local-control-command.test.ts` | E7, E12 | #68/M2 para o desktop | Cobre as interfaces atuais (CLI/RPC); a UI desktop não existe e o invariante deve ser re-verificado em M2 |
| #70.11 | [M1] idle behavior e resource budget são medidos | PASS | Daemon lifecycle owner / ops baseline | Baseline headless documenta 5 amostras: ~60 MB RSS, 0,1–0,2% de CPU, 18–20 threads, startup ~161 ms e shutdown gracioso ~7,4 ms; nova amostra em E18 mantém ~62,6 MB, 0,2% CPU, 24 threads | `scripts/headless-lifecycle-baseline.py`; `docs/evidence/headless-lifecycle-baseline-2026-10-07.md` | `scripts/test_headless_lifecycle_baseline.py`; E18 | E17, E18 | #105 (done) | Medição histórica em `1d84744`/Bun 1.4.2 e amostra única atual; sem contagem de wakeups (permissão negada); não é benchmark de carga nem garantia global de RSS |
| #70.12 | [M2] framework desktop só é escolhido após benchmark/POC e contracts estáveis | NOT_CURRENT | Interface futura (M2) | Nenhum framework desktop foi escolhido; decisão explicitamente adiada | Nenhuma implementação CURRENT | Nenhum teste aplicável | Nenhuma | #68/M2; fatos M1 | Decisão aberta; não declarar Tauri/Wails/WebKit como escolha |

#### #59 — critérios de aceite individuais

| # | Critério original | Classificação | Owner | Comportamento atual | Implementação | Teste | Evidência | Dependência/blocker | Limitação residual |
|---|---|---|---|---|---|---|---|---|---|
| #59.1 | [M1] existe mapa explícito de supervisors/workers/failure domains | PASS | Ouroboros lifecycle / failure-domain owner | `docs/FAILURE_DOMAINS.md` inventaria 7 domínios, lifecycle owners, classes de persistência e gaps P1/P2 | `docs/FAILURE_DOMAINS.md` | Nenhum teste aplicável ao documento; comportamento sustentado pelos testes citados no mapa | E1, E2, E8 | #101/PR #115 (done) | É inventário CURRENT, não implementação de supervisor; gaps P2 permanecem |
| #59.2 | [M1] lifecycle ownership é conhecido | PASS | Daemon lifecycle owner | Composition root, shutdown coordinator, scheduler driver, projeção e stores têm owner explícito no mapa e no código | `cli/src/daemon/main.ts`; `cli/src/daemon/shutdown-coordinator.ts`; `cli/src/daemon/mission-scheduler-driver.ts`; `cli/src/daemon/daemon-projection.ts` | `main-lifecycle.test.ts`, `shutdown-coordinator.test.ts`, `mission-scheduler-driver.test.ts` | E1, E2, E14 | #101/#117/#120 (done) | Ownership documentado para a composição atual; não implica supervisor genérico |
| #59.3 | [direção] restart policies são tipadas e testadas | NOT_CURRENT | Supervisão futura (#59 Fase B) | Não existe restart policy/restart manager tipado para workers; elegibilidade de retry de Invocation é semântica distinta e não substitui restart policy | Nenhuma implementação CURRENT | Nenhum teste de restart policy | Nenhuma | #59 Fase B; contrato de supervisor não aprovado | Direção apenas; não inferir de retry de Invocation |
| #59.4 | [direção] existe crash-loop protection | NOT_CURRENT | Supervisão futura | Não existe crash-loop protection de supervisor; #152 limita starvation de retry de Invocation, o que não é crash-loop de worker | Nenhuma implementação de supervisor; orçamento de retry em `cli/src/mission/mission-engine.ts`/`policy.ts` | `mission-engine.test.ts`, `policy.test.ts` (retry de Invocation, não crash-loop) | E10 | #59 Fase B | Direção apenas; não declarar #152 como crash-loop protection |
| #59.5 | [M1] recovery usa estado persistido, não memória perdida do worker | PASS | MissionStore / MissionScheduler | Reopen SQLite; recovery percorre páginas duráveis de scheduling; efeito confirmado não é re-invocado; entrega incerta permanece bloqueada | `cli/src/mission/sqlite-mission-store.ts` (`listMissionSchedulingPage`, `getMissionSchedulingRecord`, `recordMissionRecovery`); `cli/src/mission/mission-scheduler.ts` (`recoverInternal`); `cli/src/daemon/mission-scheduler-driver.ts` | `sqlite-mission-store.test.ts`, `mission-scheduler.test.ts`, `mission-scheduler-daemon.e2e.test.ts`, `headless-shutdown.e2e.test.ts` | E2, E3, E4, E14, E15 | #50/#120/#128 (done) | Notificação é same-store, sem lease cross-process; nenhum connector de produção |
| #59.6 | [M1] falhas independentes ficam isoladas | PARTIAL | Daemon lifecycle + projeção + MissionScheduler | Falha de cliente de projeção é isolada; falha de pass do scheduler não derruba o daemon; incerteza de connector não sobrescreve estado irmão; não há supervisor genérico de failure domains | `cli/src/daemon/daemon-projection.ts`; `cli/src/daemon/server.ts`; `cli/src/daemon/mission-scheduler-driver.ts`; `cli/src/capabilities/dispatch-seam.ts` | `daemon-projection.test.ts`, `local-control-auth.e2e.test.ts`, `mission-scheduler-daemon.e2e.test.ts`, `dispatch-seam.test.ts` | E8, E5, E4, E11 | #59 (parcial), #131 | Isolamento é por seam existente, não supervisor genérico; falha de pass sem wake permanece (#131) |
| #59.7 | [M1] estados de espera continuam estados normais | PASS | Mission core / MissionStore | `waiting_for_*` são estados duráveis; scheduler só reconsidera `waiting_for_capability`; approval/context/provider/budget não são promovidos automaticamente; shutdown não terminaliza | `cli/src/mission/mission-engine.ts`; `cli/src/mission/mission-scheduler.ts`; `cli/src/mission/sqlite-mission-store.ts` | `mission-engine.test.ts`, `mission-scheduler.test.ts`, `durable-mission-execution.test.ts`, `headless-shutdown.e2e.test.ts` | E10, E2, E3 | #50/#102 (done) | Promoção automática de waits de provider/budget não existe por design |
| #59.8 | [M1] nenhuma nova VM/runtime é necessária | PASS | Runtime baseline | Runtime atual é Bun/TypeScript + SQLite; nenhuma VM/runtime adicional foi introduzida | `package.json` (`packageManager: bun@1.3.9`, `engines`); `.github/workflows/ci.yml` | `bun run check` em 1.4.2 e 1.3.9 | E13, E16 | Nenhuma | #58 (Go) continua research-gated; este PASS vale para “não exigir nova VM hoje”, não para decidir linguagem |
| #59.9 | [M1] custo em idle permanece compatível com hardware modesto | PASS | Daemon lifecycle owner / ops baseline | Amostra atual: 1 processo, ~62,6 MB RSS, 0,2% de um CPU lógico, 24 threads em 5 s ociosos; baseline histórico de 5 amostras em ~60 MB e 0,1–0,2% | `scripts/headless-lifecycle-baseline.py`; `docs/evidence/headless-lifecycle-baseline-2026-10-07.md` | `scripts/test_headless_lifecycle_baseline.py`; E18 | E17, E18 | #105 (done) | Amostra única atual + baseline histórico; sem wakeups medidos; específico do host e sem claim de carga |

#### Separação M1 / M2 / M3 / decisões não implementadas

- **M1 — Local Control Plane (CURRENT, parcial):** daemon headless,
  persistência/recovery, auth local, CLI administrativa, scheduler residente,
  shutdown coordenado, projeção/eventos, boundary versionada e failure domains
  aplicáveis. É o escopo das tabelas acima.
- **M2 — Mission Control (NOT_CURRENT):** interface desktop, `Needs You`,
  navegação/experiência operacional, escolha de framework e controles
  específicos de UI. Depende de #68 e dos fatos M1; não é cumprido pelo
  frontend web legado.
- **M3 — Cross-project (NOT_CURRENT):** Runstead, Katherine, Cadinho e
  contratos de integrações externas. Ownership permanece com os módulos
  externos; Ouroboros não absorve lifecycle, verificação técnica ou estado
  privado deles.
- **Decisões ainda não implementadas:** Unix domain socket como transporte de
  produção; migração de linguagem (#58); supervisor genérico/actor system;
  user-level systemd service; políticas de restart. Recomendação arquitetural
  não é comportamento CURRENT.

#### Revisão do domínio de supervisão candidato (#59)

#59 registra `DaemonProjection` como possível primeiro domínio de supervisão.
A revisão de código e testes encontrou mecanismos já implementados e
verificados:

- limite agregado de clientes (`DEFAULT_MAX_PROJECTION_CLIENTS = 64`,
  configurável) e reserva de slot antes do upgrade/snapshot;
- limite de operações de snapshot não resolvidas;
- timeout de handshake de snapshot (5 s default) com timer one-shot;
- cliente desconectado/abortado libera a reserva correta;
- falha de envio fecha somente o cliente afetado;
- backpressure por cliente (1 MiB e 32 eventos pendentes por default);
- isolamento entre clientes e entre projeção e RPC;
- encerramento coordenado cancela handshake e termina sockets no shutdown.

Testes: `daemon-projection.test.ts`, `durable-projection.test.ts`,
`local-control-auth.e2e.test.ts`, `rpc-admission.e2e.test.ts`,
`headless-shutdown.e2e.test.ts` (E8, E5, E6, E3, E15). Não foi reproduzido
defeito material nem requisito operacional não atendido nesse domínio.

**Decisão: `NO_ACTION — no supervisor implementation justified`.** Não criar
supervisor, actor system, restart manager ou testes especulativos apenas para
satisfazer a direção conceitual de #59.

#### #131 / #132 — bloqueio de segurança preservado

- **#131 permanece OPEN/BLOCKED.** Uma falha genérica de `runOnce()` no
  `MissionSchedulerDriver` emite diagnóstico sanitizado e **não** agenda wake
  automático (`cli/src/daemon/mission-scheduler-driver.ts`, `drain`). Um novo
  pass pode ocorrer apenas após mutação durável relevante ou restart.
- O problema é de **liveness/resumption**: trabalho elegível pode permanecer sem
  novo pass. Não há prova de perda ou duplicação de efeito.
- **#132 fechou `not_planned` como pré-requisito negativo:** não existe produtor
  de produção confiável de `safe_to_retry` no nível do pass. Um pass pode já ter
  mutado estado durável ou cruzado handoff de connector (cancel/reconcile/invoke)
  antes de uma rejeição posterior. A mensagem de erro não prova ausência de
  efeito.
- Por isso **não** é autorizado: retry automático de `runOnce()`, novo timer de
  recuperação, inferência de segurança a partir de `Error.message`, novos tipos
  de erro sem produtor confiável, mudança de idempotência ou replay de efeito
  confirmado/incerto.
- **Próximo leaf executável: `NO_EXECUTABLE_LEAF`.** Nenhuma implementação
  independente e comprovadamente segura foi identificada nesta reconciliação.
  Uma eventual proposta futura exige evidência nova e decisão de contrato pelo
  mantenedor; não é aberta por esta PR.

#### Estado de saída de M1

Contagem dos 21 critérios mapeados:

| Estado | #70 | #59 | Total |
|---|---:|---:|---:|
| PASS | 7 | 6 | 13 |
| PARTIAL | 1 | 1 | 2 |
| BLOCKED | 0 | 0 | 0 |
| NOT_CURRENT | 4 | 2 | 6 |
| UNPROVEN | 0 | 0 | 0 |

Nenhum critério de aceite está `BLOCKED` de forma direta, mas M1 **não** está
saudável para exit: #131 permanece uma limitação P1 de liveness/resumption sob
#59.6, e os critérios M2/M3 continuam `NOT_CURRENT`. O gap de scheduler não
converte nenhum critério em PASS e não autoriza retry.

**M1 exit: NÃO declarado concluído.** Próximo slice: `NO_EXECUTABLE_LEAF`.
