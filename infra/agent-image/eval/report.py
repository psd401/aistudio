#!/usr/bin/env python3
"""Compare two committed agent-eval summaries and enforce promotion policy.

The report consumes only transcript-free summary JSON. It deliberately does
not accept trial JSONL, broker captures, or other raw eval artifacts.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Mapping, Sequence

import summarize


MAX_COST_INCREASE = Decimal("0.20")
TOKEN_PRICE_KEYS = {
    "input_tokens": "input",
    "output_tokens": "output",
    "cache_read_input_tokens": "cacheRead",
    "cache_write_input_tokens": "cacheWrite",
}
SAFE_REPORT_NAME_RE = re.compile(
    r"^comparison-(sha256-[0-9a-f]{64})-vs-(sha256-[0-9a-f]{64})\.md$"
)


class EvalReportError(RuntimeError):
    """Two eval summaries could not be compared safely."""


@dataclass(frozen=True)
class PassStats:
    """pass^3 counts for a task scope."""

    passed: int
    total: int

    @property
    def rate(self) -> Decimal:
        if self.total == 0:
            return Decimal(0)
        return Decimal(self.passed) / Decimal(self.total)


@dataclass(frozen=True)
class SkillDelta:
    """Per-skill reliability before and after the candidate."""

    skill: str
    baseline_regression: PassStats | None
    candidate_regression: PassStats | None
    baseline_overall: PassStats
    candidate_overall: PassStats

    @property
    def regression_delta(self) -> Decimal | None:
        if (
            self.baseline_regression is None
            or self.candidate_regression is None
        ):
            return None
        return self.candidate_regression.rate - self.baseline_regression.rate

    @property
    def overall_delta(self) -> Decimal:
        return self.candidate_overall.rate - self.baseline_overall.rate


@dataclass(frozen=True)
class TaskChange:
    """A changed task outcome with the available trial-level counts."""

    task_id: str
    skill: str
    suite: str
    baseline_passed: int
    candidate_passed: int
    trials: int


@dataclass(frozen=True)
class ClauseResult:
    """One independently evaluated promotion clause."""

    key: str
    title: str
    passed: bool | None
    detail: str


@dataclass(frozen=True)
class Comparison:
    """All values needed by terminal and Markdown renderers."""

    baseline: Mapping[str, object]
    candidate: Mapping[str, object]
    skill_deltas: tuple[SkillDelta, ...]
    task_changes: tuple[TaskChange, ...]
    clauses: tuple[ClauseResult, ...]
    baseline_caching_status: str
    candidate_caching_status: str
    verdict: str


def _mapping(value: object, description: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise EvalReportError(f"{description} must be an object")
    return value


def _string(value: object, description: str) -> str:
    if not isinstance(value, str) or not value:
        raise EvalReportError(f"{description} must be a non-empty string")
    return value


def _integer(value: object, description: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise EvalReportError(f"{description} must be an integer")
    return value


def _decimal(value: object, description: str) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise EvalReportError(f"{description} must be numeric")
    parsed = Decimal(str(value))
    if not parsed.is_finite():
        raise EvalReportError(f"{description} must be finite")
    return parsed


def _load_summary_bytes(
    path: Path,
    content: bytes,
) -> Mapping[str, object]:
    # The existing validator is intentionally reused so reporting cannot become
    # a weaker ingestion path for forced-added transcripts or unknown fields.
    validation_path = Path(".eval-runs") / path.name
    try:
        summarize.validate_committed_summary(validation_path, content)
        value = json.loads(content)
    except (json.JSONDecodeError, summarize.EvalSummaryError) as error:
        raise EvalReportError(f"invalid run summary {path}: {error}") from error
    return _mapping(value, f"{path} summary")


def load_summary(path: Path) -> Mapping[str, object]:
    """Load and fully validate one digest-named, transcript-free summary."""

    try:
        content = path.read_bytes()
    except OSError as error:
        raise EvalReportError(f"could not read {path}: {error}") from error
    return _load_summary_bytes(path, content)


def _tasks(summary: Mapping[str, object], label: str) -> Mapping[str, object]:
    return _mapping(summary.get("tasks"), f"{label}.tasks")


def _task(
    tasks: Mapping[str, object],
    task_id: str,
    label: str,
) -> Mapping[str, object]:
    return _mapping(tasks.get(task_id), f"{label}.tasks.{task_id}")


def _telemetry(
    summary: Mapping[str, object],
    label: str,
) -> Mapping[str, object]:
    overall = _mapping(summary.get("overall"), f"{label}.overall")
    return _mapping(overall.get("telemetry"), f"{label}.overall.telemetry")


def _suite(
    summary: Mapping[str, object],
    suite: str,
    label: str,
) -> Mapping[str, object]:
    suites = _mapping(summary.get("suites"), f"{label}.suites")
    if suite not in suites:
        raise EvalReportError(f"{label} has no {suite!r} suite")
    return _mapping(suites.get(suite), f"{label}.suites.{suite}")


def _pass_stats(scope: Mapping[str, object], description: str) -> PassStats:
    pass_three = _mapping(scope.get("pass^3"), f"{description}.pass^3")
    return PassStats(
        passed=_integer(
            pass_three.get("passed_tasks"),
            f"{description}.pass^3.passed_tasks",
        ),
        total=_integer(
            pass_three.get("total_tasks"),
            f"{description}.pass^3.total_tasks",
        ),
    )


def _skill_pass_stats(
    summary: Mapping[str, object],
    skill: str,
    *,
    suite: str | None = None,
) -> PassStats | None:
    selected: list[Mapping[str, object]] = []
    for task_id, value in _tasks(summary, "summary").items():
        task = _mapping(value, f"summary.tasks.{task_id}")
        if task.get("skill") != skill:
            continue
        if suite is not None and task.get("suite") != suite:
            continue
        selected.append(task)
    if not selected:
        return None
    return PassStats(
        passed=sum(task.get("pass^3") is True for task in selected),
        total=len(selected),
    )


def _validate_comparison_identity(
    baseline: Mapping[str, object],
    candidate: Mapping[str, object],
) -> None:
    baseline_harness = _string(
        baseline.get("eval_harness_commit"),
        "baseline.eval_harness_commit",
    )
    candidate_harness = _string(
        candidate.get("eval_harness_commit"),
        "candidate.eval_harness_commit",
    )
    if baseline_harness != candidate_harness:
        raise EvalReportError(
            "summaries must use the same eval_harness_commit "
            f"(baseline {baseline_harness}; candidate {candidate_harness})"
        )

    baseline_tasks = _tasks(baseline, "baseline")
    candidate_tasks = _tasks(candidate, "candidate")
    if set(baseline_tasks) != set(candidate_tasks):
        missing = sorted(set(baseline_tasks) - set(candidate_tasks))
        added = sorted(set(candidate_tasks) - set(baseline_tasks))
        raise EvalReportError(
            "summaries must contain the same task IDs "
            f"(missing from candidate: {missing or 'none'}; "
            f"candidate-only: {added or 'none'})"
        )
    for task_id in sorted(baseline_tasks):
        baseline_task = _task(baseline_tasks, task_id, "baseline")
        candidate_task = _task(candidate_tasks, task_id, "candidate")
        for field in ("skill", "suite", "trials"):
            if baseline_task.get(field) != candidate_task.get(field):
                raise EvalReportError(
                    f"task {task_id} changed {field} between summaries"
                )


def _observed_caching_status(
    summary: Mapping[str, object],
    label: str,
) -> str:
    telemetry = _telemetry(summary, label)
    tokens = _mapping(telemetry.get("tokens"), f"{label}.overall.telemetry.tokens")
    cache_reads = _integer(
        tokens.get("cache_read_input_tokens"),
        f"{label}.overall.telemetry.tokens.cache_read_input_tokens",
    )
    return "uncached" if cache_reads == 0 else "cached"


def _scope_costs(
    summary: Mapping[str, object],
    label: str,
) -> tuple[Decimal, Decimal]:
    telemetry = _telemetry(summary, label)
    tokens = _mapping(
        telemetry.get("tokens"),
        f"{label}.overall.telemetry.tokens",
    )
    model = _mapping(summary.get("model"), f"{label}.model")
    pricing = _mapping(
        model.get("pricing_usd_per_million_tokens"),
        f"{label}.model.pricing_usd_per_million_tokens",
    )
    total_cost = sum(
        Decimal(
            _integer(
                tokens.get(token_field),
                f"{label}.overall.telemetry.tokens.{token_field}",
            )
        )
        * _decimal(
            pricing.get(price_field),
            (
                f"{label}.model.pricing_usd_per_million_tokens."
                f"{price_field}"
            ),
        )
        / Decimal(1_000_000)
        for token_field, price_field in TOKEN_PRICE_KEYS.items()
    )
    overall = _mapping(summary.get("overall"), f"{label}.overall")
    task_count = _integer(
        overall.get("task_count"),
        f"{label}.overall.task_count",
    )
    if task_count <= 0:
        raise EvalReportError(f"{label}.overall.task_count must be positive")
    return total_cost, total_cost / Decimal(task_count)


def _percent_change(baseline: Decimal, candidate: Decimal) -> Decimal | None:
    if baseline == 0:
        return Decimal(0) if candidate == 0 else None
    return (candidate - baseline) / baseline


def _format_percent(value: Decimal) -> str:
    return f"{value * Decimal(100):.2f}%"


def _format_points(value: Decimal) -> str:
    return f"{value * Decimal(100):+.2f} pp"


def _build_skill_deltas(
    baseline: Mapping[str, object],
    candidate: Mapping[str, object],
) -> tuple[SkillDelta, ...]:
    skills = sorted(
        {
            _string(task.get("skill"), f"tasks.{task_id}.skill")
            for task_id, value in _tasks(baseline, "baseline").items()
            for task in [_mapping(value, f"baseline.tasks.{task_id}")]
        }
    )
    rows: list[SkillDelta] = []
    for skill in skills:
        baseline_overall = _skill_pass_stats(baseline, skill)
        candidate_overall = _skill_pass_stats(candidate, skill)
        if baseline_overall is None or candidate_overall is None:
            raise EvalReportError(f"skill {skill} is missing from one summary")
        rows.append(
            SkillDelta(
                skill=skill,
                baseline_regression=_skill_pass_stats(
                    baseline,
                    skill,
                    suite="regression",
                ),
                candidate_regression=_skill_pass_stats(
                    candidate,
                    skill,
                    suite="regression",
                ),
                baseline_overall=baseline_overall,
                candidate_overall=candidate_overall,
            )
        )

    def severity(row: SkillDelta) -> tuple[int, Decimal, Decimal, str]:
        regression_delta = row.regression_delta
        return (
            0 if regression_delta is not None and regression_delta < 0 else 1,
            regression_delta if regression_delta is not None else Decimal("Infinity"),
            row.overall_delta,
            row.skill,
        )

    return tuple(sorted(rows, key=severity))


def _build_task_changes(
    baseline: Mapping[str, object],
    candidate: Mapping[str, object],
) -> tuple[TaskChange, ...]:
    baseline_tasks = _tasks(baseline, "baseline")
    candidate_tasks = _tasks(candidate, "candidate")
    changes: list[TaskChange] = []
    for task_id in sorted(baseline_tasks):
        baseline_task = _task(baseline_tasks, task_id, "baseline")
        candidate_task = _task(candidate_tasks, task_id, "candidate")
        baseline_passed = _integer(
            baseline_task.get("passed_trials"),
            f"baseline.tasks.{task_id}.passed_trials",
        )
        candidate_passed = _integer(
            candidate_task.get("passed_trials"),
            f"candidate.tasks.{task_id}.passed_trials",
        )
        if baseline_passed == candidate_passed:
            continue
        changes.append(
            TaskChange(
                task_id=task_id,
                skill=_string(
                    baseline_task.get("skill"),
                    f"baseline.tasks.{task_id}.skill",
                ),
                suite=_string(
                    baseline_task.get("suite"),
                    f"baseline.tasks.{task_id}.suite",
                ),
                baseline_passed=baseline_passed,
                candidate_passed=candidate_passed,
                trials=_integer(
                    baseline_task.get("trials"),
                    f"baseline.tasks.{task_id}.trials",
                ),
            )
        )
    return tuple(changes)


def _promotion_clauses(
    baseline: Mapping[str, object],
    candidate: Mapping[str, object],
    skill_deltas: Sequence[SkillDelta],
    baseline_caching_status: str,
    candidate_caching_status: str,
) -> tuple[ClauseResult, ...]:
    regressions = [
        row
        for row in skill_deltas
        if row.regression_delta is not None and row.regression_delta < 0
    ]
    if regressions:
        regression_detail = "Regression-suite drops: " + ", ".join(
            f"{row.skill} ({_format_points(row.regression_delta or Decimal(0))})"
            for row in regressions
        )
    else:
        regression_detail = "No skill's regression-suite pass^3 dropped."
    regression_clause = ClauseResult(
        key="a",
        title="No per-skill regression-suite pass^3 drop",
        passed=not regressions,
        detail=regression_detail,
    )

    baseline_capability = _pass_stats(
        _suite(baseline, "capability", "baseline"),
        "baseline.suites.capability",
    )
    candidate_capability = _pass_stats(
        _suite(candidate, "capability", "candidate"),
        "candidate.suites.capability",
    )
    capability_improved = candidate_capability.rate > baseline_capability.rate
    capability_clause = ClauseResult(
        key="b",
        title="Overall capability pass^3 improves",
        passed=capability_improved,
        detail=(
            f"{_format_stats(baseline_capability)} -> "
            f"{_format_stats(candidate_capability)} "
            f"({_format_points(candidate_capability.rate - baseline_capability.rate)})"
        ),
    )

    _, baseline_cost = _scope_costs(baseline, "baseline")
    _, candidate_cost = _scope_costs(candidate, "candidate")
    if baseline_caching_status != candidate_caching_status:
        cost_clause = ClauseResult(
            key="c",
            title="Cost per task increases by no more than 20%",
            passed=None,
            detail=(
                "Declined because observed caching differs "
                f"(baseline {baseline_caching_status}, "
                f"candidate {candidate_caching_status}); no cost verdict rendered."
            ),
        )
    else:
        cost_change = _percent_change(baseline_cost, candidate_cost)
        if cost_change is None:
            cost_passed = False
            change_label = "undefined increase from a zero-cost baseline"
        else:
            cost_passed = cost_change <= MAX_COST_INCREASE
            change_label = _format_percent(cost_change)
        cost_clause = ClauseResult(
            key="c",
            title="Cost per task increases by no more than 20%",
            passed=cost_passed,
            detail=(
                f"${baseline_cost:.6f} -> ${candidate_cost:.6f} "
                f"({change_label})"
            ),
        )
    return regression_clause, capability_clause, cost_clause


def compare_summaries(
    baseline: Mapping[str, object],
    candidate: Mapping[str, object],
) -> Comparison:
    """Compare validated run summaries and evaluate the promotion rule."""

    _validate_comparison_identity(baseline, candidate)
    skill_deltas = _build_skill_deltas(baseline, candidate)
    baseline_caching_status = _observed_caching_status(baseline, "baseline")
    candidate_caching_status = _observed_caching_status(candidate, "candidate")
    clauses = _promotion_clauses(
        baseline,
        candidate,
        skill_deltas,
        baseline_caching_status,
        candidate_caching_status,
    )
    if any(clause.passed is False for clause in clauses):
        verdict = "REJECT"
    elif all(clause.passed is True for clause in clauses):
        verdict = "PROMOTE"
    else:
        verdict = "INDETERMINATE"
    return Comparison(
        baseline=baseline,
        candidate=candidate,
        skill_deltas=skill_deltas,
        task_changes=_build_task_changes(baseline, candidate),
        clauses=clauses,
        baseline_caching_status=baseline_caching_status,
        candidate_caching_status=candidate_caching_status,
        verdict=verdict,
    )


def committed_report_name(comparison: Comparison) -> str:
    """Return the only accepted .eval-runs Markdown filename."""

    baseline_digest = _string(
        comparison.baseline.get("image_digest"),
        "baseline.image_digest",
    ).replace(":", "-")
    candidate_digest = _string(
        comparison.candidate.get("image_digest"),
        "candidate.image_digest",
    ).replace(":", "-")
    return f"comparison-{baseline_digest}-vs-{candidate_digest}.md"


def _format_stats(stats: PassStats | None) -> str:
    if stats is None:
        return "—"
    return f"{stats.passed}/{stats.total} ({_format_percent(stats.rate)})"


def _format_status(passed: bool | None) -> str:
    if passed is True:
        return "PASS"
    if passed is False:
        return "FAIL"
    return "DECLINED"


def _terminal_table(
    headers: Sequence[str],
    rows: Sequence[Sequence[str]],
) -> list[str]:
    widths = [
        max([len(headers[index]), *(len(row[index]) for row in rows)])
        for index in range(len(headers))
    ]

    def line(row: Sequence[str]) -> str:
        return " | ".join(
            value.ljust(widths[index]) for index, value in enumerate(row)
        ).rstrip()

    return [
        line(headers),
        "-+-".join("-" * width for width in widths),
        *(line(row) for row in rows),
    ]


def _markdown_table(
    headers: Sequence[str],
    rows: Sequence[Sequence[str]],
) -> list[str]:
    def escape(value: str) -> str:
        return value.replace("|", "\\|").replace("\n", " ")

    return [
        "| " + " | ".join(escape(value) for value in headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
        *(
            "| " + " | ".join(escape(value) for value in row) + " |"
            for row in rows
        ),
    ]


def _summary_label(summary: Mapping[str, object], label: str) -> str:
    model = _mapping(summary.get("model"), f"{label}.model")
    return (
        f"{_string(model.get('model_id'), f'{label}.model.model_id')} | "
        f"{_string(summary.get('image_digest'), f'{label}.image_digest')}"
    )


def _metric_rows(comparison: Comparison) -> list[list[str]]:
    baseline_telemetry = _telemetry(comparison.baseline, "baseline")
    candidate_telemetry = _telemetry(comparison.candidate, "candidate")
    caching_matches = (
        comparison.baseline_caching_status
        == comparison.candidate_caching_status
    )
    rows: list[list[str]] = []

    baseline_cost = _mapping(
        baseline_telemetry.get("cost"),
        "baseline.overall.telemetry.cost",
    )
    candidate_cost = _mapping(
        candidate_telemetry.get("cost"),
        "candidate.overall.telemetry.cost",
    )
    baseline_total_exact, baseline_per_task_exact = _scope_costs(
        comparison.baseline,
        "baseline",
    )
    candidate_total_exact, candidate_per_task_exact = _scope_costs(
        comparison.candidate,
        "candidate",
    )
    for field, title, baseline_exact, candidate_exact in (
        (
            "per_task_usd",
            "Cost / task",
            baseline_per_task_exact,
            candidate_per_task_exact,
        ),
        (
            "total_usd",
            "Cost total",
            baseline_total_exact,
            candidate_total_exact,
        ),
    ):
        baseline_value = _decimal(
            baseline_cost.get(field),
            f"baseline.overall.telemetry.cost.{field}",
        )
        candidate_value = _decimal(
            candidate_cost.get(field),
            f"candidate.overall.telemetry.cost.{field}",
        )
        change = _percent_change(baseline_exact, candidate_exact)
        if not caching_matches:
            delta = "declined: caching mismatch"
        elif change is None:
            delta = "undefined from zero baseline"
        else:
            delta = _format_percent(change)
        rows.append(
            [
                title,
                f"${baseline_value:.6f}",
                f"${candidate_value:.6f}",
                delta,
            ]
        )

    for field, title in (
        ("duration_ms", "Duration mean"),
        ("latency_ms", "Latency mean"),
        ("model_call_count", "Model calls mean"),
    ):
        baseline_distribution = _mapping(
            baseline_telemetry.get(field),
            f"baseline.overall.telemetry.{field}",
        )
        candidate_distribution = _mapping(
            candidate_telemetry.get(field),
            f"candidate.overall.telemetry.{field}",
        )
        baseline_value = _decimal(
            baseline_distribution.get("mean"),
            f"baseline.overall.telemetry.{field}.mean",
        )
        candidate_value = _decimal(
            candidate_distribution.get("mean"),
            f"candidate.overall.telemetry.{field}.mean",
        )
        unit = " ms" if field != "model_call_count" else ""
        rows.append(
            [
                title,
                f"{baseline_value:.3f}{unit}",
                f"{candidate_value:.3f}{unit}",
                f"{candidate_value - baseline_value:+.3f}{unit}",
            ]
        )

    baseline_model_calls = _mapping(
        baseline_telemetry.get("model_call_count"),
        "baseline.overall.telemetry.model_call_count",
    )
    candidate_model_calls = _mapping(
        candidate_telemetry.get("model_call_count"),
        "candidate.overall.telemetry.model_call_count",
    )
    baseline_model_call_total = _integer(
        baseline_model_calls.get("total"),
        "baseline.overall.telemetry.model_call_count.total",
    )
    candidate_model_call_total = _integer(
        candidate_model_calls.get("total"),
        "candidate.overall.telemetry.model_call_count.total",
    )
    rows.append(
        [
            "Model calls total",
            str(baseline_model_call_total),
            str(candidate_model_call_total),
            f"{candidate_model_call_total - baseline_model_call_total:+d}",
        ]
    )

    for field, title in (
        ("duration_ms", "Duration p50 / p95"),
        ("latency_ms", "Latency p50 / p95"),
    ):
        baseline_distribution = _mapping(
            baseline_telemetry.get(field),
            f"baseline.overall.telemetry.{field}",
        )
        candidate_distribution = _mapping(
            candidate_telemetry.get(field),
            f"candidate.overall.telemetry.{field}",
        )
        baseline_p50 = _integer(
            baseline_distribution.get("p50"),
            f"baseline.overall.telemetry.{field}.p50",
        )
        baseline_p95 = _integer(
            baseline_distribution.get("p95"),
            f"baseline.overall.telemetry.{field}.p95",
        )
        candidate_p50 = _integer(
            candidate_distribution.get("p50"),
            f"candidate.overall.telemetry.{field}.p50",
        )
        candidate_p95 = _integer(
            candidate_distribution.get("p95"),
            f"candidate.overall.telemetry.{field}.p95",
        )
        rows.append(
            [
                title,
                f"{baseline_p50} / {baseline_p95} ms",
                f"{candidate_p50} / {candidate_p95} ms",
                f"{candidate_p50 - baseline_p50:+d} / "
                f"{candidate_p95 - baseline_p95:+d} ms",
            ]
        )

    for field, title in (("nudged", "Nudged rate"),):
        baseline_rate = _decimal(
            _mapping(
                baseline_telemetry.get(field),
                f"baseline.overall.telemetry.{field}",
            ).get("rate"),
            f"baseline.overall.telemetry.{field}.rate",
        )
        candidate_rate = _decimal(
            _mapping(
                candidate_telemetry.get(field),
                f"candidate.overall.telemetry.{field}",
            ).get("rate"),
            f"candidate.overall.telemetry.{field}.rate",
        )
        rows.append(
            [
                title,
                _format_percent(baseline_rate),
                _format_percent(candidate_rate),
                _format_points(candidate_rate - baseline_rate),
            ]
        )

    baseline_failures = _mapping(
        baseline_telemetry.get("failures"),
        "baseline.overall.telemetry.failures",
    )
    candidate_failures = _mapping(
        candidate_telemetry.get("failures"),
        "candidate.overall.telemetry.failures",
    )
    baseline_failure_rate = _decimal(
        baseline_failures.get("rate"),
        "baseline.overall.telemetry.failures.rate",
    )
    candidate_failure_rate = _decimal(
        candidate_failures.get("rate"),
        "candidate.overall.telemetry.failures.rate",
    )
    rows.append(
        [
            "Runtime failure rate",
            _format_percent(baseline_failure_rate),
            _format_percent(candidate_failure_rate),
            _format_points(candidate_failure_rate - baseline_failure_rate),
        ]
    )
    return rows


def _failure_rows(comparison: Comparison) -> list[list[str]]:
    def counts(
        summary: Mapping[str, object],
        label: str,
    ) -> Mapping[str, object]:
        telemetry = _telemetry(summary, label)
        failures = _mapping(
            telemetry.get("failures"),
            f"{label}.overall.telemetry.failures",
        )
        return _mapping(
            failures.get("by_error_class"),
            f"{label}.overall.telemetry.failures.by_error_class",
        )

    baseline_counts = counts(comparison.baseline, "baseline")
    candidate_counts = counts(comparison.candidate, "candidate")
    classes = sorted(set(baseline_counts) | set(candidate_counts))
    if not classes:
        return [["<none>", "0", "0", "0"]]
    rows: list[list[str]] = []
    for error_class in classes:
        baseline_value = _integer(
            baseline_counts.get(error_class, 0),
            f"baseline failure class {error_class}",
        )
        candidate_value = _integer(
            candidate_counts.get(error_class, 0),
            f"candidate failure class {error_class}",
        )
        rows.append(
            [
                error_class,
                str(baseline_value),
                str(candidate_value),
                f"{candidate_value - baseline_value:+d}",
            ]
        )
    return rows


def _skill_rows(comparison: Comparison) -> list[list[str]]:
    return [
        [
            row.skill,
            _format_stats(row.baseline_regression),
            _format_stats(row.candidate_regression),
            (
                _format_points(row.regression_delta)
                if row.regression_delta is not None
                else "—"
            ),
            _format_stats(row.baseline_overall),
            _format_stats(row.candidate_overall),
            _format_points(row.overall_delta),
        ]
        for row in comparison.skill_deltas
    ]


def _task_change_rows(comparison: Comparison) -> list[list[str]]:
    return [
        [
            change.task_id,
            change.skill,
            change.suite,
            (
                f"{change.baseline_passed}/{change.trials} "
                f"({'PASS' if change.baseline_passed == change.trials else 'FAIL'})"
            ),
            (
                f"{change.candidate_passed}/{change.trials} "
                f"({'PASS' if change.candidate_passed == change.trials else 'FAIL'})"
            ),
        ]
        for change in comparison.task_changes
    ]


def render_terminal(comparison: Comparison) -> str:
    """Render a compact report for an interactive terminal."""

    lines = [
        "Agent eval comparison",
        f"Verdict: {comparison.verdict}",
        f"Baseline:  {_summary_label(comparison.baseline, 'baseline')}",
        f"Candidate: {_summary_label(comparison.candidate, 'candidate')}",
        (
            "Observed caching: "
            f"{comparison.baseline_caching_status} -> "
            f"{comparison.candidate_caching_status}"
        ),
        "",
        "Promotion rule",
    ]
    lines.extend(
        f"[{_format_status(clause.passed)}] ({clause.key}) "
        f"{clause.title}: {clause.detail}"
        for clause in comparison.clauses
    )
    lines.extend(
        [
            "",
            "Per-skill pass^3",
            *_terminal_table(
                (
                    "Skill",
                    "Regression base",
                    "Regression cand",
                    "Regression Δ",
                    "Overall base",
                    "Overall cand",
                    "Overall Δ",
                ),
                _skill_rows(comparison),
            ),
            "",
            "Operational telemetry",
            *_terminal_table(
                ("Metric", "Baseline", "Candidate", "Delta"),
                _metric_rows(comparison),
            ),
            "",
            "Runtime failure classes",
            *_terminal_table(
                ("Error class", "Baseline", "Candidate", "Delta"),
                _failure_rows(comparison),
            ),
            "",
            "Changed task trial outcomes",
        ]
    )
    if comparison.task_changes:
        lines.extend(
            _terminal_table(
                ("Task", "Skill", "Suite", "Baseline", "Candidate"),
                _task_change_rows(comparison),
            )
        )
    else:
        lines.append("No task passed-trial counts changed.")
    return "\n".join(lines) + "\n"


def render_markdown(comparison: Comparison) -> str:
    """Render a report suitable for committing beside run summaries."""

    lines = [
        "# Agent eval comparison",
        "",
        f"**Verdict: {comparison.verdict}**",
        "",
        f"- Baseline: `{_summary_label(comparison.baseline, 'baseline')}`",
        f"- Candidate: `{_summary_label(comparison.candidate, 'candidate')}`",
        (
            "- Observed caching: "
            f"`{comparison.baseline_caching_status}` → "
            f"`{comparison.candidate_caching_status}`"
        ),
        "",
        "## Promotion rule",
        "",
        *_markdown_table(
            ("Clause", "Status", "Evidence"),
            [
                [
                    f"({clause.key}) {clause.title}",
                    _format_status(clause.passed),
                    clause.detail,
                ]
                for clause in comparison.clauses
            ],
        ),
        "",
        "## Per-skill pass^3",
        "",
        *_markdown_table(
            (
                "Skill",
                "Regression baseline",
                "Regression candidate",
                "Regression delta",
                "Overall baseline",
                "Overall candidate",
                "Overall delta",
            ),
            _skill_rows(comparison),
        ),
        "",
        "## Operational telemetry",
        "",
        *_markdown_table(
            ("Metric", "Baseline", "Candidate", "Delta"),
            _metric_rows(comparison),
        ),
        "",
        "## Runtime failure classes",
        "",
        *_markdown_table(
            ("Error class", "Baseline", "Candidate", "Delta"),
            _failure_rows(comparison),
        ),
        "",
        "## Changed task trial outcomes",
        "",
    ]
    if comparison.task_changes:
        lines.extend(
            _markdown_table(
                ("Task", "Skill", "Suite", "Baseline", "Candidate"),
                _task_change_rows(comparison),
            )
        )
    else:
        lines.append("No task passed-trial counts changed.")
    lines.extend(
        [
            "",
            "_`pass^3` means all three trials passed. No confidence interval is "
            "reported because three trials do not support that precision._",
            "",
        ]
    )
    return "\n".join(lines)


def validate_committed_report(
    path: Path,
    content: bytes,
    summary_blobs: Mapping[Path, bytes],
) -> None:
    """Require committed Markdown to be exactly reproducible from summaries."""

    if path.parent != Path(".eval-runs"):
        raise EvalReportError(f"{path} must be directly inside .eval-runs")
    match = SAFE_REPORT_NAME_RE.fullmatch(path.name)
    if match is None:
        raise EvalReportError(
            f"{path} must use the digest-pair comparison report filename"
        )
    baseline_path = Path(".eval-runs") / f"{match.group(1)}.json"
    candidate_path = Path(".eval-runs") / f"{match.group(2)}.json"
    missing = [
        summary_path
        for summary_path in (baseline_path, candidate_path)
        if summary_path not in summary_blobs
    ]
    if missing:
        raise EvalReportError(
            f"{path} references untracked run summaries: "
            + ", ".join(str(summary_path) for summary_path in missing)
        )
    comparison = compare_summaries(
        _load_summary_bytes(baseline_path, summary_blobs[baseline_path]),
        _load_summary_bytes(candidate_path, summary_blobs[candidate_path]),
    )
    if path.name != committed_report_name(comparison):
        raise EvalReportError(f"{path} filename does not match its summaries")
    if content != render_markdown(comparison).encode("utf-8"):
        raise EvalReportError(
            f"{path} does not exactly match the report regenerated "
            "from its tracked summaries"
        )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compare two transcript-free agent-eval run summaries.",
    )
    parser.add_argument("baseline", type=Path, help="baseline summary JSON")
    parser.add_argument("candidate", type=Path, help="candidate summary JSON")
    parser.add_argument(
        "--format",
        choices=("terminal", "markdown"),
        default="terminal",
        dest="output_format",
        help="report rendering (default: terminal)",
    )
    parser.add_argument("--out", type=Path, help="write the report to this path")
    parser.add_argument(
        "--require-promotion",
        action="store_true",
        help="exit 1 unless every promotion clause passes",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        comparison = compare_summaries(
            load_summary(args.baseline),
            load_summary(args.candidate),
        )
        rendered = (
            render_markdown(comparison)
            if args.output_format == "markdown"
            else render_terminal(comparison)
        )
        if args.out is None:
            sys.stdout.write(rendered)
        else:
            if (
                args.output_format == "markdown"
                and args.out.parent.name == ".eval-runs"
                and args.out.name != committed_report_name(comparison)
            ):
                raise EvalReportError(
                    "a report under .eval-runs must be named "
                    f"{committed_report_name(comparison)}"
                )
            args.out.write_text(rendered, encoding="utf-8")
    except (EvalReportError, OSError) as error:
        print(f"eval report failed: {error}", file=sys.stderr)
        return 2
    if args.require_promotion and comparison.verdict != "PROMOTE":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
