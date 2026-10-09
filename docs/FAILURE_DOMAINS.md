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

**CURRENT observed at the #101 audit:** the package's `daemon` and
`start:headless` scripts launched `cli/src/daemon/main.ts`. At that point it
opened independent daemon/session and Mission SQLite stores, constructed a
Mission engine and an empty in-memory capability registry, then started
`DaemonServer` without a resident Mission scheduler or dispatch seam.

**DIRECTION (#59):** bounded supervision and lifecycle over the durable
execution primitives from #50. Issue #120 adds only the resident Mission
scheduler owner described below; it does not imply a generic supervisor,
worker tree, restart manager, or restart policy.

## Startup and shutdown observed at the #101 audit (before #117)

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
the client's command result can be uncertain. This path was distinct from the
SIGINT/SIGTERM sequence. The following #117 update records the replacement
behavior and its direct evidence.

## Issue #117 lifecycle update

**Implemented and verified:** `main.ts` now owns one
`DaemonShutdownCoordinator`. SIGINT, SIGTERM, and the modern RPC gateway's
injected shutdown request enter the same idempotent sequence. `RpcGateway`
returns the existing `{ status: "shutting_down" }` result and does not call
`process.exit` or own resource cleanup.

The coordinator asks `DaemonServer` to close admission first. The server rejects
new RPC work with HTTP 503, rejects new WebSocket subscriptions, and waits up to
4 seconds for accepted RPC responses to finish. It then unsubscribes projection
listeners, closes projection clients and transport connections, and closes
Fastify. At the #117 implementation point, a failed server stop did not prevent
store close attempts; #129 below corrects this after proving handler-level
quiescence is required. Each coordinator step is bounded to 5 seconds. Failed
or timed-out steps report only their resource stage and outcome. Mission state
is not changed by daemon shutdown.

**Evidence:** `rpc-gateway-lifecycle.test.ts` proves the RPC request reaches the
injected owner without exiting the process. `shutdown-coordinator.test.ts`
proves concurrent signal/RPC requests share one ordered close, both stores are
attempted after failure, diagnostics omit private exception text, and a hung
close is bounded. `daemon-shutdown-race.test.ts` runs the real Fastify/RPC path:
it holds a Mission command open, confirms later requests receive 503, and
confirms the command response completes before stores close. The subprocess E2E
`headless-shutdown.e2e.test.ts` starts the actual Bun daemon against temporary
SQLite files with a live projection WebSocket, shuts it down through RPC,
observes the socket close, restarts it on the same port, reads the Mission and
acknowledged Invocation, then sends SIGTERM and SIGINT together.
The test reopens SQLite and confirms the completed effect's acknowledged
delivery and attempt record are unchanged.

**Limits at the #117 change:** an accepted RPC that does not settle within the
4-second drain window has an unknown outcome. #129 below changes cleanup so
that this uncertainty leaves both SQLite stores open until forced process
termination. The daemon does not cancel or terminalize that Mission. The #120
update below adds bounded scheduler drain; it does not add a general process
supervisor. No production connector is composed here.

## Issue #129 RPC handler quiescence update

**Implemented and verified:** `DaemonServer` tracks each accepted RPC until
both its asynchronous handler has settled and its HTTP response has either
finished or closed. A client disconnect marks only transport completion; it
does not release the operation while a handler may still use SQLite. Graceful
shutdown still waits for a healthy `system.shutdown` response before the
response drain completes.

If the RPC drain exceeds its 4-second bound, the server closes the transport
and reports an uncertain drain. `DaemonShutdownCoordinator` treats an
unsuccessful server stop as lack of quiescence proof and leaves **both** daemon
and Mission SQLite stores open. It still stops the resident scheduler; an
unproved scheduler drain independently keeps MissionStore open. Shutdown
records sanitized stage/outcome diagnostics, sets a nonzero exit code, and
requests forced process termination. Local-control auth resources can close
after RPC admission is closed because authorization is completed before an
operation is admitted. Shutdown does not cancel or terminalize the accepted
Mission operation.

**Evidence:** `daemon-shutdown-race.test.ts` uses a real Fastify listener and
HTTP client abort with temporary SQLite databases. A held Mission command
remains counted while its handler is pending and can still access both stores.
After release, the test requires either one successful drain with each store
closed exactly once, or a reported timeout with both stores left open and
nonzero forced termination. Bun 1.3.9 exercises the conservative timeout path;
Bun 1.4.2 observes transport closure during shutdown and exercises the graceful
path. Companion cases cover handler rejection after disconnect and a
never-settling handler; the latter proves bounded timeout, open stores,
sanitized uncertainty and forced nonzero termination. Existing
connected-response tests preserve `system.shutdown` delivery ordering.
`headless-shutdown.e2e.test.ts` exercises the actual Bun daemon subprocess,
SQLite restart/recovery, concurrent signals, and confirms an acknowledged
invocation is not dispatched again.

**Limits:** a handler that outlives the drain is not cancelled. Its outcome
remains unknown, and a remote effect may still complete independently. The
daemon preserves durable state by leaving both stores open until process
termination; it does not claim distributed exactly-once delivery or permission
to retry/replay. Bun 1.3.9's in-process HTTP compatibility layer does not
surface the child client's close event before the drain deadline, so these tests
prove safe retention on that path rather than graceful completion after the
disconnect. The subprocess restart test verifies the current no-replay behavior
for an already confirmed invocation; no production connector is composed here,
and arbitrary external effects are not covered by that fixture.

## Issue #120 scheduler composition update

**Implemented and verified:** `main.ts` now composes one `MissionScheduler`,
one `ConnectorDispatchSeam` bound to the same registry used by
`PlanPolicyValidator`, and one `MissionSchedulerDriver`. After the listener
starts, the driver begins recovery asynchronously and subscribes to committed
MissionStore changes, coalesces wakeups while one pass is active, and consumes only a valid
future `nextWakeAt` as a one-shot timer. An elapsed wake does not create an
immediate retry loop. Mission creation/state transitions and invocation
creation/completion wake the driver; other store notifications remain facts,
not authority.

Shutdown closes server admission, stops the driver and removes its listener and
timer, then closes daemon storage and MissionStore. The scheduler pass is
drained within the coordinator's step bound. If it does not settle, sanitized
`mission_scheduler/timed_out` and `mission_store/timed_out` facts are reported
and MissionStore is deliberately left open until forced process termination;
no completed/unknown claim is manufactured.

**Evidence:** `mission-scheduler-driver.test.ts` uses an injected clock/timer
for future/expired wakes, concurrent changes, one-pass-at-a-time behavior,
cleanup and sanitized failure reporting. `mission-scheduler-daemon.e2e.test.ts`
composes the actual headless server and SQLite store with test-only typed
connectors: a confirmed effect is invoked once across daemon restart, and an
exception after possible submission stays `blocked/uncertain` without a second
invoke. It also holds an initial invocation pending, verifies the listener is
available, and requests RPC shutdown before allowing the owner result to settle.
`headless-shutdown.e2e.test.ts` starts the actual Bun daemon in a
subprocess and proves a paused non-terminal Mission is recovered on each
restart while its confirmed Invocation remains intact.

**Limits at the #120 composition point:** production still registers no
capability connector. With the default empty registry, planned work with no
connector is recorded as a capability wait; no external integration is
implied by the test fixture. Mission enumeration was still an unbounded
`listMissions()` read at that point; the M1 update below corrects the resident
recovery and scheduling paths. The scheduler has one local runtime owner but
no cross-process lease, so overlapping independent daemon processes are not
covered by an exactly-once guarantee. A pass error is logged as a redacted
failure and is not automatically retried until another relevant durable
change or restart.

## M1 bounded Mission enumeration update

**Current behavior implemented on top of the #127 base (`1087d8a`):**
`MissionStore.listMissionPage()` reads at most the requested Mission page,
ordered by deterministic `created_at DESC, mission_id ASC` keyset position. The
SQLite implementation loads invocation rows only for Mission IDs in that
page, inside the same read transaction. The existing full-history
`listMissions()` API remains available to other consumers.

`MissionScheduler.recoverInternal()` walks every non-terminal Mission page
before marking recovery complete. It calls `recoverMission()` for each
durable ID; that method updates recovery metadata only and does not submit,
retry, cancel, or reconcile an external effect. Scheduling pages only
`READY`, `EXECUTING`, and `WAITING_FOR_CAPABILITY` Missions, while continuing
past pages that contain no ready plan or dispatchable step. The default page
size is 64 and may be configured up to 1024. Existing actionable/due
invocation batch limits and dispatch-slot behavior are unchanged.

The stable keyset does not hold a snapshot across the full scan. A committed
Mission create/state mutation delivered through the resident store observer
wakes the driver for another pass, so a mutation that sorts behind the active
cursor is reconsidered without a periodic polling timer. This is same-store
notification behavior; independent daemon processes remain outside the
single-owner guarantee.

**Evidence:** `sqlite-mission-store.test.ts` traverses 200 Missions in pages of
64 with deterministic order, no duplicate/omitted IDs, a terminal row filtered
out, and an invocation reference attached only to its Mission. The scheduler
tests close/reopen a real SQLite store, recover more than three pages of
non-terminal rows, continue after a read failure without dispatch, discover a
planned Mission after pages with no planned work, and use the driver to
revisit an eligible Mission inserted behind the keyset cursor. Existing
restart tests continue to prove confirmed effects are not invoked again and
uncertain handoffs remain blocked for reconciliation.

**Limits:** page size bounds Mission rows loaded per enumeration query, not
total scheduler memory. A Mission can have many invocation rows, and recovery
reports retain all recovered IDs to preserve report semantics. No production
impact benchmark is claimed. No extra timer, polling loop, public Mission v1
contract change, or scheduler parallelism was introduced.

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
  headless composition. **Corrected in #117/#129:** RPC `system.shutdown` uses
  graceful cleanup, and a disconnected accepted handler remains in the drain
  until it settles. If the bounded RPC drain expires, both stores remain open
  through forced termination; the command outcome remains unknown. Relevant
  code: `server.ts`, `shutdown-coordinator.ts`, `main.ts`,
  `session-manager.ts:71-121,362-470,947-1003`, and
  `execution-control.ts:493-520,1311-1400`.

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

- **Construction and callers:** `MissionScheduler` remains the one-shot
  authority in `cli/src/mission/mission-scheduler.ts`. `main.ts` composes one
  instance with `ConnectorDispatchSeam`; `MissionSchedulerDriver` owns
  startup/recovery, mutation wakeups, the single `nextWakeAt` timer, and
  shutdown.
- **Driver and wakeup:** the driver listens to committed durable Mission
  creation/state changes and invocation creation/completion. It coalesces
  simultaneous notifications and serializes passes. A future timestamp creates
  one timer; a missing, invalid, or elapsed timestamp creates none. No periodic
  polling is used. The driver removes listeners and cancels timers on stop.
- **If invoked directly:** recovery visits every non-terminal Mission through
  `listMissionPage()` and calls `recoverMission()` without submitting an
  effect. Mission enumeration uses deterministic keyset pages (default 64);
  invocation rows are loaded only for the Mission IDs in each page. A pass
  queries actionable invocations with default batch size 64 and due invocations
  with the same bound; default `maxInFlight` is 1 and connector calls are
  awaited sequentially, so this is a per-pass dispatch-slot bound, not
  concurrent parallelism. The cross-process exactly-once guarantee is
  explicitly out of scope. Only `waiting_for_capability` is conditionally
  reconsidered; approval, context, provider, and budget waits are not
  automatically promoted.
- **Effect/retry semantics:** it reconciles/cancels persisted actionable work
  first; retries only eligible, due, definitely-not-submitted work after the
  engine's explicit retry transition. Completed effect fingerprints and legacy
  replay barriers prevent a second logical effect. `nextWakeAt` comes from
  durable invocation retry timestamps.
- **Evidence / limits:** `mission-scheduler.test.ts`,
  `mission-scheduler-driver.test.ts`, `mission-scheduler-daemon.e2e.test.ts`,
  and `headless-shutdown.e2e.test.ts` cover one-shot scheduling, durable
  recovery, fixture dispatch, confirmed-effect idempotency, uncertain delivery,
  wake coalescing and process restart. **P2:** recovery's `listMissions()` scan
  was unbounded at the #120 audit point; the M1 update above bounds Mission
  rows per enumeration query. Total scheduler memory is not claimed bounded:
  report ID arrays and invocation fan-out for an individual Mission can still
  grow with durable data. Relevant code: `mission-scheduler.ts`,
  `sqlite-mission-store.ts`, `mission-scheduler-driver.ts`, and `main.ts`.

### 5. Capability Registry, connector dispatch, and invocation uncertainty

- **Lifecycle owner / state:** `CapabilityRegistry` owns an in-memory map of
  versioned descriptors and availability. `ConnectorDispatchSeam` owns an
  in-memory map of bound connectors for its instance. `main.ts` composes the
  seam and scheduler against the same registry used for policy. Production
  leaves the registry empty and registers no connector; deterministic typed
  fixtures are injected only by tests. Registry/connector maps remain volatile.
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
- **Evidence / limit:** `dispatch-seam.test.ts` and
  `mission-scheduler.test.ts` cover pre-mint rejection, uncertain invoke
  failure, reconciliation, and no blind replay after restart. Production
  intentionally has no registered connector, so real module-owner dispatch
  remains unavailable until an authorized integration is supplied. **P2:** no
  generic invocation timeout exists at the seam; the resident owner preserves
  uncertain delivery rather than treating a timeout as non-delivery.
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
  events per client and the default buffered socket limit is 1 MiB. The
  projection map also owns a finite aggregate limit of 64 reservations/clients
  by default (`maxProjectionClients` may configure a positive safe integer).
  The slot is reserved after authentication, scope and Origin checks, before
  WebSocket upgrade and snapshot I/O. At capacity the daemon returns HTTP 503
  without a snapshot or connected-client/timer registration. A pre-upgrade
  request error, abort or cleanup releases its reservation. After upgrade, the
  slot remains counted while the socket is active or closing: sending a close
  frame for revocation, expiry or snapshot failure does not release capacity;
  only the socket's actual `close` or `error` event does. Shutdown terminates
  upgraded sockets and relies on that same transport event for release.
  Exceeding a per-client bound, an invalid socket, snapshot
  read failure, or send exception closes only that client. The default 64 is a
  bounded fan-out choice alongside the existing per-client limits, not a
  measured memory budget: at most 2,048 handshake event entries can be queued
  across 64 clients, while buffered bytes remain governed per socket. There is
  no history replay.
- **Restart / truth / uncertainty:** sequence, clients, and pending handshake
  events are volatile and reset on process restart. A reconnect obtains a
  current snapshot; disconnect does not cancel, retry, or replay Mission or
  connector effects. A missed transient event is not recovered as an event,
  but current durable facts can be reconstructed from the snapshot. The stream
  does not promise distributed exactly-once delivery and is not Mission truth.
- **Evidence / gap:** `daemon-projection.test.ts` covers the finite default,
  configured admission, handshake reservations, cleanup and per-client
  backpressure/failure. `local-control-auth.e2e.test.ts` exercises concurrent
  handshakes through real Fastify/WebSocket with temporary SQLite, capacity
  rejection without snapshot, continued healthy event delivery and RPC,
  revocation/disconnect release, and shared auth-timer ownership.
  `DAEMON_EVENT_CONTRACT.md` documents reconnect from snapshot. **P2:** this is
  a cardinality bound, not a process-wide byte budget; transient event history
  is still not persisted or replayed. Relevant code:
  `event-bus.ts:127-150`, `daemon-projection.ts`, `server.ts`.

## Persistence ownership summary

| State | Owner / authority | Persistence class | Restart behavior |
|---|---|---|---|
| Session, wave, checkpoint, session memory, audit rows | `SqliteAdapter` / daemon session domain | Durable in `daemon.db` | Rows remain; runtime worker maps are not rebuilt by modern composition |
| Daemon mode/brake summary | `DaemonExecutionController` | Durable file when a control transition persists | Loaded on construction; corrupt/unknown state degrades; no active leases restored |
| Mission, accepted plan, invocation, retry/delivery/reconciliation | `SqliteMissionStore` / Mission authority | Durable in `missions.db` | Rows reopen; one daemon-local scheduler recovers eligible work from durable state |
| Capability descriptors and connector instances | Registry / seam | Volatile | Must be recomposed; production registry currently remains empty |
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
- **P1 residual:** an accepted RPC or scheduler pass that exceeds its bounded
  drain can retain an unknown outcome. On RPC uncertainty, both SQLite stores
  remain open until forced process termination; on scheduler uncertainty,
  MissionStore remains open. No retry/replay is authorized by this uncertainty.
- **P2:** persisted active session rows have no worker reconstruction in the modern
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
