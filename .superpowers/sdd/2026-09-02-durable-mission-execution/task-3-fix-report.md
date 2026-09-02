# Task 3 Fix Report: SQLite Durable Invocation Persistence

## Findings fixed

- Legacy invocation rows with an empty or NULL `effect_fingerprint` are migrated to the deterministic persisted value `legacy:<invocation_id>`. The value survives close/reopen and exact fingerprint lookup resolves the original row without collapsing legacy rows together.
- `MissionStore.listNonTerminalInvocations` and `listRecoverableInvocations` now require a caller-provided positive safe-integer limit. SQLite applies `LIMIT ?` with deterministic `created_at ASC, invocation_id ASC` ordering. Invalid or non-positive limits return no rows.

## Tests added/updated

- Extended the legacy migration test to assert the SQL-persisted fingerprint after restart and exact fingerprint lookup.
- Updated recovery query coverage to assert caller limits, deterministic ordering, terminal exclusion, and invalid-limit behavior.

## Validation

```text
bun test cli/src/mission/sqlite-mission-store.test.ts cli/src/mission/mission-engine.test.ts
60 pass, 0 fail

bun run check:runtime
exit code 0

git diff --check
exit code 0
```

Only the scoped Mission port/store/test changes and this report were committed. `.agent/memory` files, Task 4+, seam, and scheduler were not modified.
