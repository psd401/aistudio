"""
Unit tests for the secret-rotation handlers (batch B-012).

Covers:
- REV-INFRA-109: AWS-standard step/stage guard + finish_secret None-guard (all four).
- REV-INFRA-106 / REV-COR-435-OVF2: oauth create_secret fails loudly (no identical-material promotion).
- REV-INFRA-107 / REV-COR-435-OVF2: custom set_secret gated, test_secret real validation, shape preserved.
- REV-COR-435-OVF1 / REV-INFRA-108: database connection enforces TLS (sslmode=require).
- REV-INFRA-115: handlers redact ARNs and log only the step, not the full event.

Run: cd infra/lambdas/secret-rotation && uvx --with boto3 --with pytest pytest tests/
"""

import importlib.util
import json
import logging
import os
import sys
from pathlib import Path
from unittest import mock

import pytest

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

# The database handler imports psycopg2 at module load; mock it before loading so the
# tests don't need the native binary. `from psycopg2 import sql` needs the submodule.
_psycopg2 = mock.MagicMock()
sys.modules["psycopg2"] = _psycopg2
sys.modules["psycopg2.sql"] = _psycopg2.sql

_ROOT = Path(__file__).resolve().parent.parent


def _load(name: str, subdir: str):
    spec = importlib.util.spec_from_file_location(name, _ROOT / subdir / "index.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DB = _load("rot_database", "database")
OAUTH = _load("rot_oauth", "oauth")
CUSTOM = _load("rot_custom", "custom")
APIKEY = _load("rot_apikey", "api-key")

ALL = [DB, OAUTH, CUSTOM, APIKEY]


class _RNFE(Exception):
    """Stand-in for secretsmanager.exceptions.ResourceNotFoundException."""


def make_sm():
    sm = mock.MagicMock()
    sm.exceptions.ResourceNotFoundException = _RNFE
    return sm


# --------------------------------------------------------------------------------------
# REV-INFRA-109 — step/stage guard
# --------------------------------------------------------------------------------------

@pytest.mark.parametrize("mod", ALL)
def test_guard_rejects_when_rotation_disabled(mod):
    mod.secretsmanager = make_sm()
    mod.secretsmanager.describe_secret.return_value = {"RotationEnabled": False, "VersionIdsToStages": {}}
    with pytest.raises(ValueError):
        mod.validate_rotation_request("arn", "tok")


@pytest.mark.parametrize("mod", ALL)
def test_guard_rejects_token_not_pending(mod):
    mod.secretsmanager = make_sm()
    mod.secretsmanager.describe_secret.return_value = {
        "RotationEnabled": True,
        "VersionIdsToStages": {"tok": ["AWSPREVIOUS"]},  # not AWSPENDING
    }
    with pytest.raises(ValueError):
        mod.validate_rotation_request("arn", "tok")


@pytest.mark.parametrize("mod", ALL)
def test_guard_rejects_token_unknown(mod):
    mod.secretsmanager = make_sm()
    mod.secretsmanager.describe_secret.return_value = {
        "RotationEnabled": True,
        "VersionIdsToStages": {"other": ["AWSPENDING"]},
    }
    with pytest.raises(ValueError):
        mod.validate_rotation_request("arn", "tok")


@pytest.mark.parametrize("mod", ALL)
def test_guard_short_circuits_when_already_current(mod):
    mod.secretsmanager = make_sm()
    mod.secretsmanager.describe_secret.return_value = {
        "RotationEnabled": True,
        "VersionIdsToStages": {"tok": ["AWSCURRENT"]},
    }
    assert mod.validate_rotation_request("arn", "tok") is True


@pytest.mark.parametrize("mod", ALL)
def test_guard_allows_pending_token(mod):
    mod.secretsmanager = make_sm()
    mod.secretsmanager.describe_secret.return_value = {
        "RotationEnabled": True,
        "VersionIdsToStages": {"tok": ["AWSPENDING"]},
    }
    assert mod.validate_rotation_request("arn", "tok") is False


# --------------------------------------------------------------------------------------
# REV-INFRA-109 — finish_secret never passes RemoveFromVersionId=None
# --------------------------------------------------------------------------------------

@pytest.mark.parametrize("mod", ALL)
def test_finish_secret_no_awscurrent_omits_remove(mod):
    sm = make_sm()
    sm.describe_secret.return_value = {"VersionIdsToStages": {"tok": ["AWSPENDING"]}}  # no AWSCURRENT
    mod.secretsmanager = sm

    mod.finish_secret("arn", "tok")

    assert sm.update_secret_version_stage.call_count == 1
    kwargs = sm.update_secret_version_stage.call_args.kwargs
    # Must NOT pass RemoveFromVersionId=None.
    assert kwargs.get("RemoveFromVersionId") is not None or "RemoveFromVersionId" not in kwargs
    assert kwargs["MoveToVersionId"] == "tok"


@pytest.mark.parametrize("mod", ALL)
def test_finish_secret_removes_existing_current(mod):
    sm = make_sm()
    sm.describe_secret.return_value = {
        "VersionIdsToStages": {"old": ["AWSCURRENT"], "tok": ["AWSPENDING"]}
    }
    mod.secretsmanager = sm

    mod.finish_secret("arn", "tok")

    kwargs = sm.update_secret_version_stage.call_args.kwargs
    assert kwargs["RemoveFromVersionId"] == "old"
    assert kwargs["MoveToVersionId"] == "tok"


# --------------------------------------------------------------------------------------
# REV-INFRA-106 / REV-COR-435-OVF2 — oauth fails loudly, never promotes identical material
# --------------------------------------------------------------------------------------

def test_oauth_create_secret_raises_and_never_puts():
    OAUTH.secretsmanager = make_sm()
    with pytest.raises(NotImplementedError):
        OAUTH.create_secret("arn", "tok")
    assert not OAUTH.secretsmanager.put_secret_value.called


# --------------------------------------------------------------------------------------
# REV-INFRA-107 / REV-COR-435-OVF2 — custom gated set + real test + shape preservation
# --------------------------------------------------------------------------------------

def test_custom_set_secret_raises_without_flag():
    CUSTOM.ALLOW_PLACEHOLDER_ROTATION = False
    CUSTOM.secretsmanager = make_sm()
    with pytest.raises(NotImplementedError):
        CUSTOM.set_secret("arn", "tok")


def test_custom_set_secret_noop_with_flag():
    CUSTOM.ALLOW_PLACEHOLDER_ROTATION = True
    CUSTOM.secretsmanager = make_sm()
    CUSTOM.set_secret("arn", "tok")  # must not raise
    CUSTOM.ALLOW_PLACEHOLDER_ROTATION = False


def test_custom_test_secret_rejects_short_value():
    sm = make_sm()
    sm.get_secret_value.return_value = {"SecretString": json.dumps({"value": "tooshort"})}
    CUSTOM.secretsmanager = sm
    with pytest.raises(ValueError):
        CUSTOM.test_secret("arn", "tok")


def test_custom_test_secret_accepts_valid_value():
    sm = make_sm()
    sm.get_secret_value.return_value = {"SecretString": json.dumps({"value": "x" * 64})}
    CUSTOM.secretsmanager = sm
    CUSTOM.test_secret("arn", "tok")  # must not raise


def test_custom_create_preserves_plain_string_shape():
    sm = make_sm()
    # 1st call: AWSPENDING check -> not found; 2nd: AWSCURRENT -> a plain (non-JSON) string
    sm.get_secret_value.side_effect = [_RNFE(), {"SecretString": "a-plain-old-secret-value"}]
    CUSTOM.secretsmanager = sm

    CUSTOM.create_secret("arn", "tok")

    stored = sm.put_secret_value.call_args.kwargs["SecretString"]
    # Stays a plain string (not coerced into a JSON {"value": ...} object).
    assert not stored.strip().startswith("{")
    assert stored != "a-plain-old-secret-value"  # value actually rotated


def test_custom_create_preserves_json_and_sibling_fields():
    sm = make_sm()
    sm.get_secret_value.side_effect = [
        _RNFE(),
        {"SecretString": json.dumps({"value": "old", "kind": "cert"})},
    ]
    CUSTOM.secretsmanager = sm

    CUSTOM.create_secret("arn", "tok")

    stored = json.loads(sm.put_secret_value.call_args.kwargs["SecretString"])
    assert stored["kind"] == "cert"      # sibling field preserved
    assert stored["value"] != "old"      # value rotated


# --------------------------------------------------------------------------------------
# REV-COR-435-OVF1 / REV-INFRA-108 — database connection enforces TLS
# --------------------------------------------------------------------------------------

def test_database_connection_requires_tls():
    _psycopg2.connect.reset_mock()
    DB.get_database_connection({"host": "h", "username": "u", "password": "p"})
    kwargs = _psycopg2.connect.call_args.kwargs
    assert kwargs["sslmode"] == "require"


def test_database_connection_sslmode_overridable():
    _psycopg2.connect.reset_mock()
    DB.get_database_connection({"host": "h", "username": "u", "password": "p", "sslmode": "verify-full"})
    assert _psycopg2.connect.call_args.kwargs["sslmode"] == "verify-full"


# --------------------------------------------------------------------------------------
# REV-INFRA-115 — no full-event/ARN logging; ARNs redacted
# --------------------------------------------------------------------------------------

@pytest.mark.parametrize("mod", ALL)
def test_sanitize_for_logging_redacts_arn(mod):
    out = mod.sanitize_for_logging(
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-AbCdEf"
    )
    assert "arn:aws" not in out
    assert "[ARN_REDACTED]" in out


@pytest.mark.parametrize("mod", [OAUTH, CUSTOM, APIKEY])
def test_handler_logs_step_not_full_arn(mod, caplog):
    sm = make_sm()
    # short-circuit via the guard (token already AWSCURRENT) to avoid the full flow
    sm.describe_secret.return_value = {"RotationEnabled": True, "VersionIdsToStages": {"tok": ["AWSCURRENT"]}}
    mod.secretsmanager = sm

    with caplog.at_level(logging.INFO):
        mod.handler(
            {
                "SecretId": "arn:aws:secretsmanager:us-east-1:123456789012:secret:foo",
                "ClientRequestToken": "tok",
                "Step": "createSecret",
            },
            None,
        )

    messages = " ".join(r.getMessage() for r in caplog.records)
    assert "createSecret" in messages  # step still logged for debugging
    assert "arn:aws:secretsmanager" not in messages  # full ARN not dumped
