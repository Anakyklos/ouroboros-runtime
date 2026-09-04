# Durable Mission Execution Design

## Scope

This design is limited to issue #50. It completes the durable execution machinery around the existing `MissionEngine`, `SqliteMissionStore`, `CapabilityRegistry`, `CapabilityConnector`, `ConnectorDispatchSeam`, and Context Compiler boundaries. It does not replace the contracts delivered by #62, #63, or #64 and does not implement #38, #47, or #59.

## Authoritative flow

`MissionIntent -> Mission -> accepted PlanRevision -> deterministic policy -> Capability Registry -> durable CapabilityInvocation -> ConnectorDispatchSeam -> module owner -> evidence/result -> owner verification -> Mission verification`.

The planner remains advisory. The SQLite store is authoritative for executive state. A module owner remains authoritative for its private domain state and verification. Ouroboros stores references and coordination facts, never the owner's private database, raw credentials, complete prompts, chain-of-thought, or full private/provider responses.

## Durable entities

`Mission` and `CapabilityInvocation` remain separate entities. `Mission.invocationRefs` is a projection for existing callers; the invocation row is the complete execution record. A durable invocation includes:

- stable invocation, mission, accepted plan revision, and step identity;
- capability id, descriptor/contract version, module owner, effect class, and deterministic effect fingerprint;
- sanitized input/reference identity and desired-outcome identity;
- stable connector request identity plus per-attempt correlation identity;
- declared idempotency, retry, cancellation, and reconciliation semantics;
- delivery state, attempt records, remote operation handle, result/evidence references, and owner-verification state;
- persisted `nextEligibleAt`, cancellation state, reconciliation metadata, and lifecycle timestamps.

Only opaque identifiers, sanitized text, and evidence references cross the durable boundary. The store rejects raw-secret patterns recursively.

## Effect ordering and delivery semantics

For a new effectful invocation:

1. resolve and validate the mission, current accepted plan, approvals, capability contract, and policy;
2. persist the invocation intent and a non-submitted attempt in the existing SQLite database;
3. invoke only through `ConnectorDispatchSeam`;
4. persist submitted, acknowledged, running, failed, or uncertain delivery conservatively;
5. reconcile using the persisted request identity when the descriptor and connector support it;
6. persist typed result/evidence and owner verification;
7. release dependent steps only after the invocation is verified as complete.

A crash or exception after possible handoff leaves the invocation uncertain/blocked. The intermediate `submitted` marker means the seam entered connector code without an owner acknowledgement, and is treated like uncertain delivery for replay decisions. It is never submitted again merely because the process restarted. A retry is allowed only after a definitive non-delivery/failure or authoritative reconciliation says the effect was not performed, and only within the declared retry/idempotency policy. Reconciliation, retry, fallback, substitution, and replan are distinct operations.

## Recovery and scheduling

Recovery loads non-terminal missions and non-terminal invocations from the same store. It increments recovery metadata without changing legitimate waits, approvals, completed effects, or paused missions. `completed` rows are immutable and never dispatched again. `dispatched`, `running`, and uncertain rows are reconciled when supported; otherwise they remain conservatively blocked/waiting for intervention and cannot be blindly replayed.

Scheduling is one-shot and bounded. It queries due work from durable state, observes `nextEligibleAt`, dependencies, mission controls, connector availability, and a configured in-flight bound. It does not run a resident polling loop or busy-wait. The caller may schedule the next wakeup from the returned earliest timestamp. A fake/injected clock drives all tests and long waits.

A transiently unavailable connector moves only the affected mission to `waiting_for_capability`; other missions remain schedulable. Waiting is not failure.

## Controls and idempotency

`paused` is a persisted Mission state distinct from `cancelled`. Pausing records the previous resumable state and prevents future dispatch. Resume restores that state but does not replay an invocation whose delivery is uncertain. Cancellation during a wait prevents future dispatch. Cancellation of active work uses the declared connector cancellation operation when available, then reconciles conservatively; cooperative acknowledgement is not completion, hard cancellation may record `not_performed`, and unsupported cancellation never fabricates success. Completed external context is re-acquired through the same connector's declared reconciliation/observation operation, without mutating the terminal invocation or storing private rows in Ouroboros.

Duplicate result/event/evidence application is idempotent. Terminal invocation state cannot return to `running`, and a negative owner-verification verdict cannot be overwritten by planner or mission-level opinion. A later plan revision retains the durable effect fingerprint and completed invocation memory, so an already completed effect is not recreated as a new invocation for the same logical effect.

## Schema migration

The existing `mission_invocations` table is extended in place through deterministic, idempotent column migrations. Existing rows receive conservative defaults: their legacy status and references remain intact, and any row that lacks enough identity to reconcile is not replayable. No second database or private module store is introduced. Migration tests cover a legacy schema and repeated initialization.

## Verification evidence

Focused deterministic tests cover crash boundaries, uncertain delivery, restart recovery, waits and `nextEligibleAt`, duplicate results, connector isolation, cancellation, pause/resume, completed-effect memory across revisions, owner-verification failure, supported/unsupported reconciliation, secret hygiene, schema migration, and fake-clock idle behavior. The repository baseline and mandatory offline checks are run before review.
