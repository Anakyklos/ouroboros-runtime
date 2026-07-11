# Repository baseline (issue #35)

This document describes the **reproducible validation gate** for Ouroboros. It is the source of truth for what “green” means today.

## Runtime requirements

| Tool | Version |
|------|---------|
| Bun  | **1.3.9** (pinned in CI via `packageManager` / workflow) |
| Python | Optional for sandbox E2E; **not** required for mandatory CI |

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
| `bun run check:install` | Root + web install with frozen lockfiles; no tracked file drift |
| `bun run check:runtime` | Root TypeScript project compiles (`tsc` → CLI/runtime/scripts) |
| `bun run check:web` | Web app typechecks and Vite production build succeeds |
| `bun run check:tests` | **Mandatory** unit tests pass; quarantined suites listed, not counted green |
| `bun run check` | All of the above, in order |

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
3. `bun install --frozen-lockfile` (root)  
4. `bun install --frozen-lockfile` (web)  
5. Fail if install dirtied the git tree  
6. `bun run check:runtime`  
7. `bun run check:web`  
8. `bun run check:tests`  

Properties:

- No API keys / secrets  
- No paid model calls  
- No `continue-on-error` on mandatory steps  
- Minimal permissions (`contents: read`)

## What CI does **not** cover

- Live daemon RPC against real models  
- Sandbox / Python venv E2E security suites (quarantined)  
- Full `bun test` including quarantined files  
- TUI interactive runs  
- Web runtime E2E in a browser  
- Docker deployment paths in `docs/DEPLOYMENT.md`  
- Gemini review workflows (separate, require secrets)

## Quarantined tests

Authoritative list: [`scripts/quarantine-manifest.json`](../scripts/quarantine-manifest.json).

**Recovery debt tracker:** [issue #41](https://github.com/RenyEnnos/ouroboros-runtime/issues/41)  
(field `tracking_issue` in the manifest). Issue **#35** only establishes the baseline gate; it must not be the sole tracker after close.

Printed at the start of every `bun run check:tests` run. The runner **fails** if:

- a quarantine path is missing or renamed (silent disappearance is not allowed);
- the manifest has duplicate paths;
- required fields (`path`, `classification`, `reason`, `reactivate_when`) are empty.

Rules for quarantine:

- Test **names/paths remain visible** (manifest + runner output + file banner `QUARANTINED`)  
- Suites are **not** executed in the mandatory gate  
- Failures are **not** counted as pass  
- Files are **not** deleted or renamed to hide them  
- Each entry has `tracking_issue` (or inherits global) — currently **#41**  
- Re-enable when the `reactivate_when` condition in the manifest is met; track progress on **#41**  
- Mandatory suite size is not reduced just to keep CI green  
- No `|| true`, `continue-on-error`, or broad silence filters on required checks

Current quarantined files (summary):

| File | Classification |
|------|----------------|
| `cli/src/runtime/SandboxE2E.test.ts` | test-bug + environment |
| `cli/src/runtime/SandboxRunner.test.ts` | environment / CI |
| `cli/src/runtime/SandboxEscapeTests.test.ts` | environment / load failure |
| `cli/src/runtime/SandboxResourceLimits.test.ts` | environment / load failure |
| `cli/src/runtime/SandboxSecurity.test.ts` | environment / CI |
| `cli/src/orchestration/AntiVibeWorkflow.test.ts` | product/test partial fail |
| `cli/src/orchestration/PromotionManager.test.ts` | product partial fail |
| `cli/src/orchestration/QualityGateRegistry.test.ts` | product/test partial fail |
| `cli/src/orchestration/SkillLoader.test.ts` | external path dependency |
| `cli/src/providers/tool-executor.test.ts` | broken syntax (merge damage) |
| `web/src/stores/mission-control-store.test.ts` | stale/store mismatch |

## Known limitations

1. **Root `tsc` does not include `web/`** — by design; web has its own `tsconfig` and `check:web`.  
2. **Sandbox suites need Python venv** — not part of mandatory CI until hermetic.  
3. **Several orchestration promotion tests fail** against current product status transitions — tracked as quarantine, not fixed in #35.  
4. **`tool-executor.test.ts` is syntactically corrupted** — must be rebuilt before re-entry.  
5. **README feature claims** are not all `verified` by this baseline; only compile + mandatory tests are.

## Negative test expectations

A correct CI / local check **must fail** when:

- Runtime TypeScript is broken → `check:runtime` non-zero  
- Web TypeScript/Vite build is broken → `check:web` non-zero  
- A mandatory unit test fails → `check:tests` non-zero  
- Lockfile out of sync → frozen install non-zero  

Do not use `|| true` or optional steps to hide these failures.
