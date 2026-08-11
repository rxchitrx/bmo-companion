"""Offline validation and deterministic replay for privacy-safe BMO trajectories.

The replay engine is deliberately a state machine. It never imports Electron,
starts a worker, calls a service, opens a browser, or executes Computer Use.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


TRAJECTORY_SCHEMA_VERSION = "1.0"
TRAJECTORY_RECORD_TYPE = "bmo.trajectory"
SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
DIGEST = re.compile(r"^[a-f0-9]{12,64}$")
FULL_DIGEST = re.compile(r"^[a-f0-9]{64}$")
SAFE_METADATA_KEYS = {
    "action",
    "artifactCount",
    "authorityExpiresAt",
    "contextItemCount",
    "decision",
    "errorName",
    "guardrailReason",
    "kind",
    "limit",
    "manifestVersion",
    "observed",
    "outcomeStatus",
    "packetVersion",
    "reason",
    "reconciliationRequired",
    "selectedCapabilityCount",
    "status",
    "taskKind",
    "usedContentChars",
    "verifiedClaim",
    "workerId",
}
TEXT_METADATA_KEYS = {"message", "detail", "summary", "statement", "text", "goal", "prompt", "content"}
EXECUTION_EVENT = re.compile(r"(^|[._-])(tool|connector|computer)([._-].*)?(execut|call|use|started)", re.IGNORECASE)


class TrajectoryError(ValueError):
    """Raised when a trajectory is invalid or cannot be replayed safely."""


TRAJECTORY_REPLAY_FIXTURES: dict[str, dict[str, Any]] = {
    "approval-pause": {
        "id": "approval-pause",
        "expectedTerminalState": "needs_decision",
        "requiredEventTypes": ["task.created", "kernel.permission_decided", "task.needs_decision"],
        "forbiddenEventTypes": ["kernel.worker_started", "tool.executed", "connector.executed", "computer.executed"],
    },
    "stop-cancel": {
        "id": "stop-cancel",
        "expectedTerminalState": "cancelled",
        "requiredEventTypes": ["task.created", "task.approved", "kernel.permission_decided", "kernel.worker_started", "task.cancelled"],
        "forbiddenEventTypes": ["work.after_cancel", "connector.executed", "computer.executed"],
    },
    "verified-completion": {
        "id": "verified-completion",
        "expectedTerminalState": "completed",
        "requiredEventTypes": ["task.created", "task.approved", "kernel.permission_decided", "kernel.worker_started", "kernel.outcome_verified", "task.completed"],
        "forbiddenEventTypes": ["connector.executed", "computer.executed"],
    },
    "guardrail-decision": {
        "id": "guardrail-decision",
        "expectedTerminalState": "needs_decision",
        "requiredEventTypes": ["task.created", "task.approved", "kernel.permission_decided", "kernel.worker_started", "kernel.guardrail_triggered", "task.needs_decision"],
        "forbiddenEventTypes": ["task.completed", "connector.executed", "computer.executed"],
    },
    "corrected-completion": {
        "id": "corrected-completion",
        "expectedTerminalState": "completed",
        "requiredEventTypes": ["task.needs_decision", "user.correction", "task.approved", "kernel.outcome_verified", "task.completed"],
        "forbiddenEventTypes": ["connector.executed", "computer.executed"],
    },
}


def _read_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as error:
        raise TrajectoryError(f"Cannot read {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise TrajectoryError(f"Invalid JSON in {path}: line {error.lineno}, column {error.colno}") from error


def _object(value: Any, location: str, errors: list[str]) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        errors.append(f"{location} must be an object.")
        return None
    return value


def _exact_keys(value: dict[str, Any], required: set[str], allowed: set[str], location: str, errors: list[str]) -> None:
    missing = sorted(required - value.keys())
    extra = sorted(value.keys() - allowed)
    if missing:
        errors.append(f"{location} is missing: {', '.join(missing)}.")
    if extra:
        errors.append(f"{location} has unsupported fields: {', '.join(extra)}.")


def _safe_id(value: Any, location: str, errors: list[str], *, full: bool = False) -> None:
    pattern = FULL_DIGEST if full else SAFE_IDENTIFIER
    if not isinstance(value, str) or not pattern.fullmatch(value):
        errors.append(f"{location} must be a bounded identifier.")


def _digest(value: Any, location: str, errors: list[str], *, full_hash: bool = False) -> None:
    item = _object(value, location, errors)
    if item is None:
        return
    _exact_keys(item, {"chars", "utf8Bytes", "sha256"}, {"chars", "utf8Bytes", "sha256"}, location, errors)
    for field in ("chars", "utf8Bytes"):
        if not isinstance(item.get(field), int) or isinstance(item.get(field), bool) or item[field] < 0:
            errors.append(f"{location}.{field} must be a non-negative integer.")
    pattern = FULL_DIGEST if full_hash else DIGEST
    if not isinstance(item.get("sha256"), str) or not pattern.fullmatch(item["sha256"]):
        errors.append(f"{location}.sha256 is invalid.")


def _validate_event_metadata(value: Any, location: str, errors: list[str]) -> None:
    item = _object(value, location, errors)
    if item is None:
        return
    for key, entry in item.items():
        if not isinstance(key, str) or not SAFE_IDENTIFIER.fullmatch(key):
            errors.append(f"{location} contains an invalid key.")
        if isinstance(entry, str):
            if key in TEXT_METADATA_KEYS or key not in SAFE_METADATA_KEYS or not SAFE_IDENTIFIER.fullmatch(entry):
                errors.append(f"{location}.{key} contains raw or unsupported text.")
        elif isinstance(entry, (int, float)) and not isinstance(entry, bool):
            if entry < 0:
                errors.append(f"{location}.{key} must not be negative.")
        elif isinstance(entry, bool):
            continue
        else:
            _digest(entry, f"{location}.{key}", errors)


def validate_trajectory(record: Any) -> list[str]:
    """Return privacy and shape errors without mutating the record."""

    errors: list[str] = []
    root = _object(record, "trajectory", errors)
    if root is None:
        return errors
    required = {
        "schemaVersion", "recordType", "trajectoryId", "privacy", "task", "context", "events",
        "selectedCapabilities", "usageDeltas", "guardrailOutcomes", "verificationEvidence", "userCorrections",
    }
    _exact_keys(root, required, required | {"verificationDecision"}, "trajectory", errors)
    if root.get("schemaVersion") != TRAJECTORY_SCHEMA_VERSION:
        errors.append("schemaVersion is unsupported.")
    if root.get("recordType") != TRAJECTORY_RECORD_TYPE:
        errors.append("recordType is unsupported.")
    _safe_id(root.get("trajectoryId"), "trajectoryId", errors)

    privacy = _object(root.get("privacy"), "privacy", errors)
    expected_privacy = {
        "rawContent": False,
        "rawToolData": False,
        "personalData": False,
        "replayExecutesTools": False,
        "replayUsesLiveServices": False,
        "replayUsesComputerUse": False,
    }
    if privacy != expected_privacy:
        errors.append("privacy contract must explicitly disable raw data and live replay.")

    task = _object(root.get("task"), "task", errors)
    if task is not None:
        _exact_keys(task, {"taskId", "goal", "kind"}, {"taskId", "goal", "kind", "model", "effort"}, "task", errors)
        _digest(task.get("taskId"), "task.taskId", errors, full_hash=True)
        _digest(task.get("goal"), "task.goal", errors, full_hash=True)
        _safe_id(task.get("kind"), "task.kind", errors)
        for field in ("model", "effort"):
            if field in task:
                _safe_id(task[field], f"task.{field}", errors)

    context = _object(root.get("context"), "context", errors)
    if context is not None:
        _exact_keys(context, {"segments"}, {"packetVersion", "itemCount", "usedContentChars", "segments"}, "context", errors)
        if "packetVersion" in context:
            _safe_id(context["packetVersion"], "context.packetVersion", errors)
        for field in ("itemCount", "usedContentChars"):
            if field in context and (not isinstance(context[field], int) or isinstance(context[field], bool) or context[field] < 0):
                errors.append(f"context.{field} must be a non-negative integer.")
        segments = context.get("segments")
        if not isinstance(segments, list):
            errors.append("context.segments must be an array.")
        else:
            for index, raw_segment in enumerate(segments):
                segment = _object(raw_segment, f"context.segments[{index}]", errors)
                if segment is None:
                    continue
                _exact_keys(
                    segment,
                    {"name", "source", "provenance", "measurement"},
                    {"name", "source", "provenance", "measurement", "chars", "utf8Bytes", "sha256", "itemCount", "budgetChars", "truncated"},
                    f"context.segments[{index}]",
                    errors,
                )
                for field in ("name", "source", "provenance", "measurement"):
                    _safe_id(segment.get(field), f"context.segments[{index}].{field}", errors)
                for field in ("chars", "utf8Bytes", "itemCount", "budgetChars"):
                    if field in segment and (not isinstance(segment[field], int) or isinstance(segment[field], bool) or segment[field] < 0):
                        errors.append(f"context.segments[{index}].{field} must be a non-negative integer.")
                if "sha256" in segment and (not isinstance(segment["sha256"], str) or not FULL_DIGEST.fullmatch(segment["sha256"])):
                    errors.append(f"context.segments[{index}].sha256 is invalid.")
                if "truncated" in segment and not isinstance(segment["truncated"], bool):
                    errors.append(f"context.segments[{index}].truncated must be boolean.")

    events = root.get("events")
    if not isinstance(events, list):
        errors.append("events must be an array.")
    else:
        prior_sequence = 0
        for index, raw_event in enumerate(events):
            event = _object(raw_event, f"events[{index}]", errors)
            if event is None:
                continue
            _exact_keys(event, {"sequence", "type", "metadata"}, {"sequence", "type", "elapsedMs", "metadata"}, f"events[{index}]", errors)
            sequence = event.get("sequence")
            if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence <= prior_sequence:
                errors.append(f"events[{index}].sequence must increase monotonically.")
            elif sequence > prior_sequence:
                prior_sequence = sequence
            _safe_id(event.get("type"), f"events[{index}].type", errors)
            if "elapsedMs" in event and (not isinstance(event["elapsedMs"], int) or isinstance(event["elapsedMs"], bool) or event["elapsedMs"] < 0):
                errors.append(f"events[{index}].elapsedMs must be a non-negative integer.")
            _validate_event_metadata(event.get("metadata"), f"events[{index}].metadata", errors)

    selected = root.get("selectedCapabilities")
    if not isinstance(selected, list):
        errors.append("selectedCapabilities must be an array.")
    else:
        for index, raw_capability in enumerate(selected):
            capability = _object(raw_capability, f"selectedCapabilities[{index}]", errors)
            if capability is None:
                continue
            _exact_keys(capability, {"id", "source", "reason"}, {"id", "source", "reason"}, f"selectedCapabilities[{index}]", errors)
            _safe_id(capability.get("id"), f"selectedCapabilities[{index}].id", errors)
            if capability.get("source") not in {"context-packet", "connector-selector"}:
                errors.append(f"selectedCapabilities[{index}].source is invalid.")
            _digest(capability.get("reason"), f"selectedCapabilities[{index}].reason", errors)

    usage = root.get("usageDeltas")
    if not isinstance(usage, list):
        errors.append("usageDeltas must be an array.")
    else:
        for index, raw_delta in enumerate(usage):
            delta = _object(raw_delta, f"usageDeltas[{index}]", errors)
            if delta is None:
                continue
            fields = {"sequence", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"}
            _exact_keys(delta, fields, fields, f"usageDeltas[{index}]", errors)
            for field in fields:
                if not isinstance(delta.get(field), int) or isinstance(delta.get(field), bool) or delta[field] < 0:
                    errors.append(f"usageDeltas[{index}].{field} must be a non-negative integer.")

    guardrails = root.get("guardrailOutcomes")
    if not isinstance(guardrails, list):
        errors.append("guardrailOutcomes must be an array.")
    else:
        for index, raw_guardrail in enumerate(guardrails):
            guardrail = _object(raw_guardrail, f"guardrailOutcomes[{index}]", errors)
            if guardrail is None:
                continue
            required_guardrail = {"version", "action", "reason", "observed", "limit", "summaryDigest"}
            _exact_keys(guardrail, required_guardrail, required_guardrail | {"sequence"}, f"guardrailOutcomes[{index}]", errors)
            for field in ("version", "observed", "limit"):
                if not isinstance(guardrail.get(field), int) or isinstance(guardrail.get(field), bool) or guardrail[field] < 0:
                    errors.append(f"guardrailOutcomes[{index}].{field} must be a non-negative integer.")
            if guardrail.get("action") not in {"stop", "summarize", "needs-decision"}:
                errors.append(f"guardrailOutcomes[{index}].action is invalid.")
            if guardrail.get("reason") not in {"tokens", "time", "tool-calls", "turns", "loop", "repeated-failures"}:
                errors.append(f"guardrailOutcomes[{index}].reason is invalid.")
            if "sequence" in guardrail and (not isinstance(guardrail["sequence"], int) or guardrail["sequence"] < 1):
                errors.append(f"guardrailOutcomes[{index}].sequence is invalid.")
            _digest(guardrail.get("summaryDigest"), f"guardrailOutcomes[{index}].summaryDigest", errors)

    decision = root.get("verificationDecision")
    if decision is not None:
        decision_object = _object(decision, "verificationDecision", errors)
        if decision_object is not None:
            _exact_keys(decision_object, {"version", "status", "reasonCodes", "evidence"}, {"version", "status", "reasonCodes", "evidence"}, "verificationDecision", errors)
            if not isinstance(decision_object.get("version"), int) or decision_object["version"] < 1:
                errors.append("verificationDecision.version is invalid.")
            if decision_object.get("status") not in {"verified", "unverified"}:
                errors.append("verificationDecision.status is invalid.")
            if not isinstance(decision_object.get("reasonCodes"), list):
                errors.append("verificationDecision.reasonCodes must be an array.")
            else:
                for index, code in enumerate(decision_object["reasonCodes"]):
                    _safe_id(code, f"verificationDecision.reasonCodes[{index}]", errors)
            evidence_counts = _object(decision_object.get("evidence"), "verificationDecision.evidence", errors)
            if evidence_counts is not None:
                count_fields = {"considered", "supporting", "contradictory", "directSupporting"}
                _exact_keys(evidence_counts, count_fields, count_fields, "verificationDecision.evidence", errors)
                for field in count_fields:
                    if not isinstance(evidence_counts.get(field), int) or evidence_counts[field] < 0:
                        errors.append(f"verificationDecision.evidence.{field} is invalid.")

    evidence = root.get("verificationEvidence")
    if not isinstance(evidence, list):
        errors.append("verificationEvidence must be an array.")
    else:
        for index, raw_evidence in enumerate(evidence):
            item = _object(raw_evidence, f"verificationEvidence[{index}]", errors)
            if item is None:
                continue
            fields = {"id", "kind", "source", "polarity", "strength", "statementDigest"}
            _exact_keys(item, fields, fields, f"verificationEvidence[{index}]", errors)
            for field in ("id", "kind", "source"):
                _safe_id(item.get(field), f"verificationEvidence[{index}].{field}", errors)
            if item.get("polarity") not in {"supports", "contradicts"}:
                errors.append(f"verificationEvidence[{index}].polarity is invalid.")
            if item.get("strength") not in {"direct", "indirect"}:
                errors.append(f"verificationEvidence[{index}].strength is invalid.")
            _digest(item.get("statementDigest"), f"verificationEvidence[{index}].statementDigest", errors)

    corrections = root.get("userCorrections")
    if not isinstance(corrections, list):
        errors.append("userCorrections must be an array.")
    else:
        for index, raw_correction in enumerate(corrections):
            correction = _object(raw_correction, f"userCorrections[{index}]", errors)
            if correction is None:
                continue
            fields = {"sequence", "kind", "correctionDigest"}
            _exact_keys(correction, fields, fields, f"userCorrections[{index}]", errors)
            if not isinstance(correction.get("sequence"), int) or correction["sequence"] < 1:
                errors.append(f"userCorrections[{index}].sequence is invalid.")
            if correction.get("kind") not in {"approval", "scope-change", "stop", "cancel", "resume", "retry", "other"}:
                errors.append(f"userCorrections[{index}].kind is invalid.")
            _digest(correction.get("correctionDigest"), f"userCorrections[{index}].correctionDigest", errors)

    return errors


def load_trajectory(path: str | Path) -> dict[str, Any]:
    trajectory_path = Path(path).expanduser().resolve()
    record = _read_json(trajectory_path)
    errors = validate_trajectory(record)
    if errors:
        raise TrajectoryError("Invalid trajectory:\n" + "\n".join(errors))
    return record


def _terminal(state: str) -> bool:
    return state in {"completed", "failed", "cancelled"}


def replay_trajectory(record: dict[str, Any], fixture: str | dict[str, Any]) -> dict[str, Any]:
    """Replay only recorded decisions against a named deterministic fixture."""

    errors = validate_trajectory(record)
    fixture_value = TRAJECTORY_REPLAY_FIXTURES.get(fixture) if isinstance(fixture, str) else fixture
    if fixture_value is None:
        errors.append(f"Unknown replay fixture: {fixture!r}.")
        fixture_value = {
            "id": str(fixture),
            "expectedTerminalState": "failed",
            "requiredEventTypes": [],
            "forbiddenEventTypes": [],
        }
    violations = list(errors)
    events = record.get("events", []) if isinstance(record, dict) else []
    event_types = {event.get("type") for event in events if isinstance(event, dict)}
    for event_type in fixture_value["requiredEventTypes"]:
        if event_type not in event_types:
            violations.append(f"Required event is missing: {event_type}.")
    for event_type in fixture_value["forbiddenEventTypes"]:
        if event_type in event_types:
            violations.append(f"Forbidden event was recorded: {event_type}.")

    state = "initial"
    authority = "unknown"
    visited_states = [state]
    decision_path: list[dict[str, Any]] = []

    def move(next_state: str) -> None:
        nonlocal state
        state = next_state
        visited_states.append(next_state)

    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = event.get("type")
        if isinstance(event_type, str) and EXECUTION_EVENT.search(event_type):
            violations.append(f"Replay refuses execution event: {event_type}.")
        metadata = event.get("metadata", {})
        decision = metadata.get("decision") if isinstance(metadata, dict) else None
        kind = metadata.get("kind") if isinstance(metadata, dict) else None
        if decision or event_type == "user.correction" or event_type == "kernel.guardrail_triggered":
            item = {"sequence": event.get("sequence"), "type": event_type}
            if isinstance(decision, str):
                item["decision"] = decision
            if isinstance(kind, str):
                item["kind"] = kind
            decision_path.append(item)
        if _terminal(state) and event_type != "task.completed":
            violations.append(f"Event {event_type} occurred after terminal state {state}.")
            continue
        if event_type == "task.created":
            if state != "initial":
                violations.append("task.created must be the first state transition.")
            move("waiting_approval")
        elif event_type == "task.approved":
            if state not in {"waiting_approval", "needs_decision", "suspended"}:
                violations.append(f"task.approved is invalid from {state}.")
            move("approved")
        elif event_type == "kernel.permission_decided":
            if decision not in {"allow", "ask", "deny"}:
                violations.append("kernel.permission_decided must contain allow, ask, or deny.")
            else:
                authority = decision
                if decision == "ask":
                    move("needs_decision")
                elif decision == "deny":
                    move("failed")
                elif state == "initial":
                    move("approved")
        elif event_type == "kernel.worker_started":
            if authority != "allow":
                violations.append("A worker cannot start without an allow decision.")
            if state not in {"approved", "suspended"}:
                violations.append(f"kernel.worker_started is invalid from {state}.")
            move("running")
        elif event_type == "task.paused":
            if state != "running":
                violations.append(f"task.paused is invalid from {state}.")
            move("suspended")
        elif event_type in {"task.resumed", "task.recovery_revalidated"}:
            if state != "suspended" or authority != "allow":
                violations.append(f"{event_type} requires suspended state and allow authority.")
            move("approved")
        elif event_type == "kernel.guardrail_triggered":
            move("needs_decision")
        elif event_type == "task.needs_decision":
            move("needs_decision")
        elif event_type == "user.correction":
            if state != "needs_decision":
                violations.append("user.correction must answer a pending decision.")
        elif event_type == "kernel.outcome_verified":
            if state != "running":
                violations.append(f"kernel.outcome_verified is invalid from {state}.")
            move("completed")
        elif event_type == "task.completed":
            if state != "completed":
                violations.append(f"task.completed is invalid from {state}.")
            move("completed")
        elif event_type == "kernel.outcome_unverified":
            if state != "running":
                violations.append(f"kernel.outcome_unverified is invalid from {state}.")
            move("needs_decision")
        elif event_type == "kernel.failed":
            move("failed")
        elif event_type == "task.cancelled":
            if _terminal(state):
                violations.append(f"task.cancelled is invalid from {state}.")
            move("cancelled")

    if state != fixture_value["expectedTerminalState"]:
        violations.append(f"Expected terminal state {fixture_value['expectedTerminalState']}; received {state}.")
    return {
        "schemaVersion": TRAJECTORY_SCHEMA_VERSION,
        "replayVersion": TRAJECTORY_SCHEMA_VERSION,
        "trajectoryId": record.get("trajectoryId", "invalid"),
        "fixtureId": fixture_value["id"],
        "status": "passed" if not violations else "failed",
        "terminalState": state,
        "visitedStates": visited_states,
        "decisionPath": decision_path,
        "violations": violations,
        "toolExecutionCount": 0,
        "liveServiceCallCount": 0,
        "computerUseCallCount": 0,
    }


def render_replay(result: dict[str, Any]) -> str:
    lines = [
        f"BMO Trajectory Replay: {result['fixtureId']}",
        f"Status: {result['status'].upper()}",
        f"Trajectory: {result['trajectoryId']}",
        f"Terminal state: {result['terminalState']}",
        f"Decision events: {len(result['decisionPath'])}",
        "Execution: tools=0, live-services=0, computer-use=0",
    ]
    if result["violations"]:
        lines.append("Violations:")
        lines.extend(f"  - {violation}" for violation in result["violations"])
    return "\n".join(lines) + "\n"
