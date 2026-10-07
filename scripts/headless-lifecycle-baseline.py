#!/usr/bin/env python3
"""Repeatable, provider-free lifecycle/resource measurements for issue #105."""

from __future__ import annotations

import atexit
import argparse
import json
import os
import platform
import secrets
import signal
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
STARTUP_FAILURE: dict[str, Any] | None = None


def cleanup_daemons() -> None:
    for process in tuple(ACTIVE_DAEMONS):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if process.poll() is None:
            process.wait(timeout=5)
        ACTIVE_DAEMONS.discard(process)


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
    global STARTUP_FAILURE
    STARTUP_FAILURE = None
    log_path = cwd / "daemon-measurement.log"
    with log_path.open("wb") as log_file:
        proc = subprocess.Popen(
            ["bun", "run", str(DAEMON)], cwd=cwd,
            env={**os.environ, "OUROBOROS_PORT": str(port)},
            stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True,
        )
    ACTIVE_DAEMONS.add(proc)
    DAEMON_LOGS[proc] = log_path
    try:
        return proc, wait_health(port, proc)
    except BaseException as error:
        diagnostic = log_path.read_text(errors="replace") if log_path.exists() else ""
        STARTUP_FAILURE = {
            "command": ["bun", "run", "cli/src/daemon/main.ts"],
            "working_directory": "isolated temporary fixture directory",
            "exit_code": proc.returncode,
            "error_code": next((code for code in ("ERR_DLOPEN_FAILED", "ERR_UNSUPPORTED_ESM_URL_SCHEME") if code in diagnostic), "DAEMON_START_FAILED"),
            "diagnostic": (
                "better-sqlite3 is not supported by this Bun runtime"
                if "better-sqlite3' is not yet supported in Bun" in diagnostic
                else "Node/tsx cannot load the bun:sqlite scheme"
                if "Received protocol 'bun:'" in diagnostic
                else "daemon exited before health readiness; see local process log"
            ),
        }
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=5)
        ACTIVE_DAEMONS.discard(proc)
        raise


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def rpc_projection(port: int) -> tuple[float, dict[str, Any]]:
    start = time.monotonic()
    result = rpc_read(port, "mission.list")
    invocation_result = rpc_read(port, "invocation.list")
    duration = time.monotonic() - start
    data = result["data"]
    invocations = invocation_result["data"]
    return duration, {
        "available": data["available"],
        "mission_count": len(data["items"]),
        "mission_ids": sorted(item["missionId"] for item in data["items"]),
        "states": {item["missionId"]: item["state"] for item in data["items"]},
        "items": data["items"],
        "invocation_ids": sorted(item["invocationId"] for item in invocations["items"]),
        "invocation_count": len(invocations["items"]),
    }


def rpc_read(port: int, operation: str) -> dict[str, Any]:
    payload = json.dumps({
        "jsonrpc": "2.0", "id": operation, "method": "local_control.read",
        "params": {"operation": operation, "protocolVersion": 1, "limit": 100},
    }).encode()
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/rpc", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        result = json.loads(response.read())
    if "error" in result or not isinstance(result.get("result"), dict):
        raise RuntimeError(f"local_control.read({operation}) RPC failed")
    return result["result"]


def validate_fixture_snapshot(name: str, snapshot: dict[str, Any], expected_states: dict[str, str]) -> None:
    mission_ids = snapshot.get("missionIds")
    states = snapshot.get("states")
    expected_ids = sorted(expected_states)
    if not isinstance(mission_ids, list) or any(not isinstance(value, str) for value in mission_ids):
        raise AssertionError(f"{name}: fixture missionIds must be a string list")
    if len(mission_ids) != len(set(mission_ids)):
        raise AssertionError(f"{name}: duplicate Mission ids")
    if sorted(mission_ids) != expected_ids:
        raise AssertionError(f"{name}: expected Mission ids {expected_ids}, got {sorted(mission_ids)}")
    if states != expected_states:
        raise AssertionError(f"{name}: expected states {expected_states}, got {states}")


def validate_projection(name: str, snapshot: dict[str, Any], expected_states: dict[str, str]) -> None:
    expected_ids = sorted(expected_states)
    if snapshot.get("available") is not True:
        raise AssertionError(f"{name}: durable Mission projection is unavailable")
    mission_ids = snapshot.get("mission_ids")
    if not isinstance(mission_ids, list) or len(mission_ids) != len(set(mission_ids)):
        raise AssertionError(f"{name}: Mission projection has missing or duplicate identity data")
    if mission_ids != expected_ids or snapshot.get("mission_count") != len(expected_ids):
        raise AssertionError(f"{name}: expected exactly {expected_ids}, got {mission_ids}")
    if snapshot.get("states") != expected_states:
        raise AssertionError(f"{name}: expected states {expected_states}, got {snapshot.get('states')}")
    items = snapshot.get("items")
    if not isinstance(items, list) or len(items) != len(expected_ids):
        raise AssertionError(f"{name}: Mission item cardinality mismatch")
    item_ids = [item.get("missionId") for item in items]
    if sorted(item_ids) != expected_ids or len(item_ids) != len(set(item_ids)):
        raise AssertionError(f"{name}: Mission item identities are incomplete or duplicated")
    for item in items:
        if item.get("state") != expected_states[item["missionId"]]:
            raise AssertionError(f"{name}: Mission {item['missionId']} has unexpected state")
        if item.get("invocationIds") != []:
            raise AssertionError(f"{name}: Mission {item['missionId']} has unexpected invocations/effects")
    invocation_ids = snapshot.get("invocation_ids")
    if invocation_ids != [] or snapshot.get("invocation_count") != 0:
        raise AssertionError(f"{name}: expected no invocation/effect records, got {invocation_ids}")


def validate_exit_status(signal_name: str, returncode: int, process_group_released: bool) -> dict[str, Any]:
    expected = 0 if signal_name == "SIGTERM" else -signal.SIGKILL if signal_name == "SIGKILL" else None
    if expected is None:
        raise ValueError(f"unsupported termination signal {signal_name}")
    if returncode != expected:
        raise AssertionError(f"{signal_name}: expected exit code {expected}, got {returncode}")
    if not process_group_released:
        raise AssertionError(f"{signal_name}: daemon process group/resources remain alive")
    return {
        "requested_signal": signal_name,
        "exit_code": returncode,
        "process_group_released": process_group_released,
        "graceful": signal_name == "SIGTERM" and returncode == 0 and process_group_released,
        "forced": signal_name == "SIGKILL" and returncode == -signal.SIGKILL and process_group_released,
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
    separator = received.index(b"\r\n\r\n")
    header_bytes = received[:separator + 4]
    headers = header_bytes.decode("latin1")
    if "101 Switching Protocols" not in headers:
        raise RuntimeError(f"WebSocket upgrade failed: {headers.splitlines()[0]}")
    return {
        "socket": sock,
        "handshake_seconds": handshake_seconds,
        "response_header_bytes": len(header_bytes),
        "request_bytes": len(request.encode("ascii")),
        "bytes_read_until_handshake_headers_complete": len(received),
        "bytes_read_after_headers_in_handshake_recv": len(received) - len(header_bytes),
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


def expected_fixture_states(snapshot: dict[str, Any]) -> dict[str, str]:
    mission_ids = snapshot.get("missionIds")
    states = snapshot.get("states")
    if not isinstance(mission_ids, list) or not isinstance(states, list) or len(mission_ids) != len(states):
        raise AssertionError("fixture creation returned inconsistent Mission identities and states")
    expected = dict(zip(mission_ids, states, strict=True))
    if len(expected) != len(mission_ids):
        raise AssertionError("fixture creation returned duplicate Mission identities")
    if any(not isinstance(mission_id, str) or not isinstance(state, str) for mission_id, state in expected.items()):
        raise AssertionError("fixture creation returned malformed Mission identities or states")
    return expected


def validate_fixture_snapshot(name: str, snapshot: dict[str, Any], expected_states: dict[str, str]) -> None:
    mission_ids = snapshot.get("missionIds")
    states = snapshot.get("states")
    expected_ids = sorted(expected_states)
    if not isinstance(mission_ids, list) or any(not isinstance(value, str) for value in mission_ids):
        raise AssertionError(f"{name}: fixture missionIds must be a string list")
    if len(mission_ids) != len(set(mission_ids)):
        raise AssertionError(f"{name}: duplicate Mission ids")
    if sorted(mission_ids) != expected_ids:
        raise AssertionError(f"{name}: expected Mission ids {expected_ids}, got {sorted(mission_ids)}")
    if states != expected_states:
        raise AssertionError(f"{name}: expected states {expected_states}, got {states}")


def validate_projection(name: str, snapshot: dict[str, Any], expected_states: dict[str, str]) -> None:
    expected_ids = sorted(expected_states)
    if snapshot.get("available") is not True:
        raise AssertionError(f"{name}: durable Mission projection is unavailable")
    mission_ids = snapshot.get("mission_ids")
    if not isinstance(mission_ids, list) or len(mission_ids) != len(set(mission_ids)):
        raise AssertionError(f"{name}: Mission projection has missing or duplicate identity data")
    if mission_ids != expected_ids or snapshot.get("mission_count") != len(expected_ids):
        raise AssertionError(f"{name}: expected exactly {expected_ids}, got {mission_ids}")
    if snapshot.get("states") != expected_states:
        raise AssertionError(f"{name}: expected states {expected_states}, got {snapshot.get('states')}")
    items = snapshot.get("items")
    if not isinstance(items, list) or len(items) != len(expected_ids):
        raise AssertionError(f"{name}: Mission item cardinality mismatch")
    item_ids = [item.get("missionId") for item in items]
    if sorted(item_ids) != expected_ids or len(item_ids) != len(set(item_ids)):
        raise AssertionError(f"{name}: Mission item identities are incomplete or duplicated")
    for item in items:
        mission_id = item.get("missionId")
        if item.get("state") != expected_states[mission_id]:
            raise AssertionError(f"{name}: Mission {mission_id} has unexpected state")
        if item.get("invocationIds") != []:
            raise AssertionError(f"{name}: Mission {mission_id} has unexpected invocation/effect records")
    if snapshot.get("invocation_ids") != [] or snapshot.get("invocation_count") != 0:
        raise AssertionError(f"{name}: expected no invocation/effect records")


def validate_exit_status(signal_name: str, returncode: int, process_group_released: bool) -> dict[str, Any]:
    expected = 0 if signal_name == "SIGTERM" else -signal.SIGKILL if signal_name == "SIGKILL" else None
    if expected is None:
        raise ValueError(f"unsupported termination signal {signal_name}")
    if returncode != expected:
        raise AssertionError(f"{signal_name}: expected exit code {expected}, got {returncode}")
    if not process_group_released:
        raise AssertionError(f"{signal_name}: daemon process group/resources remain alive")
    return {
        "requested_signal": signal_name,
        "exit_code": returncode,
        "process_group_released": process_group_released,
        "graceful": signal_name == "SIGTERM" and returncode == 0,
        "forced": signal_name == "SIGKILL" and returncode == -signal.SIGKILL,
    }


def stop_daemon(proc: subprocess.Popen[bytes], signal_name: str) -> dict[str, Any]:
    start = time.monotonic()
    tracked_pids = proc_tree(proc.pid)
    requested_signal = signal.SIGTERM if signal_name == "SIGTERM" else signal.SIGKILL if signal_name == "SIGKILL" else None
    if requested_signal is None:
        raise ValueError(f"unsupported termination signal {signal_name}")
    try:
        os.killpg(proc.pid, requested_signal)
    except ProcessLookupError:
        pass
    proc.wait(timeout=15)
    ACTIVE_DAEMONS.discard(proc)
    elapsed = time.monotonic() - start
    group_released = False
    try:
        os.killpg(proc.pid, 0)
    except ProcessLookupError:
        group_released = True
    result = validate_exit_status(signal_name, proc.returncode, group_released)
    result["duration_seconds"] = round(elapsed, 6)
    result["tracked_process_ids"] = tracked_pids
    result["tracked_processes_reaped"] = all(not Path(f"/proc/{pid}").exists() for pid in tracked_pids)
    if not result["tracked_processes_reaped"]:
        raise AssertionError(f"{signal_name}: daemon PIDs remain after wait: {tracked_pids}")
    ACTIVE_DAEMONS.discard(proc)
    return result


def read_environment() -> dict[str, Any]:
    os_release = Path("/etc/os-release")
    release: dict[str, str] = {}
    if os_release.exists():
        for line in os_release.read_text().splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                release[key] = value.strip('"')
    bun = run(["bun", "--version"], cwd=ROOT).stdout.strip()
    package = json.loads((ROOT / "package.json").read_text())
    sqlite_package = json.loads((ROOT / "node_modules/better-sqlite3/package.json").read_text())
    node_sqlite = subprocess.run(
        ["node", "-e", "const DB=require('better-sqlite3'); const db=new DB(':memory:'); db.close()"],
        cwd=ROOT, capture_output=True, text=True,
    )
    bun_sqlite = subprocess.run(
        ["bun", "-e", "const DB=require('better-sqlite3'); const db=new DB(':memory:'); db.close()"],
        cwd=ROOT, capture_output=True, text=True,
    )
    tsx_bun_sqlite = subprocess.run(
        [str(ROOT / "node_modules/.bin/tsx"), "-e", "import('bun:sqlite')"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return {
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kernel": platform.release(),
        "kernel_identity": f"{platform.system()} {platform.release()} {platform.machine()}",
        "distribution": {key: release.get(key) for key in ("ID", "VERSION_ID", "PRETTY_NAME")},
        "architecture": platform.machine(),
        "logical_cpu_count": os.cpu_count(),
        "memory_total_kib": int(Path("/proc/meminfo").read_text().split("MemTotal:", 1)[1].split()[0]),
        "bun_version": bun,
        "node_version": subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip(),
        "daemon_package_script": package["scripts"]["daemon"],
        "better_sqlite3_version": sqlite_package["version"],
        "native_module_runtime_probe": {
            "node_better_sqlite3_exit_code": node_sqlite.returncode,
            "bun_better_sqlite3_exit_code": bun_sqlite.returncode,
            "bun_error_code": "ERR_DLOPEN_FAILED" if "ERR_DLOPEN_FAILED" in bun_sqlite.stderr else None,
            "tsx_node_bun_sqlite_exit_code": tsx_bun_sqlite.returncode,
            "tsx_error_code": "ERR_UNSUPPORTED_ESM_URL_SCHEME" if "ERR_UNSUPPORTED_ESM_URL_SCHEME" in tsx_bun_sqlite.stderr else None,
        },
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
            idle_fixture = fixture(idle_db, "idle")
            recovery_fixture = fixture(recovery_db, "recovery")
            recovery_fixture.pop("database", None)
            idle_expected = {"fixture-waiting": "waiting_for_provider"}
            recovery_expected = {"fixture-ready": "ready", "fixture-waiting": "waiting_for_provider"}
            validate_fixture_snapshot(f"rep-{index + 1}:idle-before-start", {
                "missionIds": idle_fixture["missionIds"],
                "states": dict(zip(idle_fixture["missionIds"], idle_fixture["states"], strict=True)),
            }, idle_expected)
            validate_fixture_snapshot(f"rep-{index + 1}:recovery-before-start", {
                "missionIds": recovery_fixture["missionIds"],
                "states": dict(zip(recovery_fixture["missionIds"], recovery_fixture["states"], strict=True)),
            }, recovery_expected)

            idle_port = free_port()
            idle_proc, idle_cold_start = start_daemon(idle_dir, idle_port)
            idle_before_seconds, idle_before = rpc_projection(idle_port)
            validate_projection(f"rep-{index + 1}:idle-before-interval", idle_before, idle_expected)
            before = sample_process(idle_proc.pid)
            interval_start = time.monotonic()
            perf_process, perf_initial = start_perf_wakeups(idle_proc.pid, idle_seconds)
            time.sleep(idle_seconds)
            interval = time.monotonic() - interval_start
            perf_result = finish_perf_wakeups(perf_process, perf_initial, idle_seconds)
            after = sample_process(idle_proc.pid)
            idle_metrics = delta(before, after, interval)
            idle_metrics["perf_sched_wakeup"] = perf_result
            idle_after_seconds, idle_after = rpc_projection(idle_port)
            validate_projection(f"rep-{index + 1}:idle-after-interval", idle_after, idle_expected)
            if idle_after["states"] != idle_before["states"] or idle_after["invocation_ids"] != idle_before["invocation_ids"]:
                raise AssertionError("idle interval changed Mission state or created effects")

            transport_before = sample_process(idle_proc.pid)
            transport = idle_websocket(idle_port)
            transport_connected = sample_process(idle_proc.pid)
            transport_start = time.monotonic()
            time.sleep(transport_seconds)
            transport_interval = time.monotonic() - transport_start
            transport["socket"].setblocking(False)
            bytes_after_handshake = 0
            while True:
                try:
                    chunk = transport["socket"].recv(65536)
                    if not chunk:
                        break
                    bytes_after_handshake += len(chunk)
                except BlockingIOError:
                    break
            transport_after = sample_process(idle_proc.pid)
            transport_metrics = delta(transport_before, transport_after, transport_interval)
            transport_metrics["handshake_seconds"] = round(transport["handshake_seconds"], 6)
            transport_metrics["response_header_bytes"] = transport["response_header_bytes"]
            transport_metrics["request_bytes"] = transport["request_bytes"]
            transport_metrics["bytes_read_until_handshake_headers_complete"] = transport["bytes_read_until_handshake_headers_complete"]
            transport_metrics["bytes_read_after_headers_in_handshake_recv"] = transport["bytes_read_after_headers_in_handshake_recv"]
            transport_metrics["bytes_after_handshake"] = bytes_after_handshake
            transport_metrics["rss_delta_at_connect_kib"] = transport_connected["rss_kib"] - transport_before["rss_kib"]
            transport_metrics["threads_delta_at_connect"] = transport_connected["threads"] - transport_before["threads"]
            transport["socket"].close()
            idle_shutdown = stop_daemon(idle_proc, "SIGTERM")
            idle_after_term = fixture(idle_db, "inspect")
            validate_fixture_snapshot(f"rep-{index + 1}:idle-after-sigterm", idle_after_term, idle_expected)

            port = free_port()
            cold_proc, cold_start = start_daemon(recovery_dir, port)
            cold_projection_ms, cold_projection = rpc_projection(port)
            validate_projection(f"rep-{index + 1}:after-cold-start", cold_projection, recovery_expected)
            graceful_shutdown = stop_daemon(cold_proc, "SIGTERM")
            after_sigterm = fixture(recovery_db, "inspect")
            validate_fixture_snapshot(f"rep-{index + 1}:after-sigterm", after_sigterm, recovery_expected)

            warm_proc, warm_start = start_daemon(recovery_dir, port)
            warm_projection_ms, warm_projection = rpc_projection(port)
            validate_projection(f"rep-{index + 1}:after-warm-start", warm_projection, recovery_expected)
            crash_shutdown = stop_daemon(warm_proc, "SIGKILL")
            after_sigkill = fixture(recovery_db, "inspect")
            validate_fixture_snapshot(f"rep-{index + 1}:after-sigkill", after_sigkill, recovery_expected)

            restart_proc, restart_start = start_daemon(recovery_dir, port)
            projection_start = time.monotonic()
            recovered_projection_ms, recovered_projection = rpc_projection(port)
            projection_seconds = time.monotonic() - projection_start
            validate_projection(f"rep-{index + 1}:after-crash-restart", recovered_projection, recovery_expected)
            persistence = fixture(recovery_db, "inspect")
            validate_fixture_snapshot(f"rep-{index + 1}:reopened-after-crash", persistence, recovery_expected)
            time.sleep(min(1.0, idle_seconds))
            post_restart_projection_ms, post_restart_projection = rpc_projection(port)
            validate_projection(f"rep-{index + 1}:after-restart-idle", post_restart_projection, recovery_expected)
            if post_restart_projection["states"] != recovered_projection["states"]:
                raise AssertionError("controlled post-restart idle interval changed Mission states")
            restart_graceful_shutdown = stop_daemon(restart_proc, "SIGTERM")
            after_restart_sigterm = fixture(recovery_db, "inspect")
            validate_fixture_snapshot(f"rep-{index + 1}:after-restart-sigterm", after_restart_sigterm, recovery_expected)

            raw.append({
                "repetition": index + 1,
                "idle_waiting_fixture": {
                    "cold_start_seconds": round(idle_cold_start, 6),
                    "metrics": idle_metrics,
                    "projection_before_interval_seconds": round(idle_before_seconds, 6),
                    "projection_after_interval_seconds": round(idle_after_seconds, 6),
                    "graceful_shutdown": idle_shutdown,
                    "after_sigterm": idle_after_term,
                },
                "transport_idle_connection": transport_metrics,
                "recovery_fixtures": recovery_fixture,
                "cold_start_seconds": round(cold_start, 6),
                "cold_projection_seconds": round(cold_projection_ms, 6),
                "cold_projection": cold_projection,
                "graceful_shutdown": graceful_shutdown,
                "after_sigterm": after_sigterm,
                "warm_start_seconds": round(warm_start, 6),
                "warm_projection_seconds": round(warm_projection_ms, 6),
                "warm_projection": warm_projection,
                "sigkill_termination": crash_shutdown,
                "after_sigkill": after_sigkill,
                "crash_restart_seconds": round(restart_start, 6),
                "restart_projection_seconds": round(recovered_projection_ms, 6),
                "restart_projection_reconstruction_seconds": round(projection_seconds, 6),
                "persisted_after_crash": persistence,
                "post_restart_projection_after_controlled_idle_seconds": round(post_restart_projection_ms, 6),
                "post_restart_projection": post_restart_projection,
                "restart_graceful_shutdown": restart_graceful_shutdown,
                "after_restart_sigterm": after_restart_sigterm,
            })

    seconds_fields = (
        "cold_start_seconds", "idle_waiting_cold_start_seconds", "cold_projection_seconds",
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
        sample["idle_waiting_fixture"]["graceful_shutdown"]["duration_seconds"] for sample in raw
    ])
    seconds_summary["graceful_shutdown_seconds"] = summarize([
        sample["graceful_shutdown"]["duration_seconds"] for sample in raw
    ])
    seconds_summary["sigkill_process_termination_seconds"] = summarize([
        sample["sigkill_termination"]["duration_seconds"] for sample in raw
    ])
    return {
        "repetitions": repetitions,
        "idle_interval_seconds": idle_seconds,
        "transport_idle_interval_seconds": transport_seconds,
        "raw_samples": raw,
        "summary_seconds": seconds_summary,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument("--idle-seconds", type=float, default=10)
    parser.add_argument("--transport-seconds", type=float, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.repetitions < 1 or args.idle_seconds < 1 or args.transport_seconds < 1:
        parser.error("repetitions and intervals must be positive; intervals must be at least one second")
    common = {
        "schema": "ouroboros.headless-lifecycle-baseline/v2",
        "base_sha": subprocess.run(["git", "merge-base", "origin/main", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip(),
        "head_sha": subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip(),
        "environment": read_environment(),
    }
    try:
        result = {
            **common,
            "measurement_status": "completed",
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
        exit_code = 0
    except Exception as error:
        result = {
            **common,
            "measurement_status": "failed_not_comparable",
            "requested_repetitions": args.repetitions,
            "failure": STARTUP_FAILURE or {
                "error_code": "HARNESS_VALIDATION_FAILED",
                "error_type": type(error).__name__,
                "diagnostic": str(error)[:500],
            },
        }
        exit_code = 2
    encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded)
    sys.stdout.write(encoded)
    return exit_code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"headless lifecycle baseline failed: {error}", file=sys.stderr)
        raise
