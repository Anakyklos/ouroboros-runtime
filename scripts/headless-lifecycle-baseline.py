#!/usr/bin/env python3
"""Repeatable, provider-free lifecycle/resource measurements for issue #105."""

from __future__ import annotations

import atexit
import argparse
import json
import os
import platform
import secrets
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "scripts/headless-lifecycle-fixtures.ts"
DAEMON = ROOT / "cli/src/daemon/main.ts"
HZ = os.sysconf(os.sysconf_names["SC_CLK_TCK"])
ACTIVE_DAEMONS: set[subprocess.Popen[bytes]] = set()
DAEMON_LOGS: dict[subprocess.Popen[bytes], Path] = {}


def cleanup_daemons() -> None:
    for process in tuple(ACTIVE_DAEMONS):
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


atexit.register(cleanup_daemons)


def run(command: list[str], *, cwd: Path | None = None, timeout: float = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=True)


def fixture(db_path: Path, mode: str) -> dict[str, Any]:
    result = run(["bun", "run", str(FIXTURES), str(db_path), mode], cwd=ROOT)
    return json.loads(result.stdout.strip().splitlines()[-1])


def proc_tree(root_pid: int) -> list[int]:
    found = {root_pid}
    pending = [root_pid]
    while pending:
        pid = pending.pop()
        try:
            children_text = Path(f"/proc/{pid}/task/{pid}/children").read_text()
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        for raw in children_text.split():
            child = int(raw)
            if child not in found:
                found.add(child)
                pending.append(child)
    return sorted(found)


def sample_process(root_pid: int) -> dict[str, Any]:
    pids = proc_tree(root_pid)
    cpu_ticks = 0
    rss_kib = 0
    thread_count = 0
    voluntary = 0
    involuntary = 0
    live_pids: list[int] = []
    for pid in pids:
        proc = Path(f"/proc/{pid}")
        try:
            stat_fields = (proc / "stat").read_text().split(") ", 1)[1].split()
            cpu_ticks += int(stat_fields[11]) + int(stat_fields[12])
            status = (proc / "status").read_text()
            values = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
            rss_kib += int(values.get("VmRSS", " 0 kB").split()[0])
            thread_count += int(values.get("Threads", " 0").split()[0])
            voluntary += int(values.get("voluntary_ctxt_switches", " 0").split()[0])
            involuntary += int(values.get("nonvoluntary_ctxt_switches", " 0").split()[0])
            live_pids.append(pid)
        except (FileNotFoundError, PermissionError, ProcessLookupError, IndexError, ValueError):
            continue
    return {
        "pid_count": len(live_pids),
        "pids": live_pids,
        "threads": thread_count,
        "rss_kib": rss_kib,
        "cpu_ticks": cpu_ticks,
        "voluntary_context_switches": voluntary,
        "involuntary_context_switches": involuntary,
    }


def wait_health(port: int, proc: subprocess.Popen[bytes], timeout: float = 30) -> float:
    started = time.monotonic()
    url = f"http://127.0.0.1:{port}/health"
    while time.monotonic() - started < timeout:
        if proc.poll() is not None:
            log_path = DAEMON_LOGS.get(proc)
            detail = log_path.read_text(errors="replace")[-2000:] if log_path and log_path.exists() else ""
            raise RuntimeError(f"daemon exited before health endpoint became ready (exit={proc.returncode}): {detail}")
        try:
            with urllib.request.urlopen(url, timeout=0.25) as response:
                if response.status == 200:
                    return time.monotonic() - started
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(0.025)
    raise TimeoutError("daemon health endpoint did not become ready within 30 seconds")


def start_daemon(cwd: Path, port: int) -> tuple[subprocess.Popen[bytes], float]:
    log_path = cwd / "daemon-measurement.log"
    with log_path.open("wb") as log_file:
        proc = subprocess.Popen(
            ["bun", "run", str(DAEMON)], cwd=cwd,
            env={**os.environ, "OUROBOROS_PORT": str(port)},
            stdout=log_file, stderr=subprocess.STDOUT,
        )
    ACTIVE_DAEMONS.add(proc)
    DAEMON_LOGS[proc] = log_path
    try:
        return proc, wait_health(port, proc)
    except BaseException:
        proc.kill()
        proc.wait(timeout=5)
        raise


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def rpc_projection(port: int) -> tuple[float, dict[str, Any]]:
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "local_control.read",
        "params": {"operation": "mission.list", "protocolVersion": 1, "limit": 100},
    }).encode()
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/rpc", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    start = time.monotonic()
    with urllib.request.urlopen(request, timeout=5) as response:
        result = json.loads(response.read())
    duration = time.monotonic() - start
    data = result["result"]["data"]
    return duration, {
        "available": data["available"],
        "mission_count": len(data["items"]),
        "mission_ids": sorted(item["missionId"] for item in data["items"]),
        "states": {item["missionId"]: item["state"] for item in data["items"]},
    }


def idle_websocket(port: int) -> dict[str, Any]:
    key = secrets.token_bytes(16)
    encoded_key = __import__("base64").b64encode(key).decode("ascii")
    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
    sock.settimeout(5)
    request = (
        "GET /ws HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {encoded_key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    start = time.monotonic()
    sock.sendall(request.encode("ascii"))
    received = b""
    while b"\r\n\r\n" not in received:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("daemon closed WebSocket before completing handshake")
        received += chunk
    handshake_seconds = time.monotonic() - start
    headers = received.split(b"\r\n\r\n", 1)[0].decode("latin1")
    if "101 Switching Protocols" not in headers:
        raise RuntimeError(f"WebSocket upgrade failed: {headers.splitlines()[0]}")
    trailing_bytes = received.split(b"\r\n\r\n", 1)[1]
    return {
        "socket": sock,
        "handshake_seconds": handshake_seconds,
        "response_header_bytes": len(headers),
        "request_bytes": len(request.encode("ascii")),
        "initial_frame_bytes": len(trailing_bytes),
    }


def start_perf_wakeups(pid: int, seconds: float) -> tuple[subprocess.Popen[str] | None, dict[str, Any]]:
    perf = shutil.which("perf")
    if not perf:
        return None, {"available": False, "reason": "perf executable not installed"}
    command = [perf, "stat", "-x,", "-e", "sched:sched_wakeup,sched:sched_wakeup_new", "-p", str(pid), "--", "sleep", str(seconds)]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return process, {}


def finish_perf_wakeups(process: subprocess.Popen[str] | None, immediate: dict[str, Any], seconds: float) -> dict[str, Any]:
    if process is None:
        return immediate
    try:
        stdout, stderr = process.communicate(timeout=seconds + 10)
    except subprocess.TimeoutExpired:
        process.kill()
        stdout, stderr = process.communicate()
        return {"available": False, "reason": "perf did not finish within the measurement interval", "stdout": stdout[-400:], "stderr": stderr[-1600:]}
    return {
        "available": process.returncode == 0,
        "returncode": process.returncode,
        "stdout": stdout.strip()[-400:],
        "stderr": stderr.strip()[-1600:],
    }


def delta(before: dict[str, Any], after: dict[str, Any], seconds: float) -> dict[str, Any]:
    cpu_seconds = (after["cpu_ticks"] - before["cpu_ticks"]) / HZ
    return {
        "interval_seconds": seconds,
        "cpu_seconds": round(cpu_seconds, 6),
        "cpu_percent_of_one_logical_cpu": round(100 * cpu_seconds / seconds, 4),
        "rss_before_kib": before["rss_kib"],
        "rss_after_kib": after["rss_kib"],
        "pid_count_before": before["pid_count"],
        "pid_count_after": after["pid_count"],
        "threads_before": before["threads"],
        "threads_after": after["threads"],
        "voluntary_context_switch_delta": after["voluntary_context_switches"] - before["voluntary_context_switches"],
        "involuntary_context_switch_delta": after["involuntary_context_switches"] - before["involuntary_context_switches"],
    }


def summarize(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    return {
        "min": round(min(ordered), 6),
        "median": round(statistics.median(ordered), 6),
        "max": round(max(ordered), 6),
        "p95_nearest_rank": round(ordered[max(0, int(0.95 * len(ordered) + 0.999999) - 1)], 6),
    }


def stop_daemon(proc: subprocess.Popen[bytes], signal_name: str) -> float:
    start = time.monotonic()
    if signal_name == "SIGKILL":
        proc.kill()
    else:
        proc.terminate()
    proc.wait(timeout=15)
    ACTIVE_DAEMONS.discard(proc)
    return time.monotonic() - start


def read_environment() -> dict[str, Any]:
    os_release = Path("/etc/os-release")
    release: dict[str, str] = {}
    if os_release.exists():
        for line in os_release.read_text().splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                release[key] = value.strip('"')
    bun = run(["bun", "--version"], cwd=ROOT).stdout.strip()
    return {
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kernel": platform.release(),
        "uname": " ".join(platform.uname()),
        "distribution": {key: release.get(key) for key in ("ID", "VERSION_ID", "PRETTY_NAME")},
        "architecture": platform.machine(),
        "logical_cpu_count": os.cpu_count(),
        "memory_total_kib": int(Path("/proc/meminfo").read_text().split("MemTotal:", 1)[1].split()[0]),
        "bun_version": bun,
        "python_version": platform.python_version(),
        "perf_version": subprocess.run(["perf", "--version"], capture_output=True, text=True).stdout.strip() if shutil.which("perf") else None,
        "proc_clock_ticks_per_second": HZ,
    }


def measure(repetitions: int, idle_seconds: float, transport_seconds: float) -> dict[str, Any]:
    raw: list[dict[str, Any]] = []
    for index in range(repetitions):
        with tempfile.TemporaryDirectory(prefix="ouroboros-lifecycle-") as temp:
            base = Path(temp)
            idle_dir = base / "idle"
            recovery_dir = base / "recovery"
            (idle_dir / ".ouroboros").mkdir(parents=True)
            (recovery_dir / ".ouroboros").mkdir(parents=True)
            idle_db = idle_dir / ".ouroboros/missions.db"
            recovery_db = recovery_dir / ".ouroboros/missions.db"
            fixture(idle_db, "idle")
            recovery_fixture = fixture(recovery_db, "recovery")
            recovery_fixture.pop("database", None)

            idle_port = free_port()
            idle_proc, idle_cold_start = start_daemon(idle_dir, idle_port)
            before = sample_process(idle_proc.pid)
            interval_start = time.monotonic()
            perf_process, perf_initial = start_perf_wakeups(idle_proc.pid, idle_seconds)
            time.sleep(idle_seconds)
            interval = time.monotonic() - interval_start
            perf_result = finish_perf_wakeups(perf_process, perf_initial, idle_seconds)
            after = sample_process(idle_proc.pid)
            idle_metrics = delta(before, after, interval)
            idle_metrics["perf_sched_wakeup"] = perf_result

            transport_before = sample_process(idle_proc.pid)
            transport = idle_websocket(idle_port)
            transport_connected = sample_process(idle_proc.pid)
            transport_start = time.monotonic()
            time.sleep(transport_seconds)
            transport_interval = time.monotonic() - transport_start
            transport["socket"].setblocking(False)
            additional_frame_bytes = 0
            while True:
                try:
                    chunk = transport["socket"].recv(65536)
                    if not chunk:
                        break
                    additional_frame_bytes += len(chunk)
                except BlockingIOError:
                    break
            transport_after = sample_process(idle_proc.pid)
            transport_metrics = delta(transport_before, transport_after, transport_interval)
            transport_metrics["handshake_seconds"] = round(transport["handshake_seconds"], 6)
            transport_metrics["response_header_bytes"] = transport["response_header_bytes"]
            transport_metrics["request_bytes"] = transport["request_bytes"]
            transport_metrics["initial_frame_bytes"] = transport["initial_frame_bytes"]
            transport_metrics["additional_frame_bytes"] = additional_frame_bytes
            transport_metrics["rss_delta_at_connect_kib"] = transport_connected["rss_kib"] - transport_before["rss_kib"]
            transport_metrics["threads_delta_at_connect"] = transport_connected["threads"] - transport_before["threads"]
            transport["socket"].close()
            idle_shutdown = stop_daemon(idle_proc, "SIGTERM")

            port = free_port()
            cold_proc, cold_start = start_daemon(recovery_dir, port)
            cold_projection_ms, cold_projection = rpc_projection(port)
            graceful_shutdown = stop_daemon(cold_proc, "SIGTERM")

            warm_proc, warm_start = start_daemon(recovery_dir, port)
            warm_projection_ms, warm_projection = rpc_projection(port)
            crash_shutdown = stop_daemon(warm_proc, "SIGKILL")

            restart_proc, restart_start = start_daemon(recovery_dir, port)
            projection_start = time.monotonic()
            recovered_projection_ms, recovered_projection = rpc_projection(port)
            projection_seconds = time.monotonic() - projection_start
            persistence = fixture(recovery_db, "inspect")
            time.sleep(min(1.0, idle_seconds))
            post_restart_projection_ms, post_restart_projection = rpc_projection(port)
            restart_graceful_shutdown = stop_daemon(restart_proc, "SIGTERM")

            raw.append({
                "repetition": index + 1,
                "idle_waiting_fixture": {"cold_start_seconds": round(idle_cold_start, 6), "metrics": idle_metrics, "graceful_shutdown_seconds": round(idle_shutdown, 6)},
                "transport_idle_connection": transport_metrics,
                "recovery_fixtures": recovery_fixture,
                "cold_start_seconds": round(cold_start, 6),
                "cold_projection_seconds": round(cold_projection_ms, 6),
                "cold_projection": cold_projection,
                "graceful_shutdown_seconds": round(graceful_shutdown, 6),
                "warm_start_seconds": round(warm_start, 6),
                "warm_projection_seconds": round(warm_projection_ms, 6),
                "warm_projection": warm_projection,
                "crash_kill_wait_seconds": round(crash_shutdown, 6),
                "crash_restart_seconds": round(restart_start, 6),
                "restart_projection_seconds": round(recovered_projection_ms, 6),
                "restart_projection_reconstruction_seconds": round(projection_seconds, 6),
                "persisted_after_crash": persistence,
                "post_restart_projection_after_controlled_idle_seconds": round(post_restart_projection_ms, 6),
                "post_restart_projection": post_restart_projection,
                "restart_graceful_shutdown_seconds": round(restart_graceful_shutdown, 6),
            })

    seconds_fields = (
        "cold_start_seconds", "idle_waiting_cold_start_seconds", "cold_projection_seconds", "graceful_shutdown_seconds",
        "warm_start_seconds", "warm_projection_seconds", "crash_restart_seconds",
        "restart_projection_seconds", "restart_projection_reconstruction_seconds",
    )
    seconds_summary = {
        key: summarize([
            sample[key] if key in sample else sample["idle_waiting_fixture"]["cold_start_seconds"]
            for sample in raw
        ])
        for key in seconds_fields
    }
    seconds_summary["idle_waiting_graceful_shutdown_seconds"] = summarize([
        sample["idle_waiting_fixture"]["graceful_shutdown_seconds"] for sample in raw
    ])
    return {
        "repetitions": repetitions,
        "idle_interval_seconds": idle_seconds,
        "transport_idle_interval_seconds": transport_seconds,
        "raw_samples": raw,
        "summary_seconds": seconds_summary,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument("--idle-seconds", type=float, default=10)
    parser.add_argument("--transport-seconds", type=float, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.repetitions < 1 or args.idle_seconds < 1 or args.transport_seconds < 1:
        parser.error("repetitions and intervals must be positive; intervals must be at least one second")
    result = {
        "schema": "ouroboros.headless-lifecycle-baseline/v1",
        "base_sha": subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip(),
        "environment": read_environment(),
        "measurements": measure(args.repetitions, args.idle_seconds, args.transport_seconds),
        "limitations": [
            "Cold means first daemon process on an isolated fresh database; OS page cache was not flushed.",
            "Warm means a graceful daemon restart on the same isolated fixture database.",
            "Wakeups use perf scheduler tracepoints when permissions allow; per-process context-switch deltas are also recorded and are not equivalent to wakeups.",
            "Idle scenario contains only a waiting_for_provider Mission; recovery scenario includes a READY accepted-plan Mission and is measured separately.",
            "READY durability and projection persistence are observed; no claim of automatic Mission scheduling or resumption is made.",
            "RSS and CPU are sampled for the daemon process tree using /proc; measurements describe this host/container environment only.",
            "No providers, models, external services, load generator, or production Mission content are used.",
        ],
    }
    encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded)
    sys.stdout.write(encoded)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"headless lifecycle baseline failed: {error}", file=sys.stderr)
        raise
