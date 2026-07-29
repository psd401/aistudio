"""Deterministic graders for local agent-image evaluations.

The graders deliberately operate on recorded outputs, telemetry, and broker
requests. They never call a model or a live service.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from numbers import Real

try:
    from ..broker_stub import ALLOWED_AGENT_BROKER_ROUTES
except ImportError:
    from broker_stub import ALLOWED_AGENT_BROKER_ROUTES


SUPPORTED_GRADERS = frozenset(
    {
        "broker_request",
        "no_route_called",
        "output_match",
        "tools_catalog",
        "trajectory_in_order",
    }
)
BODY_MATCHERS = frozenset({"exact", "contains_any", "numeric_equals"})


class GraderConfigurationError(ValueError):
    """A grader declaration is malformed or unsupported."""


@dataclass(frozen=True)
class TrialArtifacts:
    """Non-model artifacts collected while one trial ran."""

    broker_requests: tuple[Mapping[str, object], ...] = ()
    broker_errors: tuple[str, ...] = ()
    tools_catalog_log: str = ""


@dataclass(frozen=True)
class GraderResult:
    """One deterministic grading decision."""

    grader: str
    passed: bool
    reason: str

    def to_mapping(self) -> dict[str, object]:
        return {
            "grader": self.grader,
            "passed": self.passed,
            "reason": self.reason,
        }


def _require_nonempty_string(
    value: object,
    *,
    grader: str,
    field: str,
) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GraderConfigurationError(
            f"{grader} grader field {field} must be a non-empty string"
        )
    return value


def _validate_route(spec: Mapping[str, object], grader: str) -> None:
    route = _require_nonempty_string(
        spec.get("route"),
        grader=grader,
        field="route",
    )
    if route not in ALLOWED_AGENT_BROKER_ROUTES:
        raise GraderConfigurationError(
            f"{grader} grader route is not an allowed agent broker route: "
            f"{route}"
        )
    method = spec.get("method")
    if method is not None:
        validated_method = _require_nonempty_string(
            method,
            grader=grader,
            field="method",
        )
        if validated_method.upper() != "POST":
            raise GraderConfigurationError(
                f"{grader} grader method must be POST"
            )


def _validate_body_matchers(value: object) -> None:
    if value is None:
        return
    if not isinstance(value, Mapping):
        raise GraderConfigurationError(
            "broker_request grader body must be a field-to-matcher mapping"
        )
    for field, matcher in value.items():
        if not isinstance(field, str) or not field:
            raise GraderConfigurationError(
                "broker_request grader body field paths must be non-empty strings"
            )
        if not isinstance(matcher, Mapping) or len(matcher) != 1:
            raise GraderConfigurationError(
                f"broker_request body matcher for {field} "
                "must have exactly one operator"
            )
        operator, expected = next(iter(matcher.items()))
        if operator not in BODY_MATCHERS:
            raise GraderConfigurationError(
                f"broker_request body matcher for {field} uses unsupported operator "
                f"{operator}"
            )
        if operator == "contains_any":
            if (
                not isinstance(expected, Sequence)
                or isinstance(expected, (str, bytes))
                or not expected
            ):
                raise GraderConfigurationError(
                    f"broker_request contains_any matcher for {field} "
                    "must contain a non-empty list"
                )
        if operator == "numeric_equals" and (
            isinstance(expected, bool) or not isinstance(expected, Real)
        ):
            raise GraderConfigurationError(
                f"broker_request numeric_equals matcher for {field} "
                "must contain a number"
            )


def validate_grader_specs(
    specs: Sequence[Mapping[str, object]],
) -> tuple[dict[str, object], ...]:
    """Validate and normalize task grader declarations."""

    normalized: list[dict[str, object]] = []
    allowed_fields = {
        "broker_request": {"type", "route", "method", "body"},
        "no_route_called": {"type", "route", "method", "body"},
        "output_match": {"type", "pattern", "ignore_case"},
        "trajectory_in_order": {"type", "tools"},
        "tools_catalog": {"type", "expected"},
    }
    for raw_spec in specs:
        if not isinstance(raw_spec, Mapping):
            raise GraderConfigurationError("grader entries must be mappings")
        grader = _require_nonempty_string(
            raw_spec.get("type"),
            grader="task",
            field="type",
        )
        if grader not in SUPPORTED_GRADERS:
            raise GraderConfigurationError(f"unsupported grader type: {grader}")
        unknown = sorted(set(raw_spec).difference(allowed_fields[grader]))
        if unknown:
            raise GraderConfigurationError(
                f"{grader} grader has unsupported fields: {', '.join(unknown)}"
            )
        if grader in {"broker_request", "no_route_called"}:
            _validate_route(raw_spec, grader)
        if grader in {"broker_request", "no_route_called"}:
            _validate_body_matchers(raw_spec.get("body"))
        if grader == "output_match":
            pattern = _require_nonempty_string(
                raw_spec.get("pattern"),
                grader=grader,
                field="pattern",
            )
            try:
                re.compile(pattern)
            except re.error as error:
                raise GraderConfigurationError(
                    f"output_match grader pattern is invalid: {error}"
                ) from error
            ignore_case = raw_spec.get("ignore_case", False)
            if not isinstance(ignore_case, bool):
                raise GraderConfigurationError(
                    "output_match grader ignore_case must be a boolean"
                )
        elif grader in {"trajectory_in_order", "tools_catalog"}:
            field = "tools" if grader == "trajectory_in_order" else "expected"
            entries = raw_spec.get(field)
            if (
                not isinstance(entries, Sequence)
                or isinstance(entries, (str, bytes))
                or not entries
                or any(not isinstance(entry, str) or not entry for entry in entries)
            ):
                raise GraderConfigurationError(
                    f"{grader} grader field {field} must be a non-empty string list"
                )
        normalized.append(dict(raw_spec))
    return tuple(normalized)


def _strict_equal(actual: object, expected: object) -> bool:
    return type(actual) is type(expected) and actual == expected


def _resolve_field(body: object, field: str) -> tuple[bool, object]:
    if field == "$":
        return True, body
    current = body
    for component in field.split("."):
        if isinstance(current, Mapping) and component in current:
            current = current[component]
            continue
        if isinstance(current, Sequence) and not isinstance(current, (str, bytes)):
            try:
                index = int(component)
                current = current[index]
                continue
            except (ValueError, IndexError):
                pass
        return False, None
    return True, current


def _match_body(
    body: object,
    matchers: Mapping[str, object],
) -> tuple[bool, str]:
    for field, matcher_object in matchers.items():
        matcher = matcher_object
        if not isinstance(matcher, Mapping):
            return False, f"invalid matcher for {field}"
        found, actual = _resolve_field(body, field)
        if not found:
            return False, f"body field {field} was absent"
        operator, expected = next(iter(matcher.items()))
        if operator == "exact":
            if not _strict_equal(actual, expected):
                return (
                    False,
                    f"body field {field} expected exact {expected!r}, got {actual!r}",
                )
            continue
        if operator == "numeric_equals":
            if (
                isinstance(actual, bool)
                or not isinstance(actual, Real)
                or actual != expected
            ):
                return (
                    False,
                    f"body field {field} expected numeric {expected!r}, got {actual!r}",
                )
            continue
        if operator == "contains_any":
            candidates = list(expected)
            if isinstance(actual, str):
                matched = any(
                    isinstance(candidate, str) and candidate in actual
                    for candidate in candidates
                )
            elif isinstance(actual, Sequence) and not isinstance(actual, (str, bytes)):
                matched = any(
                    any(_strict_equal(item, candidate) for item in actual)
                    for candidate in candidates
                )
            else:
                matched = False
            if not matched:
                return (
                    False,
                    f"body field {field} contained none of {candidates!r}",
                )
    return True, "body matched"


def _request_matches_selector(
    request: Mapping[str, object],
    spec: Mapping[str, object],
) -> bool:
    if request.get("route") != spec.get("route"):
        return False
    method = spec.get("method")
    return method is None or request.get("method") == str(method).upper()


def _grade_broker_request(
    spec: Mapping[str, object],
    artifacts: TrialArtifacts,
) -> GraderResult:
    candidates = [
        request
        for request in artifacts.broker_requests
        if _request_matches_selector(request, spec)
    ]
    if not candidates:
        method = str(spec.get("method") or "any method").upper()
        return GraderResult(
            "broker_request",
            False,
            f"no {method} request captured for {spec['route']}",
        )
    matchers = spec.get("body")
    if not isinstance(matchers, Mapping) or not matchers:
        return GraderResult(
            "broker_request",
            True,
            f"captured {len(candidates)} matching request(s) for {spec['route']}",
        )
    failures: list[str] = []
    for candidate in candidates:
        matched, reason = _match_body(candidate.get("body"), matchers)
        if matched:
            return GraderResult(
                "broker_request",
                True,
                f"captured request for {spec['route']} with matching body",
            )
        failures.append(reason)
    return GraderResult(
        "broker_request",
        False,
        f"{len(candidates)} request(s) hit {spec['route']}, but "
        + "; ".join(failures[:3]),
    )


def _grade_no_route_called(
    spec: Mapping[str, object],
    artifacts: TrialArtifacts,
) -> GraderResult:
    candidates = [
        request
        for request in artifacts.broker_requests
        if _request_matches_selector(request, spec)
    ]
    matchers = spec.get("body")
    matches = (
        [
            request
            for request in candidates
            if isinstance(matchers, Mapping)
            and _match_body(request.get("body"), matchers)[0]
        ]
        if isinstance(matchers, Mapping) and matchers
        else candidates
    )
    selector = (
        f"{spec['route']} with matching body"
        if isinstance(matchers, Mapping) and matchers
        else str(spec["route"])
    )
    return GraderResult(
        "no_route_called",
        not matches,
        (
            f"no request captured for {selector}"
            if not matches
            else f"captured {len(matches)} forbidden request(s) for {selector}"
        ),
    )


def _grade_output_match(
    spec: Mapping[str, object],
    result: str,
) -> GraderResult:
    flags = re.IGNORECASE if spec.get("ignore_case") else 0
    matched = re.search(str(spec["pattern"]), result, flags=flags) is not None
    return GraderResult(
        "output_match",
        matched,
        (
            f"output matched /{spec['pattern']}/"
            if matched
            else f"output did not match /{spec['pattern']}/"
        ),
    )


def _tool_name(call: object) -> str | None:
    if isinstance(call, str):
        return call
    if not isinstance(call, Mapping):
        return None
    for field in ("name", "tool", "tool_name"):
        value = call.get(field)
        if isinstance(value, str) and value:
            return value
    return None


def _grade_trajectory(
    spec: Mapping[str, object],
    metadata: Mapping[str, object],
) -> GraderResult:
    raw_calls = metadata.get("tool_calls")
    calls = (
        [_tool_name(call) for call in raw_calls]
        if isinstance(raw_calls, Sequence) and not isinstance(raw_calls, (str, bytes))
        else []
    )
    observed = [call for call in calls if call is not None]
    expected = list(spec["tools"])
    position = 0
    for name in observed:
        if position < len(expected) and name == expected[position]:
            position += 1
    passed = position == len(expected)
    return GraderResult(
        "trajectory_in_order",
        passed,
        (
            f"observed expected relative order {expected!r}"
            if passed
            else f"expected relative order {expected!r}; observed {observed!r}"
        ),
    )


def _grade_tools_catalog(
    spec: Mapping[str, object],
    artifacts: TrialArtifacts,
) -> GraderResult:
    expected = list(spec["expected"])
    observed = _parse_tools_catalog_names(artifacts.tools_catalog_log)
    missing = [name for name in expected if name not in observed]
    return GraderResult(
        "tools_catalog",
        not missing,
        (
            f"catalog contained all {len(expected)} expected entries"
            if not missing
            else "catalog was missing: " + ", ".join(missing)
        ),
    )


def _parse_tools_catalog_names(log_text: str) -> set[str]:
    """Extract exact names from the compact catalog or legacy diagnostics."""

    observed: set[str] = set()

    def collect(value: object) -> None:
        if isinstance(value, Mapping):
            compact_names = value.get("names")
            if isinstance(compact_names, list):
                observed.update(
                    item
                    for item in compact_names
                    if isinstance(item, str) and item
                )
                return
            name = value.get("name")
            if isinstance(name, str) and name:
                observed.add(name)
                return
            for group in value.values():
                if isinstance(group, list):
                    collect(group)
                elif isinstance(group, Mapping):
                    group_tools = group.get("tools")
                    if isinstance(group_tools, list):
                        collect(group_tools)
                    else:
                        group_name = group.get("name")
                        if isinstance(group_name, str) and group_name:
                            observed.add(group_name)
            return
        if isinstance(value, list):
            for entry in value:
                if not isinstance(entry, Mapping):
                    continue
                name = entry.get("name")
                if isinstance(name, str) and name:
                    observed.add(name)

    marker = "tools.catalog ok:"
    for line in log_text.splitlines():
        marker_position = line.find(marker)
        if marker_position < 0:
            continue
        payload = line[marker_position + len(marker) :].strip()
        try:
            collect(json.loads(payload))
            continue
        except json.JSONDecodeError:
            pass
        # Older candidate images capped the complete catalog diagnostic at
        # 1500 characters. Preserve best-effort compatibility with their
        # explicit JSON `name` fields; current images log every name compactly.
        for match in re.finditer(
            r'"name"\s*:\s*("(?:\\.|[^"\\])*")',
            payload,
        ):
            try:
                name = json.loads(match.group(1))
            except json.JSONDecodeError:
                continue
            if isinstance(name, str) and name:
                observed.add(name)
    return observed


def grade_trial(
    specs: Sequence[Mapping[str, object]],
    *,
    result: str,
    metadata: Mapping[str, object],
    artifacts: TrialArtifacts,
) -> dict[str, object]:
    """Run every configured grader and preserve human-readable reasons."""

    grader_results: list[GraderResult] = []
    if metadata.get("failed") is True:
        error_class = metadata.get("error_class")
        detail = (
            str(error_class)
            if isinstance(error_class, str) and error_class
            else "unknown runtime error"
        )
        grader_results.append(
            GraderResult(
                "invocation",
                False,
                f"invocation metadata reported failure: {detail}",
            )
        )
    grader_results.extend(
        GraderResult("broker_stub", False, error)
        for error in artifacts.broker_errors
    )
    for spec in specs:
        grader = str(spec["type"])
        if grader == "broker_request":
            grader_results.append(_grade_broker_request(spec, artifacts))
        elif grader == "no_route_called":
            grader_results.append(_grade_no_route_called(spec, artifacts))
        elif grader == "output_match":
            grader_results.append(_grade_output_match(spec, result))
        elif grader == "trajectory_in_order":
            grader_results.append(_grade_trajectory(spec, metadata))
        elif grader == "tools_catalog":
            grader_results.append(_grade_tools_catalog(spec, artifacts))
        else:  # pragma: no cover - validate_grader_specs prevents this.
            grader_results.append(
                GraderResult(grader, False, f"unsupported grader type: {grader}")
            )
    if not grader_results:
        return {
            "passed": None,
            "reason": "no graders configured",
            "results": [],
        }
    failures = [item for item in grader_results if not item.passed]
    return {
        "passed": not failures,
        "reason": (
            f"all {len(grader_results)} graders passed"
            if not failures
            else f"{len(failures)} of {len(grader_results)} graders failed"
        ),
        "results": [item.to_mapping() for item in grader_results],
    }


def aggregate_pass_k(
    records: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    """Aggregate trial grades using reliability semantics: all k must pass."""

    grouped: dict[str, list[Mapping[str, object]]] = defaultdict(list)
    for record in records:
        task_id = record.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            raise ValueError("trial record is missing task_id")
        grouped[task_id].append(record)

    summaries: list[dict[str, object]] = []
    for task_id, task_records in grouped.items():
        declared_trials = [record.get("trials") for record in task_records]
        if any(
            isinstance(value, bool) or not isinstance(value, int)
            for value in declared_trials
        ) or len(set(declared_trials)) != 1:
            raise ValueError(f"task {task_id} has inconsistent trial counts")
        expected_trials = declared_trials[0]
        decisions = [
            (
                record.get("grade", {}).get("passed")
                if isinstance(record.get("grade"), Mapping)
                else None
            )
            for record in task_records
        ]
        passed_trials = sum(decision is True for decision in decisions)
        summaries.append(
            {
                "task_id": task_id,
                "trials": expected_trials,
                "passed_trials": passed_trials,
                "pass^k": (
                    len(task_records) == expected_trials
                    and passed_trials == expected_trials
                ),
            }
        )
    return summaries
