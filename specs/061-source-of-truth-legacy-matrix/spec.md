# Feature Specification: Source of truth realignment + legacy classification

**Feature Branch**: `issue-61-source-of-truth-legacy-matrix`
**Created**: 2026-08-30
**Status**: Draft
**Input**: Issue #61 — [P0][REALIGN] Corrigir source of truth e classificar subsistemas legados

> **Scope guard**: This feature implements ONLY issue #61 (parent: #60).
> It does NOT implement #62 (Mission contract), #63 (Capability Registry),
> #64 (Context Compiler), #69 (self-improving), #70 (app topology), or #58
> (Go migration). It does not remove legacy code in bulk.

## User Scenarios & Testing

### User Story 1 - Executor de agente (IA) recebe direção inequívoca (Priority: P1)

Um executor de agente (humano ou IA) que abre o repositório deve entender, em
minutos, o papel real do Ouroboros (executive runtime / sistema nervoso do
Anakyklos), sem ser induzido a ampliar conceitos legados (self-modification,
Council/personas, Python sandbox como capacidade central, waves, Ralph,
Electron) como se fossem direção atual.

**Why this priority**: Sem source of truth corrigida, qualquer trabalho futuro
(#62-#64, #70, novas capabilities) parte de premissas conflitantes. É o primeiro
leaf executável da epic #60.

**Independent Test**: Um leitor novo consegue responder, apenas com
README.md + AGENTS.md + docs de arquitetura:
1. O que o Ouroboros é hoje (Current) versus o que está sendo desenhado (Direction)?
2. `MissionIntent != Mission` está correto?
3. Self-improving != self-modifying está explícito?
4. Qual é a topologia do produto (daemon headless + Mission Control + CLI/Katherine)?

**Acceptance Scenarios**:

1. **Given** README.md atualizado, **When** um executor lê a identidade do produto,
   **Then** ele encontra executive coordination como direção, e nenhuma descrição de
   self-modifying/Council/personas/waves/Ralph/Electron como identidade vigente.
2. **Given** AGENTS.md atualizado, **When** um executor procura instruções de
   arquitetura, **Then** ele é direcionado para a arquitetura #60 e para as seções
   Current/Direction/Legacy/Hypothesis, sem instrução de ampliar self-modification
   ou Council por default.
3. **Given** os docs de arquitetura, **When** um executor verifica o status de um
   subsistema legado, **Then** ele encontra a classificação vinculante
   (KEEP/ADAPT/MOVE/EXTRACT/RETIRE/DEFER) com owner/boundary e justificativa.

### User Story 2 - Mantenedor toma decisões de legado com matriz vinculante (Priority: P1)

O mantenedor deve conseguir decidir, por subsistema legado, o destino
(KEEP/ADAPT/MOVE/EXTRACT/RETIRE/DEFER), com evidência do comportamento atual,
future owner/boundary, justificativa e follow-up implication.

**Why this priority**: A matriz é o produto central da #61; sem ela, follow-ups
de remoção/adaptação (#41, #68, etc.) não podem ser abertos com critério.

**Independent Test**: Para cada subsistema obrigatório listado na issue #61,
existe uma linha na matriz com os seis campos obrigatórios, e nenhuma feature
classificada RETIRE/MOVE permanece descrita como estado ideal em docs vigentes.

**Acceptance Scenarios**:

1. **Given** a matriz de legado, **When** um mantenedor consulta `SelfModifyingEngine`,
   **Then** a decisão é RETIRE do runtime core (ou MOVE/EXTRACT de primitives
   justificadas), sem preservar `modifySelf()`/authority equivalente.
2. **Given** a matriz de legado, **When** um mantenedor consulta Council/personas,
   **Then** a decisão registra que não permanecem arquitetura central.
3. **Given** a matriz de legado, **When** um mantenedor consulta bridges diretas
   (Antigravity/Gemini/Jules), **Then** a decisão registra que não definem mais a
   API central do orchestrator; direção é capability/connector versionado.
4. **Given** a matriz de legado, **When** um mantenedor consulta MemoryManager/
   MemoryRetriever, **Then** a decisão distingue durable Mission state/context
   refs (permanece) de generic agent memory (não é responsabilidade do Ouroboros).
5. **Given** a matriz de legado, **When** um mantenedor consulta UI (Council/Memory/
   Terminal UI, web frontend, TUI), **Then** a decisão registra que frontend é
   projection e daemon/state durável é autoridade.

### User Story 3 - Regressão zero no baseline (Priority: P1)

O realinhamento não pode quebrar o baseline reproduzível (#35): instalação
frozen, compilação runtime, build web e testes obrigatórios continuam passando.

**Why this priority**: Documentação não pode degradar o contrato de engenharia já
estabelecido; `bun run check` é o gate de integridade.

**Independent Test**: `bun install --frozen-lockfile` (root + web),
`bun run check` e `git diff --check` passam na branch, sem usar
skip/todo/only/`|| true`/continue-on-error/remoção de testes.

**Acceptance Scenarios**:

1. **Given** a branch da #61, **When** executa `bun run check`,
   **Then** todos os quatro estágios passam (install integrity, runtime tsc,
   web build, mandatory tests).
2. **Given** a branch da #61, **When** executa `git diff --check`,
   **Then** não há whitespace errors.
3. **Given** a branch da #61, **When** inspeciona o working tree,
   **Then** contém somente mudanças da #61 (docs/config de source of truth;
   sem remoção massiva, sem novas dependências).

### Edge Cases

- Documento legado que contém conceitos obsoletos misturados com instruções
  operacionais válidas (ex.: AGENTS.md com comandos de baseline corretos):
  preservar a parte operacional, reclassificar a parte de identidade.
- Anakyklos/architecture acessado via GitHub autenticado (privado): README.md,
  SYSTEM-MAP.md, VISION.md, policies/resource-efficiency.md,
  policies/module-autonomy.md, RFC 0001, languages/ (Technology Palette).
  Registrar provenance explícita e reconciliar docs com essas fontes.
- Subsystem com nuance real (ex.: WaveExecutor com lógica de scheduling
  reaproveitável, Anti-Vibe com conceitos fail-closed reaproveitáveis):
  não forçar classificação simplista; justificar com evidência de código.
- `web/tsconfig.tsbuildinfo` é rastreado e regenerado por `tsc -b` ao rodar o
  baseline; restaurar ao estado HEAD antes de commitar (não commitar artefato
  regenerado).

## Requirements

### Functional Requirements

- **FR-001**: README.md MUST descrever Ouroboros como executive runtime /
  sistema nervoso do Anakyklos (Direction) e parar de descrever
  self-modifying/Council/personas como identidade vigente.
- **FR-002**: README.md MUST distinguir Current / Direction / Legacy /
  Hypothesis, sem apresentar feature futura como implementada.
- **FR-003**: README.md MUST afirmar `MissionIntent != Mission` (Mission
  autoritativa nasce no Ouroboros; Katherine/Mission Control/CLI/API fornecem
  MissionIntent).
- **FR-004**: README.md MUST afirmar self-improving (Anakyklos governado, #69)
  != self-modifying (Ouroboros) e proibir `modifySelf()`/promoção silenciosa.
- **FR-005**: README.md MUST refletir a topologia #70: daemon/headless runtime
  autoridade; Mission Control desktop interface principal; CLI pequena para
  admin/recovery; Katherine interface humana opcional; Electron não-default;
  TUI não compete como segunda UI principal.
- **FR-006**: AGENTS.md MUST direcionar futuros executores para a arquitetura
  #60 e para as seções Current/Direction/Legacy/Hypothesis, e NÃO instruir a
  ampliar self-modification/Council por default.
- **FR-007**: AGENTS.md MUST preservar as instruções operacionais corretas do
  baseline (#35): `bun run check`, frozen installs, quarantine manifest.
- **FR-008**: Documentação arquitetural/status diretamente relacionada
  (ex.: DESIGN.md, SPEC_OUROBOROS_ENV.md, CONDUCTOR_JULES_INTEGRATION.md,
  .agent/rules.md, docs legados) MUST ser marcada como Legacy quando descrever
  conceitos formalmente classificados, sem apagá-la.
- **FR-009**: Uma matriz vinculante de legado MUST ser criada (docs ou
  equivalente versionado) cobrindo todos os subsistemas obrigatórios da #61,
  com colunas: Subsystem, Current responsibility/evidence, Decision
  (KEEP/ADAPT/MOVE/EXTRACT/RETIRE/DEFER), Future owner/boundary, Rationale,
  Follow-up implication.
- **FR-010**: A matriz MUST classificar pelo menos: SelfModifyingEngine,
  PersistentPythonREPL, SandboxRunner, SandboxTool, Council/personas,
  ArchitectClient, WaveExecutor, Anti-Vibe workflow, PromotionManager/code-review
  gates, Antigravity bridge, Gemini bridge, Jules bridge, local inference,
  MemoryManager, MemoryRetriever, Ralph loop, MCP/SkillLoader, Council UI,
  Memory UI, Terminal UI, Electron shell (se existir), local web server,
  Fastify/WebSocket transport, React/Ink TUI, web frontend, terminal pane,
  direct daemon/UI coupling, duplicated frontend stores/state.
- **FR-011**: Decisões vinculantes da #61/#69/#70 MUST ser respeitadas:
  SelfModifyingEngine → RETIRE (nunca KEEP AS CORE; extração de primitives
  registrada em Future owner/boundary); Council/personas
  → não arquitetura central; Anti-Vibe → conceitos fail-closed podem sobreviver,
  verificação técnica de software → Runstead, promotion/capability evolution →
  Cadinho, mission-level gates → Ouroboros; Memory → durable Mission state
  permanece, generic agent memory não; direct bridges → não definem API central;
  UI → frontend é projection, daemon é autoridade.
- **FR-012**: Nenhuma mudança de código é permitida exceto mínima e
  estritamente necessária para impedir documentação/configuração de declarar
  como vigente algo formalmente classificado.
- **FR-013**: Nenhuma nova dependency/framework MUST ser adicionada.
- **FR-014**: Nenhuma remoção massiva de código MUST ocorrer nesta PR.
- **FR-015**: Baseline MUST passar: `bun install --frozen-lockfile` (root+web),
  `bun run check`, `git diff --check`.
- **FR-016**: Buscas finais por conceitos obsoletos como direção vigente
  (self-modifying, Council, agents that write their own code, persona,
  persistent agent memory, Ralph, waves, thought process, Electron) MUST
  mostrar ocorrências apenas em seções `Legacy`/histórico.

### Key Entities

- **MissionIntent**: entrada de intenção fornecida por interface autorizada
  (Katherine, Mission Control, CLI, API). Não é a Mission.
- **Mission**: entidade durável criada e persistida dentro do Ouroboros a
  partir de MissionIntent (contrato formal em #62; referenciada aqui como
  direção, não implementada).
- **Capability Registry**: direção de descoberta de capabilities (#63);
  referenciada, não implementada.
- **Classificação de legado**: registro vinculante por subsistema com
  Decision/owner/boundary/rationale/follow-up.

## Success Criteria

### Measurable Outcomes

- **SC-001**: 100% dos subsistemas obrigatórios da #61 possuem linha na matriz
  com os seis campos obrigatórios.
- **SC-002**: 0 ocorrências de self-modifying/Council/personas/waves/Ralph/
  Electron como identidade/direção vigente fora de seções Legacy/histórico
  (verificação por busca textual ao final).
- **SC-003**: `bun run check` termina com exit 0 na branch (4 estágios).
- **SC-004**: `git diff --check` termina sem saída (exit 0).
- **SC-005**: Working tree final contém somente mudanças da #61
  (git status não mostra arquivos fora do escopo).
- **SC-006**: Uma única PR aberta contra main, vinculada à #61, com descrição
  contendo `Closes #61`, resumo da source of truth, localização da matriz,
  decisões principais, arquivos alterados, Spec Kit artifacts/workflow,
  skills utilizadas, validação e follow-ups recomendados.

## Assumptions

- `Anakyklos/architecture` (README.md/SYSTEM-MAP.md/VISION.md/policies/
  RFC 0001/languages/) acessado via GitHub autenticado (repositório privado);
  a direção autoritativa é reconciliada com essas fontes primárias e com
  #60/#69/#70, conforme hierarquia de autoridade: para comportamento/current
  reality, `code + tests + observation > documentação`; para
  direção/boundaries, `Anakyklos/architecture + decisões aprovadas >
  documentação legada do produto`; Current ≠ Direction ≠ Legacy ≠ Hypothesis.
- Issue #60/#61/#69/#70 e seus comentários são decisões vinculantes; a
  matriz não reabre decisões já tomadas (ex.: Electron rejeitado como default,
  SelfModifyingEngine RETIRE).
- A estrutura atual do repositório (root package + web/ package, Bun 1.3.9,
  baseline #35) permanece válida e não será alterada por esta PR.
- A documentação será escrita em português/inglês conforme o estilo atual do
  repositório (README histórico em inglês com seções em PT; docs mistos);
  priorizar clareza sobre consistência de idioma.
- Spec Kit foi utilizado como workflow para executar a #61; apenas os
  artefatos específicos da issue (spec.md, plan.md, tasks.md em
  specs/061-source-of-truth-legacy-matrix/) são versionados. O scaffold
  genérico (.specify/, .jcode/speckit/commands/, constitution.md) foi
  removido da PR — adoção permanente de Spec Kit/JCode tooling deve ser
  decidida separadamente se houver necessidade demonstrada.
- A source of truth do repositório permanece: Anakyklos/architecture
  (fonte primária), decisões aprovadas/issues arquiteturais, README.md /
  AGENTS.md / docs apropriados, e código + testes para comportamento atual.
