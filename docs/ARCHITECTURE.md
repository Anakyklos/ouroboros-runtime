# Ouroboros Architecture

> **Status**: Current (Direction) — Esta documentação reflete a direção arquitetural
> do Ouroboros conforme a epic #60. Conteúdo que descreve comportamento já
> implementado está em *Current*. Conteúdo que descreve onde o produto está
> indo está em *Direction*. Código existente que não representa mais a direção
> está em *Legacy*. Decisões dependentes de POC/benchmark estão em *Hypothesis*.

---

## Identity

Ouroboros é o **executive runtime / sistema nervoso do Anakyklos**.

**O que Ouroboros faz:**
- Preserva intent original, constraints e acceptance
- Cria e mantém Missions (entidades duráveis)
- Compila contexto mínimo autorizado
- Propõe e decompõe trabalho (via Planner)
- Descobre capabilities disponíveis (via Capability Registry)
- Aplica policy determinística para autorizar effects
- Coordena module owners (Runstead, LifeOS, Tecer, device modules, etc.)
- Mantém execução durável e checkpoints
- Coleta evidence e resultados
- Faz mission-level verification (não substitui verificação técnica do owner)

**O que Ouroboros NÃO é:**
- **Não** é coding agent concorrente do Runstead
- **Não** é capability factory / autônoma concorrente do Cadinho
- **Não** é self-modifying runtime (não altera/promove silenciosamente o próprio código)
- **Não** é arquitetura de Council/personas (não coleção fixa de personas internas)
- **Não** é executor irrestrito de Python/shell
- **Não** é banco universal de memória/personal data
- **Não** é dono das invariantes/internals de LifeOS, Tecer, device modules
- **Não** é chatbot concorrente da Katherine
- **Não** substitui verificação técnica do módulo executor (Runstead)

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
evidence acceptance, recovery/idempotency.

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

**Níveis de adaptação:**
1. **Adaptação operacional bounded** (automática se autorizada): ranking
   entre capabilities já aprovadas, seleção entre providers/modelos já
   autorizados, context selection/budget, caching/batching, scheduling,
   retry timing. Não amplia permissions, não adiciona capability.
2. **Melhoria de configuração/policy** (proposta ou auto-promoção sob
   policy explícita): thresholds, defaults, ranking rules, budget policy,
   preferred provider profile.
3. **Evolução de capability/código** (nunca self-modification direta):
   nova capability, novo connector, novo algoritmo, novo módulo. Fluxo
   obrigatório: Ouroboros detecta gap → Cadinho candidate → Runstead
   implementation → verification → promoção explícita.

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
6. **TUI completa não compete como segunda UI principal.** Direção:
   RETIRE/DEFER como produto principal; preservar CLI pequena.
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

A direção arquitetural, conforme #60, #62, #63, #64, #69, #70:

- **Mission** como entidade durável first-class (#62)
- **Capability Registry** + connector versionado (#63)
- **Context Compiler** com provenance e ownership externo (#64)
- **Planning agentic** advisory; **policy determinística** autoritativa
- **Lifecycle de Mission**: created, planning, waiting_for_context,
  waiting_for_approval, ready, executing, waiting_for_capability,
  waiting_for_provider, waiting_for_budget, verifying, completed, blocked,
  failed_terminal, cancelled
- **Mission-level verification** separada de domain/technical verification
- **Self-improving** governado (#69): Ouroboros observa → adaptação bounded
  OR CapabilityGap → Cadinho trial → Runstead implementation → verification
  → promoção explícita
- **Execução durável** (#50/#59): supervisão, recovery, reconciliation
- **Contexto compilado** sob orçamento, com provenance, sem universal memory
- **Headless daemon** (ouroborosd) como autoridade
- **Mission Control desktop** leve como interface principal
- **IPC local** (Unix socket) como transporte default
- **CLI pequena** para admin/recovery
- **Katherine** como interface opcional via contract público
- **Capability discovery** substitui bridges hardcoded no orchestrator
- **Runstead** boundary explícita: software work pertence ao Runstead
- **Cadinho** boundary: capability-gap evolution explícita
- **Domain modules** (LifeOS, Tecer, devices) mantêm state ownership

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

- **Go como runtime core** (#58): avaliar Go para ouroborosd após semântica
  estabilizada (Mission, Capability, Context contracts). Não migrar primeiro
  e depois descobrir o que o core deveria fazer.
- **Zig/Rust para boundaries especializadas**: reservar para boundaries de
  segurança/performance quando justificado.
- **Framework desktop**: Tauri, Wails, pywebview, WebKitGTK, system WebView
  — decidir após contracts estabilizados e POC de IPC local.
- **IPC protocol**: Unix domain socket vs outros — decidir após benchmark
  com Mission/Capability contracts.
- **WebView vs HTML/CSS/JS local**: reaproveitar componentes web existentes
  em shell leve, ou reescrever em framework nativo — POC pendente.
- **Service lifecycle**: systemd user service, crash recovery, upgrade
  semantics — avaliar após definição do runtime.

---

## Proveniência

> **Nota**: O repositório `Anakyklos/architecture` (README.md, SYSTEM-MAP.md)
> não está acessível publicamente (HTTP 404). A direção arquitetural registrada
> neste documento foi derivada das issues #60, #69, #70, seus comentários, e
> das referências ao SYSTEM-MAP citadas nessas issues. Quando o repositório
> de arquitetura estiver acessível, este documento deve ser reconciliado com
> ele como fonte primária.

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