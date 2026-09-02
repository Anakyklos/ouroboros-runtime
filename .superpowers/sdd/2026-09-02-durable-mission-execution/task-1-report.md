# Task 1 Report: Durable Mission Execution Red Tests

## Files changed

- `cli/src/mission/durable-mission-execution.test.ts`

No production implementation, dependency, or existing test was changed.

## Exact red test command and observed failure

```bash
bun test cli/src/mission/durable-mission-execution.test.ts
```

Observed result:

- 7 tests ran.
- 1 test passed: recursive raw-secret rejection.
- 6 tests failed, as intended for the Task 1 red phase.
- Exit code: 1.
- The primary failure showed that the current SQLite mapper only returns the legacy reference fields and drops the durable fields, including `acceptedPlanRevisionId`, `effectFingerprint`, attempt records, delivery, retry, cancellation, reconciliation, and timestamps.
- Pause/resume failed because `MissionEngine.pauseMission` is not implemented yet.
- Migration expectations failed because legacy invocation rows do not yet receive the required conservative durable defaults.

## Test cases added

1. Complete durable invocation round trip and distinction between the authoritative invocation record and the legacy `Mission.invocationRefs` projection.
2. Delivery and attempt transition persistence, including attempt correlation identity and `nextEligibleAt`.
3. Cancellation metadata and conservative reconciliation state for uncertain delivery.
4. Persisted `paused` mission state distinct from `cancelled`, with pause metadata and resume behavior.
5. Legacy `mission_invocations` schema reopen/migration defaults and repeated initialization.
6. Recursive secret rejection across invocation request identity, errors, attempt correlation identity, and evidence references.
7. Fake-clock determinism and preservation of a 24-hour retry wait across durable reads.

## Concerns

- The test file defines the expected Task 2 durable invocation shape locally until the production contract is added. Task 2 should replace the local structural type with the exported `CapabilityInvocation` and typed metadata contracts without weakening these assertions.
- The migration test intentionally expects Task 3 to add columns in place and map old `dispatched` rows conservatively as uncertain/non-replayable.
- The pause test intentionally expects Task 4 to add authoritative engine pause/resume methods and persisted pause metadata.
- Existing secret hygiene already passes this focused test; the new assertions preserve that behavior while extending coverage to nested invocation fields.

## Fix round 1

### Changes

- Strengthened fake-clock coverage with persisted `nextEligibleAt` boundary assertions before, immediately before, and exactly at eligibility.
- Replaced the truthiness-only secret-case check with per-case rejection and error-message assertions labeled by secret field/path.
- Replaced raw `"paused"` expectations with the typed `PAUSED_STATE` test contract. The current pre-implementation `MissionState` enum does not export `PAUSED` yet.
- No production code, dependency, or unrelated test was changed.

## Fix round 2

### Changes

- Confirmed the local `DurableInvocation` structural type includes the optional top-level `error?: string` field, making the error update type-correct.
- Kept the typed `PAUSED_STATE` assertion.
- The fake-clock test uses the pure test-local `isDue(invocation, now)` predicate, which reads the restored invocation's persisted `retry.nextEligibleAt` and asserts false before eligibility, true exactly at eligibility, and true afterward.
- The attempt transition test preserves the initial prepared attempt, records the later failed attempt, and asserts both ordered entries with their attempt numbers, states, and correlation identities.
- No production code, dependency, skip, filter, or weakened assertion was added.

### Exact red test command and result

```bash
bun test cli/src/mission/durable-mission-execution.test.ts
```

```text
bun test v1.3.9 (cf6cdbbb)

1 pass
6 fail
9 expect() calls
Ran 7 tests across 1 file. [311.00ms]

--- 6 tests failed because the durable persistence, pause/resume, migration, and eligibility production behavior is not implemented yet.
--- 1 test passed: rejects raw secrets recursively in invocation identity, errors, attempts, and references.
--- exit code: 1
```
