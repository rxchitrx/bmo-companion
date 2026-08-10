"""Schema-aware, read-only comparison of BMO evaluation runs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


SCENARIO_VERSION = "1.0"
COMPARISON_VERSION = "1.0"
METRICS = (
    "input",
    "cachedInput",
    "freshInput",
    "output",
    "reasoning",
    "turns",
    "toolCalls",
    "latency",
)


class LabError(ValueError):
    """Raised when replay input is invalid or cannot be compared safely."""


def _read_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as error:
        raise LabError(f"Cannot read {path}: {error.strerror or error}") from error
    except json.JSONDecodeError as error:
        raise LabError(f"Invalid JSON in {path}: line {error.lineno}, column {error.colno}") from error


def _require_object(value: Any, location: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise LabError(f"{location} must be an object.")
    return value


def _require_exact_keys(value: dict[str, Any], required: set[str], allowed: set[str], location: str) -> None:
    missing = sorted(required - value.keys())
    extra = sorted(value.keys() - allowed)
    if missing:
        raise LabError(f"{location} is missing: {', '.join(missing)}.")
    if extra:
        raise LabError(f"{location} has unsupported fields: {', '.join(extra)}.")


def _require_nonempty_string(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value:
        raise LabError(f"{location} must be a non-empty string.")
    return value


def _schema_enum(schema: dict[str, Any], *path: str) -> set[str]:
    current: Any = schema
    for part in path:
        current = current[part]
    return set(current)


def _validate_measurement(
    value: Any,
    location: str,
    expected_unit: str,
    statuses: set[str],
) -> None:
    measurement = _require_object(value, location)
    _require_exact_keys(measurement, {"status", "unit"}, {"status", "unit", "value", "note"}, location)
    status = measurement["status"]
    if status not in statuses:
        raise LabError(f"{location}.status is invalid: {status!r}.")
    if measurement["unit"] != expected_unit:
        raise LabError(f"{location}.unit must be {expected_unit!r}.")
    has_value = "value" in measurement
    if status == "measured" and not has_value:
        raise LabError(f"{location}.value is required when status is measured.")
    if status != "measured" and has_value:
        raise LabError(f"{location}.value must be omitted when status is {status}.")
    if has_value and (
        isinstance(measurement["value"], bool)
        or not isinstance(measurement["value"], (int, float))
        or measurement["value"] < 0
    ):
        raise LabError(f"{location}.value must be a non-negative number.")
    if "note" in measurement:
        _require_nonempty_string(measurement["note"], f"{location}.note")


def validate_results(results: Any, schema: dict[str, Any], source: Path) -> list[dict[str, Any]]:
    """Validate the evaluation-spine fields consumed by the lab."""
    if not isinstance(results, list) or not results:
        raise LabError(f"{source} must contain a non-empty JSON array of evaluation results.")

    required = set(schema.get("required", []))
    allowed = set(schema.get("properties", {}))
    expected_required = {
        "caseId", "caseName", "mode", *METRICS, "outcome", "verificationEvidence"
    }
    if required != expected_required:
        raise LabError("Evaluation schema is incompatible with comparison format 1.0.")

    statuses = _schema_enum(schema, "$defs", "status", "enum")
    modes = _schema_enum(schema, "properties", "mode", "enum")
    verdicts = _schema_enum(schema, "properties", "outcome", "properties", "verdict", "enum")
    evidence_kinds = _schema_enum(
        schema, "properties", "verificationEvidence", "items", "properties", "kind", "enum"
    )
    units = {
        "input": "tokens", "cachedInput": "tokens", "freshInput": "tokens",
        "output": "tokens", "reasoning": "tokens", "turns": "count",
        "toolCalls": "count", "latency": "milliseconds",
    }
    validated: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(results):
        location = f"{source}[{index}]"
        result = _require_object(raw, location)
        _require_exact_keys(result, required, allowed, location)
        case_id = _require_nonempty_string(result["caseId"], f"{location}.caseId")
        _require_nonempty_string(result["caseName"], f"{location}.caseName")
        if case_id in seen:
            raise LabError(f"{source} contains duplicate caseId {case_id!r}.")
        seen.add(case_id)
        if result["mode"] not in modes:
            raise LabError(f"{location}.mode is invalid: {result['mode']!r}.")
        for metric, unit in units.items():
            _validate_measurement(result[metric], f"{location}.{metric}", unit, statuses)

        outcome = _require_object(result["outcome"], f"{location}.outcome")
        _require_exact_keys(outcome, {"status", "verdict", "summary"}, {"status", "verdict", "summary"}, f"{location}.outcome")
        if outcome["status"] not in statuses:
            raise LabError(f"{location}.outcome.status is invalid.")
        if outcome["verdict"] not in verdicts:
            raise LabError(f"{location}.outcome.verdict is invalid.")
        _require_nonempty_string(outcome["summary"], f"{location}.outcome.summary")

        evidence = result["verificationEvidence"]
        if not isinstance(evidence, list) or not evidence:
            raise LabError(f"{location}.verificationEvidence must be a non-empty array.")
        for evidence_index, raw_item in enumerate(evidence):
            item_location = f"{location}.verificationEvidence[{evidence_index}]"
            item = _require_object(raw_item, item_location)
            _require_exact_keys(item, {"status", "kind", "detail"}, {"status", "kind", "detail"}, item_location)
            if item["status"] not in statuses:
                raise LabError(f"{item_location}.status is invalid.")
            if item["kind"] not in evidence_kinds:
                raise LabError(f"{item_location}.kind is invalid.")
            _require_nonempty_string(item["detail"], f"{item_location}.detail")
        validated.append(result)
    return validated


def load_scenario(path: str | Path) -> dict[str, Any]:
    scenario_path = Path(path).expanduser().resolve()
    scenario = _require_object(_read_json(scenario_path), str(scenario_path))
    required = {"schemaVersion", "scenarioId", "name", "evaluationResultSchema", "baseline", "candidate"}
    _require_exact_keys(scenario, required, required, str(scenario_path))
    if scenario["schemaVersion"] != SCENARIO_VERSION:
        raise LabError(
            f"Unsupported scenario schemaVersion {scenario['schemaVersion']!r}; expected {SCENARIO_VERSION!r}."
        )
    _require_nonempty_string(scenario["scenarioId"], "scenarioId")
    _require_nonempty_string(scenario["name"], "name")
    _require_nonempty_string(scenario["evaluationResultSchema"], "evaluationResultSchema")
    for run_name in ("baseline", "candidate"):
        run = _require_object(scenario[run_name], run_name)
        _require_exact_keys(run, {"label", "results"}, {"label", "results"}, run_name)
        _require_nonempty_string(run["label"], f"{run_name}.label")
        _require_nonempty_string(run["results"], f"{run_name}.results")
    scenario["_path"] = scenario_path
    return scenario


def _compare_measurement(baseline: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"baseline": baseline, "candidate": candidate}
    if baseline["status"] != "measured" or candidate["status"] != "measured":
        result.update(
            status="unavailable",
            note=f"Requires two measured values; got {baseline['status']} and {candidate['status']}.",
        )
        return result
    delta = candidate["value"] - baseline["value"]
    status = "improved" if delta < 0 else "regressed" if delta > 0 else "unchanged"
    result.update(status=status, delta=delta)
    if baseline["value"] != 0:
        result["percentDelta"] = round(delta / baseline["value"] * 100, 2)
    return result


def _compare_outcome(baseline: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"baseline": baseline, "candidate": candidate}
    if baseline["status"] != "measured" or candidate["status"] != "measured":
        result["status"] = "unavailable"
        return result
    rank = {"not-run": 0, "fail": 1, "pass": 2}
    delta = rank[candidate["verdict"]] - rank[baseline["verdict"]]
    result["status"] = "improved" if delta > 0 else "regressed" if delta < 0 else "unchanged"
    return result


def _compare_evidence(baseline: list[dict[str, Any]], candidate: list[dict[str, Any]]) -> dict[str, Any]:
    baseline_items = [{"kind": item["kind"], "detail": item["detail"]} for item in baseline]
    candidate_items = [{"kind": item["kind"], "detail": item["detail"]} for item in candidate]
    baseline_keys = {(item["kind"], item["detail"]) for item in baseline}
    candidate_keys = {(item["kind"], item["detail"]) for item in candidate}
    comparable = all(item["status"] == "measured" for item in [*baseline, *candidate])
    return {
        "status": ("unchanged" if baseline_keys == candidate_keys else "changed") if comparable else "unavailable",
        "baseline": baseline_items,
        "candidate": candidate_items,
        "added": [item for item in candidate_items if (item["kind"], item["detail"]) not in baseline_keys],
        "removed": [item for item in baseline_items if (item["kind"], item["detail"]) not in candidate_keys],
    }


def compare_scenario(scenario: dict[str, Any]) -> dict[str, Any]:
    scenario_path: Path = scenario["_path"]
    base_dir = scenario_path.parent
    schema_path = (base_dir / scenario["evaluationResultSchema"]).resolve()
    schema = _require_object(_read_json(schema_path), str(schema_path))

    loaded: dict[str, tuple[Path, list[dict[str, Any]]]] = {}
    for run_name in ("baseline", "candidate"):
        results_path = (base_dir / scenario[run_name]["results"]).resolve()
        loaded[run_name] = (results_path, validate_results(_read_json(results_path), schema, results_path))

    baseline_by_id = {item["caseId"]: item for item in loaded["baseline"][1]}
    candidate_by_id = {item["caseId"]: item for item in loaded["candidate"][1]}
    if baseline_by_id.keys() != candidate_by_id.keys():
        missing = sorted(baseline_by_id.keys() - candidate_by_id.keys())
        extra = sorted(candidate_by_id.keys() - baseline_by_id.keys())
        raise LabError(f"Run caseIds differ; missing candidate={missing}, candidate-only={extra}.")

    counts = {"improved": 0, "regressed": 0, "unchanged": 0, "unavailable": 0}
    cases = []
    for case_id, baseline in baseline_by_id.items():
        candidate = candidate_by_id[case_id]
        if baseline["mode"] != candidate["mode"]:
            raise LabError(
                f"Case {case_id!r} mixes modes {baseline['mode']!r} and {candidate['mode']!r}."
            )
        if baseline["caseName"] != candidate["caseName"]:
            raise LabError(f"Case {case_id!r} has different baseline and candidate names.")
        metrics = {}
        for metric in METRICS:
            comparison = _compare_measurement(baseline[metric], candidate[metric])
            metrics[metric] = comparison
            counts[comparison["status"]] += 1
        outcome = _compare_outcome(baseline["outcome"], candidate["outcome"])
        counts[outcome["status"]] += 1
        cases.append(
            {
                "caseId": case_id,
                "caseName": candidate["caseName"],
                "metrics": metrics,
                "outcome": outcome,
                "verificationEvidence": _compare_evidence(
                    baseline["verificationEvidence"], candidate["verificationEvidence"]
                ),
            }
        )

    if counts["regressed"]:
        verdict = "regression"
    elif counts["unavailable"]:
        verdict = "incomplete"
    else:
        verdict = "no-regression"
    return {
        "schemaVersion": COMPARISON_VERSION,
        "scenarioId": scenario["scenarioId"],
        "name": scenario["name"],
        "baseline": {"label": scenario["baseline"]["label"], "results": str(loaded["baseline"][0])},
        "candidate": {"label": scenario["candidate"]["label"], "results": str(loaded["candidate"][0])},
        "overallVerdict": verdict,
        "summary": {"caseCount": len(cases), **counts},
        "cases": cases,
    }
