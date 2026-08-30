---

description: "Task list for issue #61 — source of truth + legacy classification"
---

# Tasks: Source of truth realignment + legacy classification

**Input**: spec.md, plan.md in `specs/061-source-of-truth-legacy-matrix/`

**Prerequisites**: plan.md (required), spec.md (required)

**Organization**: Tasks grouped by user story enabling independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- All paths relative to repository root

## Phase 1: Setup (Spec Kit workflow + Branch)

**Purpose**: Issue-specific Spec Kit artifacts, branch, and research

- [x] T001 [P] Use Spec Kit workflow for issue #61: create feature spec, plan, and tasks under `specs/061-source-of-truth-legacy-matrix/`
- [x] T002 Create branch `issue-61-source-of-truth-legacy-matrix` from `main`
- [x] T003 [P] Write feature spec (`specs/061-source-of-truth-legacy-matrix/spec.md`)
- [x] T004 [P] Write implementation plan (`specs/061-source-of-truth-legacy-matrix/plan.md`)
- [x] T005 Write task list (`specs/061-source-of-truth-legacy-matrix/tasks.md`)

---

## Phase 2: Foundational (Research Complete)

**Purpose**: All research already done. Proceed directly to user story implementation.

---

## Phase 3: User Story 1 — Agent executor receives unambiguous direction (Priority: P1) 🎯 MVP

**Goal**: README.md, AGENTS.md, and docs/ARCHITECTURE.md provide correct, authoritative source of truth distinguishing Current/Direction/Legacy/Hypothesis.

**Independent Test**: A new reader can answer: what Ouroboros is today (Current) vs where it is heading (Direction); what is the authoritative flow; what is legacy vs hypothesis.

### Implementation for User Story 1

- [x] T006 [US1] Create `docs/ARCHITECTURE.md` with authoritative architecture doc:
  - Identity: Ouroboros as executive runtime / sistema nervoso do Anakyklos
  - Authoritative flow: Intent → MissionIntent → Mission → Planner → Policy → Capability Registry → Invocation → Module Owner → evidence → verification
  - What Ouroboros IS (preserves intent, creates Missions, compiles context, proposes/decomposes, discovers capabilities, applies policy, coordinates owners, maintains execution, collects evidence, does mission-level verification)
  - What Ouroboros IS NOT (not coding agent, not capability factory, not self-modifying runtime, not Council/personas, not unrestricted Python executor, not universal memory, not owner of other modules' databases, not chatbot, not Runstead/Cadinho competitor)
  - Current (behaviour proven today), Direction (executive coordination), Legacy (code that no longer defines direction), Hypothesis (Go migration, Zig/Rust boundaries, desktop framework)
  - `MissionIntent != Mission` — Mission born within Ouroboros
  - Self-improving (#69) != self-modifying — `modifySelf()` not preserved
  - Topology (#70): daemon/headless autoridade; Mission Control desktop interface principal; CLI pequena admin/recovery; Katherine interface humana opcional; Electron não-default; TUI não compete como segunda UI principal
  - `Create Mission in Mission Control: On | Off` — controls only MissionIntent entry surface
  - Provenance: reconciled with `Anakyklos/architecture` (README.md, SYSTEM-MAP.md, VISION.md, policies, RFC 0001, Technology Palette)
- [x] T007 [US1] Rewrite `README.md`:
  - Header: remove "Self-Modifying-Agent", "Agents that write their own code", Council, Anti-Vibe Protocol as primary identity
  - Replace with executive coordination identity, authoritative flow, quick instantiation
  - Add Current/Direction/Legacy/Hypothesis sections in architecture section
  - Add `MissionIntent != Mission` and self-improving != self-modifying
  - Add topology #70 (daemon + Mission Control + CLI/Katherine)
  - Add `Create Mission in Mission Control: On | Off`
  - Preserve baseline commands (bun install frozen, bun run check)
  - Remove TUI as primary interface; mark as Legacy
  - Add links to docs/ARCHITECTURE.md, docs/LEGACY_MATRIX.md, and Anakyklos/architecture
- [x] T008 [US1] Rewrite `AGENTS.md`:
  - Preserve correct baseline commands (#35, frozen installs, check, quarantine)
  - Replace self-modifying-agent identity with direction to #60/architecture docs
  - Remove Anti-Vibe Protocol, Ralph, TUI design, Council as active instructions
  - Remove "Estado ideal" with waves/semantic memory/skills/MCP/self-healing
  - Add Legacy section markers for removed content
  - Add link to docs/ARCHITECTURE.md, docs/LEGACY_MATRIX.md, Anakyklos/architecture
  - Mark sections like "Self-Modifying Agent" as Legacy
- [x] T009 [US1] Update `.agent/rules.md`: replace legacy autonomy sandbox rules with rules aligned with #60 (no unrestricted self-modification, no Council/personas, deliberate boundaries)

---

## Phase 4: User Story 2 — Maintainer decides legacy with binding matrix (Priority: P1)

**Goal**: Complete binding classification matrix covering all mandatory subsystems, with Decision/Future owner/boundary/Rationale/Follow-up.

**Independent Test**: Every subsystem from #61 list has a row in the matrix with 6 required fields; no RETIRE/MOVE subsystem described as ideal state in current docs.

### Implementation for User Story 2

- [x] T010 [P] [US2] Create `docs/LEGACY_MATRIX.md` with the full binding classification matrix:
  - Table with columns: Subsystem | Current responsibility/evidence | Decision | Future owner/boundary | Rationale | Follow-up implication
  - Classify ALL mandatory subsystems from #61 (see task list below for each row)
- [x] T011 [US2] Classify `SelfModifyingEngine` → RETIRE from runtime core (MOVE/EXTRACT primitives if justified)
- [x] T012 [US2] Classify `PersistentPythonREPL` → RETIRE (arbitrary Python execution not core capability)
- [x] T013 [US2] Classify `SandboxRunner` / `SandboxTool` → RETIRE (not core executive responsibility)
- [x] T014 [US2] Classify `Council/personas` → RETIRE (not central architecture)
- [x] T015 [US2] Classify `ArchitectClient` → RETIRE (hardcoded persona; planner capability (#62) replaces)
- [x] T016 [US2] Classify `WaveExecutor` → ADAPT (scheduling semantics for capability invocations, drop "agent wave" framing)
- [x] T017 [US2] Classify `Anti-Vibe workflow` / `PromotionManager` / code-review gates → ADAPT (fail-closed gates survive as mission-level gates; technical software verification → Runstead; promotion/capability evolution → Cadinho)
- [x] T018 [US2] Classify Antigravity bridge / Gemini bridge / Jules bridge → ADAPT (connector/capability pattern replaces direct integration; versioned connectors)
- [x] T019 [US2] Classify local inference subsystem → ADAPT (planner backend optional; not product identity)
- [x] T020 [US2] Classify `MemoryManager` / `MemoryRetriever` → ADAPT (durable Mission state/context refs remain; generic agent memory → RETIRE)
- [x] T021 [US2] Classify Ralph loop → RETIRE (dev tooling, not runtime product; evaluate if MOVE to dev-tools)
- [x] T022 [US2] Classify MCP / `SkillLoader` → DEFER (capability protocol candidate, prematuro como arquitetura obrigatória)
- [x] T023 [US2] Classify Council UI / Memory UI / Terminal UI panels → RETIRE (conceitos legados na UI; frontend é projection)
- [x] T024 [US2] Classify Electron shell → RETIRE (não-default arquitetural; verificar se existe código)
- [x] T025 [US2] Classify local web server (Fastify/WebSocket) → DEFER (IPC local preferido #70; Fastify mantido para compatibilidade até contracts)
- [x] T026 [US2] Classify React/Ink TUI → RETIRE (não compete como segunda UI principal; debug/recovery CLI subsiste)
- [x] T027 [US2] Classify web frontend (Vite/React) → ADAPT (componentes reutilizáveis; direção é Mission Control desktop leve; deployment web não obrigatório)
- [x] T028 [US2] Classify terminal pane → ADAPT (útil para debug; semântica capability futura)
- [x] T029 [US2] Classify direct daemon/UI coupling → ADAPT (separar IPC versionado; UI não authority)
- [x] T030 [US2] Classify duplicated frontend stores/state → ADAPT (consolidar após contracts de projeção)
- [x] T031 [US2] Mark legacy docs with `> **Status: Legacy**` header and classification reference:
  - `DESIGN.md` → Legacy (TUI design system)
  - `SPEC_OUROBOROS_ENV.md` → Legacy (Python sandbox spec)
  - `CONDUCTOR_JULES_INTEGRATION.md` → Legacy (Conductor+Jules orchestration)
  - `UI_UX_IMPROVEMENT_REPORT.md` → Legacy (UI report)
  - `WEB_FRONTEND_PLAN.md` → Legacy (web frontend plan)
  - `conductor/index.md` → mark as Legacy (conductor architecture)
  - `docs/LOCAL_INFERENCE.md` → mark as Legacy/experimental
  - `docs/PROVIDER_CREDENTIALS.md` → add note: provider not identity

---

## Phase 5: User Story 3 — Zero regression on baseline (Priority: P1)

**Goal**: `bun run check` passes; `git diff --check` passes; working tree contains only #61 changes.

**Independent Test**: `bun install --frozen-lockfile` (root + web), `bun run check`, `git diff --check` pass.

### Implementation for User Story 3

- [x] T032 [US3] Install root dependencies: `bun install --frozen-lockfile`
- [x] T033 [US3] Install web dependencies: `cd web && bun install --frozen-lockfile && cd ..`
- [x] T034 [US3] Run full baseline: `bun run check`
- [x] T035 [US3] Verify whitespace: `git diff --check`
- [x] T036 [US3] Verify working tree: `git status --short` (only #61 files)
- [x] T037 [US3] Restore `web/tsconfig.tsbuildinfo` to HEAD (regenerated by tsc -b)
- [x] T038 [US3] Final search for obsolete concepts as current direction:
  - Search terms: `self-modifying`, `Council`, `agents that write their own code`, `persona`, `persistent agent memory`, `Ralph`, `waves`, `thought process`, `Electron`
  - Verify occurrences only in `Legacy` / historical sections

---

## Phase 6: Delivery

**Purpose**: Commit, PR, and report.

- [x] T039 Commit foundational changes (Spec Kit artifacts, SPEC_OUROBOROS, LEGACY_MATRIX)
- [x] T040 Commit docs/ARCHITECTURE.md + docs/LEGACY_MATRIX.md
- [x] T041 Commit README.md rewrite
- [x] T042 Commit AGENTS.md + .agent/rules.md rewrite
- [x] T043 Commit legacy doc markers
- [x] T044 Open PR #71 against `main` with `Closes #61`, full description, validation results, follow-ups
- [x] T045 Apply review corrections: reconcile with Anakyklos/architecture, fix quarantine facts, remove Spec Kit scaffold, update PR description

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — done
- **Foundational (Phase 2)**: Research complete — skip
- **User Stories 1-2 (Phase 3-4)**: Can proceed in parallel (docs and matrix)
- **User Story 3 (Phase 5)**: Depends on all implementation being done
- **Delivery (Phase 6)**: Depends on validation passing

### User Story Dependencies

- **US1**: No dependencies — independent
- **US2**: No dependencies — independent (can parallel with US1)
- **US3**: Depends on US1 + US2 completion

### Parallel Opportunities

- T006 (ARCHITECTURE.md) and T010 (LEGACY_MATRIX.md) can be written in parallel
- T007 (README.md) and T008 (AGENTS.md) can be written in parallel
- T011-T030 (matrix rows) can be written in parallel (they're rows in the same table)
- T031 (legacy doc markers) can be done in parallel with matrix
- T032-T038 (validation) must be sequential
- All Phase 1 tasks are done (setup complete)