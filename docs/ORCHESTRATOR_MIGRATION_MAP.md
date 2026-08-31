# Orchestrator Migration Map (Issue #62)

> **Status**: Direction — migration plan, not a removal PR.
> **Authority**: #60, #62, `docs/LEGACY_MATRIX.md` (#61).
> **Goal**: make explicit, reconciled with the current code, how the legacy
> `cli/src/orchestration/Orchestrator.ts` concepts map to the new Mission
> architecture (`cli/src/mission/`). No mass removal in this PR.

This map classifies each concept as:

- **Reutilizável** — semantics that survive, under the new contract;
- **Adaptável** — useful idea, must be reshaped;
- **Legado** — does not define direction; kept only for compatibility;
- **Issue posterior** — responsibility owned by a future issue.

---

## 1. `OrchestratorTask` → Mission / CapabilityInvocation

| `OrchestratorTask` field | Destination |
|---|---|
| `id` | **Reutilizável** as step/invocation id discipline (stable ids) |
| `instruction` | **Legado as written.** `instruction` is a mutable prompt. The Mission contract preserves `originalIntent` verbatim and immutable; a mutable instruction string is the anti-pattern `fixIssues()` exploits. Future: interpreted objective + plan steps carry declarative outcomes, never a mutable prompt pretending to be the intent |
| `persona` | **Legado** — no first-class persona in the new model (see §2) |
| `context` | **Adaptável** → authorized `contextRefs` with provenance (#64 Context Compiler) |
| `workDir` | **Legado** — module-owned execution state; Ouroboros does not own module workdirs |
| `validationStrategy` | **Adaptável** → module-owner verification + mission-level verification layers (#66) |

**Split rule**: what belongs to Mission = intent, constraints, acceptance,
plan revision, durable state, approval state, verification (executive).
What belongs to a future CapabilityInvocation = one dispatched effect
against a capability, its state, its evidence, its owner verification.

## 2. `PersonaType` — leaves first-class status

`PersonaType` (ARCHITECT/DEVELOPER/REVIEWER/TESTER) is **Legado** as an
architectural abstraction. Coordination semantics are now expressed by
Mission state + PlanRevision + Invocation status, not by fixed personas.
The new code (`cli/src/mission/`) has zero references to `PersonaType`.

## 3. `PERSONA_PHASE_MAP` — Legado

Maps persona → Anti-Vibe phase. **Legado**: Anti-Vibe phases are a
code-oriented workflow, not the executive Mission model. Not reused.

## 4. `ESCALATION_CHAIN` — Legado

Persona-to-persona escalation (DEVELOPER → REVIEWER → ARCHITECT → human).
**Legado, not future Mission policy**: escalation in the new model is an
explicit, policy-driven decision (retry allowed? replan? block? ask human?)
made by deterministic code, never by a fixed persona ladder.

## 5. `loopUntilSuccess()` — decompose

`loopUntilSuccess()` mixes: build prompt → phase gate → provider call →
text heuristics → retry → escalate. **Adaptável**: decompose into explicit
state transitions:

- plan accepted → `ready`;
- dispatch step → `executing` (invocation `dispatched`);
- waiting on capability/provider/budget/approval → `waiting_*`;
- failure after policy-allowed retries → `blocked` or replan;
- terminal states (`completed`, `failed_terminal`, `cancelled`) reached
  only via deterministic transitions.

Retry and replan must be **separate** transitions: a retry is not a hidden
replan, and neither erases original intent (proven by test).

## 6. `fixIssues()` — cannot mutate instruction

`fixIssues(originalInstruction, error)` wraps the instruction with a new
prompt and reassigns `task.instruction`. **Legado / prohibited pattern**:
mutating the instruction while pretending the original intent stayed the
same is exactly what the Mission contract forbids (`originalIntent`
preserved verbatim, `acceptanceCriteria` immutable by planner). Future
replanning is an explicit versioned PlanRevision with a sanitized reason,
never silent mutation of the intent text.

## 7. Text heuristics (`SUCCESS_INDICATORS` / `FAILURE_INDICATORS`)

`evaluateResult()` decides success by scanning output for emojis and
substrings ("✅", "SUCCESS", "all tests passed"). **Legado / not completion
authority**: planner/model text is advisory; completion authority comes from
deterministic policy + evidence + module-owner verification.

## 8. `ContextEntry` with raw prompt/output — not Mission truth

`ContextEntry { timestamp, prompt, output, error, persona }` stores raw
prompt and output. **Legado**: raw prompt/output is never Mission truth and
is never persisted by the Mission contract. Only sanitized evidence refs,
sanitized reasons and authorized context refs survive (#64).

## 9. `MemoryManager` → Context Compiler (#64)

`MemoryManager` (Markdown file-first prompt/output memory) is **Adaptável
in a narrow way**: only durable Mission state/evidence references survive.
Generic agent memory (prompt/output logs as truth) is **Legado** and is
handled under #64 (Context Compiler with provenance/ownership). Ouroboros
never becomes a universal knowledge store.

## 10. Approval semantics — migrate fail-closed

`requireApproval` + `onApprovalRequired` in the Orchestrator is a useful,
simple approval gate. **Adaptável** → Mission-level approval, fail-closed:

- approval requirements live on the Mission (`approvalRequirements`);
- a step that requires approval but attaches none is rejected by policy;
- an attached but un-granted approval puts the Mission in
  `waiting_for_approval` (a waiting state, never a failure);
- `recordApproval(missionId, approvalId, grantedBy)` is explicit and
  persisted.

## 11. `Orchestrator` pause/cancel semantics

`pause()` / `resume()` / `cancel()` (emergency brake) are **Adaptável**:
the Mission model keeps cooperative cancellation (`cancelMission`) and
waiting states, but they become durable state transitions rather than
in-memory flags.

## 12. `MemoryRetriever` — Context Compiler (#64)

Retrieval without provenance/ownership cannot feed the planner as truth.
**Adaptável** under #64; not part of this PR.

## 13. `WaveExecutor` — scheduler (#50)

Parallel scheduling with dependencies is **Adaptável** as invocation
scheduling without the "agent wave" metaphor (#50). Not part of this PR.

---

## Summary

| Concept | Classification |
|---|---|
| `OrchestratorTask.instruction` (mutable) | Legado |
| Stable task ids | Reutilizável (step/invocation ids) |
| `context`/`workDir` | Adaptável (contextRefs, #64) |
| `validationStrategy` | Adaptável (layered verification) |
| `PersonaType`, `PERSONA_PHASE_MAP`, `ESCALATION_CHAIN` | Legado |
| `loopUntilSuccess()` | Adaptável (explicit state machine + retry/replan) |
| `fixIssues()` instruction mutation | Legado / prohibited |
| `SUCCESS_INDICATORS`/`FAILURE_INDICATORS` | Legado / not authority |
| `ContextEntry` raw prompt/output | Legado |
| `MemoryManager`/`MemoryRetriever` | Adaptável → #64 |
| approval gates | Adaptável → Mission-level approval (fail-closed) |
| pause/resume/cancel | Adaptável → durable state transitions |

The new Mission model (`cli/src/mission/`) does **not** wrap
`OrchestratorTask`. Dependencies point from legacy code toward the new
architecture, not the reverse. #63 and #50 can proceed without depending on
personas.
