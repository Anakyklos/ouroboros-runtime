# Task 3 Report: SQLite Durable Invocation Persistence

## Files changed

- `cli/src/mission/sqlite-mission-store.ts`
  - Added the full `CapabilityInvocation` SQLite representation in the existing `mission_invocations` table.
  - Added idempotent metadata-driven migrations using `PRAGMA table_info` and `ALTER TABLE ADD COLUMN` only for absent columns.
  - Added `pause_metadata` to `missions` with a safe `{}` default, without implementing pause behavior.
  - Added complete typed row mapping for plan revision, contract version, owner, effect fingerprint, request/input refs, idempotency, retry/backoff/attempt/next eligibility, attempts, delivery/remote handle, cancellation, reconciliation, owner verification, result refs, error, and timestamps.
  - Added deterministic non-terminal, recoverable, due/limited, and effect-fingerprint queries.
  - Added recursive raw-secret rejection, conservative legacy-reference normalization, terminal-state protection, and ref de-duplication.
  - Made repeated `initialize()` calls idempotent for an already-open store.
- `cli/src/mission/ports.ts`
  - Changed `getInvocation` and `listInvocations` to expose complete `CapabilityInvocation` records while retaining `CapabilityInvocationRef` as the Mission projection.
  - Made Task 3 recovery query methods required on the store port.
- `cli/src/mission/sqlite-mission-store.test.ts`
  - Corrected the canonical projection assertion to compare an explicit minimal ref projection.
  - Added deterministic full round-trip, legacy migration/repeated initialize, pause metadata, due ordering/limit, recoverable listing, fingerprint lookup, legacy normalization, duplicate evidence, and completed/cancelled terminal safety tests.
- `cli/src/mission/durable-mission-execution.test.ts`
  - Removed incomplete casts from full invocation reads so the typed full-read contract is exercised directly.

## Schema and migration decisions

- One database boundary and one `mission_invocations` table are used. No dependency, store, or database was added.
- Complex typed invocation fields are persisted as JSON columns; scalar identity/status/timestamp fields remain scalar columns.
- Legacy rows receive deterministic conservative defaults: unknown contract/idempotency metadata, no retry eligibility, empty attempts, uncertain delivery when dispatched, unsupported reconciliation, and no fabricated result/evidence.
- Existing legacy result refs, owner verification, status, and timestamps are preserved. Legacy timestamp defaults use existing row timestamps or a deterministic epoch, never wall-clock time.
- Terminal `completed` and `cancelled` invocations are immutable at the store boundary.
- Mission `invocationRefs` is rebuilt from the canonical table through an explicit minimal projection, while direct invocation reads return the full entity.

## Commands and results

```bash
bun test cli/src/mission/sqlite-mission-store.test.ts
```

Result: **20 pass, 0 fail**.

```bash
bun test cli/src/mission/mission-engine.test.ts cli/src/mission/sqlite-mission-store.test.ts
```

Result: **60 pass, 0 fail**.

```bash
bun run check:runtime
```

Result: **exit code 0**.

```bash
git diff --check
```

Result: **exit code 0**.

The focused durable contract suite was also run:

```bash
bun test cli/src/mission/durable-mission-execution.test.ts
```

Result: **6 pass, 1 fail**. The sole failure is the pre-existing `pauseMission`/`resumeMission` engine behavior, which belongs to Task 4 and was intentionally not changed under the Task 3 scope restriction. All Task 3 storage assertions in that file pass, including full round-trip, delivery/attempt persistence, migration defaults, recursive secret rejection, and restart eligibility preservation.

## Limitations and follow-ups

- Mission pause/resume transitions remain unimplemented here by design. Task 4 owns that behavior.
- Scheduler behavior, connector reconciliation/cancellation, Context Compiler, UI, and legacy subsystems were not modified.
- Migration preserves unknown legacy rows conservatively and does not infer delivery success or invent evidence.
