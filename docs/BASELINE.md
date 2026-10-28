# Repository baseline (issue #35)

This document describes the **reproducible validation gate** for Ouroboros. It is the source of truth for what “green” means today.

## Runtime requirements

| Tool | Version |
|------|---------|
| Bun  | **1.3.9** (pinned in CI via `packageManager` / workflow) |
| Python | Not required for mandatory CI (legacy Python sandbox retired in #83) |

Use Bun lockfiles only:

- Root: `bun.lock`
- Web: `web/bun.lock`

(`package-lock.json` / `web/package-lock.json` may exist historically; they are **not** used by the baseline.)

## Dependency strategy

**Chosen: two separate packages + explicit aggregator scripts** (not Bun workspaces).

| Option | Decision |
|--------|----------|
| Bun workspaces monorepo | **Rejected** — root pins React 18 (Ink TUI) while `web/` pins React 19; separate lockfiles already work; workspaces would force shared dependency resolution with little gain. |
| Aggregator scripts | **Accepted** — simplest reliable path: root and `web/` install/build independently; `bun run check` sequences them. |

## Install (clean environment)

```bash
# From repository root
bun install --frozen-lockfile
cd web && bun install --frozen-lockfile && cd ..
```

Or via the check helper (also asserts the working tree is unchanged by install):

```bash
bun run check:install
```

`check:install` fails hard if `git status` cannot run (git missing, not a repo, non-zero exit). It never treats a failed git command as a clean tree.

If `--frozen-lockfile` fails, refresh and commit lockfiles:

```bash
bun install
cd web && bun install && cd ..
git add bun.lock web/bun.lock
```

## Validation commands

| Command | What it proves |
|---------|----------------|
| `bun run check:install` | Root + web install with frozen lockfiles; no tracked file drift during install |
| `bun run check:runtime` | Root TypeScript project compiles (`tsc` → CLI/runtime/scripts) |
| `bun run check:web` | Web app typechecks and Vite production build succeeds |
| `bun run check:tests` | **Mandatory** unit tests pass; quarantined suites listed, not counted green |
| `bun run check` | All of the above, in order, plus a post-check working-tree integrity verification |

Legacy aliases still present:

- `bun run build` → same as `check:runtime` (`tsc`)
- `bun run test` → raw `bun test` (**includes quarantined files**; may fail)

For PR / CI trust, always use **`bun run check`**, not only `build` + `test`.

## What CI covers

Workflow: `.github/workflows/ci.yml`

Triggers:

- every `pull_request`
- `push` to `main`

Steps:

1. Checkout  
2. Bun **1.3.9**  
3. Snapshot the non-ignored working tree (`scripts/check-tree-integrity.ts snapshot`)
4. `bun install --frozen-lockfile` (root)
5. `bun install --frozen-lockfile` (web)
6. Fail if install dirtied the git tree
7. `bun run check:runtime`
8. `bun run check:web`
9. `bun run check:tests`
10. Verify the tree against the pre-install snapshot (`scripts/check-tree-integrity.ts verify`)

Properties:

- No API keys / secrets  
- No paid model calls  
- No `continue-on-error` on mandatory steps  
- Minimal permissions (`contents: read`)

## Working-tree integrity (issue #153)

The baseline must not modify the checkout as a side effect of compiling or
running tests. A clean checkout must remain clean after `bun run check`.

### Regenerable artifacts

`web/tsconfig.tsbuildinfo` is a TypeScript incremental build cache produced by
`tsc -b`. It is not source, has no legitimate consumer, and is regenerated on
every web build. It is **not tracked** by Git; the root `.gitignore` ignores
`*.tsbuildinfo` so local builds can still create it.

Other ignored build outputs (`node_modules/`, `web/dist/`, ...) remain ignored
and are intentionally outside the integrity snapshot.

### What the gate checks

`bun run check` now runs the baseline through
`scripts/check-tree-integrity.ts run`:

1. Snapshot the non-ignored working tree before any install/build/test.
2. Run `check:install`, `check:runtime`, `check:web`, and `check:tests` in order.
3. Snapshot again and fail if the tree changed.

The snapshot records `git status --porcelain -z -uall` entries (tracked
modifications, deletions, and untracked files) plus a content hash for every
entry. Entries are stored in a null-prototype map, so Git-valid names such as
`__proto__`, `constructor`, and `toString` are preserved as own entries rather
than falling through to `Object.prototype`. Content is hashed with SHA-256
through a fixed 64 KiB buffer, so auxiliary memory does not scale with file
size; symlinks are represented by their target string.

It fails the gate when:

- a tracked file changes unexpectedly;
- a new non-ignored file appears;
- a preexisting dirty file changes content or status;
- a preexisting change disappears;
- `HEAD` changes;
- `git status` fails (missing git, not a repository, non-zero exit, signal);
- `git rev-parse` fails unexpectedly. A repository with **no commits at all**
  is the only accepted unborn-HEAD case and is recorded as `head: null`; an
  unresolvable HEAD in a repository that has commits fails the gate.

For local runs the checkout does not need to be clean. Preexisting changes are
captured before the gate and are allowed to remain only if their content and
status are unchanged. This avoids hiding a baseline mutation in a file that was
already modified.

CI snapshots the clean checkout before installing dependencies and verifies the
same snapshot after the mandatory tests. A green baseline therefore means the
install, runtime compile, web build, and tests left no tracked or untracked
non-ignored changes behind.

### Test fixture isolation

Legacy `MemoryManager` defaults to `process.cwd()` and creates
`.agent/memory/`. `Orchestrator` accepts an optional `memoryRoot`; the
`SessionManager` suite passes a unique `mkdtemp` directory per test and removes
it in `afterEach`, including on failure. Tests that exercise the real
`loopUntilSuccess` path (including cancel/resume) write memory only under that
temporary root, never the repository.

### Limitations

- Ignored files are not inspected (by design: `node_modules/`, `dist/`,
  `*.tsbuildinfo` are expected outputs).
- A process that changes a file and restores it to the exact prior content
  within the same run is not detected.
- The gate inspects the repository working tree only; files outside it are out
  of scope.
- `git status` is the source of truth for "changed", so files excluded by
  `.gitignore` cannot be asserted about.

## What CI does **not** cover

- Live daemon RPC against real models  
- Full `bun test` including quarantined files  
- TUI interactive runs  
- Web runtime E2E in a browser  
- Docker deployment paths in `docs/DEPLOYMENT.md`  

## Quarantined tests

Authoritative list: [`scripts/quarantine-manifest.json`](../scripts/quarantine-manifest.json).

Issue [#41](https://github.com/Anakyklos/ouroboros-runtime/issues/41) is
resolved. The current manifest has an empty `files` list, so **0 suites are
quarantined**. The quarantine mechanism remains documented for future use; its
presence does not represent active recovery debt.

Printed at the start of every `bun run check:tests` run. The runner **fails** if:

- a quarantine path is missing or renamed (silent disappearance is not allowed);
- the manifest has duplicate paths;
- required fields (`path`, `classification`, `reason`, `reactivate_when`) are empty.

Rules for quarantine:

- Test **names/paths remain visible** (manifest + runner output + file banner `QUARANTINED`)  
- Suites are **not** executed in the mandatory gate  
- Failures are **not** counted as pass  
- Files are **not** deleted or renamed to hide them  
- Each entry must have `tracking_issue` (or inherit the global value)
- Re-enable when the `reactivate_when` condition in the manifest is met.
- Every future entry must name an explicit, current tracking issue; do not
  inherit the manifest's historical `tracking_issue: 41` default.
- Mandatory suite size is not reduced just to keep CI green  
- No `|| true`, `continue-on-error`, or broad silence filters on required checks

Exactly **0 suites remain quarantined**. The manifest's `files` list is empty.
Issue #41's final recovery reactivated `AntiVibeWorkflow.test.ts` in the
mandatory runner after correcting fixture gates, approval-state expectations,
and the spec/report assertions. That issue is closed; no quarantine debt is
active. This restores test coverage for legacy compatibility without changing
Ouroboros product scope: Runstead owns software verification and Cadinho owns
capability promotion/evolution.

## Known limitations

1. **Root `tsc` does not include `web/`** — by design; web has its own `tsconfig` and `check:web`.  
2. **Legacy sandbox suites removed (#83)** — `SandboxRunner`/`SandboxTool`/`SandboxPathUtils` and their five quarantined suites were retired from the core; they are no longer part of the baseline.
3. **`PromotionManager.test.ts` reactivated (#41)** — fixture gates now use deterministic local strategies; a required gate without a strategy rejects the candidate and cannot enter approval.
4. **`tool-executor.test.ts` reconstructed (#85)** — the merge-corrupted suite was rebuilt against the fail-close contract and re-entered the mandatory gate.
5. **`QualityGateRegistry.test.ts` reactivated (#41)** — the two failing cases were assertion-API bugs (`await expect(promise).toThrow()` instead of `.rejects.toThrow()`); the registry already throws distinct `not registered` vs `disabled` errors and fails closed on required-gate failure/exception. The timeout case was made deterministic (strategy-owned timeout, no real sleep) and the suite now runs in the mandatory gate.
6. **README feature claims** are not all `verified` by this baseline; only compile + mandatory tests are.
7. **Tree integrity ignores ignored files** — `node_modules/`, `dist/`, and
   `*.tsbuildinfo` are expected regenerable outputs and are not asserted about.
8. **Write-then-restore is invisible** — the gate compares snapshots before and
   after the run, so a process that restores a file to its exact prior content
   is not detected.

## Negative test expectations

A correct CI / local check **must fail** when:

- Runtime TypeScript is broken → `check:runtime` non-zero  
- Web TypeScript/Vite build is broken → `check:web` non-zero  
- A mandatory unit test fails → `check:tests` non-zero  
- Lockfile out of sync → frozen install non-zero  
- A tracked file is modified unexpectedly → tree integrity non-zero
- A new non-ignored file appears → tree integrity non-zero
- A Git-valid special path (e.g. `__proto__`) is modified or created → tree integrity non-zero
- `HEAD` is unresolvable in a repository with commits → tree integrity non-zero
- Git inspection fails → tree integrity non-zero (never treated as clean)
- A build/test process leaves an unexpected artifact → tree integrity non-zero

Do not use `|| true` or optional steps to hide these failures.

## Daemon operational controls (issue #37)

**Control plane:** `cli/src/daemon/execution-control.ts` (`DaemonExecutionController`).

### Guarantees (exact)

- The daemon **confirms admission closed** after brake/pause.
- For local abortable work it **requests abort** and **waits a bounded settlement** (`DEFAULT_BRAKE_SETTLEMENT_TIMEOUT_MS`).
- **`cancelled_confirmed` requires execution settlement** (provider/loop/tool terminal) — not merely `AbortController.abort()`.
- `Orchestrator.loopUntilSuccess` **awaits** `executeWithTimeout` fully after cancel; it does **not** `Promise.race` away the inner provider/tool.
- `cancel()` before start is **not** cleared by `loopUntilSuccess` — only `resume()` clears `cancelled` (avoids provider start after brake during `appendLog`).
- Wave checks `shouldAbort` before each task/chunk so dependent work never starts after brake.
- Tools already in-flight may not be abortable; if they do not settle in time → `abort_requested_unconfirmed` / **partial**.
- External delegates (Gemini/Antigravity/Jules) may continue remotely → **partial**.
- **Partial ≠ gate failure**: admission is closed; some executions lacked confirmed settlement.
- `setMode(running)` resumes Orchestrators **only after** durable admission reopen succeeds.
- Exact-once resume of cancelled tasks is **not** claimed (`brakeRecoverable: false` / #50).

### State machine
`running` → `paused` | `braking` → `braked` | `degraded`. Admission open **only** in `running`.

`braked` stores `completeness` + `unresolvedWorkCount`. A second brake returns `already_stopped` and **preserves** `complete: false` when the first was partial or work remains unresolved.

### Stop progress
`abort_not_requested` → `abort_requested` → `abort_acknowledged` → `execution_settled`  
(or `detached_remote` / `unsupported`)

### Stop capability by WorkKind (honest)
| Kind | Stop | Brake action |
|------|------|----------------|
| `session_task`, `delegate_glm`, `delegate_glm_wave` | abortable **with settlement** | `cancelled_confirmed` only after settle; else `abort_requested_unconfirmed` |
| `delegate_gemini`, `delegate_antigravity` | request only | `abort_requested_unconfirmed` → aggregate **partial** |
| `delegate_jules` | detached remote | `detached_remote` → **partial**; remote may continue |

GLM Wave: **per-task Orchestrator isolation** (no shared `runAbort` / cancel handles across parallel tasks).

### Brake durability (two phases)
1. Close admission in memory  
2. **Persist `braking` intent** (fail → partial/degraded; no durable claim)  
3. Apply per-kind stop + bounded settlement wait  
4. Persist final `braked complete|partial`  

`clearBrakeAndRun` / resume: persist `running` **before** unpausing leases.

### pause ≠ cancel
Pause is cooperative where wired to the executor; cancel/brake is terminal for local work after settlement. No secrets/prompts in persisted ops state.
