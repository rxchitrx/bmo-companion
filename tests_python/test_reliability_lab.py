from __future__ import annotations

import copy
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from reliability_lab.cli import main, render_replay, render_scorecard
from reliability_lab.comparison import LabError, compare_scenario, load_scenario, validate_results
from reliability_lab.trajectory import (
    TrajectoryError,
    load_trajectory,
    replay_trajectory,
    validate_trajectory,
)


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "reliability_lab/scenarios/deterministic-example.json"
SCHEMA = json.loads((ROOT / "evaluation/evaluation-result.schema.json").read_text(encoding="utf-8"))
FIXTURE = json.loads((ROOT / "reliability_lab/fixtures/deterministic-baseline.json").read_text(encoding="utf-8"))
TRAJECTORY_FIXTURE = ROOT / "reliability_lab/fixtures/trajectory-verified-completion.json"


class ReliabilityLabTests(unittest.TestCase):
    def test_example_preserves_unavailable_fields(self) -> None:
        comparison = compare_scenario(load_scenario(EXAMPLE))

        self.assertEqual(comparison["overallVerdict"], "incomplete")
        self.assertEqual(comparison["summary"], {
            "caseCount": 1,
            "improved": 0,
            "regressed": 0,
            "unchanged": 3,
            "unavailable": 6,
        })
        self.assertEqual(comparison["cases"][0]["metrics"]["input"]["status"], "unavailable")
        self.assertNotIn("delta", comparison["cases"][0]["metrics"]["latency"])

    def test_measured_resources_compare_lower_as_better(self) -> None:
        baseline = copy.deepcopy(FIXTURE[0])
        candidate = copy.deepcopy(FIXTURE[0])
        baseline["input"] = {"status": "measured", "unit": "tokens", "value": 100}
        candidate["input"] = {"status": "measured", "unit": "tokens", "value": 80}
        baseline["latency"] = {"status": "measured", "unit": "milliseconds", "value": 50}
        candidate["latency"] = {"status": "measured", "unit": "milliseconds", "value": 75}
        comparison = self._compare_temp([baseline], [candidate])

        metrics = comparison["cases"][0]["metrics"]
        self.assertEqual(metrics["input"]["status"], "improved")
        self.assertEqual(metrics["input"]["delta"], -20)
        self.assertEqual(metrics["input"]["percentDelta"], -20.0)
        self.assertEqual(metrics["latency"]["status"], "regressed")
        self.assertEqual(comparison["overallVerdict"], "regression")

    def test_outcome_regression_is_reported(self) -> None:
        candidate = copy.deepcopy(FIXTURE[0])
        candidate["outcome"] = {"status": "measured", "verdict": "fail", "summary": "Failed replay."}
        comparison = self._compare_temp(FIXTURE, [candidate])

        self.assertEqual(comparison["cases"][0]["outcome"]["status"], "regressed")
        self.assertEqual(comparison["overallVerdict"], "regression")

    def test_mixed_fixture_and_live_modes_are_rejected(self) -> None:
        candidate = copy.deepcopy(FIXTURE[0])
        candidate["mode"] = "live-runtime"
        with self.assertRaisesRegex(LabError, "mixes modes"):
            self._compare_temp(FIXTURE, [candidate])

    def test_schema_rejects_measured_value_that_is_missing(self) -> None:
        invalid = copy.deepcopy(FIXTURE)
        invalid[0]["turns"] = {"status": "measured", "unit": "count"}
        with self.assertRaisesRegex(LabError, "value is required"):
            validate_results(invalid, SCHEMA, Path("invalid.json"))

    def test_unknown_scenario_version_is_rejected(self) -> None:
        scenario = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        scenario["schemaVersion"] = "2.0"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scenario.json"
            path.write_text(json.dumps(scenario), encoding="utf-8")
            with self.assertRaisesRegex(LabError, "Unsupported scenario"):
                load_scenario(path)

    def test_machine_readable_cli(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            exit_code = main(["compare", str(EXAMPLE), "--json"])
        result = json.loads(output.getvalue())

        self.assertEqual(exit_code, 0)
        self.assertEqual(result["schemaVersion"], "1.0")
        self.assertEqual(result["scenarioId"], "deterministic-zero-tool-replay")

    def test_scorecard_is_concise_and_complete(self) -> None:
        text = render_scorecard(compare_scenario(load_scenario(EXAMPLE)))

        self.assertIn("Overall: INCOMPLETE", text)
        self.assertIn("cached input: unsupported -> unsupported [unavailable]", text)
        self.assertIn("outcome: pass -> pass [unchanged]", text)
        self.assertIn("evidence: 2 -> 2 [unchanged]", text)

    def test_trajectory_fixture_replays_without_execution(self) -> None:
        trajectory = load_trajectory(TRAJECTORY_FIXTURE)
        result = replay_trajectory(trajectory, "verified-completion")

        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["terminalState"], "completed")
        self.assertEqual(result["toolExecutionCount"], 0)
        self.assertEqual(result["liveServiceCallCount"], 0)
        self.assertEqual(result["computerUseCallCount"], 0)
        self.assertEqual(validate_trajectory(trajectory), [])

    def test_trajectory_rejects_raw_text_in_event_metadata(self) -> None:
        trajectory = json.loads(TRAJECTORY_FIXTURE.read_text(encoding="utf-8"))
        trajectory["events"][0]["metadata"]["goal"] = "private prompt"

        errors = validate_trajectory(trajectory)
        self.assertTrue(any("raw or unsupported text" in error for error in errors))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid-trajectory.json"
            path.write_text(json.dumps(trajectory), encoding="utf-8")
            with self.assertRaisesRegex(TrajectoryError, "Invalid trajectory"):
                load_trajectory(path)

    def test_trajectory_replay_fails_closed_before_allow(self) -> None:
        trajectory = json.loads(TRAJECTORY_FIXTURE.read_text(encoding="utf-8"))
        trajectory["events"] = [
            {"sequence": 1, "type": "task.created", "metadata": {}},
            {"sequence": 2, "type": "kernel.worker_started", "metadata": {"workerId": "codex-task"}},
            {"sequence": 3, "type": "kernel.outcome_verified", "metadata": {"outcomeStatus": "verified"}},
            {"sequence": 4, "type": "task.completed", "metadata": {"status": "completed"}},
        ]

        result = replay_trajectory(trajectory, "verified-completion")
        self.assertEqual(result["status"], "failed")
        self.assertTrue(any("without an allow decision" in violation for violation in result["violations"]))

    def test_trajectory_cli_has_machine_and_human_modes(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            exit_code = main(["replay", str(TRAJECTORY_FIXTURE), "--fixture", "verified-completion", "--json"])
        result = json.loads(output.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["toolExecutionCount"], 0)

        text = render_replay(result)
        self.assertIn("Status: PASSED", text)
        self.assertIn("tools=0, live-services=0, computer-use=0", text)

    def _compare_temp(self, baseline: list[dict], candidate: list[dict]) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            (temp / "baseline.json").write_text(json.dumps(baseline), encoding="utf-8")
            (temp / "candidate.json").write_text(json.dumps(candidate), encoding="utf-8")
            (temp / "schema.json").write_text(json.dumps(SCHEMA), encoding="utf-8")
            scenario = {
                "schemaVersion": "1.0",
                "scenarioId": "test",
                "name": "Test scenario",
                "evaluationResultSchema": "schema.json",
                "baseline": {"label": "baseline", "results": "baseline.json"},
                "candidate": {"label": "candidate", "results": "candidate.json"},
            }
            (temp / "scenario.json").write_text(json.dumps(scenario), encoding="utf-8")
            return compare_scenario(load_scenario(temp / "scenario.json"))


if __name__ == "__main__":
    unittest.main()
