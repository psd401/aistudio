"""
Agent failure capture from inside the AgentCore container.

Writes a row to `agent_failures` via the RDS Data API when the relevant env
vars are present; otherwise emits a structured JSON log line that a CloudWatch
subscription filter can ship to a writer Lambda. Either way, every failure is
recoverable from CloudWatch by grepping for `AGENT_FAILURE_RECORD`.

Never raises — failure-of-the-failure-writer must not affect the user-facing
agent reply.
"""

from __future__ import annotations

import json
import logging
import os
import traceback
from typing import Any, Dict, Mapping, Optional

logger = logging.getLogger("agent_failures")

_DATABASE_RESOURCE_ARN = os.environ.get("DATABASE_RESOURCE_ARN")
_DATABASE_SECRET_ARN = os.environ.get("DATABASE_SECRET_ARN")
_DATABASE_NAME = os.environ.get("DATABASE_NAME")
_ENVIRONMENT = os.environ.get("ENVIRONMENT", "unknown")
_AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

_VALID_SOURCES = {"router", "harness", "cron", "agent_self_report", "tool"}
_VALID_SEVERITIES = {"error", "warn", "empty_response"}

_rds_client = None
_cloudwatch_client = None


def _get_rds_client():
    global _rds_client
    if _rds_client is not None:
        return _rds_client
    try:
        import boto3  # type: ignore[import-not-found]

        _rds_client = boto3.client("rds-data")
        return _rds_client
    except Exception as exc:  # noqa: BLE001
        logger.debug("rds-data client unavailable: %s", exc)
        return None


def _get_cloudwatch_client():
    global _cloudwatch_client
    if _cloudwatch_client is not None:
        return _cloudwatch_client
    try:
        import boto3  # type: ignore[import-not-found]

        _cloudwatch_client = boto3.client("cloudwatch", region_name=_AWS_REGION)
        return _cloudwatch_client
    except Exception as exc:  # noqa: BLE001
        logger.debug("cloudwatch client unavailable: %s", exc)
        return None


def _emit_failure_metric(source: str) -> None:
    """
    Best-effort: emit a CloudWatch custom metric for the failure so the
    AgentFailureRateAlarm in agent-platform-stack picks it up. Bypasses the
    log-group-based MetricFilter approach because AgentCore log group names
    contain a runtime-generated suffix (`psd_agent_<env>-<id>-DEFAULT`) that
    isn't predictable at CDK synth time.
    """
    client = _get_cloudwatch_client()
    if client is None:
        return
    try:
        client.put_metric_data(
            Namespace=f"PSD/AgentPlatform/{_ENVIRONMENT}",
            MetricData=[
                {
                    "MetricName": "AgentFailuresHarness",
                    "Value": 1,
                    "Unit": "Count",
                    "Dimensions": [{"Name": "Source", "Value": source}],
                }
            ],
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("put_metric_data failed: %s", exc)


def _truncate(s: Optional[str], max_len: int) -> Optional[str]:
    if s is None:
        return None
    if len(s) <= max_len:
        return s
    return s[:max_len]


def record_failure(
    source: str,
    severity: str,
    error_message: Optional[str] = None,
    *,
    user_id: Optional[str] = None,
    session_id: Optional[str] = None,
    schedule_name: Optional[str] = None,
    model: Optional[str] = None,
    error_class: Optional[str] = None,
    stack: Optional[str] = None,
    context: Optional[Mapping[str, Any]] = None,
    exc: Optional[BaseException] = None,
) -> None:
    """
    Record a failure. Best-effort, never raises.

    Pass either `error_message`/`stack` directly, or pass `exc` and the
    function will derive class, message, and stack automatically.
    """
    try:
        if source not in _VALID_SOURCES:
            source = "harness"
        if severity not in _VALID_SEVERITIES:
            severity = "error"

        if exc is not None:
            error_class = error_class or exc.__class__.__name__
            error_message = error_message or str(exc)
            if stack is None:
                stack = "".join(
                    traceback.format_exception(type(exc), exc, exc.__traceback__)
                )

        payload: Dict[str, Any] = {
            "source": source,
            "severity": severity,
            "user_id": user_id,
            "session_id": session_id,
            "schedule_name": schedule_name,
            "model": model,
            "error_class": _truncate(error_class, 128),
            "error_message": _truncate(error_message, 4000),
            "stack_excerpt": _truncate(
                "\n".join((stack or "").splitlines()[:20]) or None, 4000
            ),
            "context": dict(context) if context else None,
        }

        # Always emit a structured CloudWatch line so failures are recoverable
        # even if the DB write fails or env vars are missing.
        logger.error("AGENT_FAILURE_RECORD %s", json.dumps(payload, default=str))

        # Emit a CloudWatch metric so the AgentFailureRateAlarm fires.
        _emit_failure_metric(source)

        if not (_DATABASE_RESOURCE_ARN and _DATABASE_SECRET_ARN and _DATABASE_NAME):
            return

        client = _get_rds_client()
        if client is None:
            return

        params = [
            {"name": "source", "value": {"stringValue": payload["source"]}},
            {"name": "severity", "value": {"stringValue": payload["severity"]}},
            _string_or_null("user_id", payload["user_id"]),
            _string_or_null("session_id", payload["session_id"]),
            _string_or_null("schedule_name", payload["schedule_name"]),
            _string_or_null("model", payload["model"]),
            _string_or_null("error_class", payload["error_class"]),
            _string_or_null("error_message", payload["error_message"]),
            _string_or_null("stack_excerpt", payload["stack_excerpt"]),
            _string_or_null(
                "context",
                json.dumps(payload["context"]) if payload["context"] is not None else None,
            ),
        ]
        sql = (
            "INSERT INTO agent_failures "
            "(source, severity, user_id, session_id, schedule_name, model, "
            " error_class, error_message, stack_excerpt, context, occurred_at) "
            "VALUES (:source, :severity, :user_id, :session_id, :schedule_name, "
            " :model, :error_class, :error_message, :stack_excerpt, "
            " CAST(:context AS jsonb), NOW())"
        )
        client.execute_statement(
            resourceArn=_DATABASE_RESOURCE_ARN,
            secretArn=_DATABASE_SECRET_ARN,
            database=_DATABASE_NAME,
            sql=sql,
            parameters=params,
        )
    except Exception as fail_exc:  # noqa: BLE001
        # Last-ditch: log the writer failure but never propagate.
        try:
            logger.error(
                "agent_failures.record_failure() itself failed: %s", fail_exc
            )
        except Exception:
            pass


def _string_or_null(name: str, value: Optional[str]) -> Dict[str, Any]:
    if value is None:
        return {"name": name, "value": {"isNull": True}}
    return {"name": name, "value": {"stringValue": value}}
