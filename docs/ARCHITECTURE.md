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

## Current (comportamento comprovado hoje)

O que o repositório implementa e testa atualmente:

- **Daemon server** com RPC gateway (JSON-RPC 2.0 sobre Fastify + WebSocket)
- **SessionManager** com lifecycle de sessões
- **EventBus** para comunicação cross-module
- **GatewayOrchestrator** integrando bridges (Antigravity, Gemini, Jules,
  inference, Architect, MemoryRetriever, WaveExecutor)
- **WaveExecutor** para paralelização de tasks
- **Orchestrator** com personas, escalation chain, loopUntilSuccess,
  Anti-Vibe phases
- **MemoryManager** / **MemoryRetriever** (Markdown file-first em .agent/memory)
- **SQLite storage** (better-sqlite3, WAL mode, prepared statements)
- **TUI React/Ink** com tema Emerald
- **Web frontend** Vite/React (Mission Control, Swiss, settings, terminal pane,
  memory panel, Council quadrants)
- **SelfModifyingEngine** com mutations, backup, rollback, git commit
- **SandboxRunner** / **SandboxTool** / **PersistentPythonREPL** (Python
  sandboxed execution)
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

A direção arquitetural, conforme `Anakyklos/architecture` (README.md,
SYSTEM-MAP.md, RFC 0001, VISION.md, policies) + issues #60, #62, #63, #64,
#69, #70:

- **Mission** como entidade durável first-class (#62)
- **Capability Registry** + connector versionado (#63)
- **Context Compiler** com provenance e ownership externo (#64)
- **Planning agentic** advisory; **policy determinística** autoritativa
- **Mission-level verification** separada de domain/technical verification
  (SYSTEM-MAP.md: "No higher layer may erase a lower layer's safety or
  correctness checks")
- **Self-improving** governado (#69): Ouroboros observa → adaptação bounded
  OR CapabilityGap → Cadinho trial → Runstead implementation → verification
  → promoção explícita
- **Execução durável** (#50/#59): supervisão, recovery, reconciliation
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

---

## Legacy (código existente que não define mais direção)

Código e documentação que preservam a identidade histórica de "self-modifying
multi-agent runtime" e não representam a direção futura. A classificação
vinculante de cada subsistema está em [LEGACY_MATRIX.md](LEGACY_MATRIX.md).

**Exemplos de conceitos legados:**
- Self-modifying engine (SelfModifyingEngine, modifySelf())
- Python sandbox como capacidade central (SandboxRunner, SandboxTool,
  PersistentPythonREPL)
- Council/personas como arquitetura central (Vision, Architect, Guardian,
  Kinetic)
- Fixed persona ArchitectClient
- Agentic "waves" como metáfora central de paralelismo
- Anti-Vibe Protocol como gate de promoção de código
- Ralph loop autônomo
- MCP/skills como expansão do próprio agente
- Electron como shell desktop
- TUI React/Ink como segunda interface principal
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
| #60 | [P0][EPIC][REALIGN] Reorientar Ouroboros para executive coordination | Direction |
| #61 | [P0][REALIGN] Corrigir source of truth e classificar subsistemas legados | Esta PR |
| #62 | [P0][ARCH] Definir Mission como entidade durável | Blocked by #61 |
| #63 | [P0][ARCH] Definir Capability Registry e connector contract | Blocked by #62 |
| #64 | [P0][ARCH] Definir Context Compiler com provenance | Blocked by #62/#63 |
| #69 | [P1][ARCH] Self-improving Anakyklos sem self-modifying Ouroboros | Direction |
| #70 | [P1][ARCH][APP] Ouroboros como daemon headless + Mission Control + CLI | Direction |
| #35 | Baseline reproduzível e CI | Current |
| #41 | Resolver quarentenas após classificação do legado | Blocked by #61 |
| #50 | Execução durável de missões e capability invocations | Current/Direction |
| #58 | Avaliar Go como runtime core | Hypothesis |