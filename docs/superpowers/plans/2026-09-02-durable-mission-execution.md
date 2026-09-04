# Durable Mission Execution Implementation Plan

> **Execution note:** Follow the TDD skill. For each behavior, add a focused failing test first, run it red, then make the smallest production change that turns it green. Do not weaken existing assertions.

## Goal

Complete issue #50 using the existing Mission, capability, connector, and context boundaries. Keep one SQLite mission store, no external services, no new dependency, and no blind replay of uncertain effects.

## Task 1: Lock the durable contract with failing tests

- Add deterministic tests for a full invocation record, delivery/attempt transitions, `nextEligibleAt`, cancellation metadata, pause state, and migration defaults.
- Add tests proving the legacy `Mission.invocationRefs` projection remains compatible while full invocation state is durable and distinct.
- Add tests for recursive secret hygiene on invocation identity, errors, and references.
- Run the new focused file and confirm the expected failures before implementation.

## Task 2: Extend contracts and ports

- Add a persisted `PAUSED` Mission state and explicit pause/resume metadata.
- Add the full `CapabilityInvocation` type and typed delivery, cancellation, verification, attempt, and reconciliation records while retaining the minimal #62 reference surface for compatibility.
- Add store operations needed by recovery and due scheduling, keeping all data in `mission_invocations`.
- Add deterministic helpers for effect identity, retry eligibility, terminal immutability, and safe result merging.
- Export the new contracts through the existing mission/capability entry points.

## Task 3: Migrate and persist invocation state in SQLite

- Add an idempotent schema migration for the existing table, using SQLite metadata and `ALTER TABLE ADD COLUMN` only when a column is absent.
- Persist full invocation identity, semantics, attempts, delivery, handles, verification, cancellation, reconciliation, result refs, and timestamps as sanitized JSON/scalar columns.
- Keep writes transactional with mission transitions and use conservative defaults for pre-#50 rows.
- Ensure restart/reopen restores exact timestamps, waits, approvals, plan revision identity, and completed-effect memory.
- Add migration/reopen tests, including repeated initialization and old-row compatibility.

## Task 4: Make MissionEngine transitions durable and idempotent

- Mint a complete invocation before connector handoff, with stable request identity and persisted pre-submission delivery.
- Add explicit attempt preparation for safe retries only after definitive failure or authoritative non-delivery, never for uncertain delivery.
- Make duplicate terminal results/evidence idempotent and keep terminal states immutable.
- Add pause, resume, and cancellation operations. Active cancellation delegates only through the declared connector path; unsupported cancellation remains conservative.
- Preserve negative owner verification and prevent late planner-level success from replacing it.
- Add tests for crash-before-submit, duplicate results, owner failure, cancel during wait/active, pause/restart/resume, and later plan revisions.

## Task 5: Complete the connector seam for recovery-safe operations

- Preserve the existing pre-mint gates and single handoff boundary.
- Add recovery/reconciliation and cancellation entry points that consume only persisted request/operation identities and validate returned typed results before state mutation.
- Record uncertainty on possible handoff, malformed/mismatched responses, and connector exceptions.
- Permit a second connector call only when the persisted state and descriptor semantics explicitly authorize reconciliation or a safe retry after definitive non-delivery.
- Add tests proving uncertain delivery never causes a blind second `invoke`, supported reconciliation resolves state without submission, unsupported reconciliation blocks conservatively, and connector unavailability isolates missions.

## Task 6: Add bounded one-shot durable scheduling and recovery

- Implement a small scheduler/runtime that reads durable missions/invocations, respects terminal/paused/waiting states, dependencies, approvals, connector availability, retry policy, and `nextEligibleAt`.
- Bound in-flight work and avoid resident timers, aggressive polling, busy-wait, or unbounded RAM queues. Return the next durable wakeup timestamp instead of sleeping.
- Recover non-terminal state after restart, reconcile ambiguous invocations where supported, and leave unsupported cases blocked/waiting with an explicit next action.
- Use the injected `ClockService` in every scheduling decision and add a 24-hour-plus fake-clock test with no repeated idle polling.
- Add tests proving one unavailable capability does not stop other missions and completed effects are not redispatched.

## Task 7: Context and documentation regression coverage

- Verify Context Compiler external references still pass through the existing seam and can be reacquired/reconciled from durable references without accessing owner-private storage.
- Add concise architecture documentation for state semantics, migration, ordering, recovery, bounded idle behavior, and deliberate #38/#47/#59 follow-ups.
- Run all existing Mission, capability, and Context Compiler suites unchanged plus the new durable suite.

## Task 8: Mandatory verification and delivery

- From a clean checkout of the issue branch run `bun install --frozen-lockfile`.
- Run `cd web && bun install --frozen-lockfile && cd ..`.
- Run `bun run check`, focused Mission/capability/context/new tests, and `git diff --check`.
- Inspect the final diff for issue-only scope, commit the implementation, and open one PR against `main` with `Closes #50`, reproducible evidence, and explicit limitations.
