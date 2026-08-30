# Ouroboros Constitution

> Governa todo trabalho executado neste repositório via Spec Kit.
> Versão: 1.0.0 | Ratificado: 2026-08-30 | Última emenda: 2026-08-30

## Core Principles

### I. Ouroboros é executive runtime / sistema nervoso do Anakyklos
Trabalho neste repositório deve preservar a direção de #60: Ouroboros coordena
missions e capabilities; planning/LLM é advisory; código/policy autoriza effects.

Fluxo autoritativo:

```text
Intent source → MissionIntent → Ouroboros creates/persists Mission
→ Planner proposal → Deterministic policy → Capability Registry
→ Capability Invocation → Module Owner → evidence + verification
→ mission verification
```

`MissionIntent != Mission`. A Mission autoritativa nasce dentro do Ouroboros.

### II. Ouroboros não é o que o legado dizia
Proibido apresentar como direção vigente: self-modifying runtime, Council/personas
como arquitetura central, executor irrestrito de Python/shell, banco universal de
memória, dono de databases/invariants de outros módulos, chatbot concorrente da
Katherine, coding agent concorrente do Runstead, capability factory do Cadinho.

### III. Self-improving != self-modifying
Self-improving Anakyklos permanece válido (ciclo governado #69: observar →
adaptação bounded OU CapabilityGap → Cadinho trial → Runstead implementation →
verification → promoção explícita → Capability Registry).
Self-edit/promoção silenciosa pelo Ouroboros é proibida.

### IV. Documentação distingue Current / Direction / Legacy / Hypothesis
Nunca apresentar Direction ou Hypothesis como já implementado. Conteúdo legado
só pode permanecer em seções claramente marcadas `Legacy` ou histórico.

### V. Forma do produto (topologia #70)
Daemon/headless runtime é autoridade. Mission Control desktop é interface
principal. CLI pequena para admin/recovery. Katherine é interface humana opcional.
Electron não é default arquitetural. TUI completa não compete como segunda UI
principal. `Create Mission in Mission Control: On | Off` controla somente a
superfície de entrada de MissionIntent; não cria duas máquinas de Mission.

## Scope & Governance

- Esta PR implementa somente #61: source of truth + matriz de classificação de
  legado. Proibido scope creep: não implementar #62/#63/#64/#69/#70/#58, não
  remover código em massa, não adicionar dependências/frameworks, não fazer
  refactor oportunista.
- Classificações da matriz usam exatamente: KEEP, ADAPT, MOVE/EXTRACT, RETIRE,
  DEFER. Presença de código funcional não é motivo suficiente para KEEP.
- Mudança de código só é aceitável se estritamente necessária para impedir
  documentação/configuração de declarar como vigente algo já classificado, e
  deve ser mínima e justificada.
- Não abrir issues por conta própria; follow-ups são registrados na matriz/PR
  para o mantenedor criar após merge.
- Baseline obrigatório: `bun install --frozen-lockfile` (root + web),
  `bun run check`, `git diff --check`. Proibido skip/todo/only/`|| true`/
  `continue-on-error`/remoção de testes/assertions enfraquecidas.

## Verification

- Cada classificação exige: Subsystem, Current responsibility/evidence,
  Decision, Future owner/boundary, Rationale, Follow-up implication.
- Buscas finais por conceitos obsoletos como direção vigente
  (self-modifying, Council, persona, waves, Ralph, Electron) devem passar;
  ocorrências só em seções `Legacy`/histórico.
- Working tree final contém somente mudanças da #61.
