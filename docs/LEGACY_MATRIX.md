# Matriz de Classificação de Legado (Ouroboros)

> **Status**: Binding — Issue #61 (parent: #60).
> Esta matriz é a referência vinculante para decidir o destino de cada
> subsistema legado do Ouroboros. Decisões: `KEEP`, `ADAPT`, `MOVE/EXTRACT`,
> `RETIRE`, `DEFER`. Presença de código funcional não é motivo suficiente
> para `KEEP`.
>
> **Authority**: #60 (executive coordination), #69 (self-improving !=
> self-modifying), #70 (headless daemon + Mission Control + CLI/Katherine),
> comentários de #61/#62/#70.
>
> **Regra de uso**: nenhum subsistema classificado abaixo pode ganhar nova
> feature antes da sua disposição ser executada, quando diretamente afetado
> pelo realinhamento. Follow-ups são abertos pelo mantenedor após o merge
> desta PR.

---

## Decisões por subsistema

### 1. SelfModifyingEngine

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/runtime/SelfModifyingEngine.ts` (+ `SelfModifyingEngine.test.ts`, `cli/benchmarks/SelfModifyingEngine.bench.ts`) |
| **Current responsibility/evidence** | Engine que altera source files, cria backups, executa testes, faz rollback e opcionalmente cria git commit (`autoGitCommit`). Permite que o agente reescreva seus próprios módulos em runtime. |
| **Decision** | **RETIRE** do runtime core. **MOVE/EXTRACT** somente de primitives realmente reutilizáveis (backup/rollback/test-run) para Cadinho/Runstead, se justificado por eles. |
| **Future owner/boundary** | Cadinho (evolution de capabilities) e Runstead (software work). Ouroboros não possui `modifySelf()` nem authority equivalente. |
| **Rationale** | #60: "sistema que altera/promove silenciosamente o próprio código" está na lista de "Ouroboros não deve ser". #69: proibido preservar `Ouroboros.modifySelf()` com authority de produção. Software work pertence ao Runstead; forging/evolution pertence ao Cadinho com promoção explícita. |
| **Follow-up implication** | Abrir issue de remoção do SelfModifyingEngine do core + avaliação de extração de primitives (backup/rollback) para Cadinho/Runstead. A remoção também pode resolver a quarentena de `SelfModifyingEngine.test.ts` (#41). |

### 2. PersistentPythonREPL

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/runtime/PersistentPythonREPL.ts` (+ `PersistentPythonREPL.test.ts`) |
| **Current responsibility/evidence** | REPL Python persistente que mantém processo vivo e estado de variáveis entre execuções (`spawn → keep alive → execute N vezes`). |
| **Decision** | **RETIRE** do runtime core. |
| **Future owner/boundary** | Nenhum módulo do Anakyklos reivindicou REPL Python arbitrário persistente. Se surgir necessidade legítima de execução Python, será via capability declarada com owner (ex.: Runstead para software work) sob policy. |
| **Rationale** | #60: Ouroboros "não é executor irrestrito de Python/shell". Execução arbitrária persistente não é necessidade executiva do coordination runtime. |
| **Follow-up implication** | Remoção do runtime core; quarentena `PersistentPythonREPL.test.ts` pode ser resolvida após decisão (#41). |

### 3. SandboxRunner

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/runtime/SandboxRunner.ts` (+ `SandboxRunner.test.ts`) |
| **Current responsibility/evidence** | Execução Python sandboxed com resource limits, timeout e filesystem confinement via venv isolado. Testes dependem de `.ouroboros/venv` (quarentena #41). |
| **Decision** | **RETIRE** do runtime core. |
| **Future owner/boundary** | Nenhuma necessidade executiva real permanece no core. Se algum módulo precisar de sandbox, será capability do owner (Runstead para software work), com sua própria verificação técnica. |
| **Rationale** | #60: Python playground não é capacidade central; Ouroboros não é executor irrestrito. A quarentena dos testes de sandbox (#41) já reconhece incompatibilidade com CI limpa. |
| **Follow-up implication** | Remoção do core; resolver quarentenas de sandbox (#41) como consequência da decisão RETIRE. |

### 4. SandboxTool

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/runtime/SandboxTool.ts` |
| **Current responsibility/evidence** | Tool `sandbox` (ITool) que expõe execução de código Python arbitrário no sandbox para agentes. |
| **Decision** | **RETIRE**. |
| **Future owner/boundary** | Mesma boundary do SandboxRunner: execução arbitrária não pertence ao core; capability de software work é do Runstead. |
| **Rationale** | Depende diretamente do SandboxRunner (RETIRE) e representa "executor irrestrito de Python/shell" que #60 proíbe. |
| **Follow-up implication** | Remoção junto com SandboxRunner. |

### 5. Council / personas

| Campo | Valor |
|---|---|
| **Subsystem** | `PersonaType`, `PERSONA_PHASE_MAP`, `ESCALATION_CHAIN` em `cli/src/orchestration/types.ts`; personas no Orchestrator; docs (README/AGENTS) descrevendo Council (Vision/Architect/Guardian/Kinetic); `.agent/skills/` de Council/personas |
| **Current responsibility/evidence** | Orchestrator coordena subagentes com personas fixas, escalation chain entre personas e retries internos. |
| **Decision** | **RETIRE** como arquitetura central. |
| **Future owner/boundary** | Nenhum owner futuro; a semântica de coordenação útil (lifecycle/cancel/validation) migra para Mission/Invocation (#62) e Capability Registry (#63). |
| **Rationale** | #60: "coleção fixa de personas internas como arquitetura do produto" está na lista de "Ouroboros não deve ser". #62: `PersonaType` e `ESCALATION_CHAIN` devem perder papel arquitetural first-class. |
| **Follow-up implication** | Migration map do Orchestrator (#62) remove personas; docs atualizadas nesta PR marcam Council como Legacy. |

### 6. ArchitectClient

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/orchestration/ArchitectClient.ts` |
| **Current responsibility/evidence** | Integração nativa com Gemini Architect via subprocess para design review e spec approval (modelo `flash`/`pro`). Persona fixa de "Architect". |
| **Decision** | **RETIRE** como persona hardcoded. **ADAPT/MOVE/EXTRACT** da capacidade genérica de planner/consultation para planner contract (#62), se reutilizável. |
| **Future owner/boundary** | Ouroboros possui planner capability genérica (advisory); providers/modelos ficam atrás de contracts comuns. A persona fixa "Architect" não permanece. |
| **Rationale** | #60: "ArchitectClient como persona fixa" é trabalho legado a classificar. #63: provider/model específico não define roadmap do core. |
| **Follow-up implication** | Reavaliar como planner provider após #62/#63; não ampliar como persona. |

### 7. WaveExecutor

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/orchestration/WaveExecutor.ts` (+ `WaveExecutor.test.ts`, wave-types) |
| **Current responsibility/evidence** | Executa tasks em waves paralelas respeitando dependências (agrupa por wave, executa com maxConcurrent, aguarda wave completar). |
| **Decision** | **ADAPT** — a semântica de scheduling paralelo com dependências pode se tornar scheduling de capability invocations sem a metáfora "agent wave". |
| **Future owner/boundary** | Ouroboros (scheduler de invocations com dependências), integrado ao durable runtime (#50). Metáfora "wave" e acoplamento a Orchestrator/personas são removidos. |
| **Rationale** | #60: "WaveExecutor semantics" listado para classificação; paralelismo com dependências é útil, mas "waves de agentes" não é direção. |
| **Follow-up implication** | Refatorar para scheduling de capability invocations quando #62/#63 estabilizarem; não adicionar features "wave" antes disso. |

### 8. Anti-Vibe workflow

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/orchestration/AntiVibeWorkflow.test.ts`, `cli/src/utils/anti-vibe.ts`, validators (`SpecValidator`, `TestCoverageValidator`), `ValidationReporter` |
| **Current responsibility/evidence** | Quality gates fail-closed para workflow de código: spec → code → validate → approve → promote. Suite em quarentena (#41) por falhas parciais. |
| **Decision** | **ADAPT/MOVE** — conceitos de fail-closed e evidence podem sobreviver como mission-level gates no Ouroboros. Technical software verification pertence ao Runstead; promotion/capability evolution pertence ao Cadinho. |
| **Future owner/boundary** | Ouroboros: mission acceptance/approval gates. Runstead: verificação técnica de software. Cadinho: promoção/evolução de capabilities. |
| **Rationale** | #61: "Preservar ideias úteis de gates fail-closed e evidência, mas revisão técnica de software deve permanecer no Runstead. Ouroboros pode manter mission acceptance/approval gates." |
| **Follow-up implication** | Extrair mission-level gate semantics; resolver quarentena conforme decisão (#41); não ampliar como código-oriented protocol no core. |

### 9. PromotionManager / code-review gates

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/orchestration/PromotionManager.ts` (+ `PromotionManager.test.ts`, `promotion-types.ts`, `strategies/CommandValidationStrategy.ts`, `QualityGateRegistry.ts`), `ApprovalManager.ts` |
| **Current responsibility/evidence** | Sistema de promoção playground → src com quality gates (test, type-check, lint), aprovação humana e state em `.agent/promotion/`. |
| **Decision** | **ADAPT/MOVE** — approval/promotion state machine pode inspirar mission-level approval; code promotion gates pertencem ao Runstead (verificação técnica) e Cadinho (promotion de capability). |
| **Future owner/boundary** | Ouroboros: approval workflow para missions (approval requests, state). Runstead: quality gates de software. Cadinho: candidate → trial → promotion. |
| **Rationale** | #61/#69: promotion/capability evolution pertence ao Cadinho; Ouroboros mantém mission-level gates e approvals. |
| **Follow-up implication** | Migration de approval/promotion para Mission approval contract (#62); resolver quarentenas (#41). |

### 10. Antigravity bridge

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/bridges/AntigravityBridge.ts` (+ `PersistentAntigravityBridge.ts`) |
| **Current responsibility/evidence** | Bridge direta para Antigravity, usada pelo GatewayOrchestrator. |
| **Decision** | **ADAPT/MOVE** — não permanece como API central do orchestrator; vira connector/capability versionado (#63) ou é retirado se sem owner. |
| **Future owner/boundary** | Capability/connector versionado com owner externo (Antigravity), atrás do Capability Registry e policy. |
| **Rationale** | #60: "GatewayOrchestrator conhece diretamente Antigravity... O alvo é capability discovery + versioned connector contracts." |
| **Follow-up implication** | Migration map do GatewayOrchestrator (#63) remove bridges hardcoded; não ampliar bridge como método público. |

### 11. Gemini bridge

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/bridges/GeminiCliBridge.ts` (+ `GeminiCliBridge` usado no GatewayOrchestrator) |
| **Current responsibility/evidence** | Bridge para Gemini CLI via subprocess (modelos flash/pro). |
| **Decision** | **ADAPT/MOVE** — provider/model específico não define o roadmap do core; vira planner provider atrás de contract comum ou connector versionado. |
| **Future owner/boundary** | Ouroboros: planner provider opcional sob policy/config. Gemini: provider externo atrás de contracts. |
| **Rationale** | #60: "nenhum adapter específico define o roadmap do core; model result é proposta/input, não authority." |
| **Follow-up implication** | Reavaliar como provider do planner (#62) atrás de contracts; não manter como método público do gateway. |

### 12. Jules bridge

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/bridges/JulesBridge.ts` (+ `jules-types.ts`, `test-persistent-bridge.ts`) |
| **Current responsibility/evidence** | Bridge para Jules (implementador assíncrono via Gemini CLI extension). |
| **Decision** | **ADAPT/MOVE** — software work pertence ao Runstead; se Jules for ferramenta de implementação, o uso é via capability/connector versionado, não bridge hardcoded no core. |
| **Future owner/boundary** | Runstead (software work) ou connector versionado; Ouroboros apenas formula objetivo/acceptance e recebe evidence. |
| **Rationale** | #60: "Ouroboros não deve editar repo em paralelo ao Runstead; substituir tool policy/evidence/verifier do Runstead." |
| **Follow-up implication** | Migration para connector/capability após #63; não ampliar bridge. |

### 13. Local inference

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/inference/` (InferenceSubsystem, ModelProvider, ModelRouter, EmbeddingEngine, LocalInferenceProvider, SemanticCache, etc.) |
| **Current responsibility/evidence** | Subsistema de inferência local com 3 modelos especializados, routing, embedding e cache semântico. |
| **Decision** | **ADAPT/DEFER** — planner backend opcional; não é identidade do produto. Pode permanecer como provider opcional sob policy, mas não define roadmap. |
| **Future owner/boundary** | Ouroboros: provider/planner opcional atrás de contracts (#62/#44/#47). |
| **Rationale** | #60: "Ouroboros ainda pode precisar de LLM para planning/interpretation. Portanto #44/#47 continuam úteis. Mas provider não é a identidade do produto." |
| **Follow-up implication** | Manter sob contracts comuns; não expandir como subsystem first-class antes de #62. |

### 14. MemoryManager

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/orchestration/MemoryManager.ts` (+ `MemoryManager.test.ts`) |
| **Current responsibility/evidence** | Memória persistente file-first (Markdown) em `.agent/memory/`, salvando prompt/output de tasks por dia. |
| **Decision** | **ADAPT** — durable Mission state/context references permanecem; generic agent memory (prompt/output logs em Markdown como truth) é retirado. |
| **Future owner/boundary** | Ouroboros: mission state, plan revisions, decisions, evidence/result refs, contexto compilado com provenance (#64). Katherine/LifeOS/Tecer continuam donos dos próprios dados. |
| **Rationale** | #60: "Ouroboros pode e deve persistir missões, planos, checkpoints, decisões, references/evidence, contexto compilado... Mas não deve se tornar fonte universal de conhecimento pessoal." #64: "MemoryManager não permanece como persistent agent memory genérica." |
| **Follow-up implication** | Migration para Context Compiler (#64); prompt/output bruto não é mission truth. |

### 15. MemoryRetriever

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/orchestration/MemoryRetriever.ts` (+ `memory-config.ts`, GeminiEmbeddingClient) |
| **Current responsibility/evidence** | Indexa e recupera contexto de logs passados com hybrid search (vector + keyword, OpenClaw-inspired). |
| **Decision** | **ADAPT** — retrieval sem ownership/provenance não alimenta planner como verdade; passa a servir context compilation com provenance (#64). |
| **Future owner/boundary** | Ouroboros: context retrieval bounded com provenance/freshness/authorization. |
| **Rationale** | #64: "retrieval sem ownership/provenance não deve alimentar planner como verdade." |
| **Follow-up implication** | Migrar para Context Compiler (#64); embeddings não são default. |

### 16. Ralph loop

| Campo | Valor |
|---|---|
| **Subsystem** | `scripts/ralph/` (ralph.sh, prd.json, OPENCODE.md, progress.txt) |
| **Current responsibility/evidence** | Loop autônomo que roda opencode repetidamente até completar itens de PRD. |
| **Decision** | **RETIRE** do runtime/product. **MOVE/EXTRACT** como dev tooling separado, se útil, fora do core. |
| **Future owner/boundary** | Dev tooling (fora do runtime). Software work em loop pertence ao Runstead com verificação própria. |
| **Rationale** | #60: "Ralph autonomous loop" está na auditoria como identidade documental desalinhada; execução autônoma de código em loop contradiz a boundary do Runstead. |
| **Follow-up implication** | Remover do core ou mover para dev-tools; documentar como Legacy até disposição. |

### 17. MCP / SkillLoader

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/orchestration/SkillLoader.ts` (+ `.agent/skills/`, `.agent/skills-lab/`) |
| **Current responsibility/evidence** | Carrega skills Markdown (extraídas de AionUi) como prompts/contextos; MCP como expansão do agente. |
| **Decision** | **DEFER** — capability protocol candidate; não é arquitetura obrigatória. MCP pode futuramente ser transport/adapter para capabilities (#63), atrás dos invariantes do contract. |
| **Future owner/boundary** | Ouroboros: Capability Registry (#63) é o modelo de autoridade; MCP opcional como transporte. Cadinho: evolução de capabilities. |
| **Rationale** | #63: "MCP pode futuramente ser um transport/adapter candidate... mas não é o modelo de autoridade do Ouroboros. Não assumir que todo módulo é MCP server." |
| **Follow-up implication** | Reavaliar após #63; não ampliar MCP/skills como expansão do próprio agente. |

### 18. Council UI

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/tui/components/CouncilPanel.tsx`; `web/src/components/quadrants/the-council.tsx` (Council quadrant no web) |
| **Current responsibility/evidence** | Painéis que exibem debate do Council/quadrantes de personas. |
| **Decision** | **RETIRE** como superfície principal. |
| **Future owner/boundary** | Nenhum; Council/personas não permanecem arquitetura central (#60). UI futura é projection de Mission facts. |
| **Rationale** | #61: "Council/CoT/persona theatre não permanece superfície principal." |
| **Follow-up implication** | Remover/ocultar painéis quando UI for re-trabalhada (#68); não ampliar. |

### 19. Memory UI

| Campo | Valor |
|---|---|
| **Subsystem** | `web/src/components/memory-panel.tsx` |
| **Current responsibility/evidence** | Painel de memória com busca/filtro no web frontend. |
| **Decision** | **ADAPT/DEFER** — re-apresentar como Mission state/context projection após #62/#64; não como "agent memory" universal. |
| **Future owner/boundary** | Ouroboros: projeção de Mission/contexto autorizado (frontend é projection). |
| **Rationale** | #64: context ownership/provenance; UI não é source of truth. |
| **Follow-up implication** | Redesenhar após contracts; não ampliar como memória pessoal. |

### 20. Terminal UI

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/tui/` (React/Ink TUI completa) |
| **Current responsibility/evidence** | TUI Ink/React com tema Emerald, visualization de waves/intent/health. |
| **Decision** | **RETIRE/DEFER** como produto principal — não compete como segunda UI principal. CLI pequena scriptable permanece para recovery/debug (#70). |
| **Future owner/boundary** | Ouroboros: CLI pequena (`ouroboros status/missions/mission show|pause|resume|cancel/capabilities`). |
| **Rationale** | #70: "A TUI completa não deve permanecer como segunda experiência principal competindo com o desktop." |
| **Follow-up implication** | Substituir por CLI pequena; reter somente componentes com valor real para recovery/debug. |

### 21. Electron shell

| Campo | Valor |
|---|---|
| **Subsystem** | Nenhum código Electron encontrado no repositório (busca por `*electron*` vazia fora de node_modules). |
| **Current responsibility/evidence** | Não existe shell Electron no repo. |
| **Decision** | **RETIRE** (como direção) — Electron rejeitado como default arquitetural (#70). Sem código a remover. |
| **Future owner/boundary** | Framework desktop leve decidido após POC/benchmark (#70/#58). |
| **Rationale** | #70: "Electron fica rejeitado como default arquitetural para o app residente." |
| **Follow-up implication** | Nenhum código; assegurar que docs não promovam Electron. |

### 22. Local web server

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/daemon/server.ts` (Fastify + WebSocket, port 7777), `cli/src/daemon/` (rpc-gateway, session-manager) |
| **Current responsibility/evidence** | Daemon expõe JSON-RPC 2.0 sobre Fastify/WebSocket; usada pelo web frontend e tests. |
| **Decision** | **ADAPT/DEFER** — transporte local versionado (#70: IPC local/Unix socket preferido). Fastify/WebSocket mantido para compatibilidade até contracts; HTTP/WebSocket remoto só com caso real. |
| **Future owner/boundary** | Ouroboros: daemon headless (ouroborosd) com contract versionado independente de transporte. |
| **Rationale** | #70: "IPC local em vez de web server como default"; transport não contamina Mission/Capability semantics. |
| **Follow-up implication** | Avaliar IPC local após contracts; manter server existente enquanto web frontend usa. |

### 23. Fastify/WebSocket transport

| Campo | Valor |
|---|---|
| **Subsystem** | `@fastify/websocket` + Fastify em `cli/src/daemon/server.ts` |
| **Current responsibility/evidence** | Transporte WebSocket para projeção de eventos do daemon (daemon-event-contract, daemon-event-stream). |
| **Decision** | **ADAPT/DEFER** — o contract de eventos/projeção permanece útil (#38); o transporte pode mudar para IPC local quando decidido. |
| **Future owner/boundary** | Ouroboros: contract versionado de eventos/projeção; transporte substituível. |
| **Rationale** | #70: IPC local preferido; #38: eventos/reconexão normalizados permanecem válidos. |
| **Follow-up implication** | Manter contract; avaliar transporte após benchmark. |

### 24. React/Ink TUI

| Campo | Valor |
|---|---|
| **Subsystem** | `cli/src/tui/` (entry.tsx, components, store, adapter) |
| **Current responsibility/evidence** | TUI React/Ink com LogViewer, StatusPanel, CouncilPanel, InputBar. |
| **Decision** | **RETIRE/DEFER** — mesma decisão da Terminal UI (#20): não é segunda UI principal. |
| **Future owner/boundary** | Ouroboros: CLI pequena para admin/recovery. |
| **Rationale** | #70: TUI não compete como segunda experiência principal. |
| **Follow-up implication** | Substituir por CLI; componentes com valor real para debug podem ser retidos. |

### 25. Web frontend

| Campo | Valor |
|---|---|
| **Subsystem** | `web/` (Vite/React, pages mission-control/settings/swiss-mission-control, stores, hooks, components) |
| **Current responsibility/evidence** | Frontend web completo com Mission Control, Swiss Mission Control V2, terminal pane, memory panel, Council quadrants, emergency brake, keyboard shortcuts. |
| **Decision** | **ADAPT** — componentes TypeScript/HTML/CSS reutilizáveis; direção é Mission Control desktop leve (system WebView ou outra tech da Technology Palette após POC). Deployment web não é obrigação. |
| **Future owner/boundary** | Ouroboros: Mission Control como projection operacional; frontend é projection, daemon é authority. |
| **Rationale** | #70: "Web UI atual é fonte de componentes, não obrigação de deployment web. Reusable frontend code != requirement for web server or Electron shell." |
| **Follow-up implication** | Reaproveitar componentes em shell leve após contracts/POC (#70/#68); não ampliar como web app principal. |

### 26. Terminal pane

| Campo | Valor |
|---|---|
| **Subsystem** | `web/src/components/terminal/` (terminal.tsx, terminal-grid.tsx, @xterm/*) |
| **Current responsibility/evidence** | Terminal integrado com xterm.js no web frontend. |
| **Decision** | **ADAPT** — útil para diagnóstico/debug; não é superfície central. Semântica futura via capability/connector, não execução arbitrária. |
| **Future owner/boundary** | Ouroboros: diagnóstico secundário e explícito (#70). |
| **Rationale** | #70: diagnóstico secundário; execução arbitrária não é direção (#60). |
| **Follow-up implication** | Manter para debug; reavaliar com Mission Control. |

### 27. Direct daemon/UI coupling

| Campo | Valor |
|---|---|
| **Subsystem** | `web/src/hooks/use-daemon-api.ts`, `use-live-mission-control.ts`, `use-sse-stream.ts`, `use-event-bus.ts`, `web/src/lib/daemon-*` |
| **Current responsibility/evidence** | UI conecta-se diretamente ao daemon (WebSocket/RPC) com hooks e stores locais. |
| **Decision** | **ADAPT** — separar em IPC versionado com contract explícito; UI não recebe authority por estar na mesma máquina (#70 security). |
| **Future owner/boundary** | Ouroboros: contract público versionado; policy/checks permanecem no daemon. |
| **Rationale** | #70: "A UI não recebe authority por estar na mesma máquina"; local/versioned IPC. |
| **Follow-up implication** | Formalizar contract de projeção/controle; não acoplar UI como authority. |

### 28. Duplicated frontend stores/state

| Campo | Valor |
|---|---|
| **Subsystem** | `web/src/stores/` (mission-control-store.ts, settings-store.ts, log-store.ts) + `cli/src/tui/store.ts` |
| **Current responsibility/evidence** | Stores duplicados entre TUI e web frontend; state de UI separado do daemon. |
| **Decision** | **ADAPT** — consolidar após contracts de projeção; stores refletem projection, nunca state autoritativo da Mission. |
| **Future owner/boundary** | Ouroboros: projeção versionada; UI state é cache de exibição. |
| **Rationale** | #61/#70: "duplicated frontend stores/state" classificado; frontend é projection. |
| **Follow-up implication** | Consolidar após #62/#70; não duplicar state machine de Mission na UI. |

---

## Resumo executivo

| Decisão | Subsistemas |
|---|---|
| **RETIRE** | SelfModifyingEngine (do core), PersistentPythonREPL, SandboxRunner, SandboxTool, Council/personas, ArchitectClient (como persona), Ralph loop, Council UI, Electron shell (direção), React/Ink TUI, Terminal UI |
| **ADAPT** | WaveExecutor (scheduling), Anti-Vibe (mission gates), PromotionManager (approval), Antigravity/Gemini/Jules bridges (connectors), local inference (provider opcional), MemoryManager (mission state), MemoryRetriever (context provenance), Memory UI, local web server, Fastify/WebSocket transport, web frontend, terminal pane, direct daemon/UI coupling, duplicated stores |
| **MOVE/EXTRACT** | Primitives de SelfModifyingEngine (backup/rollback) → Cadinho/Runstead; code-review/technical verification → Runstead; promotion/capability evolution → Cadinho |
| **DEFER** | MCP/SkillLoader (capability protocol candidate), local web server/Fastify (até contracts), Electron (POC) |
| **KEEP** | Daemon/headless core (server, rpc-gateway, session-manager, event-bus), SQLite storage, daemon controls, event contract, baseline CI (#35) |

## Follow-ups recomendados (para o mantenedor criar após merge)

1. **#61-followup-1**: Remover SelfModifyingEngine do runtime core; avaliar extração de primitives backup/rollback para Cadinho/Runstead.
2. **#61-followup-2**: Remover PersistentPythonREPL, SandboxRunner, SandboxTool do runtime core; resolver quarentenas #41 relacionadas.
3. **#61-followup-3**: Migration map do Orchestrator (#62) — remover personas/ESCALATION_CHAIN como abstração first-class.
4. **#61-followup-4**: GatewayOrchestrator (#63) — remover bridges hardcoded em favor de Capability Registry/connectors.
5. **#61-followup-5**: MemoryManager/MemoryRetriever → Context Compiler (#64) com provenance.
6. **#61-followup-6**: Ralph loop → mover para dev-tools ou remover.
7. **#61-followup-7**: TUI React/Ink → substituir por CLI pequena (#70); reter componentes de debug.
8. **#61-followup-8**: Web frontend → reaproveitar componentes em Mission Control desktop leve após POC (#70/#68).
9. **#61-followup-9**: Transporte → avaliar IPC local (Unix socket) após contracts (#70).
10. **#61-followup-10**: MCP/SkillLoader → reavaliar como transport candidate após Capability Registry (#63).
