# Headless daemon resource and lifecycle baseline (#105)

**Main base SHA:** `fd62c7c81b922ba8e142465278e00e47e54d3361`
**Measured code HEAD:** `8be6751d8d32d1d73bd527d13698f5ee17bb46ee`
**Collection:** 2026-10-07 23:27 UTC; five repetitions after frozen installs and `bun run check` at the measured HEAD.

**Environment:** Linux Mint 22.3, kernel `7.0.0-30-generic`, x86_64, 12 logical CPUs, 31.1 GiB RAM, Bun 1.4.2, Node 22.23.2, Python 3.12.3, `better-sqlite3` 12.6.2 installed, perf 7.0.12. Hostname is omitted. Raw samples and runtime probes are in [the JSON artifact](headless-lifecycle-baseline-2026-10-07.json).

## Reproduction and runtime diagnosis

After frozen root and web installs, run the repository gate and the harness:

```bash
bun install --frozen-lockfile
(cd web && bun install --frozen-lockfile)
bun run check
python3 -m unittest discover -s scripts -p 'test_headless_lifecycle_baseline.py' -v
python3 scripts/headless-lifecycle-baseline.py \
  --repetitions 5 \
  --idle-seconds 10 \
  --transport-seconds 5 \
  --output docs/evidence/headless-lifecycle-baseline-2026-10-07.json
```

The five-run collection in the JSON completed after these frozen installs and the full gate. `bun run check` passed all 66 mandatory files; the web build emitted its existing chunk-size warning. The harness's eight explicit unit tests cover malformed identity, duplicate and missing Missions, wrong state, unexpected invocation/effect records, nonzero SIGTERM exit, and SIGKILL classification.

The post-install failure was a real runtime composition mismatch, not a damaged native binary: Node 22 loaded the installed `better-sqlite3` 12.6.2 addon successfully, while Bun 1.4.2 failed to instantiate it with `ERR_DLOPEN_FAILED`. The package's former `tsx` daemon command ran under Node, where the headless composition's `bun:sqlite` import failed with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. The failed attempt and its sanitized environment are retained in [the diagnostic artifact](headless-lifecycle-baseline-post-check.json).

The minimum compatibility correction keeps Bun as the daemon runtime: `SqliteAdapter` now uses Bun's built-in synchronous SQLite adapter, and the package `daemon` script invokes Bun directly. No dependency version or lockfile changed. Repeating the harness after that correction and after `bun run check` produced the five successful samples below.

## Measurements

Times show min / median / max over five repetitions. Process exit codes and every checkpoint are present per sample in the raw JSON.

| Measurement | Result |
|---|---:|
| First start with fresh fixture DB | 132–215 ms / **187 ms** / 215 ms |
| Warm restart with same DB | 109–241 ms / **133 ms** / 241 ms |
| Graceful SIGTERM to exit 0 and released process group | 7.3–15.6 ms / **7.4 ms** / 15.6 ms |
| Forced SIGKILL termination | exit `-9` in all runs; 3.4–7.6 ms / **7.5 ms** / 7.6 ms |
| Crash restart to health-ready | 107–215 ms / **134 ms** / 215 ms |
| Post-restart authoritative projection | 5.9–9.9 ms / **6.8 ms** / 9.9 ms |
| Warm-start projection | 6.1–10.4 ms / **7.2 ms** / 10.4 ms |

For each controlled 10-second idle interval, the database had only a synthetic `waiting_for_provider` Mission. The daemon process tree had one process, with RSS 59,488–60,344 KiB at interval start and 60,000–60,308 KiB at the end (median end RSS 60,260 KiB). CPU was 0.1–0.3% of one logical CPU. Threads ranged from 19–20 at start and 18–19 at end. Voluntary context-switch delta was 55–74 (median 57); involuntary delta was 3–24. Direct scheduler wakeup tracepoints were denied by host permissions, so no wakeup count is claimed.

One idle localhost WebSocket was held open for five seconds per repetition. Handshake latency was 2.2–5.5 ms (median 4.5 ms); the client request was 156 bytes and the HTTP response header was 166 bytes, including its delimiter. The socket read through handshake completion returned 1,881–1,883 bytes total; 1,715–1,717 bytes followed the headers in that same read. Those trailing bytes are recorded as received bytes, not interpreted as a complete or validated WebSocket frame. No additional bytes arrived during the remaining idle interval. RSS changed by +692–788 KiB at connection time (median +748 KiB), thread count by 0–1, and CPU was 0.2% of one logical CPU.

## Recovery and shutdown checks

The harness asserts exact Mission identity, cardinality and state before startup and after cold start, SIGTERM, warm start, SIGKILL, crash restart, controlled idle, and final SIGTERM. It also checks each Mission's empty `invocationIds` and the empty authoritative invocation list. All five samples retained exactly `fixture-ready=ready` and `fixture-waiting=waiting_for_provider`; no synthetic effect was dispatched or recreated.

Every SIGTERM sample recorded exit code `0`, process-group release, and reaped tracked processes before counting the duration as graceful. Every SIGKILL sample recorded `-9`, forced termination, released process group, and reaped processes separately. The eight Python regression tests also reject incorrect exit codes and unreleased process groups.

These results prove durable state and projection reconstruction. They do not demonstrate automatic Mission resumption: current `main.ts` still does not compose a resident `MissionScheduler`, as recorded in [FAILURE_DOMAINS.md](../FAILURE_DOMAINS.md).

## Limitations

- `perf` could not read `sched_wakeup` / `sched_wakeup_new` tracepoints on this host. The raw JSON records the permission failure on every idle sample. Context switches and CPU time are not substitutes for a wakeup count.
- The transport byte counts do not parse or validate the WebSocket frame. They measure bytes returned with handshake reads and bytes received afterward.
- `cold` means a new process and fresh isolated fixture DB; the OS page cache was not flushed. `warm` means a process restart using the same fixture DB.
- The result is environment-specific, uses one idle client, and makes no load-capacity claim. No provider, model, external service, production Mission content, or alternate runtime/transport was used.
