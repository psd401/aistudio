"""
Agent failure capture from inside the AgentCore container.

Writes a row to `agent_failures` through the owner-bound web broker and emits a
structured JSON log line. The model-facing runtime has no database credential
or arbitrary SQL authority.

Never raises — failure-of-the-failure-writer must not affect the user-facing
agent reply.
"""

from __future__ import annotations

import json
import logging
import os
import traceback
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Mapping, Optional

logger = logging.getLogger("agent_failures")

_ENVIRONMENT = os.environ.get("ENVIRONMENT", "unknown")
_AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

_VALID_SOURCES = {"harness", "agent_self_report", "tool"}
_VALID_SEVERITIES = {"error", "warn", "empty_response"}

_cloudwatch_client = None


def _post_failure_broker(payload: Mapping[str, Any]) -> None:
    base = os.environ.get("APP_BASE_URL", "").rstrip("/")
    parsed = urllib.parse.urlparse(base)
    local_http = parsed.scheme == "http" and parsed.hostname in {
        "127.0.0.1",
        "localhost",
    }
    if parsed.scheme != "https" and not local_http:
        raise RuntimeError("APP_BASE_URL must use HTTPS")
    context_path = os.environ.get(
        "PSD_INVOCATION_CONTEXT_FILE",
        "/tmp/psd-agent-invocation-context",
    )
    with open(context_path, "r", encoding="ascii") as context_file:
        token = context_file.read().strip()
    broker_payload = {
        "source": payload["source"],
        "severity": payload["severity"],
        "scheduleName": payload["schedule_name"],
        "model": payload["model"],
        "errorClass": payload["error_class"],
        "errorMessage": payload["error_message"],
        "stackExcerpt": payload["stack_excerpt"],
        "context": payload["context"],
    }
    request = urllib.request.Request(
        f"{base}/api/agent/failures",
        data=json.dumps(broker_payload, default=str).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Agent-Invocation-Context": token,
        },
    )
    with urllib.request.urlopen(request, timeout=10):
        pass


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


def emit_agent_metric(
    metric_name: str,
    value: float = 1,
    dimensions: Optional[Mapping[str, str]] = None,
) -> None:
    """
    Best-effort: emit a CloudWatch custom metric from inside the AgentCore
    container into the `PSD/AgentPlatform/{ENVIRONMENT}` namespace.

    The container's log group name contains a runtime-generated suffix
    (`psd_agent_<env>-<id>-DEFAULT`) that isn't predictable at CDK synth time,
    so a log-group MetricFilter cannot attach to it. Container-origin signals
    (boot markers, nudge fires, boot-truncation WARNs) therefore emit their
    metrics directly via put_metric_data and alarm on the resulting metric —
    the same escape hatch AgentFailuresHarness uses.

    Never raises: telemetry must never break a chat turn or a boot.
    """
    client = _get_cloudwatch_client()
    if client is None:
        return
    try:
        datum: Dict[str, Any] = {
            "MetricName": metric_name,
            "Value": value,
            "Unit": "Count",
        }
        if dimensions:
            datum["Dimensions"] = [
                {"Name": k, "Value": v} for k, v in dimensions.items()
            ]
        client.put_metric_data(
            Namespace=f"PSD/AgentPlatform/{_ENVIRONMENT}",
            MetricData=[datum],
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("put_metric_data failed: %s", exc)


def _emit_failure_metric(source: str) -> None:
    """
    Emit the AgentFailuresHarness metric so the AgentFailureRateAlarm in
    agent-platform-stack picks it up. Thin wrapper over emit_agent_metric.
    """
    emit_agent_metric("AgentFailuresHarness", dimensions={"Source": source})


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

        _post_failure_broker(payload)
    except Exception as fail_exc:  # noqa: BLE001
        # Last-ditch: log the writer failure but never propagate.
        try:
            logger.error(
                "agent_failures.record_failure() itself failed: %s", fail_exc
            )
        except Exception:
            pass
