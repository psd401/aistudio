#!/usr/bin/env python3
"""
Agent Schedule CLI — manages per-user schedules in the psd-agent-schedules
DynamoDB table. Each row is reconciled to a matching EventBridge Scheduler
entry by the scheduler-sync Lambda (via DynamoDB Streams).

Intended invocation from the agent via shell, e.g.:

  python3 /app/agent_schedules.py list --user hagelk@psd401.net
  python3 /app/agent_schedules.py create \
      --user hagelk@psd401.net \
      --name "Morning Brief" \
      --prompt "Generate my morning brief: calendar, priority tasks, email highlights" \
      --cron "0 9 * * MON-FRI" \
      --timezone "America/Los_Angeles"
  python3 /app/agent_schedules.py update <scheduleId> --user <email> --enabled false
  python3 /app/agent_schedules.py delete <scheduleId> --user <email>

All operations require --user (the caller's email) to scope the row.
The agent owns trust here: it MUST pass the authenticated caller's email,
never a value supplied by the conversation.

ENV:
  SCHEDULES_TABLE   — DynamoDB table name (injected by AgentCore runtime)
  AWS_REGION        — defaults to us-east-1

Output is JSON on stdout for easy parsing by the agent.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List

import boto3
from botocore.exceptions import ClientError

TABLE_ENV = "SCHEDULES_TABLE"
DEFAULT_TIMEZONE = "America/Los_Angeles"


def _table():
    table_name = os.environ.get(TABLE_ENV)
    if not table_name:
        raise RuntimeError(f"{TABLE_ENV} environment variable is not set")
    region = os.environ.get("AWS_REGION", "us-east-1")
    return boto3.resource("dynamodb", region_name=region).Table(table_name)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _emit(payload: Any) -> None:
    json.dump(payload, sys.stdout, default=str)
    sys.stdout.write("\n")


def cmd_list(args: argparse.Namespace) -> int:
    table = _table()
    resp = table.query(
        KeyConditionExpression="userId = :u",
        ExpressionAttributeValues={":u": args.user},
    )
    items: List[Dict[str, Any]] = resp.get("Items", [])
    _emit({"schedules": items, "count": len(items)})
    return 0


def cmd_create(args: argparse.Namespace) -> int:
    table = _table()
    schedule_id = str(uuid.uuid4())
    item: Dict[str, Any] = {
        "userId": args.user,
        "scheduleId": schedule_id,
        "name": args.name,
        "prompt": args.prompt,
        "cronExpression": args.cron,
        "timezone": args.timezone or DEFAULT_TIMEZONE,
        "enabled": not args.disabled,
        "createdAt": _now(),
        "updatedAt": _now(),
    }
    if args.google_identity:
        item["googleIdentity"] = args.google_identity
    if args.dm_space_name:
        item["dmSpaceName"] = args.dm_space_name
    table.put_item(Item=item)
    _emit({"created": item})
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    table = _table()
    # Build dynamic UPDATE expression from provided fields.
    sets: List[str] = ["updatedAt = :updatedAt"]
    values: Dict[str, Any] = {":updatedAt": _now()}
    names: Dict[str, str] = {}

    field_map = {
        "name": args.name,
        "prompt": args.prompt,
        "cronExpression": args.cron,
        "timezone": args.timezone,
        "enabled": args.enabled,
        "googleIdentity": args.google_identity,
        "dmSpaceName": args.dm_space_name,
    }
    for key, value in field_map.items():
        if value is None:
            continue
        placeholder = f":{key}"
        alias = f"#{key}"
        sets.append(f"{alias} = {placeholder}")
        values[placeholder] = value
        names[alias] = key

    update_expr = "SET " + ", ".join(sets)
    try:
        resp = table.update_item(
            Key={"userId": args.user, "scheduleId": args.schedule_id},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=values,
            ExpressionAttributeNames=names or None,
            ConditionExpression="attribute_exists(scheduleId)",
            ReturnValues="ALL_NEW",
        )
    except ClientError as err:
        if err.response["Error"]["Code"] == "ConditionalCheckFailedException":
            _emit({"error": "schedule not found", "scheduleId": args.schedule_id})
            return 1
        raise
    _emit({"updated": resp.get("Attributes", {})})
    return 0


def cmd_delete(args: argparse.Namespace) -> int:
    table = _table()
    try:
        table.delete_item(
            Key={"userId": args.user, "scheduleId": args.schedule_id},
            ConditionExpression="attribute_exists(scheduleId)",
        )
    except ClientError as err:
        if err.response["Error"]["Code"] == "ConditionalCheckFailedException":
            _emit({"error": "schedule not found", "scheduleId": args.schedule_id})
            return 1
        raise
    _emit({"deleted": args.schedule_id})
    return 0


def _parse_bool(value: str) -> bool:
    lowered = value.strip().lower()
    if lowered in {"true", "1", "yes", "on"}:
        return True
    if lowered in {"false", "0", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"Invalid bool: {value}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage agent schedules")
    sub = parser.add_subparsers(dest="command", required=True)

    list_p = sub.add_parser("list", help="List schedules for a user")
    list_p.add_argument("--user", required=True)
    list_p.set_defaults(func=cmd_list)

    create_p = sub.add_parser("create", help="Create a new schedule")
    create_p.add_argument("--user", required=True, help="Caller email (PK)")
    create_p.add_argument("--name", required=True)
    create_p.add_argument("--prompt", required=True)
    create_p.add_argument(
        "--cron",
        required=True,
        help=(
            "5-field (minute hour day month day-of-week) or 6-field cron "
            "expression interpreted in --timezone (default America/Los_Angeles)"
        ),
    )
    create_p.add_argument("--timezone", default=DEFAULT_TIMEZONE)
    create_p.add_argument("--disabled", action="store_true", help="Create in disabled state")
    create_p.add_argument("--google-identity", help='Google Chat user ID ("users/...")')
    create_p.add_argument("--dm-space-name", help='Google Chat DM space ("spaces/...")')
    create_p.set_defaults(func=cmd_create)

    update_p = sub.add_parser("update", help="Update fields on a schedule")
    update_p.add_argument("schedule_id")
    update_p.add_argument("--user", required=True)
    update_p.add_argument("--name")
    update_p.add_argument("--prompt")
    update_p.add_argument("--cron")
    update_p.add_argument("--timezone")
    update_p.add_argument("--enabled", type=_parse_bool)
    update_p.add_argument("--google-identity")
    update_p.add_argument("--dm-space-name")
    update_p.set_defaults(func=cmd_update)

    delete_p = sub.add_parser("delete", help="Delete a schedule")
    delete_p.add_argument("schedule_id")
    delete_p.add_argument("--user", required=True)
    delete_p.set_defaults(func=cmd_delete)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.func(args)
    except Exception as exc:
        _emit({"error": str(exc)})
        return 2


if __name__ == "__main__":
    sys.exit(main())
