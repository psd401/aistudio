"""Graders for local agent-image evaluations.

Most graders deliberately operate only on recorded outputs, telemetry, and
broker requests. The ``quickchart_image`` L2 grader is the narrow exception: it
probes an exact ``https://quickchart.io/chart`` URL after validating its encoded
chart configuration, content type, and PNG signature. No grader calls a model.
"""

from __future__ import annotations

import json
import re
import urllib.error as urllib_error
import urllib.parse as urllib_parse
import urllib.request as urllib_request
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from numbers import Real

try:
    from ..broker_stub import ALLOWED_AGENT_BROKER_ROUTES, mapping_contains
except ImportError:
    from broker_stub import ALLOWED_AGENT_BROKER_ROUTES, mapping_contains


SUPPORTED_GRADERS = frozenset(
    {
        "broker_request",
        "no_route_called",
        "output_match",
        "quickchart_image",
        "tool_call_succeeded",
        "tools_catalog",
        "trajectory_in_order",
    }
)
BODY_MATCHERS = frozenset(
    {
        "exact",
        "contains_any",
        "json_contains",
        "matches_any",
        "numeric_equals",
        "text_equals",
    }
)


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
        if operator in {"contains_any", "matches_any"}:
            if (
                not isinstance(expected, Sequence)
                or isinstance(expected, (str, bytes))
                or not expected
            ):
                raise GraderConfigurationError(
                    f"broker_request {operator} matcher for {field} "
                    "must contain a non-empty list"
                )
        if operator == "numeric_equals" and (
            isinstance(expected, bool) or not isinstance(expected, Real)
        ):
            raise GraderConfigurationError(
                f"broker_request numeric_equals matcher for {field} "
                "must contain a number"
            )
        if operator == "json_contains" and not isinstance(expected, Mapping):
            raise GraderConfigurationError(
                f"broker_request json_contains matcher for {field} "
                "must contain an object"
            )
        if operator == "text_equals" and not isinstance(expected, str):
            raise GraderConfigurationError(
                f"broker_request text_equals matcher for {field} "
                "must contain a string"
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
        "quickchart_image": {
            "type",
            "chart_type",
            "title",
            "labels",
            "values",
        },
        "tool_call_succeeded": {"type", "tool", "args_pattern"},
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
        elif grader == "quickchart_image":
            chart_type = _require_nonempty_string(
                raw_spec.get("chart_type"),
                grader=grader,
                field="chart_type",
            )
            if chart_type not in {"bar", "line", "pie"}:
                raise GraderConfigurationError(
                    "quickchart_image grader chart_type must be "
                    "bar, line, or pie"
                )
            _require_nonempty_string(
                raw_spec.get("title"),
                grader=grader,
                field="title",
            )
            labels = raw_spec.get("labels")
            if (
                not isinstance(labels, Sequence)
                or isinstance(labels, (str, bytes))
                or not labels
                or any(not isinstance(label, str) or not label for label in labels)
            ):
                raise GraderConfigurationError(
                    "quickchart_image grader labels must be a non-empty string list"
                )
            values = raw_spec.get("values")
            if (
                not isinstance(values, Sequence)
                or isinstance(values, (str, bytes))
                or not values
                or any(
                    isinstance(value, bool) or not isinstance(value, Real)
                    for value in values
                )
            ):
                raise GraderConfigurationError(
                    "quickchart_image grader values must be a non-empty number list"
                )
            if len(labels) != len(values):
                raise GraderConfigurationError(
                    "quickchart_image grader labels and values must have equal length"
                )
        elif grader == "tool_call_succeeded":
            _require_nonempty_string(
                raw_spec.get("tool"),
                grader=grader,
                field="tool",
            )
            pattern = _require_nonempty_string(
                raw_spec.get("args_pattern"),
                grader=grader,
                field="args_pattern",
            )
            try:
                re.compile(pattern)
            except re.error as error:
                raise GraderConfigurationError(
                    f"tool_call_succeeded args_pattern is invalid: {error}"
                ) from error
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
            continue
        if operator == "json_contains":
            if not mapping_contains(actual, expected):
                return (
                    False,
                    f"body field {field} did not contain JSON {expected!r}",
                )
            continue
        if operator == "matches_any":
            alternatives = list(expected)
            if not any(
                mapping_contains(actual, alternative)
                for alternative in alternatives
            ):
                return (
                    False,
                    f"body field {field} matched none of {alternatives!r}",
                )
            continue
        if operator == "text_equals":
            if not isinstance(actual, str) or actual.strip() != expected.strip():
                return (
                    False,
                    f"body field {field} expected text {expected!r}, got {actual!r}",
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


_QUICKCHART_URL_RE = re.compile(
    r"https://quickchart\.io/chart\?[^\s\"'<>\\)\],}]+"
)
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class _RejectRedirects(urllib_request.HTTPRedirectHandler):
    """Keep an output-controlled URL from redirecting off the pinned host."""

    def redirect_request(
        self,
        request: urllib_request.Request,
        file_pointer: object,
        code: int,
        message: str,
        headers: Mapping[str, str],
        new_url: str,
    ) -> None:
        _ = (request, file_pointer, code, message, headers, new_url)
        return None


def _quickchart_config_error(
    spec: Mapping[str, object],
    url: str,
) -> str | None:
    """Return why a QuickChart URL is unsafe/wrong, or ``None`` when exact."""

    try:
        parsed = urllib_parse.urlsplit(url)
        port = parsed.port
    except ValueError as error:
        return f"invalid QuickChart URL: {error}"
    if (
        parsed.scheme != "https"
        or parsed.hostname != "quickchart.io"
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/chart"
        or parsed.fragment
    ):
        return "QuickChart URL did not use the pinned https host and /chart path"
    try:
        query = urllib_parse.parse_qs(
            parsed.query,
            keep_blank_values=True,
            strict_parsing=True,
        )
    except ValueError as error:
        return f"QuickChart URL query was invalid: {error}"
    if query.get("format") != ["png"]:
        return "QuickChart URL did not request format=png"
    encoded_configs = query.get("c")
    if not isinstance(encoded_configs, list) or len(encoded_configs) != 1:
        return "QuickChart URL did not contain exactly one encoded config"
    try:
        config = json.loads(encoded_configs[0])
    except (TypeError, json.JSONDecodeError) as error:
        return f"QuickChart config was not valid JSON: {error}"
    if not isinstance(config, Mapping):
        return "QuickChart config was not an object"
    if config.get("type") != spec["chart_type"]:
        return "QuickChart config used the wrong chart type"
    data = config.get("data")
    if not isinstance(data, Mapping):
        return "QuickChart config omitted data"
    if data.get("labels") != list(spec["labels"]):
        return "QuickChart config used the wrong labels"
    datasets = data.get("datasets")
    if (
        not isinstance(datasets, list)
        or len(datasets) != 1
        or not isinstance(datasets[0], Mapping)
    ):
        return "QuickChart config did not contain exactly one dataset"
    dataset = datasets[0]
    if dataset.get("label") != spec["title"]:
        return "QuickChart dataset used the wrong label"
    if dataset.get("data") != list(spec["values"]):
        return "QuickChart config used the wrong values"
    options = config.get("options")
    title = (
        options.get("plugins", {}).get("title")
        if isinstance(options, Mapping)
        and isinstance(options.get("plugins"), Mapping)
        else None
    )
    if (
        not isinstance(title, Mapping)
        or title.get("display") is not True
        or title.get("text") != spec["title"]
    ):
        return "QuickChart config used the wrong visible title"
    return None


def _grade_quickchart_image(
    spec: Mapping[str, object],
    result: str,
) -> GraderResult:
    """Validate exact chart semantics, then prove QuickChart returned a PNG."""

    urls = list(dict.fromkeys(_QUICKCHART_URL_RE.findall(result)))
    if not urls:
        return GraderResult(
            "quickchart_image",
            False,
            "output contained no https://quickchart.io/chart URL",
        )
    config_errors: list[str] = []
    for url in urls:
        config_error = _quickchart_config_error(spec, url)
        if config_error is not None:
            config_errors.append(config_error)
            continue
        request = urllib_request.Request(
            url,
            headers={
                "Accept": "image/png",
                "User-Agent": "psd-agent-eval/1.0",
            },
        )
        try:
            opener = urllib_request.build_opener(_RejectRedirects)
            with opener.open(request, timeout=15) as response:
                status = getattr(response, "status", None)
                if status is None:
                    status = response.getcode()
                content_type = response.headers.get("Content-Type", "")
                signature = response.read(len(_PNG_SIGNATURE))
        except (OSError, urllib_error.URLError, ValueError) as error:
            return GraderResult(
                "quickchart_image",
                False,
                f"QuickChart image probe failed: {error}",
            )
        if status != 200:
            return GraderResult(
                "quickchart_image",
                False,
                f"QuickChart image probe returned HTTP {status}",
            )
        if content_type.split(";", 1)[0].strip().lower() != "image/png":
            return GraderResult(
                "quickchart_image",
                False,
                f"QuickChart image probe returned {content_type!r}, not image/png",
            )
        if signature != _PNG_SIGNATURE:
            return GraderResult(
                "quickchart_image",
                False,
                "QuickChart image response did not start with the PNG signature",
            )
        return GraderResult(
            "quickchart_image",
            True,
            "exact QuickChart configuration returned HTTP 200 image/png",
        )
    detail = config_errors[-1] if config_errors else "no usable chart URL"
    return GraderResult("quickchart_image", False, detail)


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


def _render_tool_arguments(call: Mapping[str, object]) -> str | None:
    arguments = call.get("args")
    if arguments is None:
        return None
    if isinstance(arguments, str):
        return arguments
    try:
        return json.dumps(arguments, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(arguments)


def _grade_tool_call_succeeded(
    spec: Mapping[str, object],
    metadata: Mapping[str, object],
) -> GraderResult:
    """Require a named invocation and its matching completion to succeed.

    Two telemetry shapes are reconciled here, because a task may be graded
    against either the current harness or an already-deployed image:

    1. Current (`harness_adapter.py`): one record per completed call, carrying
       both the rendered ``args`` and the authoritative ``status``::

           [{"name": "exec", "args": {...}, "status": "success"}]

    2. Legacy (older deployed images): the call is split across two records --
       an args-bearing invocation, immediately followed by an args-less record
       holding the authoritative ``status``::

           [{"name": "exec", "args": {...}, "status": "running"},
            {"name": "exec", "args": None,  "status": "error"}]

    The scan below therefore starts from the matched args-bearing record's own
    status, then looks ahead for an immediately-following args-less record of
    the same tool and lets that record's status win. The look-ahead stops at the
    next args-bearing call of the same tool, since that is a new invocation
    rather than this one's completion.
    """

    raw_calls = metadata.get("tool_calls")
    calls = (
        list(raw_calls)
        if isinstance(raw_calls, Sequence)
        and not isinstance(raw_calls, (str, bytes))
        else []
    )
    expected_tool = str(spec["tool"])
    args_pattern = str(spec["args_pattern"])
    matched_invocations = 0
    completion_statuses: list[str] = []

    for index, raw_call in enumerate(calls):
        if not isinstance(raw_call, Mapping):
            continue
        arguments = _render_tool_arguments(raw_call)
        if (
            _tool_name(raw_call) != expected_tool
            or arguments is None
            or re.search(args_pattern, arguments) is None
        ):
            continue
        matched_invocations += 1
        status = raw_call.get("status")
        effective_status = (
            status if isinstance(status, str) and status else None
        )
        # Deployed images predating the current harness may emit a second
        # args-less record with the authoritative completion status. Prefer
        # that record when present, while accepting the current single-record
        # telemetry shape.
        for later_call in calls[index + 1 :]:
            if not isinstance(later_call, Mapping):
                continue
            if _tool_name(later_call) != expected_tool:
                continue
            if _render_tool_arguments(later_call) is not None:
                break
            later_status = later_call.get("status")
            if isinstance(later_status, str) and later_status:
                effective_status = later_status
                break
        if effective_status == "success":
            return GraderResult(
                "tool_call_succeeded",
                True,
                (
                    f"{expected_tool} invocation matching "
                    f"/{args_pattern}/ completed successfully"
                ),
            )
        if effective_status is not None:
            completion_statuses.append(effective_status)

    if matched_invocations == 0:
        reason = (
            f"no {expected_tool} invocation matched arguments /{args_pattern}/"
        )
    elif completion_statuses:
        reason = (
            f"{expected_tool} invocation matching /{args_pattern}/ "
            f"completed with status {completion_statuses[-1]!r}"
        )
    else:
        reason = (
            f"{expected_tool} invocation matching /{args_pattern}/ "
            "had no completion record"
        )
    return GraderResult("tool_call_succeeded", False, reason)


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
        elif grader == "quickchart_image":
            grader_results.append(_grade_quickchart_image(spec, result))
        elif grader == "tool_call_succeeded":
            grader_results.append(_grade_tool_call_succeeded(spec, metadata))
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
