# Implementation Plan: Source of truth realignment + legacy classification

**Branch**: `issue-61-source-of-truth-legacy-matrix` | **Date**: 2026-08-30 | **Spec**: [spec.md](./spec.md)

**Input**: Issue #61 — [P0][REALIGN] Corrigir source of truth e classificar subsistemas legados

## Summary

Realinhar a documentação autoritativa do repositório (`README.md`, `AGENTS.md`,
docs de arquitetura/status relacionados) com a direção #60 (Ouroboros como
executive runtime / sistema nervoso do Anakyklos), distinguindo
Current / Direction / Legacy / Hypothesis, e produzir uma matriz vinculante de
classificação de legado (KEEP / ADAPT / MOVE/EXTRACT / RETIRE / DEFER) para os
subsistemas listados na #61, respeitando as decisões vinculantes de #69
(self-improving != self-modifying) e #70 (daemon headless + Mission Control +
CLI/Katherine).

**Natureza**: issue primordialmente de source-of-truth e classificação.
Nenhuma remoção/refactor de subsistemas nesta PR. Mudança de código só se
estritamente necessária para impedir que documentação/configuração declare como
vigente algo formalmente classificado — e deve ser mínima e justificada.

## Technical Context

**Language/Version**: TypeScript (ES2022/NodeNext) + Bun 1.3.9 + React 18 (TUI root) / React 19 (web) — sem alterações nesta PR.

**Primary Dependencies**: nenhuma nova dependency/framework será adicionada.

**Storage**: SQLite via better-sqlite3 (daemon state); MemoryManager file-first Markdown (.agent/memory) — classificado, não alterado.

**Testing**: baseline #35 — `bun run check` (check:install, check:runtime, check:web, check:tests). Sem alteração de testes.

**Target Platform**: Linux dev machine; CI ubuntu-latest (Bun 1.3.9).

**Project Type**: executive runtime (TypeScript/Bun) + web frontend (Vite/React) + daemon Fastify/WebSocket.

**Performance Goals**: N/A para esta issue (documentação/classificação).

**Constraints**:
- Escopo restrito à #61 (proibido implementar #62/#63/#64/#69/#70/#58).
- Proibido: remoção massiva, novas dependências, refactor oportunista, testes
  alterados para obter verde, `skip`/`todo`/`only`/`|| true`/continue-on-error.
- Ocorrências de conceitos obsoletos só podem continuar em seções `Legacy`/histórico.
- Working tree final contém somente mudanças da #61.
- Anakyklos/architecture acessado via GitHub autenticado (privado) e reconciliado:
  README.md, SYSTEM-MAP.md, VISION.md, policies/resource-efficiency.md,
  policies/module-autonomy.md, RFC 0001, languages/ (Technology Palette).

**Scale/Scope**: ~28 subsistemas a classificar; ~6+ arquivos de doc a atualizar/criar.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] I. Ouroboros é executive runtime — documentos devem refletir o fluxo
  Intent → MissionIntent → Mission → Planner proposal → Deterministic policy →
  Capability Registry → Invocation → Module Owner → evidence → mission verification.
- [x] II. Ouroboros não é o que o legado dizia — self-modifying/Council/personas/
  Python irrestrito/memória universal não podem ser apresentados como direção.
- [x] III. Self-improving != self-modifying — #69 preservado, sem `modifySelf()`.
- [x] IV. Current/Direction/Legacy/Hypothesis distinguíveis; nunca apresentar
  Direction como implementada.
- [x] V. Topologia #70 — daemon autoridade; Mission Control projection; CLI
  admin/recovery; Katherine opcional; Electron não-default; TUI não segunda UI.
- [x] Scope & Governance — somente #61; matriz com 5 decisões; mudança de código
  mínima; follow-ups registrados para o mantenedor.
- [x] Verification — baseline obrigatório e buscas finais por conceitos obsoletos.

## Project Structure

### Documentation (this feature)

```text
specs/061-source-of-truth-legacy-matrix/
├── spec.md          # Feature spec (/speckit.specify)
├── plan.md          # Este arquivo (/speckit.plan)
├── tasks.md         # Task list (/speckit.tasks)
└── checklists/      # Quality checklists
```

### Documentation (product, repository root)

```text
README.md                       # REESCREVER: identidade executive runtime, fluxo
                                # autoritativo, Current/Direction/Legacy/Hypothesis,
                                # MissionIntent != Mission, self-improving !=
                                # self-modifying, topologia #70, `Create Mission
                                # in Mission Control: On | Off`.
AGENTS.md                       # REESCREVER: direcionar executores para #60;
                                # preservar comandos operacionais do baseline;
                                # marcar seções legadas como Legacy.
docs/ARCHITECTURE.md            # CRIAR (ou equivalente): documento de arquitetura
                                # com Current/Direction/Legacy/Hypothesis e a
                                # matriz de classificação vinculante (ou link).
docs/LEGACY_MATRIX.md           # CRIAR: matriz vinculante de legado (tabela com
                                # Subsystem/Current/Decision/Owner/Rationale/
                                # Follow-up).
DESIGN.md                       # MARCAR Legacy (design system do TUI legado).
SPEC_OUROBOROS_ENV.md           # MARCAR Legacy (sandbox Python legado).
CONDUCTOR_JULES_INTEGRATION.md  # MARCAR Legacy (orquestração Conductor/Jules).
UI_UX_IMPROVEMENT_REPORT.md     # MARCAR Legacy (relatório UI legada).
WEB_FRONTEND_PLAN.md            # MARCAR Legacy (plano frontend legado).
.agent/rules.md                 # REESCREVER/MARCAR: regras legadas de
                                # autonomia/Council; alinhar com #60.
docs/DEPLOYMENT.md              # REVISAR: somente se descrever identidade legada.
docs/LOCAL_INFERENCE.md         # REVISAR: classificar local inference na matriz;
                                # marcar como legacy/experimental se necessário.
docs/MODEL_PROVIDER_CONTRACT.md # REVISAR: contract de provider permanece útil
                                # (#44/#47), mas provider não é identidade.
```

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Nenhuma    | —          | —                                    |

## Phases

### Phase 0: Outline & Research (complete)

Leitura concluída: #60, #61 (comentários), #62 (comentários), #63, #64, #69,
#70 (comentários), README.md, AGENTS.md, docs/, conductor/, .agent/rules.md,
código-fonte dos subsistemas a classificar (SelfModifyingEngine, SandboxRunner,
SandboxTool, PersistentPythonREPL, Orchestrator, GatewayOrchestrator,
WaveExecutor, MemoryManager, MemoryRetriever, PromotionManager,
AntiVibeWorkflow, ArchitectClient, bridges, inference, daemon, tui, web),
scripts/ralph/, .agent/skills/, Spec Kit probe e templates.

### Phase 1: Design (documentation architecture)

1. **docs/ARCHITECTURE.md** (novo): identidade, fluxo autoritativo
   (#60), o que Ouroboros é / não é, Current (comportamento comprovado hoje),
   Direction (executive coordination), Legacy (código que não define mais
   direção), Hypothesis (Go/Zig/Rust, desktop framework), MissionIntent !=
   Mission, self-improving != self-modifying, topologia #70, `Create Mission
   in Mission Control: On | Off`, referências de provenance.
2. **docs/LEGACY_MATRIX.md** (novo): matriz com colunas obrigatórias e todas as
   linhas obrigatórias da #61 + UI/transport/state rows da #70.
3. **README.md**: reescrita com identidade alinhada, seções Current/Direction/
   Legacy/Hypothesis, quickstart do baseline, links para docs.
4. **AGENTS.md**: reescrita preservando comandos operacionais corretos
   (baseline #35) e direcionando para #60/docs; seções legadas marcadas.
5. **Docs legados**: adicionar header `> **Status: Legacy**` (com classificação
   da matriz) em DESIGN.md, SPEC_OUROBOROS_ENV.md, CONDUCTOR_JULES_INTEGRATION.md,
   UI_UX_IMPROVEMENT_REPORT.md, WEB_FRONTEND_PLAN.md, .agent/rules.md.
6. **Revisão de docs**: docs/BASELINE.md (manter), docs/MODEL_PROVIDER_CONTRACT.md
   (revisar identidade), docs/LOCAL_INFERENCE.md (marcar conforme matriz).

### Phase 2: Validation (baseline)

1. `bun install --frozen-lockfile` (root) e `cd web && bun install
   --frozen-lockfile && cd ..`.
2. `bun run check` (4 estágios).
3. `git diff --check`.
4. Buscas finais por conceitos obsoletos como direção vigente.
5. Restaurar `web/tsconfig.tsbuildinfo` ao estado HEAD (artefato regenerado
   pelo check:web; não commitar).

## Delivery

- Commits pequenos e coerentes (spec kit setup; docs/ARCHITECTURE + matriz;
  README; AGENTS; marcação de docs legados; validação).
- Uma única PR contra `main`, vinculada à #61, com `Closes #61`, resumo da
  source of truth, localização da matriz, decisões KEEP/ADAPT/MOVE/RETIRE/
  DEFER principais, arquivos alterados, Spec Kit artifacts/workflow, skills
  utilizadas, validação executada, resultados e follow-ups recomendados.
- Após abrir a PR, parar. Não iniciar #62 nem outra issue.
