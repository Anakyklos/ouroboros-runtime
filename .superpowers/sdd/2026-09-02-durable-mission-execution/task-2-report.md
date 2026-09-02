# Task 2 Report: Durable Mission Execution Contracts and Ports

## Files changed

- `cli/src/mission/contracts.ts`
  - Added `MissionState.PAUSED`; it is not included in `WAITING_STATES` or `TERMINAL_STATES`.
  - Added exported `CapabilityInvocation` extending the source-compatible minimal `CapabilityInvocationRef` projection.
  - Added typed attempt, delivery, idempotency, retry, cancellation, reconciliation, owner-verification, and pause metadata contracts.
  - Reused the #63 `IdempotencyMode`, `RetryBackoff`, `CancellationSupport`, and `ReconciliationSupport` types.
  - Added pure helpers for effect fingerprinting, terminality, uncertain delivery, due checks, safe retry eligibility, terminal update checks, and result merging.
  - Used `planRevisionId`, numeric `contractVersion`, `moduleOwner`, stable `requestId`, string input refs, and `effectFingerprint`.
- `cli/src/mission/ports.ts`
  - Expanded invocation operations to accept legacy `CapabilityInvocationRef` callers and expose full `CapabilityInvocation` reads/results.
  - Added ports for recoverable/non-terminal listing, bounded due listing, and effect-fingerprint lookup. These are optional at this boundary so existing store adapters remain source-compatible until their later implementation task.
- `cli/src/mission/sqlite-mission-store.ts`
  - Made the existing invocation method declarations compatible with the expanded port without adding SQLite schema/migration or behavior from later tasks.
- `cli/src/mission/durable-mission-execution.test.ts`
  - Removed the conflicting local durable shape and consumed exported `CapabilityInvocation` plus #63 enums/types.
  - Preserved the existing semantic assertions and updated only structural field names/types.

## Commands and results

### TDD red check before implementation

```bash
bun test cli/src/mission/durable-mission-execution.test.ts
```

Result: exit code 1, 1 pass and 6 failures. Failures were the expected missing durable SQLite mapping, pause/resume engine behavior, migration defaults, and due-field persistence.

### Runtime typecheck

```bash
bun run check:runtime
```

Result: exit code 0.

### Focused Task 2 test

```bash
bun test cli/src/mission/durable-mission-execution.test.ts
```

Result: exit code 1, 1 pass and 6 failures. The remaining failures are expected downstream Task 3/Task 4 production behavior: full SQLite invocation persistence, pause/resume, legacy-row migration defaults, and due-field persistence. The recursive secret rejection assertion passes.

### Relevant existing Mission tests

```bash
bun test cli/src/mission/mission-engine.test.ts cli/src/mission/sqlite-mission-store.test.ts
```

Result: exit code 0, 56 pass, 0 fail, 285 expect calls.

### Diff hygiene

```bash
git diff --check
```

Result: exit code 0.

## Decisions

- `CapabilityInvocationRef` remains unchanged as the minimal Mission projection. Durable fields are available only on the exported full entity.
- `BLOCKED` is intentionally non-terminal because the existing dispatch seam uses it as a conservative waiting/block state. Only completed and cancelled invocations are immutable terminal records in the pure helper.
- `inputRefs` are sanitized opaque string references, while result refs retain the existing typed sanitized `EvidenceRef` contract.
- `contractVersion` is numeric to align with the #63 `CapabilityDescriptor.contractVersion`.
- The new query methods are optional on `MissionStore` for this contract-only task, preventing an accidental SQLite implementation or migration. The later store implementation can make the adapter fully implement them without introducing another store boundary.

## Concerns and follow-up

- Task 3 must persist/map the full invocation fields and implement the new store queries, including conservative defaults for legacy rows and due ordering/limits.
- Task 4 must implement authoritative pause/resume behavior and persisted pause metadata.
- The focused test is intentionally still red for those downstream behaviors; no assertions were weakened or skipped.
- `.agent/memory/*.md` files were left untracked and were not included in the commit.

## Reviewer fix loop (commit dca8d626)

- `MissionStore.saveInvocation/getInvocation/listInvocations` and the existing
  SQLite adapter now expose the legacy `CapabilityInvocationRef` projection.
  Full `CapabilityInvocation` reads and persistence remain explicitly deferred
  to Task 3; the adapter no longer casts incomplete rows or input values to the
  full entity. Full-invocation inputs are accepted so existing callers can
  submit them without changing the legacy return contract, and are projected
  explicitly on return.
- FAILED is documented as a definitive attempt outcome that can remain
  retryable when retry metadata authorizes an explicit safe transition.
  `COMPLETED` and `CANCELLED` are the only immutable terminal invocation
  statuses. The terminal update and result-merge helpers now enforce that
  boundary, including duplicate terminal results.
- Added `assertValidInvocationIdentity` as a small contract-level structural
  check for non-empty identity strings and opaque `inputRefs: string[]`.
  Existing recursive `assertNoRawSecrets` remains the authoritative durable
  rejection boundary, so identity refs are never silently redacted.

### Fix-loop validation

```bash
bun run check:runtime
```

Result: exit code 0.

The focused durable suite remains intentionally red for downstream Task 3 and
Task 4 behavior (full SQLite mapping, migration defaults, due persistence, and
pause/resume), as documented above. No SQLite migration, scheduler, recovery,
connector seam, or pause/resume implementation was added in this fix loop.
