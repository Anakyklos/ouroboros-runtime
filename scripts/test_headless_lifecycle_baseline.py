import importlib.util
import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen


SCRIPT = Path(__file__).with_name("headless-lifecycle-baseline.py")
SPEC = importlib.util.spec_from_file_location("headless_lifecycle_baseline", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline)


EXPECTED = {"fixture-ready": "ready", "fixture-waiting": "waiting_for_provider"}


def projection() -> dict:
    items = [
        {"missionId": mission_id, "state": state, "invocationIds": []}
        for mission_id, state in sorted(EXPECTED.items())
    ]
    return {
        "available": True,
        "mission_count": len(items),
        "mission_ids": [item["missionId"] for item in items],
        "states": {item["missionId"]: item["state"] for item in items},
        "items": items,
        "invocation_ids": [],
        "invocation_count": 0,
    }


class ProjectionValidationTests(unittest.TestCase):
    def test_accepts_exact_snapshot(self) -> None:
        baseline.validate_projection("valid", projection(), EXPECTED)

    def test_rejects_duplicate_mission_identity(self) -> None:
        broken = projection()
        broken["mission_ids"] = ["fixture-ready", "fixture-ready"]
        with self.assertRaises(AssertionError):
            baseline.validate_projection("duplicate", broken, EXPECTED)

    def test_rejects_missing_mission_cardinality(self) -> None:
        broken = projection()
        broken["items"] = broken["items"][:1]
        with self.assertRaises(AssertionError):
            baseline.validate_projection("missing", broken, EXPECTED)

    def test_rejects_mission_promoted_to_wrong_state(self) -> None:
        broken = projection()
        broken["states"]["fixture-waiting"] = "ready"
        with self.assertRaises(AssertionError):
            baseline.validate_projection("promoted", broken, EXPECTED)

    def test_rejects_unexpected_effect_invocation(self) -> None:
        broken = projection()
        broken["items"][0]["invocationIds"] = ["unexpected-effect"]
        broken["invocation_ids"] = ["unexpected-effect"]
        broken["invocation_count"] = 1
        with self.assertRaises(AssertionError):
            baseline.validate_projection("effect", broken, EXPECTED)

    def test_rejects_duplicate_persisted_fixture_identity(self) -> None:
        broken = {"missionIds": ["fixture-ready", "fixture-ready"], "states": EXPECTED}
        with self.assertRaises(AssertionError):
            baseline.validate_fixture_snapshot("duplicate-store", broken, EXPECTED)


class ExitStatusTests(unittest.TestCase):
    def test_sigterm_is_graceful_only_for_zero_exit_and_released_group(self) -> None:
        result = baseline.validate_exit_status("SIGTERM", 0, True)
        self.assertTrue(result["graceful"])
        for code, released in ((-15, True), (1, True), (0, False)):
            with self.subTest(code=code, released=released), self.assertRaises(AssertionError):
                baseline.validate_exit_status("SIGTERM", code, released)

    def test_sigkill_is_recorded_as_forced_not_graceful(self) -> None:
        result = baseline.validate_exit_status("SIGKILL", -9, True)
        self.assertTrue(result["forced"])
        self.assertFalse(result["graceful"])
        with self.assertRaises(AssertionError):
            baseline.validate_exit_status("SIGKILL", 0, True)


class AuthenticatedHarnessTests(unittest.TestCase):
    def test_fixture_refuses_to_seed_without_private_token_pipe(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ouroboros-baseline-no-pipe-test-") as directory:
            database = Path(directory) / ".ouroboros" / "missions.db"
            result = baseline.run(
                ["bun", "run", str(baseline.FIXTURES), str(database), "idle"],
                cwd=baseline.ROOT,
                env=baseline.controlled_child_env(Path(directory), database.parent),
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            baseline.assert_no_credential_material(result.stdout)
            baseline.assert_no_credential_material(result.stderr)
            self.assertFalse(database.parent.exists())

    def test_fixture_provisions_a_private_read_only_client_in_the_daemon_data_dir(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ouroboros-baseline-auth-test-") as directory:
            database = Path(directory) / ".ouroboros" / "missions.db"
            fixture, token, stdout = baseline.fixture(database, "idle")

            self.assertIsNotNone(token)
            self.assertTrue(token.startswith("oc1."))
            auth_database = database.parent / "local-control-auth.db"
            self.assertTrue(auth_database.is_file())
            self.assertEqual(database.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(auth_database.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(token, json.dumps(fixture))
            self.assertNotIn(token, stdout)
            self.assertNotIn("localControlToken", fixture)
            self.assertNotIn("ouroboros_control_session=", stdout)
            baseline.assert_no_credential_material(stdout, (token,))
            self.assertEqual(fixture["missionIds"], ["fixture-waiting"])

            inspected, inspect_token, inspect_stdout = baseline.fixture(database, "inspect")
            self.assertIsNone(inspect_token)
            baseline.assert_no_credential_material(inspect_stdout)
            self.assertEqual(inspected["missionIds"], ["fixture-waiting"])

    def test_persistable_output_rejects_bearer_and_browser_cookie_material(self) -> None:
        token = "oc1.synthetic.bearer"
        cookie = "ouroboros_control_session=synthetic-cookie"
        baseline.assert_no_credential_material({"mission_count": 1}, (token, cookie))
        with self.assertRaises(AssertionError):
            baseline.assert_no_credential_material({"diagnostic": token}, (token,))
        with self.assertRaises(AssertionError):
            baseline.assert_no_credential_material({"diagnostic": cookie}, (cookie,))
        with self.assertRaises(AssertionError):
            baseline.assert_no_credential_material({"authorization": f"Bearer {token}"})

    def test_rpc_read_sends_the_bearer_only_in_the_authorization_header(self) -> None:
        token = "oc1.temporary.credential"
        result = {"result": {"data": {"available": True}}}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(result).encode()

        with patch.object(baseline.urllib.request, "urlopen", return_value=Response()) as urlopen:
            actual = baseline.rpc_read(41234, "mission.list", token)

        request = urlopen.call_args.args[0]
        self.assertEqual(actual, result["result"])
        self.assertEqual(request.get_header("Authorization"), f"Bearer {token}")
        self.assertNotIn(token, request.full_url)
        self.assertNotIn(token, request.data.decode())

    def test_browser_session_exchange_uses_exact_origin_and_keeps_cookie_out_of_result_errors(self) -> None:
        token = "oc1.temporary.credential"
        origin = "http://127.0.0.1:41234"
        cookie_value = "private-session-value"

        class Response:
            status = 204
            headers = {"Set-Cookie": f"ouroboros_control_session={cookie_value}; Path=/ws; HttpOnly; SameSite=Strict"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        with patch.object(baseline.urllib.request, "urlopen", return_value=Response()) as urlopen:
            cookie = baseline.browser_session_cookie(41234, token, origin)

        request = urlopen.call_args.args[0]
        self.assertEqual(cookie, f"ouroboros_control_session={cookie_value}")
        self.assertEqual(request.get_header("Authorization"), f"Bearer {token}")
        self.assertEqual(request.get_header("Origin"), origin)
        self.assertNotIn(token, request.full_url)
        self.assertNotIn(cookie_value, request.full_url)

    def test_browser_session_rejects_missing_cookie_without_exposing_credentials(self) -> None:
        token = "oc1.temporary.credential"

        class Response:
            status = 204
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        with patch.object(baseline.urllib.request, "urlopen", return_value=Response()):
            with self.assertRaises(RuntimeError) as raised:
                baseline.browser_session_cookie(41234, token, "http://127.0.0.1:41234")
        self.assertNotIn(token, str(raised.exception))

    def test_rpc_http_rejection_is_sanitized(self) -> None:
        token = "oc1.temporary.credential"
        error = HTTPError("http://127.0.0.1:41234/rpc", 401, "unauthorized", {}, None)
        with patch.object(baseline.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "HTTP 401") as raised:
                baseline.rpc_read(41234, "mission.list", token)
        self.assertNotIn(token, str(raised.exception))


class HeadlessAuthenticationIntegrationTests(unittest.TestCase):
    @staticmethod
    def rpc_http_status(port: int, authorization: str | None) -> int:
        request = Request(
            f"http://127.0.0.1:{port}/rpc",
            data=json.dumps({
                "jsonrpc": "2.0",
                "id": "baseline-auth-probe",
                "method": "local_control.read",
                "params": {"operation": "mission.list", "protocolVersion": 1, "limit": 100},
            }).encode(),
            headers={
                "Content-Type": "application/json",
                **({"Authorization": authorization} if authorization else {}),
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=5) as response:
                return response.status
        except HTTPError as error:
            status = error.code
            error.close()
            return status

    @staticmethod
    def browser_session_status(port: int, authorization: str | None, origin: str) -> int:
        request = Request(
            f"http://127.0.0.1:{port}/auth/browser-session",
            headers={
                "Origin": origin,
                **({"Authorization": authorization} if authorization else {}),
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=5) as response:
                return response.status
        except HTTPError as error:
            status = error.code
            error.close()
            return status

    @staticmethod
    def websocket_status(port: int, origin: str, cookie: str | None = None) -> int:
        key = "dGhlIHNhbXBsZSBub25jZQ=="
        headers = [
            "GET /ws HTTP/1.1",
            f"Host: 127.0.0.1:{port}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
            f"Origin: {origin}",
        ]
        if cookie:
            headers.append(f"Cookie: {cookie}")
        request = "\r\n".join([*headers, "", ""]).encode("ascii")
        with socket.create_connection(("127.0.0.1", port), timeout=5) as client:
            client.settimeout(5)
            client.sendall(request)
            received = b""
            while b"\r\n\r\n" not in received:
                chunk = client.recv(4096)
                if not chunk:
                    raise AssertionError("Daemon closed the WebSocket request before an HTTP response")
                received += chunk
        status_line = received.split(b"\r\n", 1)[0].decode("latin1")
        parts = status_line.split(" ", 2)
        if len(parts) < 2 or not parts[1].isdigit():
            raise AssertionError("Daemon returned an invalid WebSocket HTTP status")
        return int(parts[1])

    def test_real_daemon_accepts_the_fixture_token_and_browser_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ouroboros-baseline-daemon-test-") as directory:
            database = Path(directory) / ".ouroboros" / "missions.db"
            fixture, token, fixture_stdout = baseline.fixture(database, "idle")
            self.assertIsNotNone(token)
            self.assertNotIn(token, fixture_stdout)
            auth_database = database.parent / "local-control-auth.db"
            auth_module = (baseline.ROOT / "cli/src/daemon/local-control-auth.ts").as_posix()
            provision_control = f'''
import {{ writeSync }} from "node:fs";
import {{ LocalControlCredentialStore }} from "{auth_module}";
const store = new LocalControlCredentialStore("{auth_database.as_posix()}");
try {{
  const credential = store.provision("lifecycle-control-probe", ["mission.control"], Date.now() + 60_000);
  writeSync(Number(process.env.OUROBOROS_PRIVATE_TOKEN_FD), credential.token, undefined, "utf8");
}} finally {{
  store.close();
}}
'''
            control_result, control_token = baseline.run_with_private_token(
                ["bun", "-e", provision_control], cwd=baseline.ROOT,
                env=baseline.controlled_child_env(Path(directory), database.parent),
            )
            self.assertEqual(control_result.returncode, 0)
            self.assertIsNotNone(control_token)
            baseline.assert_no_credential_material(control_result.stdout, (control_token,))
            port = baseline.free_port()
            origin = f"http://127.0.0.1:{port}"
            process, _startup_seconds = baseline.start_daemon(Path(directory), port, origin)
            socket = None
            try:
                self.assertEqual(self.rpc_http_status(port, None), 401)
                self.assertEqual(self.rpc_http_status(port, "Bearer oc1.invalid.invalid"), 401)
                self.assertEqual(self.rpc_http_status(port, f"Bearer {control_token}"), 403)
                self.assertEqual(self.browser_session_status(port, None, origin), 403)
                self.assertEqual(self.browser_session_status(port, "Bearer oc1.invalid.invalid", origin), 403)
                self.assertEqual(self.browser_session_status(port, f"Bearer {control_token}", origin), 403)
                self.assertEqual(self.browser_session_status(port, f"Bearer {token}", "http://attacker.invalid"), 403)
                self.assertEqual(self.websocket_status(port, origin), 401)
                allowed_cookie = baseline.browser_session_cookie(port, token, origin)
                self.assertEqual(self.websocket_status(port, "http://attacker.invalid", allowed_cookie), 403)

                projection_seconds, projection = baseline.rpc_projection(port, token)
                self.assertGreaterEqual(projection_seconds, 0)
                self.assertEqual(projection["mission_ids"], ["fixture-waiting"])
                self.assertEqual(projection["invocation_ids"], [])
                stream = baseline.idle_websocket(port, token, origin)
                socket = stream["socket"]
                self.assertGreaterEqual(stream["handshake_seconds"], 0)
                self.assertNotIn(token, json.dumps({key: value for key, value in stream.items() if key != "socket"}))
                self.assertEqual(stream["status_code"], 101)
            finally:
                if socket is not None:
                    socket.close()
                baseline.stop_daemon(process, "SIGTERM")

            persisted, inspect_token, inspect_stdout = baseline.fixture(database, "inspect")
            self.assertIsNone(inspect_token)
            baseline.assert_no_credential_material(inspect_stdout)
            self.assertEqual(persisted["missionIds"], ["fixture-waiting"])
            self.assertEqual(persisted["states"], {"fixture-waiting": "waiting_for_provider"})

    def test_inherited_data_dir_cannot_redirect_daemon_away_from_fixture(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ouroboros-baseline-isolation-test-") as directory:
            root = Path(directory)
            fixture_root = root / "measured-instance"
            alternate_root = root / "operator-synthetic-data"
            fixture_db = fixture_root / ".ouroboros" / "missions.db"
            alternate_db = alternate_root / ".ouroboros" / "missions.db"
            fixture_data, fixture_token, _fixture_stdout = baseline.fixture(fixture_db, "idle")
            alternate_data, alternate_token, _alternate_stdout = baseline.fixture(alternate_db, "recovery")
            self.assertIsNotNone(fixture_token)
            self.assertIsNotNone(alternate_token)
            self.assertEqual(fixture_data["missionIds"], ["fixture-waiting"])
            self.assertEqual(set(alternate_data["missionIds"]), {"fixture-ready", "fixture-waiting"})
            sentinel = alternate_root / "operator-sentinel.txt"
            sentinel.write_text("synthetic operator data; must remain untouched\n")
            alternate_before = {
                path.relative_to(alternate_root).as_posix(): path.read_bytes()
                for path in alternate_root.rglob("*") if path.is_file()
            }

            port = baseline.free_port()
            origin = f"http://127.0.0.1:{port}"
            daemon = None
            with patch.dict("os.environ", {
                "OUROBOROS_DATA_DIR": str(alternate_root / ".ouroboros"),
                "OUROBOROS_OPS_PATH": str(alternate_root / "operator-ops.json"),
                "OUROBOROS_PORT": "1",
                "OUROBOROS_ALLOWED_ORIGINS": "http://attacker.invalid",
                "HOME": str(alternate_root),
                "XDG_CONFIG_HOME": str(alternate_root / "config"),
                "TMPDIR": str(alternate_root / "tmp"),
                "BUN_OPTIONS": "--preload=/synthetic/operator-preload.js",
                "NODE_OPTIONS": "--require=/synthetic/operator-preload.cjs",
                "LD_PRELOAD": "/synthetic/operator-library.so",
                "DWAVE_API_KEY": "synthetic-operator-key",
                "ZAI_API_KEY": "synthetic-operator-key",
            }):
                daemon, _startup_seconds = baseline.start_daemon(fixture_root, port, origin)
                try:
                    _duration, projection = baseline.rpc_projection(port, fixture_token)
                    baseline.validate_projection(
                        "inherited-data-dir-isolation", projection,
                        {"fixture-waiting": "waiting_for_provider"},
                    )
                    cookie = baseline.browser_session_cookie(port, fixture_token, origin)
                    self.assertEqual(self.websocket_status(port, origin, cookie), 101)
                    self.assertEqual(self.websocket_status(port, "http://attacker.invalid", cookie), 403)
                finally:
                    baseline.stop_daemon(daemon, "SIGTERM")

            alternate_after = {
                path.relative_to(alternate_root).as_posix(): path.read_bytes()
                for path in alternate_root.rglob("*") if path.is_file()
            }
            self.assertEqual(alternate_after, alternate_before)
            self.assertTrue(sentinel.is_file())
            self.assertFalse((alternate_root / "operator-ops.json").exists())
            self.assertFalse((alternate_root / ".ouroboros" / "daemon-ops.json").exists())

            daemon_env = baseline.controlled_child_env(
                fixture_root,
                fixture_root / ".ouroboros",
                port=port,
                origin=origin,
            )
            self.assertEqual(daemon_env["OUROBOROS_DATA_DIR"], str((fixture_root / ".ouroboros").resolve()))
            self.assertEqual(daemon_env["OUROBOROS_OPS_PATH"], str((fixture_root / ".ouroboros" / "daemon-ops.json").resolve()))
            self.assertEqual(daemon_env["HOME"], str(fixture_root.resolve()))
            for key in (
                "OUROBOROS_PRIVATE_TOKEN_FD", "BUN_OPTIONS", "NODE_OPTIONS", "LD_PRELOAD",
                "DWAVE_API_KEY", "ZAI_API_KEY", "SSL_CERT_FILE",
            ):
                self.assertNotIn(key, daemon_env)
            self.assertEqual(daemon_env["OUROBOROS_PORT"], str(port))
            self.assertEqual(daemon_env["OUROBOROS_ALLOWED_ORIGINS"], origin)
            self.assertNotIn("OUROBOROS_PRIVATE_TOKEN_FD", daemon_env)


if __name__ == "__main__":
    unittest.main()
