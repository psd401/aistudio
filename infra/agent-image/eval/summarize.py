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

SCHEMA_VERSION = 1
SUMMARY_KIND = "agent-eval-run"
IMMUTABLE_DIGEST_RE = re.compile(r"(?:^|@)(sha256:[0-9a-f]{64})$")
SAFE_SUMMARY_NAME_RE = re.compile(r"^sha256-[0-9a-f]{64}\.json$")
GIT_OID_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
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
) -> tuple[str, str, str, int, int, str, datetime]:
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
    return task_id, skill, suite, trial, trials, image, recorded_at


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
) -> dict[str, object]:
    """Validate complete trials and return a transcript-free run summary."""

    if not records:
        raise EvalSummaryError("cannot summarize zero records")
    if source_commit is not None and GIT_OID_RE.fullmatch(source_commit) is None:
        raise EvalSummaryError("source_commit must be a full Git object ID")
    seen_trials: set[tuple[str, int]] = set()
    grouped_tasks: dict[str, list[Mapping[str, object]]] = defaultdict(list)
    task_identity: dict[str, tuple[str, str, int]] = {}
    images: set[str] = set()
    digests: set[str] = set()
    recorded_times: list[datetime] = []
    for index, record in enumerate(records, start=1):
        task_id, skill, suite, trial, trials, image, recorded_at = _validate_record(
            record,
            index,
        )
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
        "run": {
            "started_at": min(recorded_times).isoformat(),
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
    _assert_no_transcript_fields(root)


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
        records = load_records(args.records)
        summary = summarize_records(
            records,
            load_model_pricing(args.model_config),
            expected_image=args.image,
            source_commit=args.source_commit,
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
