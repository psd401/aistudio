#!/usr/bin/env python3
"""Create a safe, committed summary from agent-eval JSONL trial records.

The input JSONL is a sensitive transcript. The output intentionally contains
only aggregate grades and telemetry, never prompts, results, broker requests,
session identifiers, messages, or tool-call arguments.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

SCHEMA_VERSION = 2
SUMMARY_KIND = "agent-eval-run"
IMMUTABLE_DIGEST_RE = re.compile(r"(?:^|@)(sha256:[0-9a-f]{64})$")
SAFE_SUMMARY_NAME_RE = re.compile(r"^sha256-[0-9a-f]{64}\.json$")
GIT_OID_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
SAFE_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$")
SOURCE_COMMIT_PROVENANCE = frozenset({"image-label", "legacy-image-tag"})
FORBIDDEN_SUMMARY_KEYS = frozenset(
    {
        "broker_requests",
        "messages",
        "metadata",
        "prompt",
        "request_body",
        "result",
        "session_id",
        "tool_calls",
    }
)
TRANSCRIPT_NAME_TOKENS = ("capture", "raw", "transcript")
TOKEN_PRICE_KEYS = {
    "input_tokens": "input",
    "output_tokens": "output",
    "cache_read_input_tokens": "cacheRead",
    "cache_write_input_tokens": "cacheWrite",
}
TELEMETRY_INTEGER_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_write_input_tokens",
    "model_call_count",
    "duration_ms",
    "latency_ms",
)
USD_QUANTUM = Decimal("0.000001")


class EvalSummaryError(RuntimeError):
    """Trial records could not be converted into a trustworthy summary."""


def _mapping(value: object, description: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise EvalSummaryError(f"{description} must be an object")
    return value


def _nonempty_string(value: object, description: str) -> str:
    if not isinstance(value, str) or not value:
        raise EvalSummaryError(f"{description} must be a non-empty string")
    return value


def _nonnegative_integer(value: object, description: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise EvalSummaryError(f"{description} must be a non-negative integer")
    return value


def _positive_integer(value: object, description: str) -> int:
    parsed = _nonnegative_integer(value, description)
    if parsed == 0:
        raise EvalSummaryError(f"{description} must be positive")
    return parsed


def _finite_decimal(value: object, description: str) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EvalSummaryError(f"{description} must be a number")
    try:
        parsed = Decimal(str(value))
    except InvalidOperation as error:
        raise EvalSummaryError(f"{description} must be a number") from error
    if not parsed.is_finite() or parsed < 0:
        raise EvalSummaryError(f"{description} must be finite and non-negative")
    return parsed


def _digest_from_image(image: str) -> str:
    match = IMMUTABLE_DIGEST_RE.search(image)
    if match is None:
        raise EvalSummaryError(
            "trial image must be an immutable sha256 digest, not a mutable tag"
        )
    return match.group(1)


def _timestamp(value: object, description: str) -> datetime:
    raw = _nonempty_string(value, description)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise EvalSummaryError(f"{description} must be an ISO 8601 timestamp") from error
    if parsed.tzinfo is None:
        raise EvalSummaryError(f"{description} must include a timezone")
    return parsed


def load_records(paths: Sequence[Path]) -> list[dict[str, object]]:
    """Load JSONL records without retaining blank lines or non-object values."""

    if not paths:
        raise EvalSummaryError("at least one --records path is required")
    records: list[dict[str, object]] = []
    for path in paths:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            raise EvalSummaryError(f"could not read trial records {path}: {error}") from error
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                raise EvalSummaryError(
                    f"{path}:{line_number} is not valid JSON: {error}"
                ) from error
            if not isinstance(record, dict):
                raise EvalSummaryError(f"{path}:{line_number} must contain an object")
            records.append(record)
    if not records:
        raise EvalSummaryError("trial record inputs were empty")
    return records


def load_model_pricing(path: Path) -> dict[str, object]:
    """Resolve the primary model and its declared per-million-token prices."""

    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise EvalSummaryError(f"could not read model config {path}: {error}") from error
    root = _mapping(config, "model config")
    agents = _mapping(root.get("agents"), "model config agents")
    defaults = _mapping(agents.get("defaults"), "model config agents.defaults")
    model_defaults = _mapping(
        defaults.get("model"),
        "model config agents.defaults.model",
    )
    primary = _nonempty_string(
        model_defaults.get("primary"),
        "model config primary model",
    )
    if "/" not in primary:
        raise EvalSummaryError("primary model must use provider/model form")
    provider_name, model_id = primary.split("/", 1)
    models = _mapping(root.get("models"), "model config models")
    providers = _mapping(models.get("providers"), "model config providers")
    provider = _mapping(
        providers.get(provider_name),
        f"model config provider {provider_name}",
    )
    declared_models = provider.get("models")
    if not isinstance(declared_models, list):
        raise EvalSummaryError(f"provider {provider_name} models must be a list")
    selected: Mapping[str, object] | None = None
    for candidate in declared_models:
        if isinstance(candidate, Mapping) and candidate.get("id") == model_id:
            selected = candidate
            break
    if selected is None:
        raise EvalSummaryError(
            f"primary model {model_id} is not declared under {provider_name}"
        )
    cost = _mapping(selected.get("cost"), f"model {model_id} cost")
    prices = {
        price_key: _finite_decimal(
            cost.get(price_key),
            f"model {model_id} cost.{price_key}",
        )
        for price_key in TOKEN_PRICE_KEYS.values()
    }
    return {
        "primary": primary,
        "provider": provider_name,
        "model_id": model_id,
        "pricing_usd_per_million_tokens": prices,
    }


def _validate_record(
    record: Mapping[str, object],
    index: int,
) -> tuple[str, str, str, int, int, str, datetime, datetime | None]:
    label = f"trial record {index}"
    task_id = _nonempty_string(record.get("task_id"), f"{label} task_id")
    skill = _nonempty_string(record.get("skill"), f"{label} skill")
    suite = _nonempty_string(record.get("suite"), f"{label} suite")
    trial = _positive_integer(record.get("trial"), f"{label} trial")
    trials = _positive_integer(record.get("trials"), f"{label} trials")
    if trial > trials:
        raise EvalSummaryError(f"{label} trial exceeds its declared trial count")
    image = _nonempty_string(record.get("image"), f"{label} image")
    digest = _digest_from_image(image)
    recorded_at = _timestamp(
        record.get("recorded_at"),
        f"{label} recorded_at",
    )
    raw_run_started_at = record.get("run_started_at")
    run_started_at = (
        None
        if raw_run_started_at is None
        else _timestamp(raw_run_started_at, f"{label} run_started_at")
    )
    if run_started_at is not None and run_started_at > recorded_at:
        raise EvalSummaryError(f"{label} run_started_at is after recorded_at")
    grade = _mapping(record.get("grade"), f"{label} grade")
    if not isinstance(grade.get("passed"), bool):
        raise EvalSummaryError(f"{label} grade.passed must be a boolean")
    metadata = _mapping(record.get("metadata"), f"{label} metadata")
    for field in TELEMETRY_INTEGER_FIELDS:
        _nonnegative_integer(metadata.get(field), f"{label} metadata.{field}")
    for field in ("nudged", "failed"):
        if not isinstance(metadata.get(field), bool):
            raise EvalSummaryError(f"{label} metadata.{field} must be a boolean")
    error_class = metadata.get("error_class")
    if error_class is not None and not isinstance(error_class, str):
        raise EvalSummaryError(f"{label} metadata.error_class must be a string or null")
    return task_id, skill, suite, trial, trials, image, recorded_at, run_started_at


def _rounded_usd(value: Decimal) -> float:
    return float(value.quantize(USD_QUANTUM, rounding=ROUND_HALF_UP))


def _rate(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 6) if denominator else 0.0


def _percentile(values: Sequence[int], percentile: float) -> int:
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile * len(ordered)))
    return ordered[rank - 1]


def _distribution(values: Sequence[int]) -> dict[str, int | float]:
    if not values:
        raise EvalSummaryError("cannot summarize an empty telemetry distribution")
    return {
        "total": sum(values),
        "mean": round(sum(values) / len(values), 3),
        "p50": _percentile(values, 0.50),
        "p95": _percentile(values, 0.95),
    }


def _telemetry_summary(
    records: Sequence[Mapping[str, object]],
    prices: Mapping[str, Decimal],
) -> dict[str, object]:
    tokens = {field: 0 for field in TOKEN_PRICE_KEYS}
    durations: list[int] = []
    latencies: list[int] = []
    model_calls: list[int] = []
    nudged_count = 0
    failed_count = 0
    graded_failure_count = 0
    failure_classes: Counter[str] = Counter()
    failed_graders: Counter[str] = Counter()
    for index, record in enumerate(records, start=1):
        metadata = _mapping(record.get("metadata"), f"trial record {index} metadata")
        for field in TOKEN_PRICE_KEYS:
            tokens[field] += _nonnegative_integer(
                metadata.get(field),
                f"trial record {index} metadata.{field}",
            )
        durations.append(
            _nonnegative_integer(
                metadata.get("duration_ms"),
                f"trial record {index} metadata.duration_ms",
            )
        )
        latencies.append(
            _nonnegative_integer(
                metadata.get("latency_ms"),
                f"trial record {index} metadata.latency_ms",
            )
        )
        model_calls.append(
            _nonnegative_integer(
                metadata.get("model_call_count"),
                f"trial record {index} metadata.model_call_count",
            )
        )
        if metadata.get("nudged") is True:
            nudged_count += 1
        if metadata.get("failed") is True:
            failed_count += 1
            error_class = metadata.get("error_class")
            failure_classes[
                error_class if isinstance(error_class, str) and error_class else "unknown"
            ] += 1
        grade = _mapping(record.get("grade"), f"trial record {index} grade")
        if grade.get("passed") is False:
            graded_failure_count += 1
            recorded_failed_grader = False
            grader_results = grade.get("results")
            if isinstance(grader_results, list):
                for grader_result in grader_results:
                    if (
                        isinstance(grader_result, Mapping)
                        and grader_result.get("passed") is False
                    ):
                        grader = grader_result.get("grader")
                        failed_graders[
                            grader if isinstance(grader, str) and grader else "unknown"
                        ] += 1
                        recorded_failed_grader = True
            if not recorded_failed_grader:
                failed_graders["unknown"] += 1
    cost = sum(
        Decimal(tokens[token_field]) * prices[price_key] / Decimal(1_000_000)
        for token_field, price_key in TOKEN_PRICE_KEYS.items()
    )
    task_count = len({_nonempty_string(record.get("task_id"), "task_id") for record in records})
    return {
        "tokens": tokens,
        "cost": {
            "total_usd": _rounded_usd(cost),
            "per_trial_usd": _rounded_usd(cost / Decimal(len(records))),
            "per_task_usd": _rounded_usd(cost / Decimal(task_count)),
        },
        "duration_ms": _distribution(durations),
        "latency_ms": _distribution(latencies),
        "model_call_count": _distribution(model_calls),
        "nudged": {
            "trials": nudged_count,
            "rate": _rate(nudged_count, len(records)),
        },
        "failures": {
            "trials": failed_count,
            "rate": _rate(failed_count, len(records)),
            "by_error_class": dict(sorted(failure_classes.items())),
            "graded_trials": graded_failure_count,
            "graded_rate": _rate(graded_failure_count, len(records)),
            "by_failed_grader": dict(sorted(failed_graders.items())),
        },
        "caching_status": (
            "uncached" if tokens["cache_read_input_tokens"] == 0 else "cached"
        ),
    }


def _scope_summary(
    records: Sequence[Mapping[str, object]],
    task_summaries: Mapping[str, Mapping[str, object]],
    prices: Mapping[str, Decimal],
) -> dict[str, object]:
    task_ids = sorted(
        {_nonempty_string(record.get("task_id"), "task_id") for record in records}
    )
    passed_tasks = sum(
        task_summaries[task_id].get("pass^3") is True for task_id in task_ids
    )
    return {
        "task_count": len(task_ids),
        "trial_count": len(records),
        "pass^3": {
            "passed_tasks": passed_tasks,
            "total_tasks": len(task_ids),
            "rate": _rate(passed_tasks, len(task_ids)),
        },
        "telemetry": _telemetry_summary(records, prices),
    }


def summarize_records(
    records: Sequence[Mapping[str, object]],
    model_pricing: Mapping[str, object],
    *,
    expected_image: str | None = None,
    source_commit: str | None = None,
    source_commit_provenance: str | None = None,
    eval_harness_commit: str | None = None,
) -> dict[str, object]:
    """Validate complete trials and return a transcript-free run summary."""

    if not records:
        raise EvalSummaryError("cannot summarize zero records")
    if source_commit is not None and GIT_OID_RE.fullmatch(source_commit) is None:
        raise EvalSummaryError("source_commit must be a full Git object ID")
    if (
        source_commit_provenance is not None
        and source_commit_provenance not in SOURCE_COMMIT_PROVENANCE
    ):
        raise EvalSummaryError("source_commit_provenance is invalid")
    if (
        eval_harness_commit is not None
        and GIT_OID_RE.fullmatch(eval_harness_commit) is None
    ):
        raise EvalSummaryError("eval_harness_commit must be a full Git object ID")
    seen_trials: set[tuple[str, int]] = set()
    grouped_tasks: dict[str, list[Mapping[str, object]]] = defaultdict(list)
    task_identity: dict[str, tuple[str, str, int]] = {}
    images: set[str] = set()
    digests: set[str] = set()
    recorded_times: list[datetime] = []
    run_started_times: list[datetime] = []
    missing_run_started_at = False
    for index, record in enumerate(records, start=1):
        (
            task_id,
            skill,
            suite,
            trial,
            trials,
            image,
            recorded_at,
            run_started_at,
        ) = _validate_record(record, index)
        key = (task_id, trial)
        if key in seen_trials:
            raise EvalSummaryError(f"duplicate trial record for {task_id} trial {trial}")
        seen_trials.add(key)
        identity = (skill, suite, trials)
        if task_id in task_identity and task_identity[task_id] != identity:
            raise EvalSummaryError(f"task {task_id} changed skill, suite, or trial count")
        task_identity[task_id] = identity
        grouped_tasks[task_id].append(record)
        images.add(image)
        digests.add(_digest_from_image(image))
        recorded_times.append(recorded_at)
        if run_started_at is None:
            missing_run_started_at = True
        else:
            run_started_times.append(run_started_at)
    if len(images) != 1 or len(digests) != 1:
        raise EvalSummaryError("all trial records must use the same immutable image")
    image = next(iter(images))
    digest = next(iter(digests))
    if expected_image is not None and (
        _digest_from_image(expected_image) != digest or expected_image != image
    ):
        raise EvalSummaryError("trial image does not match --image")

    task_summaries: dict[str, dict[str, object]] = {}
    for task_id in sorted(grouped_tasks):
        task_records = grouped_tasks[task_id]
        skill, suite, trials = task_identity[task_id]
        if trials != 3:
            raise EvalSummaryError(
                f"task {task_id} declared {trials} trials; committed summaries require pass^3"
            )
        observed_trials = sorted(
            _positive_integer(record.get("trial"), f"task {task_id} trial")
            for record in task_records
        )
        if observed_trials != [1, 2, 3]:
            raise EvalSummaryError(
                f"task {task_id} does not contain exactly trials 1, 2, and 3"
            )
        passed_trials = sum(
            _mapping(record.get("grade"), f"task {task_id} grade").get("passed")
            is True
            for record in task_records
        )
        task_summaries[task_id] = {
            "skill": skill,
            "suite": suite,
            "trials": trials,
            "passed_trials": passed_trials,
            "pass^3": passed_trials == trials,
        }

    prices_object = _mapping(
        model_pricing.get("pricing_usd_per_million_tokens"),
        "model pricing",
    )
    prices = {
        key: (
            value
            if isinstance(value, Decimal)
            else _finite_decimal(value, f"model pricing {key}")
        )
        for key, value in prices_object.items()
    }
    if set(prices) != set(TOKEN_PRICE_KEYS.values()):
        raise EvalSummaryError("model pricing is missing one or more token categories")

    suite_records: dict[str, list[Mapping[str, object]]] = defaultdict(list)
    skill_records: dict[str, list[Mapping[str, object]]] = defaultdict(list)
    for record in records:
        task_id = _nonempty_string(record.get("task_id"), "task_id")
        skill, suite, _ = task_identity[task_id]
        suite_records[suite].append(record)
        skill_records[skill].append(record)
    safe_model_pricing = {
        "primary": model_pricing["primary"],
        "provider": model_pricing["provider"],
        "model_id": model_pricing["model_id"],
        "pricing_usd_per_million_tokens": {
            key: float(value) for key, value in prices.items()
        },
    }
    summary = {
        "schema_version": SCHEMA_VERSION,
        "summary_kind": SUMMARY_KIND,
        "image": image,
        "image_digest": digest,
        "source_commit": source_commit,
        "source_commit_provenance": source_commit_provenance,
        "eval_harness_commit": eval_harness_commit,
        "run": {
            "started_at": (
                None
                if missing_run_started_at
                else min(run_started_times).isoformat()
            ),
            "start_time_status": (
                "unavailable-legacy-records"
                if missing_run_started_at
                else "captured"
            ),
            "first_trial_recorded_at": min(recorded_times).isoformat(),
            "completed_at": max(recorded_times).isoformat(),
            "task_count": len(task_summaries),
            "trial_count": len(records),
            "trials_per_task": 3,
        },
        "model": safe_model_pricing,
        "overall": _scope_summary(records, task_summaries, prices),
        "suites": {
            suite: _scope_summary(suite_records[suite], task_summaries, prices)
            for suite in sorted(suite_records)
        },
        "skills": {
            skill: {
                **_scope_summary(skill_records[skill], task_summaries, prices),
                "task_ids": sorted(
                    task_id
                    for task_id, task_summary in task_summaries.items()
                    if task_summary["skill"] == skill
                ),
            }
            for skill in sorted(skill_records)
        },
        "tasks": task_summaries,
    }
    _assert_no_transcript_fields(summary)
    _validate_summary_schema(summary, "summary")
    return summary


def _assert_no_transcript_fields(value: object, path: str = "$") -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if key in FORBIDDEN_SUMMARY_KEYS:
                raise EvalSummaryError(
                    f"summary contains forbidden transcript field {path}.{key}"
                )
            _assert_no_transcript_fields(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _assert_no_transcript_fields(child, f"{path}[{index}]")


def _exact_keys(
    value: Mapping[str, object],
    expected: set[str],
    description: str,
) -> None:
    actual = set(value)
    if actual != expected:
        unexpected = sorted(actual - expected)
        missing = sorted(expected - actual)
        details = []
        if unexpected:
            details.append(f"unexpected fields: {', '.join(unexpected)}")
        if missing:
            details.append(f"missing fields: {', '.join(missing)}")
        raise EvalSummaryError(f"{description} has {'; '.join(details)}")


def _safe_identifier(value: object, description: str) -> str:
    parsed = _nonempty_string(value, description)
    if SAFE_IDENTIFIER_RE.fullmatch(parsed) is None:
        raise EvalSummaryError(f"{description} is not a safe identifier")
    return parsed


def _rate_value(value: object, description: str) -> None:
    parsed = _finite_decimal(value, description)
    if parsed > 1:
        raise EvalSummaryError(f"{description} must be between zero and one")


def _validate_counter_map(value: object, description: str) -> None:
    counters = _mapping(value, description)
    for key, count in counters.items():
        _safe_identifier(key, f"{description} key")
        _nonnegative_integer(count, f"{description}.{key}")


def _validate_pass_three(value: object, description: str) -> None:
    pass_three = _mapping(value, description)
    _exact_keys(
        pass_three,
        {"passed_tasks", "total_tasks", "rate"},
        description,
    )
    passed = _nonnegative_integer(
        pass_three.get("passed_tasks"),
        f"{description}.passed_tasks",
    )
    total = _nonnegative_integer(
        pass_three.get("total_tasks"),
        f"{description}.total_tasks",
    )
    if passed > total:
        raise EvalSummaryError(f"{description}.passed_tasks exceeds total_tasks")
    _rate_value(pass_three.get("rate"), f"{description}.rate")


def _validate_distribution(value: object, description: str) -> None:
    distribution = _mapping(value, description)
    _exact_keys(distribution, {"total", "mean", "p50", "p95"}, description)
    _nonnegative_integer(distribution.get("total"), f"{description}.total")
    _finite_decimal(distribution.get("mean"), f"{description}.mean")
    _nonnegative_integer(distribution.get("p50"), f"{description}.p50")
    _nonnegative_integer(distribution.get("p95"), f"{description}.p95")


def _validate_telemetry(value: object, description: str) -> None:
    telemetry = _mapping(value, description)
    _exact_keys(
        telemetry,
        {
            "tokens",
            "cost",
            "duration_ms",
            "latency_ms",
            "model_call_count",
            "nudged",
            "failures",
            "caching_status",
        },
        description,
    )
    tokens = _mapping(telemetry.get("tokens"), f"{description}.tokens")
    _exact_keys(tokens, set(TOKEN_PRICE_KEYS), f"{description}.tokens")
    for field in TOKEN_PRICE_KEYS:
        _nonnegative_integer(
            tokens.get(field),
            f"{description}.tokens.{field}",
        )
    cost = _mapping(telemetry.get("cost"), f"{description}.cost")
    _exact_keys(
        cost,
        {"total_usd", "per_trial_usd", "per_task_usd"},
        f"{description}.cost",
    )
    for field in ("total_usd", "per_trial_usd", "per_task_usd"):
        _finite_decimal(cost.get(field), f"{description}.cost.{field}")
    for field in ("duration_ms", "latency_ms", "model_call_count"):
        _validate_distribution(
            telemetry.get(field),
            f"{description}.{field}",
        )
    nudged = _mapping(telemetry.get("nudged"), f"{description}.nudged")
    _exact_keys(nudged, {"trials", "rate"}, f"{description}.nudged")
    _nonnegative_integer(nudged.get("trials"), f"{description}.nudged.trials")
    _rate_value(nudged.get("rate"), f"{description}.nudged.rate")
    failures = _mapping(telemetry.get("failures"), f"{description}.failures")
    _exact_keys(
        failures,
        {
            "trials",
            "rate",
            "by_error_class",
            "graded_trials",
            "graded_rate",
            "by_failed_grader",
        },
        f"{description}.failures",
    )
    _nonnegative_integer(
        failures.get("trials"),
        f"{description}.failures.trials",
    )
    _rate_value(failures.get("rate"), f"{description}.failures.rate")
    _nonnegative_integer(
        failures.get("graded_trials"),
        f"{description}.failures.graded_trials",
    )
    _rate_value(
        failures.get("graded_rate"),
        f"{description}.failures.graded_rate",
    )
    _validate_counter_map(
        failures.get("by_error_class"),
        f"{description}.failures.by_error_class",
    )
    _validate_counter_map(
        failures.get("by_failed_grader"),
        f"{description}.failures.by_failed_grader",
    )
    if telemetry.get("caching_status") not in {"cached", "uncached"}:
        raise EvalSummaryError(
            f"{description}.caching_status must be cached or uncached"
        )


def _validate_scope(
    value: object,
    description: str,
    *,
    includes_task_ids: bool = False,
) -> None:
    scope = _mapping(value, description)
    expected = {"task_count", "trial_count", "pass^3", "telemetry"}
    if includes_task_ids:
        expected.add("task_ids")
    _exact_keys(scope, expected, description)
    _nonnegative_integer(scope.get("task_count"), f"{description}.task_count")
    _nonnegative_integer(scope.get("trial_count"), f"{description}.trial_count")
    _validate_pass_three(scope.get("pass^3"), f"{description}.pass^3")
    _validate_telemetry(scope.get("telemetry"), f"{description}.telemetry")
    if includes_task_ids:
        task_ids = scope.get("task_ids")
        if not isinstance(task_ids, list):
            raise EvalSummaryError(f"{description}.task_ids must be a list")
        for index, task_id in enumerate(task_ids):
            _safe_identifier(task_id, f"{description}.task_ids[{index}]")


def _validate_summary_schema(root: Mapping[str, object], description: str) -> None:
    """Validate the complete allowlisted committed-summary schema."""

    _exact_keys(
        root,
        {
            "schema_version",
            "summary_kind",
            "image",
            "image_digest",
            "source_commit",
            "source_commit_provenance",
            "eval_harness_commit",
            "run",
            "model",
            "overall",
            "suites",
            "skills",
            "tasks",
        },
        description,
    )
    run = _mapping(root.get("run"), f"{description}.run")
    _exact_keys(
        run,
        {
            "started_at",
            "start_time_status",
            "first_trial_recorded_at",
            "completed_at",
            "task_count",
            "trial_count",
            "trials_per_task",
        },
        f"{description}.run",
    )
    status = run.get("start_time_status")
    if status not in {"captured", "unavailable-legacy-records"}:
        raise EvalSummaryError(f"{description}.run has invalid start_time_status")
    started_at = run.get("started_at")
    if status == "captured":
        started = _timestamp(started_at, f"{description}.run.started_at")
    elif started_at is not None:
        raise EvalSummaryError(
            f"{description}.run.started_at must be null for legacy records"
        )
    else:
        started = None
    first_recorded = _timestamp(
        run.get("first_trial_recorded_at"),
        f"{description}.run.first_trial_recorded_at",
    )
    completed = _timestamp(
        run.get("completed_at"),
        f"{description}.run.completed_at",
    )
    if started is not None and started > first_recorded:
        raise EvalSummaryError(f"{description}.run started after its first trial")
    if first_recorded > completed:
        raise EvalSummaryError(f"{description}.run completed before its first trial")
    _nonnegative_integer(run.get("task_count"), f"{description}.run.task_count")
    _nonnegative_integer(run.get("trial_count"), f"{description}.run.trial_count")
    _positive_integer(
        run.get("trials_per_task"),
        f"{description}.run.trials_per_task",
    )

    model = _mapping(root.get("model"), f"{description}.model")
    _exact_keys(
        model,
        {"primary", "provider", "model_id", "pricing_usd_per_million_tokens"},
        f"{description}.model",
    )
    for field in ("primary", "provider", "model_id"):
        _safe_identifier(model.get(field), f"{description}.model.{field}")
    pricing = _mapping(
        model.get("pricing_usd_per_million_tokens"),
        f"{description}.model.pricing_usd_per_million_tokens",
    )
    _exact_keys(
        pricing,
        set(TOKEN_PRICE_KEYS.values()),
        f"{description}.model.pricing_usd_per_million_tokens",
    )
    for field in TOKEN_PRICE_KEYS.values():
        _finite_decimal(
            pricing.get(field),
            f"{description}.model.pricing_usd_per_million_tokens.{field}",
        )

    _validate_scope(root.get("overall"), f"{description}.overall")
    for field, includes_task_ids in (("suites", False), ("skills", True)):
        scopes = _mapping(root.get(field), f"{description}.{field}")
        for key, scope in scopes.items():
            _safe_identifier(key, f"{description}.{field} key")
            _validate_scope(
                scope,
                f"{description}.{field}.{key}",
                includes_task_ids=includes_task_ids,
            )
    tasks = _mapping(root.get("tasks"), f"{description}.tasks")
    for task_id, task_value in tasks.items():
        _safe_identifier(task_id, f"{description}.tasks key")
        task = _mapping(task_value, f"{description}.tasks.{task_id}")
        _exact_keys(
            task,
            {"skill", "suite", "trials", "passed_trials", "pass^3"},
            f"{description}.tasks.{task_id}",
        )
        _safe_identifier(task.get("skill"), f"{description}.tasks.{task_id}.skill")
        _safe_identifier(task.get("suite"), f"{description}.tasks.{task_id}.suite")
        trials = _positive_integer(
            task.get("trials"),
            f"{description}.tasks.{task_id}.trials",
        )
        passed_trials = _nonnegative_integer(
            task.get("passed_trials"),
            f"{description}.tasks.{task_id}.passed_trials",
        )
        if passed_trials > trials:
            raise EvalSummaryError(
                f"{description}.tasks.{task_id}.passed_trials exceeds trials"
            )
        if not isinstance(task.get("pass^3"), bool):
            raise EvalSummaryError(
                f"{description}.tasks.{task_id}.pass^3 must be a boolean"
            )


def validate_committed_summary(path: Path, content: bytes) -> None:
    """Reject committed eval artifacts that are not safe, digest-named summaries."""

    lowered_name = path.name.lower()
    if path.suffix == ".jsonl" or any(
        token in lowered_name for token in TRANSCRIPT_NAME_TOKENS
    ):
        raise EvalSummaryError(f"{path} looks like a trial transcript")
    if path.parent != Path(".eval-runs"):
        raise EvalSummaryError(f"{path} must be directly inside .eval-runs")
    if path.suffix != ".json" or SAFE_SUMMARY_NAME_RE.fullmatch(path.name) is None:
        raise EvalSummaryError(f"{path} must be a digest-named summary JSON")
    try:
        value = json.loads(content)
    except json.JSONDecodeError as error:
        raise EvalSummaryError(f"{path} is not valid JSON: {error}") from error
    root = _mapping(value, f"{path} summary")
    if root.get("schema_version") != SCHEMA_VERSION:
        raise EvalSummaryError(f"{path} has an unsupported schema version")
    if root.get("summary_kind") != SUMMARY_KIND:
        raise EvalSummaryError(f"{path} is not an agent eval run summary")
    image = _nonempty_string(root.get("image"), f"{path} image")
    digest = _digest_from_image(image)
    if root.get("image_digest") != digest:
        raise EvalSummaryError(f"{path} image digest does not match its image")
    expected_name = f"{digest.replace(':', '-')}.json"
    if path.name != expected_name:
        raise EvalSummaryError(f"{path} filename does not match its image digest")
    source_commit = root.get("source_commit")
    if not isinstance(source_commit, str) or GIT_OID_RE.fullmatch(source_commit) is None:
        raise EvalSummaryError(f"{path} source_commit must be a full Git object ID")
    eval_harness_commit = root.get("eval_harness_commit")
    if (
        not isinstance(eval_harness_commit, str)
        or GIT_OID_RE.fullmatch(eval_harness_commit) is None
    ):
        raise EvalSummaryError(
            f"{path} eval_harness_commit must be a full Git object ID"
        )
    if root.get("source_commit_provenance") not in SOURCE_COMMIT_PROVENANCE:
        raise EvalSummaryError(f"{path} has invalid source_commit_provenance")
    _assert_no_transcript_fields(root)
    _validate_summary_schema(root, f"{path} summary")


def check_repository(repo_root: Path) -> list[Path]:
    """Validate every tracked artifact under .eval-runs/."""

    result = subprocess.run(
        ["git", "ls-files", "-z", "--", ".eval-runs"],
        cwd=repo_root,
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise EvalSummaryError(f"git ls-files failed: {detail}")
    tracked = [
        Path(value.decode("utf-8"))
        for value in result.stdout.split(b"\0")
        if value
    ]
    for relative_path in tracked:
        try:
            content = (repo_root / relative_path).read_bytes()
        except OSError as error:
            raise EvalSummaryError(f"could not read {relative_path}: {error}") from error
        validate_committed_summary(relative_path, content)
    return tracked


def write_summary(path: Path, summary: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o644)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(summary, output, indent=2, sort_keys=True)
            output.write("\n")
    except BaseException:
        try:
            path.unlink()
        except OSError:
            pass
        raise


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--records", action="append", type=Path)
    mode.add_argument("--check-repository", action="store_true")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--image")
    parser.add_argument("--source-commit")
    parser.add_argument(
        "--source-commit-provenance",
        choices=sorted(SOURCE_COMMIT_PROVENANCE),
    )
    parser.add_argument("--eval-harness-commit")
    parser.add_argument(
        "--model-config",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "openclaw.json",
    )
    parser.add_argument("--require-all-pass", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.check_repository:
            if args.out is not None:
                raise EvalSummaryError("--out is not valid with --check-repository")
            repo_root = Path(__file__).resolve().parents[3]
            tracked = check_repository(repo_root)
            print(f"validated {len(tracked)} committed eval artifact(s)")
            return 0
        if args.out is None:
            raise EvalSummaryError("--out is required with --records")
        if args.image is None:
            raise EvalSummaryError("--image is required with --records")
        if args.source_commit is None:
            raise EvalSummaryError("--source-commit is required with --records")
        if args.source_commit_provenance is None:
            raise EvalSummaryError(
                "--source-commit-provenance is required with --records"
            )
        if args.eval_harness_commit is None:
            raise EvalSummaryError(
                "--eval-harness-commit is required with --records"
            )
        records = load_records(args.records)
        summary = summarize_records(
            records,
            load_model_pricing(args.model_config),
            expected_image=args.image,
            source_commit=args.source_commit,
            source_commit_provenance=args.source_commit_provenance,
            eval_harness_commit=args.eval_harness_commit,
        )
        write_summary(args.out, summary)
        print(
            f"wrote transcript-free summary for {summary['run']['task_count']} "
            f"tasks to {args.out}"
        )
        pass_three = _mapping(summary["overall"], "overall").get("pass^3")
        if args.require_all_pass and (
            not isinstance(pass_three, Mapping)
            or pass_three.get("passed_tasks") != pass_three.get("total_tasks")
        ):
            print("one or more tasks failed pass^3")
            return 1
        return 0
    except (EvalSummaryError, OSError) as error:
        print(f"error: {error}", file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
