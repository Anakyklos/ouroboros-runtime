# Local IPC transport spike (#100)

**Decision: `HYBRID` (recommendation for maintainer review).** Keep the current
loopback HTTP/JSON-RPC and WebSocket listener operational. The isolated UDS
adapter has proven parity for the complete v1 read contract and showed lower
round-trip latency in this host run. If a transport implementation follows,
prefer UDS for the local read-only control contract while retaining loopback
for typed Mission commands and event streaming until those paths have their
own parity and security evidence. This spike does not wire UDS into production
or make that follow-up an architectural mandate.

## Scope and source

- Issue #100 was open and marked `ready` + `research-gated` when checked.
  #97's dependency was completed through merged PR #107. No competing open PR
  for #100 was listed.
- Revalidated `origin/main` and measured base: `ee9bdaeb096bbfab9229c48ec7e17376f30b8d58`.
- The current daemon remains the existing Fastify listener. The experiment is
  an independently startable read-only adapter; it does not modify daemon
  composition, Mission authority, command authority, stores, policy, registry,
  scheduler, or locks.
- The transport-neutral `shared/local-control-read-contract.ts` v1 is the
  semantic boundary. Both adapters receive the same requests and call the same
  `LocalControlReadService` backed by one isolated SQLite fixture.

## Experimental UDS framing and safety

- Linux `AF_UNIX` stream socket using one UTF-8 JSON value followed by `\n` per
  request and response. The server handles requests in order on a connection;
  clients may reconnect for a new request.
- Supported messages are the complete v1 read contract: negotiation, health,
  status, Mission list/show, Invocation list/show, capability registry list,
  and diagnostics list. Existing service validation remains authoritative.
- Maximum request is 64 KiB; maximum response is 1 MiB; at most 16 queued
  messages per client. Oversize input closes the connection. Malformed JSON
  receives the contract's sanitized `INVALID_REQUEST` response. Incompatible
  versions fail closed.
- The parent directory must already exist, be a real directory owned by the
  current user, and have owner-only mode `0700`. Socket mode is set and
  verified as `0600`. A symlink or non-socket at the socket path is rejected.
  An existing live socket is rejected. A stale socket is removed only after
  `ECONNREFUSED`/`ENOENT`, owner validation, and a second device/inode check.
- The adapter exports reads only. Possessing the socket adds no Mission,
  command, dispatch, or provider authority. Linux peer credentials are not
  available through the Bun/Node `net.Socket` API used here; the enforced
  boundary is the current UID and owner-only filesystem permissions. Other
  processes under the same UID can connect.
- Parent directory ownership/mode and socket inode are checked around bind,
  chmod, stale cleanup, and shutdown. A same-UID process can still race path
  replacement inside its own directory; this is within the same-user boundary
  and should be reconsidered if that boundary changes.

## Parity, lifecycle, and limits exercised

`cli/src/daemon/local-control-uds.test.ts` runs the real loopback HTTP/JSON-RPC
server and UDS listener against a real temporary SQLite MissionStore and the
same read service. It compares every contract-v1 operation, normalizing only
legitimately variable runtime identity/timestamp fields. It also verifies
version rejection, invalid JSON, maximum-list rejection, oversized requests,
independent concurrent clients, missing daemon behavior, socket permissions,
public-directory rejection, symlink/non-socket rejection, live/stale socket
handling, reconnect, UDS shutdown, and restart on the same path. The existing
loopback server remains unchanged and its WebSocket handshake/snapshot is
observed by the benchmark.

WebSocket event delivery is **not** compared for semantic equivalence. The
benchmark opens a loopback WebSocket, receives its snapshot, leaves one client
idle, then reconnects after listener restart; it does not inject or compare an
event. Typed `mission.pause` / `mission.resume` / `mission.cancel` commands are
not sent over UDS and were not compared. UDS intentionally exposes no command
operation. No provider, model, external service, or effect dispatch is used.

## Reproduction

Environment and raw sanitized samples are in
[`local-ipc-spike-2026-10-07.json`](local-ipc-spike-2026-10-07.json). The
artifact contains sizes and timings only, not request/response bodies, prompts,
private data, credentials, or host name.

```bash
bun install --frozen-lockfile
(cd web && bun install --frozen-lockfile)
bun test cli/src/daemon/local-control-uds.test.ts
bun scripts/local-ipc-spike.ts 5 20 2 docs/evidence/local-ipc-spike-2026-10-07.json
```

The script alternates listener start/shutdown order and paired request order,
uses one host/runtime/process and isolated SQLite fixtures, and runs five
repetitions with 20 requests for each of the nine read-contract operations per
transport (900 requests per transport total). Each operation includes a fresh
connection round trip; the HTTP client sends `Connection: close`. It records
listener startup, shutdown, rebind, client reconnect, per-operation latency,
and a two-second paired idle sample with one loopback WebSocket and one UDS
client. UDS receives one health request before idle. The same fixture starts in
`ready` state for every repetition.

Host: Linux `7.0.0-30-generic`, x86_64, 12 logical CPUs, 31.1 GiB RAM, Bun
1.4.2, Node compatibility `v26.3.0`, Python 3.12.3. The project pins Bun
1.3.9; the targeted suite also passed under Bun 1.3.9. This host benchmark was
collected under Bun 1.4.2, so it is not a Bun 1.3.9 performance result.

### Results

Milliseconds, min / median / max across five repetitions for lifecycle values
and 100 paired samples per operation:

| Measurement | Loopback HTTP | UDS |
|---|---:|---:|
| Listener start | 5.6 / 6.6 / 24.9 | 0.5 / 0.8 / 1.9 |
| Listener shutdown | 0.4 / 0.7 / 2.8 | 0.3 / 0.4 / 1.2 |
| Listener restart (bind after stop) | 5.2 / 6.8 / 8.5 | 0.5 / 0.6 / 0.9 |
| Client reconnect through snapshot/health-ready | 1.2 / 1.6 / 2.0 | 0.5 / 0.5 / 0.6 |
| `protocol.negotiate` | 0.3 / 0.8 / 19.8 | 0.1 / 0.3 / 5.4 |
| `health` | 0.3 / 0.7 / 1.7 | 0.1 / 0.3 / 0.9 |
| `status` | 0.4 / 0.6 / 1.8 | 0.1 / 0.3 / 0.8 |
| `mission.list` | 0.7 / 1.1 / 5.6 | 0.3 / 0.7 / 1.6 |
| `mission.show` | 0.5 / 0.8 / 1.5 | 0.2 / 0.4 / 0.8 |
| `invocation.list` | 0.8 / 1.2 / 2.0 | 0.4 / 0.7 / 1.1 |
| `invocation.show` | 0.4 / 0.8 / 1.4 | 0.1 / 0.3 / 6.0 |
| `capability_registry.list` | 0.4 / 0.7 / 1.3 | 0.1 / 0.3 / 0.7 |
| `diagnostics.list` | 0.3 / 0.6 / 1.3 | 0.1 / 0.3 / 0.6 |

The UDS median was lower for each measured read operation in this collection.
Both paths returned semantically equivalent results for identical requests.
Typical request sizes were 42–88 bytes; responses were 99–642 bytes for these
fixtures.

Across the five paired two-second idle windows, aggregate process CPU was
8.8–22.2 ms (median 10.3 ms). The paired clients' process RSS delta at connect
was 0–584 KiB (median 0 KiB); RSS then fell by 2.7–5.9 MiB during idle,
consistent with process-wide allocator/GC changes. These are aggregate
observations, not per-transport CPU/RSS attribution or a memory-benefit claim.
The WebSocket handshake plus snapshot measured 1,598 bytes; the UDS health
response measured 228 bytes. Those payloads differ and byte counts are not a
protocol-efficiency comparison. Scheduler wakeups are `unavailable`: the host
denied access to `sched_wakeup`/`sched_wakeup_new` tracepoints (`perf` probe
exit 129).

The existing #105 lifecycle baseline is not paired: it used a different base
SHA and different daemon composition. Its process start/RSS/CPU results are
not combined with these listener measurements.

## Complexity, trade-offs, and threats to validity

- No runtime dependency or lockfile changed. The isolated adapter, tests, and
  harness are about 760 lines total; this includes substantial test and
  evidence scaffolding. Operational deployment would need a dedicated private
  socket directory (for example, a `0700` runtime subdirectory) and client
  reconnect handling.
- UDS improves same-user filesystem access control and measured read latency
  on this host. Its Linux-only path semantics, stale-path management, mode
  requirements, and absent peer-credential API add operating requirements.
- The HTTP side closes each request connection, matching UDS's per-request
  connect behavior. This models local CLI reads; a persistent HTTP client or
  a persistent UDS session can have different latency.
- One SQLite fixture and one idle client do not establish throughput or
  multi-user behavior. CPU/RSS are process-wide and affected by Bun's allocator
  and GC. No daemon process startup measurement is claimed here.
- The experiment uses Bun 1.4.2 for measurements. The contract/transport tests
  passed on both Bun 1.3.9 and 1.4.2; performance was not repeated on 1.3.9.

## Follow-up recommendation

Treat the measured result as support for a **hybrid migration candidate**:
use UDS for local read-only control after a bounded implementation task proves
directory ownership at daemon startup and defines reconnect behavior for CLI
clients. Keep loopback available for current WebSocket consumers and typed
commands until streaming and command contracts are exercised over UDS with the
same permission boundary. The maintainer decides whether to authorize that
follow-up; this spike does not open another issue or change the production
listener.
