# Task 4 Report: Durable Mission Execution Transitions

## Escopo entregue

Implementado exclusivamente o fix do Task 4 a partir de `c36f490`:

- `cli/src/mission/contracts.ts`
  - Matriz explícita de transições monotônicas para invocations.
  - Estados terminais permanecem imutáveis; retry é a única saída explícita de `FAILED`.
- `cli/src/mission/mission-engine.ts`
  - Pré-handoff persiste a invocation como `PENDING`, com attempt preparado e delivery `not_submitted`.
  - Handoff explícito promove para `DISPATCHED` ou `RUNNING`; facts incertos exigem reconciliação.
  - Preparação de retry explícita, idempotente, sem dispatch automático, preservando request/effect/capability/revision/idempotency identity.
  - Resultados regressivos são rejeitados e resultados tardios após cancellation preservam status da invocation e da Mission, incorporando facts/evidence de forma idempotente.
  - Fingerprint é calculado e consultado no escopo da Mission, com validação de shape, identities opacas e sanitização apenas de texto livre.
- `cli/src/mission/ports.ts`
  - Port mínimo para claim atômico e busca de fingerprint por `(missionId, effectFingerprint)`.
- `cli/src/mission/sqlite-mission-store.ts`
  - Índice único `(mission_id, effect_fingerprint)` e claim insert-only.
  - Transações serializadas por store para evitar race local entre claims concorrentes.
  - Invocations legadas recebem defaults conservadores e ficam incertas, nunca replayáveis automaticamente.
  - Migração falha fechada diante de fingerprints duplicados, sem apagar efeitos.
  - Invocations inicialmente preparadas são excluídas das consultas automáticas de recovery/due até handoff ou retry explícito.
- Testes determinísticos:
  - `cli/src/mission/mission-engine.test.ts`
  - `cli/src/mission/sqlite-mission-store.test.ts`

## Comportamento e limites

- `MissionIntent` continua distinto de `Mission`; nenhuma alteração foi feita no fluxo de connector, scheduler ou Context Compiler.
- Não foi implementada integração efetiva com `dispatch-seam.ts`. A API de handoff/reconciliação permanece no motor para o seam do Task 5.
- Não foram tocados UI, legado, connector, scheduler, Context Compiler ou `.agent/memory`.
- Os arquivos `.agent/memory/2026-08-31.md`, `2026-09-01.md` e `2026-09-02.md` já estavam untracked e foram excluídos do commit.

## Validação final

```bash
bun test cli/src/mission/mission-engine.test.ts cli/src/mission/durable-mission-execution.test.ts cli/src/mission/sqlite-mission-store.test.ts
```

Resultado: **85 pass, 0 fail, 427 expect() calls**.

```bash
bun run check:runtime
git diff --check
```

Resultado: **ambos com exit code 0** após a atualização deste relatório.

## Commit

Será criado um único commit escopado contendo somente os arquivos do Task 4 listados acima e este relatório.
