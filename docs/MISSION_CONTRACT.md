# Mission Contract (Issue #62)

> **Status**: Direction (implemented contract) — this is the first executable
> contract of the executive-coordination realignment (epic #60).
> **Authority**: #60, #62 + `Anakyklos/architecture` (SYSTEM-MAP.md, RFC 0001).
> **Implementation**: `cli/src/mission/` (TypeScript, provider-free, testable).

## Core rule

> **The LLM/planner proposes. Code/policy authorizes.**

No model gains authority over effects by producing text, JSON, a tool call,
or a plan. Deterministic policy and downstream module validation remain
required (RFC 0001).

## Authoritative flow

```text
Intent source (Katherine / Mission Control / CLI / API / operator)
        ↓
MissionIntent
        ↓
Ouroboros interpretation + durable creation
        ↓
Mission
        ↓
Planner (advisory proposal)
        ↓
PlanCandidate
        ↓
Deterministic validation / policy
        ↓
future CapabilityInvocation
```

## `MissionIntent != Mission`

- `MissionIntent` is input from an authorized interface. It represents only
  what an interface can legitimately deliver: request/source identity,
  original user-visible intent, explicit constraints, known acceptance,
  explicit choices, authorized context references, and explicitly
  represented approvals/permissions.
- The authoritative `Mission` is born **inside Ouroboros** (interpretation +
  durable creation). `source/interface` records provenance, never ownership
  or special authority.
- Katherine, Mission Control, CLI, API and operator intents flow through the
  **same creation pipeline** (`MissionEngine.createMission`) — there is no
  per-interface state machine.
- `MissionIntent` is never implicit authorization for arbitrary effects.
  Approvals/permissions explicitly represented on the intent surface on the
  Mission as `approvalRequirements` (data, not authority).

## Contract version

`MISSION_CONTRACT_VERSION = 1` (`cli/src/mission/contracts.ts`).

Bump the version on any breaking schema change. The schema is stored per
Mission (`schemaVersion`), so mixed versions can coexist during migration.

## `Mission` fields (v1)

| Field | Meaning |
|---|---|
| `missionId` | Stable id, generated inside Ouroboros |
| `schemaVersion` | Contract version |
| `source` | Source/interface (provenance only) |
| `originalIntent` | Original user intent, preserved verbatim |
| `interpretedObjective` | Objective interpreted by Ouroboros |
| `constraints` | Explicit constraints (immutable by planner) |
| `acceptanceCriteria` | Acceptance (immutable by planner) |
| `budgetPolicy` | Budget/resource policy |
| `allowedCapabilityScope` | Authorized capability ids + effect classes + ref prefixes |
| `approvalRequirements` | Approval requirements/state |
| `contextRefs` | Authorized context references/provenance |
| `state` | Current durable Mission state |
| `currentPlanRevisionId` | Current accepted plan revision |
| `invocationRefs` | Child/capability invocation references |
| `evidenceRefs` | Evidence/result references |
| `unresolvedQuestions` | Open questions (may need user input) |
| `createdAt` / `updatedAt` | Timestamps |
| `recoveryMetadata` | Recovery counters/timestamps |

**Never persisted:** API keys, Authorization headers, raw secrets, chain of
thought, full prompts, raw provider responses.

## Mission state

States are semantic, and `waiting_*` states are waiting — never collapsed
into `failed`:

```text
created
planning
waiting_for_context
waiting_for_approval
ready
executing
waiting_for_capability
waiting_for_provider
waiting_for_budget
verifying
completed
blocked
failed_terminal
cancelled
```

`MissionState` is distinct from `InvocationStatus` (pending/dispatched/
running/completed/failed/cancelled/blocked). The full durable scheduler,
`nextEligibleAt`, reconciliation, provider cooldown and exactly-once belong
to #50 — not to this contract.

## PlanCandidate / PlanRevision

The planner produces a **declarative proposal**, not arbitrary commands.
Each step declares: stable step id, desired outcome, dependencies,
capability requirement, input/context references, expected acceptance,
effect class, approval requirement, budget hint, and fallbacks as proposals
only.

An accepted revision carries a revision id, version number and a **sanitized
reason based on event/evidence** (no chain of thought).

### Approval authority — planner proposes, policy/recordApproval grants

- `PlanStep.approvalRequirement` is **advisory only** (`StepApprovalRequirement`):
  it declares that a step *requires* approval (approval id, approver, reason).
  It carries **no** `granted` / `grantedBy` / `grantedAt` fields.
- The authoritative grant state lives only on the Mission
  (`Mission.approvalRequirements`), created un-granted at plan acceptance
  and changed **only** through the explicit `MissionEngine.recordApproval()`
  path.
- A candidate that smuggles grant fields inside an approval requirement is
  deterministically rejected (`APPROVAL_GRANT_FORBIDDEN`). The planner cannot
  concede its own approval.

Invariants (enforced by contract/test):

- `originalIntent`, constraints and acceptance never change silently during
  replan;
- revisions are versioned and auditable (`proposed → accepted |
  rejected | superseded`);
- completed effects/invocation refs never disappear after replan;
- retry is not treated as replan;
- invalid planner output does not mutate durable Mission state.

## Deterministic policy

`PlanPolicyValidator` (`cli/src/mission/policy.ts`) rejects, before any
dispatch, proposals that:

- use a capability outside the Mission's authorized scope;
- use a capability unknown to the catalog/resolver (discovery !=
  authorization);
- contain a dependency cycle (or unknown step references);
- declare an unauthorized effect class (or one that mismatches the catalog);
- require approval without attaching an approval requirement (fail-closed);
- attach input references incompatible with the capability contract;
- attempt to change Mission acceptance/constraints without authority;
- attempt to access storage/database outside authorized prefixes;
- explicitly attempt to bypass a module owner.

The policy is a pure function of (mission, candidate, capability catalog):
the same input always yields the same decision. The Capability Registry
(#63) will later provide the real catalog; #62 proves the gate with an
injectable resolver/fake.

## Dispatch gate (authorization is re-checked immediately before dispatch)

`MissionEngine.dispatchStep()` fails closed before any invocation is
created when:

- the Mission is not in an authorizable state (`ready` / `executing`) —
  e.g. `waiting_for_approval` → `DispatchRejectedError`, zero invocation;
- the step is not in the current accepted revision;
- an invocation already exists for the same logical step (replay
  protection);
- a required approval is not granted (authoritative Mission state);
- the capability is no longer available in the current catalog;
- the accepted plan is no longer authorized by current policy (a validation
  performed at proposal time does not grant eternal authority).

## Replay protection (idempotency boundary for #62)

- One invocation per logical `(mission, step)`. A second `dispatchStep()` for
  a step that already has an invocation — including after store restart —
  throws `InvocationConflictError` and never creates a second row.
- This preserves the mandatory criterion: **a completed invocation is never
  repeated after restart**, and an effect whose outcome is completed or
  uncertain is never blindly re-dispatched.
- Full exactly-once scheduling belongs to #50.

## Persistence / recovery

`SqliteMissionStore` (`cli/src/mission/sqlite-mission-store.ts`) persists
Missions, plan revisions and invocation references using the repo-approved
`bun:sqlite` primitive (same as `budget-tracker.ts`), WAL mode, prepared
statements. Missions and the current plan revision are recoverable after
restart/reinstantiation of the store.

Atomicity and single authority:

- `mission_invocations` is the **canonical** table for invocation state;
  `Mission.invocationRefs` is derived from it on read (no divergent
  duplicate).
- Multi-record transitions (dispatch = invocation + mission state; accept =
  supersede old revision + accept new + current pointer + approvals) run in
  a single SQLite transaction (`MissionStore.withTransaction`). A crash
  mid-transition rolls back atomically; restart always reconstructs an
  internally consistent state.

Scope discipline: only the Mission contract is persisted. No scheduler
state, provider state or private module state.

## Mission-level verification (fail-closed, typed)

`MissionVerifier` (engine default) verifies only the executive level:
do the capability results satisfy the Mission's objective/acceptance?

It **cannot** override negative module-owner verification:

```text
moduleOwnerVerification = failed
plannerSuggestion       = "looks good"
→ Mission MUST NOT become completed
```

Completion is **not** derived from text heuristics. The default verifier
fails closed unless, for every acceptance criterion, there is an explicit
typed `CriterionVerification` record (`satisfied: true`) recorded through
the engine's authorized path (`recordCriterionVerification`). A missing
mandatory lower-layer verification (per `CapabilityContract.
requiresOwnerVerification`) is never implicit success — the invocation must
carry a positive module-owner verification.

Domain/technical verification (Runstead, Tecer, LifeOS, device modules)
stays with the respective module owner (#66/#67 follow-ups).

## Files

| File | Responsibility |
|---|---|
| `cli/src/mission/contracts.ts` | Types: MissionIntent, Mission, PlanCandidate, PlanRevision, state enums, rejection codes |
| `cli/src/mission/ports.ts` | Ports: MissionStore, PlannerPort, CapabilityResolver, ClockService, IdGenerator |
| `cli/src/mission/policy.ts` | Deterministic PlanPolicyValidator |
| `cli/src/mission/mission-engine.ts` | MissionEngine (creation, proposal, acceptance, dispatch refs, verification) |
| `cli/src/mission/sqlite-mission-store.ts` | Durable SQLite store |
| `cli/src/mission/testing.ts` | Injectable fakes (test-only) |
| `cli/src/mission/*.test.ts` | Contract/policy/persistence tests |

## Out of scope (future issues)

- Capability Registry + real catalog (#63)
- Context Compiler with provenance (#64)
- Durable invocation scheduler, exactly-once, reconciliation (#50)
- Supervision tree (#59)
- Katherine/Runstead/Cadinho/Mission Control integration (#65-#68)
