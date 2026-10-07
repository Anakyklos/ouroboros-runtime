import importlib.util
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
