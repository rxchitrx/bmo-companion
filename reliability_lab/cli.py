"""Command-line interface for the offline BMO reliability lab."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Sequence

from .comparison import LabError, METRICS, compare_scenario, load_scenario
from .trajectory import TrajectoryError, load_trajectory, render_replay, replay_trajectory


LABELS = {
    "cachedInput": "cached input",
    "freshInput": "fresh input",
    "toolCalls": "tool calls",
}


def _measurement_text(measurement: dict[str, Any]) -> str:
    if measurement["status"] == "measured":
        return f"{measurement['value']:g} {measurement['unit']}"
    return measurement["status"]


def render_scorecard(comparison: dict[str, Any]) -> str:
    summary = comparison["summary"]
    lines = [
        f"BMO Reliability Lab: {comparison['name']}",
        f"Overall: {comparison['overallVerdict'].upper()}",
        (
            f"Cases: {summary['caseCount']} | improved {summary['improved']} | "
            f"regressed {summary['regressed']} | unchanged {summary['unchanged']} | "
            f"unavailable {summary['unavailable']}"
        ),
    ]
    for case in comparison["cases"]:
        outcome = case["outcome"]
        lines.extend(["", f"{case['caseName']} ({case['caseId']})"])
        for metric in METRICS:
            item = case["metrics"][metric]
            delta = ""
            if "delta" in item:
                delta = f" (delta {item['delta']:+g})"
            lines.append(
                f"  {LABELS.get(metric, metric)}: {_measurement_text(item['baseline'])} -> "
                f"{_measurement_text(item['candidate'])} [{item['status']}]{delta}"
            )
        lines.append(
            f"  outcome: {outcome['baseline']['verdict']} -> {outcome['candidate']['verdict']} "
            f"[{outcome['status']}]"
        )
        evidence = case["verificationEvidence"]
        lines.append(
            f"  evidence: {len(evidence['baseline'])} -> {len(evidence['candidate'])} "
            f"[{evidence['status']}]"
        )
    return "\n".join(lines) + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Compare two saved BMO evaluation-spine runs offline.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    compare = subparsers.add_parser("compare", help="compare the runs named by a versioned scenario")
    compare.add_argument("scenario", help="path to scenario JSON")
    compare.add_argument("--json", action="store_true", help="emit machine-readable comparison JSON")
    replay = subparsers.add_parser(
        "replay",
        help="replay a privacy-safe trajectory against a deterministic fixture",
    )
    replay.add_argument("trajectory", help="path to a trajectory JSON record")
    replay.add_argument(
        "--fixture",
        default=None,
        help="fixture id; defaults to the record's trajectoryId when it names a fixture",
    )
    replay.add_argument("--json", action="store_true", help="emit machine-readable replay JSON")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "replay":
        try:
            trajectory = load_trajectory(args.trajectory)
            fixture = args.fixture or trajectory["trajectoryId"]
            result = replay_trajectory(trajectory, fixture)
        except (LabError, TrajectoryError) as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
        if args.json:
            print(json.dumps(result, indent=2, sort_keys=True))
        else:
            print(render_replay(result), end="")
        return 0 if result["status"] == "passed" else 1
    try:
        comparison = compare_scenario(load_scenario(args.scenario))
    except LabError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(comparison, indent=2, sort_keys=True))
    else:
        print(render_scorecard(comparison), end="")
    return 1 if comparison["overallVerdict"] == "regression" else 0
