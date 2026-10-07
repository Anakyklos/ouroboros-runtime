# Current Failure Domains and Lifecycle Ownership

> Audit/design for issue #101. This document records behavior observed in the
> code and tests; it does not implement the supervision direction in #59.

## Evidence boundary

Audit performed 2026-10-07 against the fetched `origin/main` at
`575deba140aae152e4cbbc5f9899b6e715a17360`. The preflight `git fetch origin`
succeeded (`0bbfb4c..575deba main -> origin/main`) before this isolated worktree
was created. A second fetch from inside the Codex sandbox could not update the
shared `FETCH_HEAD` and could not resolve `github.com`; that sandbox limitation
does not change the verified preflight base SHA. The live #101 and #59 issue
bodies were fetched via `gh issue view` before dispatch: #101 had no comments,
and #59 had a maintainer follow-up on supervision boundaries. Current claims
below are grounded in code/tests; Direction is limited to the approved #59
semantics and the repository architecture statement in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Current and Direction

**CURRENT observed:** the package's `daemon` and `start:headless` scripts launch
`cli/src/daemon/main.ts`. It opens independent daemon/session and Mission SQLite
stores, constructs a Mission engine and an empty in-memory capability registry,
then starts `DaemonServer`. Its default RPC gateway exposes daemon status/mode/
brake, read-only session reads, Mission reads, and pause/resume/cancel commands.
No resident Mission scheduler or connector dispatch seam is composed there.

**DIRECTION (#59):** bounded supervision and lifecycle over the durable
execution primitives from #50. This audit does not treat a scheduler, worker
tree, restart manager, or restart policy as implemented. The concrete boundary
to audit is the composition and behavior that exists above.

## Startup and shutdown observed

```text
package daemon / start:headless
  -> main(): attach global EventBus log listeners
  -> mkdir(.ouroboros)
  -> SqliteAdapter(.ouroboros/daemon.db).initialize()
  -> SqliteMissionStore(.ouroboros/missions.db).initialize()
  -> CapabilityRegistry() -> PlanPolicyValidator -> MissionEngine
  -> read active daemon sessions
  -> DaemonServer(...)
       -> default RpcGateway -> SessionManager / DaemonExecutionController
       -> DaemonProjection + MissionStore mutation subscription
  -> register SIGINT/SIGTERM handlers
  -> server.start(): WebSocket plugin/routes/listener -> ready event

SIGINT/SIGTERM:
  -> server.stop(): unsubscribe + close projection clients/connections + app.close()
  -> SqliteAdapter.close()
  -> SqliteMissionStore.close()
  -> process.exit(0)
```

Evidence: `package.json` scripts; `cli/src/daemon/main.ts:18-95`;
`cli/src/daemon/server.ts:47-89,158-166,219-263`; and
`cli/src/daemon/rpc-gateway.ts:24-50`.

The order is sequential and has no application-level rollback/finally path:
startup failure reaches `main().catch()` and exits; failure in `server.stop()`
or either store close skips later close calls. Signal handlers are installed
after both stores and the server object are initialized. RPC `system.shutdown`
returns and schedules `process.exit(0)` after 100 ms; it does not call
`DaemonServer.stop()` or either store's `close()` (`rpc-gateway.ts:109-124`).
That timer can interrupt in-flight RPC work, including a Mission command, so
the client's command result can be uncertain. This path is distinct from the
SIGINT/SIGTERM sequence.

## Domain inventory

### 1. Process, transport, RPC, and daemon/session control

- **Lifecycle owner / construction:** `main()` owns construction and the signal
  shutdown sequence. `DaemonServer` owns Fastify routes, event subscriptions,
  the projection instance, and WebSocket clients; `RpcGateway` constructs one
  `SessionManager`. `server.stop()` removes subscriptions and closes clients
  and Fastify. It does not call a `SessionManager.close()` or drain a scheduler.
- **State and durability:** Fastify state, connected clients, RPC method map,
  SessionManager's `activeOrchestrators`, `activeTasks`, `sessionWaves`, and
  checkpoint interval handles are volatile. The `DaemonExecutionController`
  stores daemon operational state in `.ouroboros/daemon-ops.json` by default,
  using a temporary file and rename. This file is not a work queue or task
  checkpoint store. `daemon.db` separately stores session records, waves,
  checkpoints, session memory, and audit entries.
- **Dependencies and propagation:** RPC reads/commands call the gateway's
  manager, Mission store, or Mission command authority. The gateway converts
  thrown handler errors into JSON-RPC errors; `LocalControlCommandService`
  returns typed command failures. Process supervision/restart is outside this
  composition. Daemon control persistence errors return a rejected or degraded
  result; the controller loads corrupt/unknown ops state as degraded.
- **Wait, retry, cancellation, concurrency:** emergency brake closes admission
  and persists the braking intent before requesting aborts. Local task
  settlement is bounded; the manager uses a 3-second brake settle race and
  default cleanup of up to 3 iterations of 5 seconds. Unsupported or detached
  work is reported partial, not confirmed cancelled. These controls exist in
  `SessionManager`, but the modern RPC methods are session list/get plus daemon
  status/mode/brake; they do not create or resume a legacy agent task. There is
  no global RPC queue/concurrency bound configured by `DaemonServer`.
- **Restart and legacy reachability:** the ops file restores mode/brake facts;
  in-memory leases and SessionManager task maps do not survive restart. The
  daemon logs active rows found in `daemon.db`, but the modern RPC surface only
  reads those sessions and does not rebuild their workers. The old interactive
  `daemon/loop.ts`, `LegacyRpcGateway`, `GatewayOrchestrator`, and provider/agent
  workers are not composed by the package `daemon`/`start:headless` entrypoint;
  `headless-composition.test.ts` explicitly guards against importing the
  legacy execution modules.
- **Evidence / gap:** `session-manager.test.ts` covers persisted brake state
  across manager re-instantiation and bounded settlement behavior. **P2:**
  persisted active session rows have no worker reconstruction owner in this
  headless composition. **P1:** RPC `system.shutdown` bypasses the graceful
  cleanup sequence and can leave an in-flight command's outcome unknown.
  Relevant code: `session-manager.ts:71-121,362-470,947-1003`,
  `execution-control.ts:493-520,1311-1400`, and
  `rpc-gateway.ts:109-159`.

### 2. Daemon/session SQLite and durable Mission SQLite

- **Lifecycle owner / creation / close:** `main()` creates and initializes
  `SqliteAdapter('.ouroboros/daemon.db')`, then a separate
  `SqliteMissionStore()` whose default is `.ouroboros/missions.db`; SIGINT/
  SIGTERM closes them in that order, after `server.stop()`. Each owns its own
  SQLite connection and WAL; there is no cross-database transaction.
- **State authority:** daemon/session rows are authority for the legacy session
  domain. Mission, plan revision, and complete sanitized invocation rows in
  MissionStore are the durable executive authority. Invocation state includes
  stable identity, delivery, retry eligibility, attempt, cancellation,
  reconciliation, result references, and owner-verification facts. Connector
  private state remains with its module owner; it is not copied into either
  Ouroboros database.
- **Failure / persistence:** SQLite exceptions propagate from the stores; no
  in-memory worker copy is promoted over a failed durable write. MissionStore
  rejects raw-secret patterns recursively and applies conservative defaults to
  migrated rows. Committed Mission mutations notify observers after the write;
  observer exceptions are swallowed so they cannot undo a committed fact.
- **Concurrency / waits / restart:** MissionStore serializes its local
  transaction chain and queries due/actionable invocations with explicit
  limits. SQLite WAL is enabled in both adapters. Reopening reconstructs rows,
  not active connector/session workers. A legacy invocation lacking sufficient
  delivery identity is restored as `uncertain` with reconciliation
  `unsupported`, not as replay permission.
- **Evidence / gap:** `sqlite-mission-store.test.ts` and
  `durable-mission-execution.test.ts` cover reopen/migration, uncertainty, and
  secret rejection. **P2:** separate databases mean daemon-session state,
  daemon ops state, and Mission state have no atomic joint commit; callers must
  treat each owning store as authoritative only for its own records. Relevant
  code: `sqlite.adapter.ts:12-102`,
  `sqlite-mission-store.ts:192-245,593-625,1477-1503`.

### 3. MissionEngine and Mission command boundary

- **Lifecycle owner:** `MissionEngine` owns deterministic Mission transitions;
  its injected `MissionStore` owns persistence. The headless daemon passes the
  engine to `LocalControlCommandService`, which accepts versioned
  `mission.pause`, `mission.resume`, and `mission.cancel` commands and delegates
  each once to the engine.
- **State / semantics:** waiting states are durable Mission states, not process
  failures. Pause/resume/cancel alter Mission state through the store; they do
  not themselves submit connector effects. Planning is advisory and deterministic
  policy remains the authorization boundary. Persistence failure prevents a
  command from being reported as a durable success.
- **Cancellation / timeout / restart:** MissionEngine defines and persists
  cancellation and retry/reconciliation facts, but no per-Mission runtime
  timeout or resident cancellation worker is installed by `main.ts`. Restart
  keeps the Mission rows; it does not schedule them.
- **Evidence / gap:** `mission-engine.test.ts`,
  `local-control-command.test.ts`, and durable execution tests cover state
  transitions and command validation. **P1:** the modern composition can expose
  durable Mission state and control commands without owning progression after
  a command or restart; the scheduling gap below is the operative limitation.
  Relevant code: `mission-engine.ts`, `local-control-command.ts:16-103`,
  `rpc-gateway.ts:152-159`.

### 4. MissionScheduler and restart/recovery ownership

- **Construction and callers:** `MissionScheduler` is defined in
  `cli/src/mission/mission-scheduler.ts`; repository search found no production
  construction outside tests. No production caller invokes `recover()` or
  `runOnce()`. `runOnce()` calls `recover()` internally when it is called.
- **Driver and wakeup:** the scheduler explicitly owns no resident timer and
  does not sleep. It returns `nextWakeAt`; no daemon, CLI, or service consumes
  that value in the current headless composition. No timer, event wakeup, or
  external driver is wired here. No owner resumes stored Missions after daemon
  restart. Current daemon exposes Mission facts and pause/resume/cancel only;
  it does not run resident Mission scheduling.
- **If invoked directly:** recovery visits each non-terminal Mission and calls
  `recoverMission()` without submitting an effect. A pass queries actionable
  invocations with default batch size 64 and due invocations with the same
  bound; default `maxInFlight` is 1 and the connector calls are awaited
  sequentially, so this is a per-pass dispatch-slot bound, not concurrent
  parallelism. The cross-process exactly-once guarantee is explicitly out of
  scope. Recovery's `listMissions()` walk has no batch limit. Only
  `waiting_for_capability` is conditionally reconsidered; approval, context,
  provider, and budget waits are not automatically promoted.
- **Effect/retry semantics:** it reconciles/cancels persisted actionable work
  first; retries only eligible, due, definitely-not-submitted work after the
  engine's explicit retry transition. Completed effect fingerprints and legacy
  replay barriers prevent a second logical effect. `nextWakeAt` comes from
  durable invocation retry timestamps.
- **Evidence / gaps:** `mission-scheduler.test.ts` covers recovery,
  `nextWakeAt`, restart reconciliation without a second invoke, and sharing a
  single pass for overlapping calls in one instance. **P1:** no production
  caller means there is currently no automatic recovery, reconciliation,
  dispatch, or wakeup consumption. **P2:** the recovery Mission scan is
  unbounded even though actionable/due invocation reads are bounded. Relevant
  code: `mission-scheduler.ts:47-99,102-121,129-188,314-325`.

### 5. Capability Registry, connector dispatch, and invocation uncertainty

- **Lifecycle owner / state:** `CapabilityRegistry` owns an in-memory map of
  versioned descriptors and availability. `ConnectorDispatchSeam` owns an
  in-memory map of bound connectors for its instance. The modern `main.ts`
  constructs an empty registry for policy validation, but does not construct a
  `ConnectorDispatchSeam`, register descriptors/connectors, or compose a
  scheduler. Registry/connector maps therefore are not durable production
  worker state in this entrypoint.
- **Dependencies / failure propagation:** if the seam is composed elsewhere,
  it checks registered identity, availability, policy/descriptor agreement,
  version/schema, and persisted invocation identity before the single
  effectful `invoke()`. Pre-mint rejection creates no invocation. An exception
  after entering `invoke()`, mismatched request identity, or untrustworthy
  result is recorded as blocked/uncertain; it is not converted into definitive
  failure or blind replay. Supported cancellation and reconciliation use
  separate declared connector operations. No generic timeout wraps `invoke()`.
- **Queue / restart / idempotency:** there is no connector queue or concurrency
  limit in the seam itself. Durable invocation state and effect fingerprints
  live in MissionStore; connector objects and owner-private operation state do
  not. A restarted process must recompose its registry/connector bindings. A
  possibly submitted invocation must be reconciled from its durable request
  identity or remain blocked; its in-memory connector state is not authority.
- **Evidence / gap:** `dispatch-seam.test.ts` and
  `mission-scheduler.test.ts` cover pre-mint rejection, uncertain invoke
  failure, reconciliation, and no blind replay after restart. **P1:** the
  modern daemon has no production dispatch/recovery owner. **P2:** no generic
  invocation timeout exists at the seam; any future owner must preserve the
  uncertain-delivery barrier rather than treating timeout as non-delivery.
  Relevant code: `registry.ts:143-156,197-201`,
  `dispatch-seam.ts:260-291,304-403,412-423,676-681,894`.

### 6. ProviderResilience boundary and snapshots

- **Reachability:** `ProviderResilience` is not constructed by `daemon/main.ts`
  or the current headless Mission path. `InferenceSubsystem` constructs it
  when that subsystem is instantiated; the repository's construction path is
  through the legacy `GatewayOrchestrator`, not the package's modern daemon
  entrypoint.
- **State / owner:** retry policy, quota buckets, circuit breakers, in-flight
  counters, and waiters live in memory. `snapshot()` exports quota,
  concurrency, and breaker data; `restore()` restores quota and circuit
  cooldowns only. In-flight concurrency state is intentionally process-local
  and is not restored. No durable provider snapshot store or automatic
  snapshot/restore caller is wired into the modern composition.
- **Wait / retry / cancellation:** calls use bounded retry and per-execution
  time budgets (default five minutes), honor `AbortSignal`, and can wait on
  configured quota/concurrency/circuit boundaries. Timeouts/cancellation are
  classified as non-retryable because delivery may be uncertain. Explicitly
  allowed provider fallback is distinct from Mission retry and does not alter
  Mission truth. The provider boundary owns neither scheduling nor durable
  Mission resumption.
- **Queue / evidence / gap:** configured concurrency caps active calls per
  `(providerId, credentialScope)`, but its waiter array has no queue-length
  limit. `provider-resilience.test.ts` covers bounds, cancellation, snapshot/
  restore, and sensitive-field exclusion. **P2:** if a future Mission consumer
  relies on persisted provider cooldowns, that consumer must explicitly own
  snapshot persistence/restore; the current provider snapshot is not authority.
  Configured provider waiters also have no count-based admission limit. Relevant
  code: `provider-resilience.ts:1030-1071,1131-1190` and
  `InferenceSubsystem.ts:130,254`.

### 7. EventBus, durable projection, and WebSocket clients

- **Lifecycle owner / state:** the process owns `globalEventBus`; it has
  synchronous in-memory listeners and no durable event queue. `DaemonServer`
  owns the wildcard forwarding subscription and removes it on stop. A
  `DaemonProjection` owns per-client handshake state and a process-local
  sequence counter. Durable Mission mutations feed events only after their
  store write; the snapshot callback reads current daemon/Mission facts from
  the RPC gateway and durable stores.
- **Propagation / backpressure:** EventBus redacts values and catches listener
  exceptions. Public event types/payloads are allowlisted. Projection sends a
  snapshot before queued handshake events; default handshake capacity is 32
  events per client and the default buffered socket limit is 1 MiB. Exceeding
  either limit, an invalid socket, snapshot read failure, or send exception
  closes only that client. There is no history replay and no total connected
  client cap.
- **Restart / truth / uncertainty:** sequence, clients, and pending handshake
  events are volatile and reset on process restart. A reconnect obtains a
  current snapshot; disconnect does not cancel, retry, or replay Mission or
  connector effects. A missed transient event is not recovered as an event,
  but current durable facts can be reconstructed from the snapshot. The stream
  does not promise distributed exactly-once delivery and is not Mission truth.
- **Evidence / gap:** `daemon-projection.test.ts` covers bounded handshake,
  slow-client isolation, send failure, and snapshot failure; `DAEMON_EVENT_CONTRACT.md`
  documents reconnect from snapshot. **P2:** per-client buffers are bounded,
  but total clients and transient event history are not bounded/persisted.
  Relevant code: `event-bus.ts:127-150`,
  `daemon-projection.ts:34-72,79-105,127-203`, `server.ts:91-155`.

## Persistence ownership summary

| State | Owner / authority | Persistence class | Restart behavior |
|---|---|---|---|
| Session, wave, checkpoint, session memory, audit rows | `SqliteAdapter` / daemon session domain | Durable in `daemon.db` | Rows remain; runtime worker maps are not rebuilt by modern composition |
| Daemon mode/brake summary | `DaemonExecutionController` | Durable file when a control transition persists | Loaded on construction; corrupt/unknown state degrades; no active leases restored |
| Mission, accepted plan, invocation, retry/delivery/reconciliation | `SqliteMissionStore` / Mission authority | Durable in `missions.db` | Rows reopen; no production scheduler resumes them |
| Capability descriptors and connector instances | Registry / seam | Volatile | Must be recomposed; no seam is wired in `main.ts` |
| Provider retry/quota/circuit state | `ProviderResilience` | Volatile unless an external consumer persists a snapshot | Quota/circuit can be restored explicitly; in-flight concurrency is not restored |
| EventBus listeners, WebSocket clients, sequence, handshake queue | Process / `DaemonProjection` | Volatile, reconstructible only as current snapshot facts | Clients reconnect; cursor starts fresh; no historical replay |
| Module-owner private effect state | Respective module owner | Outside Ouroboros authority | Reconciliation only through that owner's declared connector contract |

## Gaps by severity

Severity basis for this audit: **P0** means direct evidence of a critical
invariant/security/data-loss failure; **P1** means a production lifecycle or
durable-resumption ownership gap, or a control path that can leave a durable
command outcome unknown; **P2** means a bounded limitation or missing guard
whose impact is narrower and does not itself prove an unsafe effect. Severity
describes the observed gap, not an asserted incident.

- **P0:** none identified by this code audit.
- **P1:** Mission scheduling/recovery/wakeup is not composed in production;
  durable non-terminal Mission rows therefore have no automatic resumption
  owner in this daemon. RPC `system.shutdown` bypasses graceful cleanup and can
  interrupt in-flight command responses.
- **P2:** startup/shutdown lack compensating cleanup on intermediate failure;
  persisted active session rows have no worker reconstruction in the modern
  composition; scheduler recovery scans all Missions without a batch bound;
  provider snapshots are not automatically persisted/restored and configured
  provider waiters have no count bound; projection bounds each client but not
  total clients or event history; no connector invoke timeout is defined at
  the seam.

These severities classify the observed control-plane gap, not a claim that a
particular external effect occurred. An absent caller/wiring is directly
observed; a specific runtime impact under a future composition is an inference
and is labeled as such above.

## Single lowest-risk candidate for a future supervisor proof

**One `DaemonProjection` WebSocket client session** is the recommended first
failure domain. Its work is read-only; its volatile state is a handshake buffer
and connection; current durable facts can be rebuilt from the authoritative
snapshot; and current code already isolates client send/backpressure/snapshot
failure to that client. Tests prove a failing or slow client is closed without
blocking a healthy sibling. A proof over this one lifecycle would not own
Mission state, authorize a connector effect, or make an uncertain delivery
replayable. Keep the existing daemon as lifecycle owner and do not infer a
general process/worker supervisor from this candidate.

## Evidence index

- Composition/lifecycle: `cli/src/daemon/main.ts`,
  `cli/src/daemon/server.ts`, `cli/src/daemon/rpc-gateway.ts`,
  `cli/src/daemon/headless-composition.test.ts`.
- Session/control state: `cli/src/daemon/session-manager.ts`,
  `cli/src/daemon/execution-control.ts`, `cli/src/daemon/session-manager.test.ts`,
  `cli/src/adapters/sqlite.adapter.ts`.
- Mission authority/recovery: `cli/src/mission/mission-engine.ts`,
  `cli/src/mission/mission-scheduler.ts`, `cli/src/mission/sqlite-mission-store.ts`,
  `cli/src/mission/mission-scheduler.test.ts`,
  `cli/src/mission/durable-mission-execution.test.ts`.
- Capability delivery: `cli/src/capabilities/registry.ts`,
  `cli/src/capabilities/dispatch-seam.ts`, `cli/src/capabilities/dispatch-seam.test.ts`.
- Provider boundary: `cli/src/inference/provider-resilience.ts`,
  `cli/src/inference/InferenceSubsystem.ts`,
  `cli/src/inference/__tests__/provider-resilience.test.ts`.
- Projection: `cli/src/daemon/event-bus.ts`,
  `cli/src/daemon/daemon-projection.ts`,
  `cli/src/daemon/durable-projection.ts`,
  `cli/src/daemon/daemon-projection.test.ts`, `docs/DAEMON_EVENT_CONTRACT.md`.
