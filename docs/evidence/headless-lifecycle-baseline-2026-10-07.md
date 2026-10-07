# Headless daemon resource and lifecycle baseline (#105)

**Measured against main SHA:** `fd62c7c81b922ba8e142465278e00e47e54d3361`

**Environment:** Linux Mint 22.3, kernel `7.0.0-30-generic`, x86_64, 12 logical CPUs, 31.1 GiB RAM, Bun 1.4.2, Python 3.12.3, perf 7.0.12.

**Collection:** 2026-10-07 UTC; five repetitions. The machine identity and unaggregated samples are in [the raw JSON artifact](headless-lifecycle-baseline-2026-10-07.json).

This is a baseline of the current Bun headless daemon. It does not implement or benchmark a supervisor, a different language runtime, or a replacement transport.

## Reproduce

From the repository root, with Bun and Python 3 available:

```bash
python3 scripts/headless-lifecycle-baseline.py \
  --repetitions 5 \
  --idle-seconds 10 \
  --transport-seconds 5 \
  --output docs/evidence/headless-lifecycle-baseline-2026-10-07.json
```

Each repetition creates two fresh temporary SQLite stores under `/tmp`. The idle fixture has one synthetic `waiting_for_provider` Mission and no runnable Mission. The recovery fixture has that waiting Mission plus one synthetic `ready` Mission with an accepted plan. The daemon runs on a dynamically selected `127.0.0.1` port. The harness makes no provider/model calls and deletes the fixture directories after the measurement.

The harness times health readiness from child-process spawn; its `cold` label means the first daemon process using a fresh fixture DB, not an OS page-cache flush. `warm` is a graceful restart with the same DB and warm OS file cache. Idle samples use monotonic wall time. CPU time, resident memory, process tree, thread count, and context-switch counters come from `/proc`. Projection reconstruction is the elapsed `local_control.read`/`mission.list` request after crash restart. A WebSocket connection is held open for the controlled transport interval.

## Results

Times below are min / median / max across five repetitions. The raw JSON keeps every sample and the environment details.

| Measurement | Result |
|---|---:|
| First process start, fresh fixture DB | 131–214 ms / **134 ms** / 214 ms |
| Warm process restart, same DB | 106–240 ms / **160 ms** / 240 ms |
| Graceful SIGTERM shutdown | 7–15 ms / **15 ms** / 15 ms |
| SIGKILL then daemon restart to health-ready | 132–265 ms / **134 ms** / 265 ms |
| Durable projection response after restart | 4.1–8.8 ms / **4.9 ms** / 8.8 ms |
| Projection response after warm restart | 4.1–10.4 ms / **5.2 ms** / 10.4 ms |

During each 10-second no-runnable-Mission interval, the daemon process tree contained one process. RSS was 66,208–66,772 KiB at the start and 66,740–66,952 KiB at the end (median end RSS 66,756 KiB). CPU was 10–20 ms per interval, or 0.1–0.2% of one logical CPU. Thread counts ranged from 20–22 at the start and 17–19 at the end. The observed voluntary context-switch delta was 50–71 per interval; involuntary delta was 0–14.

With one idle WebSocket client held for five seconds, each handshake took 5.3–15.7 ms (median 7.5 ms). The client sent 156 request bytes; the server returned 162 HTTP header bytes and an initial 1,716–1,717 byte snapshot frame. No further frame bytes arrived during the interval. The measured process RSS change at connection time was +924–1,204 KiB and thread count increased by two in each sample. CPU during the connected interval was 10–30 ms (0.2–0.6% of one logical CPU). These are observed one-client deltas, not a per-client capacity estimate.

After `SIGKILL`, both synthetic Mission rows remained in SQLite and appeared in the rebuilt projection with their original states: `fixture-waiting=waiting_for_provider` and `fixture-ready=ready`. A further controlled idle interval left both states unchanged. This proves persistence and projection reconstruction only; it does not demonstrate scheduler recovery or automatic execution.

## Anomalies and limits

- Direct `sched_wakeup` / `sched_wakeup_new` counts could not be collected: this host denies `perf` access to `/sys/kernel/tracing/events/sched/`. The harness records this failure for each repetition. Context switches are reported separately and are not a wakeup count.
- The five-run collection completed before `bun run check`. After that gate's frozen installs, a follow-up one-run harness validation exited during daemon startup with `ERR_DLOPEN_FAILED`: Bun reported that `better-sqlite3` is not supported in Bun. The successful measurements above are the recorded collection; a post-install recollection was not possible in this environment. This dependency/runtime condition is surfaced for follow-up rather than hidden or changed in this measurement scope.
- CPU use was low over the measured intervals, with no observed CPU busy loop. Because scheduler tracepoints were unavailable, these measurements cannot rule out periodic wakeups or establish their source.
- Linux exposes process RSS in KiB and the daemon uses a variable number of runtime threads; the values are host/runtime-specific and should not be treated as a deployment budget.
- Startup timing includes Bun process launch and health polling. The first launch does not clear filesystem caches. This experiment does not compare a different runtime or transport.
- The measured transport cost is for one localhost WebSocket connection and the existing snapshot. It does not measure multiple clients, sustained events, or an alternate IPC transport.
- A Mission in `ready` state survived restart, but current `main.ts` does not compose a resident `MissionScheduler`. This matches the current lifecycle audit in [FAILURE_DOMAINS.md](../FAILURE_DOMAINS.md); persistence is not resumption.

The failed scheduler-tracepoint measurement is retained as a limitation, not converted into a zero-wakeup claim.
