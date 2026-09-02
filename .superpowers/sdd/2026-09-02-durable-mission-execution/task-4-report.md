# Task 4 Report: Durable Mission Execution Transitions

## Files changed

- `cli/src/mission/mission-engine.ts`
  - Persists a complete `CapabilityInvocation` before any handoff seam, including plan revision, descriptor metadata, stable request/effect/correlation identity, prepared attempt, and `not_submitted` delivery.
  - Adds idempotent result/evidence recording with immutable terminal completed/cancelled invocations and sovereign negative owner verification.
  - Preserves explicit `FAILED` attempt results without implicitly retrying or dispatching.
  - Adds persisted pause/resume transitions distinct from cancellation and waiting, explicit waiting-to-ready restoration, conservative cancellation handling, and small handoff/reconciliation state transitions.
  - Applies raw-secret rejection and string sanitization at every persisted engine boundary.
- `cli/src/mission/mission-engine.test.ts`
  - Added deterministic FakeClock/fake-store coverage for prepared invocation persistence, idempotency, owner verification, pause/resume, cancellation, descriptor validation, revision fingerprint reuse, waiting restoration, and explicit failed attempts.
- `.superpowers/sdd/2026-09-02-durable-mission-execution/task-4-report.md`
  - Recorded scope, validation, and limitations.

## Behavior delivered

- `dispatchStep` creates the durable invocation and mission transition atomically before any external handoff.
- Duplicate terminal results and evidence are no-ops. Completed effects from earlier plan revisions prevent a second invocation for the same effect fingerprint.
- Negative owner verification remains authoritative even when a planner/result claims success. Failed attempts remain explicit and retain retry metadata without scheduler behavior.
- Pausing does not cancel active work, survives restart through persisted mission state, and resuming restores the prior non-terminal state without dispatching.
- Cancellation marks unsubmitted work cancelled locally and requests cancellation conservatively for active or uncertain work.
- Waiting missions remain waiting until an explicit `restoreWaitingToReady` transition.

## Commands and results

```bash
bun test cli/src/mission/mission-engine.test.ts cli/src/mission/durable-mission-execution.test.ts cli/src/mission/sqlite-mission-store.test.ts
```

Result: **77 pass, 0 fail, 389 expect() calls**.

```bash
bun run check:runtime
```

Result: **exit code 0**.

```bash
git diff --check
```

Result: **exit code 0** before this report was added. It will be rerun after the report update.

## Scope limits

- No connector calls, real reconciliation, scheduler, retry dispatch, or changes to `dispatch-seam.ts` were added.
- Context, UI, legacy subsystems, and `.agent/memory` were not modified. Existing `.agent/memory` files remain untracked and are excluded from the commit.
- The full `bun run check` gate was not rerun because the requested validation scope was the focused Mission/durable/SQLite suites plus `bun run check:runtime` and `git diff --check`.
