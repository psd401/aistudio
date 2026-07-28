#!/usr/bin/env python3
"""Run a repeated task suite against a local PSD Agent Docker image.

Example:
    python3 runner.py --image <tag-or-digest> --suite suites/core.yaml \
        --trials 3 --out /tmp/issue-1424-run.jsonl
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol, TextIO

if __package__:
    from .broker_stub import (
        ALLOWED_AGENT_BROKER_ROUTES,
        CAPTURE_FILENAME,
        CONTROL_DIRECTORY_ENV,
        TRIAL_CONFIG_FILENAME,
    )
    from .graders import (
        GraderConfigurationError,
        TrialArtifacts,
        aggregate_pass_k,
        grade_trial,
        validate_grader_specs,
    )
    from .probe import (
        ProbeProtocolError,
        build_invocation_payload,
        extract_last_result_event,
    )
else:
    from broker_stub import (
        ALLOWED_AGENT_BROKER_ROUTES,
        CAPTURE_FILENAME,
        CONTROL_DIRECTORY_ENV,
        TRIAL_CONFIG_FILENAME,
    )
    from graders import (
        GraderConfigurationError,
        TrialArtifacts,
        aggregate_pass_k,
        grade_trial,
        validate_grader_specs,
    )
    from probe import (
        ProbeProtocolError,
        build_invocation_payload,
        extract_last_result_event,
    )

LOGGER = logging.getLogger("agent_eval")
DEFAULT_OWNER_EMAIL = "canary@build-gate.invalid"
DEFAULT_CONTEXT_TTL_SECONDS = 900
AWS_CREDENTIAL_EXPIRY_MARGIN_SECONDS = 60
INVOCATION_AUTHORITY_EXPIRY_MARGIN_SECONDS = 60
CONTEXT_MINT_ROUNDING_SECONDS = 5
MAX_CONTEXT_TTL_SECONDS = 7200
AWS_CREDENTIAL_ENVIRONMENT_KEYS = frozenset(
    {
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_SECURITY_TOKEN",
    }
)
REQUIRED_METADATA_FIELDS = frozenset(
    {
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_write_input_tokens",
        "model_call_count",
        "duration_ms",
        "latency_ms",
        "nudged",
        "tool_calls",
        "failed",
        "error_class",
        "session_id",
    }
)


class EvalRunnerError(RuntimeError):
    """The local runner could not safely complete the requested evaluation."""


@dataclass(frozen=True)
class Task:
    id: str
    skill: str
    level: str
    workspace: str
    prompt: str
    trials: int
    fixture_paths: tuple[Path, ...] = ()
    graders: tuple[dict[str, object], ...] = ()


@dataclass(frozen=True)
class InvocationAuthority:
    invocation_context: str
    request_proof_key: str
    owner_email: str
    session_id: str
    expires_at: datetime


@dataclass(frozen=True)
class AwsCredentials:
    environment: Mapping[str, str]
    expires_at: datetime | None

    @property
    def identity(self) -> tuple[str, str, str]:
        return (
            self.environment["AWS_ACCESS_KEY_ID"],
            self.environment["AWS_SECRET_ACCESS_KEY"],
            self.environment.get("AWS_SESSION_TOKEN", ""),
        )


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


class CommandExecutor:
    """Shell-free subprocess adapter that keeps secrets out of command logs."""

    def run(
        self,
        arguments: Sequence[str],
        *,
        input_text: str | None = None,
        timeout: float | None = None,
        env: Mapping[str, str] | None = None,
        check: bool = True,
    ) -> CommandResult:
        try:
            completed = subprocess.run(
                list(arguments),
                input=input_text,
                text=True,
                capture_output=True,
                timeout=timeout,
                env=dict(env) if env is not None else None,
                check=False,
            )
        except subprocess.TimeoutExpired:
            timeout_detail = (
                f" after {timeout:g}s" if timeout is not None else ""
            )
            raise EvalRunnerError(
                f"{arguments[0]} timed out{timeout_detail}"
            ) from None
        except OSError as error:
            raise EvalRunnerError(
                f"command failed to execute: {arguments[0]}: {error}"
            ) from error
        result = CommandResult(
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
        )
        if check and result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            raise EvalRunnerError(
                f"{arguments[0]} exited {result.returncode}: {detail[-2000:]}"
            )
        return result


class ContextMinter(Protocol):
    def mint(self, session_id: str) -> InvocationAuthority:
        """Mint authority bound to the exact trial session."""


class Runtime(Protocol):
    def prepare(self) -> bool:
        """Ensure credentials are valid; return whether the runtime was restarted."""

    def invoke(
        self,
        task: Task,
        session_id: str,
        authority: InvocationAuthority,
    ) -> dict[str, object]:
        """Invoke one task and return its terminal event."""

    def stop(self) -> None:
        """Remove only this runner-owned container."""

    def begin_trial(
        self,
        task: Task,
        trial_number: int,
        session_id: str,
    ) -> None:
        """Install fixture/capture state immediately before invocation."""

    def end_trial(self) -> TrialArtifacts:
        """Collect the active trial's broker requests and diagnostic artifacts."""


class RuntimeFactory(Protocol):
    def create(self, task: Task) -> Runtime:
        """Create an unstarted, independently owned runtime."""


class CredentialProvider(Protocol):
    def resolve(self) -> AwsCredentials:
        """Resolve the active AWS chain without retaining stale credentials."""


class ActiveAwsCredentialProvider:
    """Re-resolve the AWS CLI credential chain before every trial."""

    def __init__(self, executor: CommandExecutor) -> None:
        self._executor = executor

    def resolve(self) -> AwsCredentials:
        return _resolve_aws_credentials(self._executor)


class ProbeContextMinter:
    """Mint fresh context authority immediately before every trial."""

    def __init__(
        self,
        executor: CommandExecutor,
        repo_root: Path,
        environment: str,
        region: str,
        *,
        credential_provider: CredentialProvider | None = None,
        ttl_seconds: int = DEFAULT_CONTEXT_TTL_SECONDS,
        minimum_remaining_seconds: int = 30,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not 30 <= ttl_seconds <= MAX_CONTEXT_TTL_SECONDS:
            raise EvalRunnerError(
                f"context TTL must be between 30 and {MAX_CONTEXT_TTL_SECONDS} seconds"
            )
        if not 1 <= minimum_remaining_seconds <= ttl_seconds:
            raise EvalRunnerError(
                "minimum context lifetime must be positive and no longer than its TTL"
            )
        self._executor = executor
        self._script = repo_root / "scripts/agent-workspace/mint-agent-probe-context.ts"
        self._environment = environment
        self._region = region
        self._credential_provider = credential_provider
        self._ttl_seconds = ttl_seconds
        self._minimum_remaining_seconds = minimum_remaining_seconds
        self._now = now or (lambda: datetime.now(timezone.utc))

    def mint(self, session_id: str) -> InvocationAuthority:
        if not self._script.is_file():
            raise EvalRunnerError(f"context minter not found: {self._script}")
        environment = dict(os.environ)
        if self._credential_provider is not None:
            credentials = self._credential_provider.resolve()
            for key in AWS_CREDENTIAL_ENVIRONMENT_KEYS:
                environment.pop(key, None)
            environment.update(credentials.environment)
        environment["ENVIRONMENT"] = self._environment
        environment["AWS_REGION"] = self._region
        result = self._executor.run(
            [
                "bun",
                "run",
                str(self._script),
                "--json",
                "--session",
                session_id,
                "--ttl",
                str(self._ttl_seconds),
            ],
            timeout=90,
            env=environment,
        )
        try:
            minted = json.loads(result.stdout)
            expires_at = datetime.fromisoformat(
                str(minted["expiresAt"]).replace("Z", "+00:00")
            )
            returned_session = str(minted["sessionId"])
            authority = InvocationAuthority(
                invocation_context=str(minted["invocationContext"]),
                request_proof_key=str(minted["requestProofKey"]),
                owner_email=str(minted.get("ownerEmail") or DEFAULT_OWNER_EMAIL),
                session_id=returned_session,
                expires_at=expires_at,
            )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise EvalRunnerError("context minter returned malformed JSON") from error
        if authority.session_id != session_id:
            raise EvalRunnerError(
                "context minter returned a token for a different session"
            )
        if (
            authority.expires_at - self._now()
        ).total_seconds() < self._minimum_remaining_seconds:
            raise EvalRunnerError(
                "context minter returned authority that cannot outlive the "
                "configured invocation timeout"
            )
        return authority


def _load_fixture_files(paths: Sequence[Path]) -> list[dict[str, object]]:
    """Load and validate JSON fixtures before exposing them to the container."""

    fixtures: list[dict[str, object]] = []
    allowed_fields = {"route", "method", "request_body", "response"}
    for path in paths:
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except OSError as error:
            raise EvalRunnerError(
                f"could not read fixture file {path}: {error}"
            ) from error
        except json.JSONDecodeError as error:
            raise EvalRunnerError(f"fixture file {path} is not valid JSON") from error
        if isinstance(document, Mapping):
            entries = document.get("fixtures")
        else:
            entries = document
        if not isinstance(entries, list):
            raise EvalRunnerError(
                f"{path}: fixture file must be a list or contain a fixtures list"
            )
        for index, entry in enumerate(entries, start=1):
            if not isinstance(entry, Mapping):
                raise EvalRunnerError(f"{path}: fixture {index} must be an object")
            unknown = sorted(set(entry).difference(allowed_fields))
            if unknown:
                raise EvalRunnerError(
                    f"{path}: fixture {index} has unsupported fields: "
                    + ", ".join(unknown)
                )
            route = entry.get("route")
            if not isinstance(route, str) or route not in ALLOWED_AGENT_BROKER_ROUTES:
                raise EvalRunnerError(
                    f"{path}: fixture {index} route is not in the "
                    "agent-broker allowlist"
                )
            method = entry.get("method", "POST")
            if not isinstance(method, str) or method.upper() != "POST":
                raise EvalRunnerError(
                    f"{path}: fixture {index} method must be POST"
                )
            request_body = entry.get("request_body")
            if request_body is not None and not isinstance(request_body, Mapping):
                raise EvalRunnerError(
                    f"{path}: fixture {index} request_body must be an object"
                )
            response = entry.get("response", {})
            if not isinstance(response, Mapping):
                raise EvalRunnerError(
                    f"{path}: fixture {index} response must be an object"
                )
            response_unknown = sorted(
                set(response).difference({"status", "body"})
            )
            if response_unknown:
                raise EvalRunnerError(
                    f"{path}: fixture {index} response has unsupported fields: "
                    + ", ".join(response_unknown)
                )
            status = response.get("status", 200)
            if (
                isinstance(status, bool)
                or not isinstance(status, int)
                or status < 100
                or status > 599
            ):
                raise EvalRunnerError(
                    f"{path}: fixture {index} response status must be 100-599"
                )
            normalized = dict(entry)
            normalized["method"] = "POST"
            normalized["response"] = dict(response)
            fixtures.append(normalized)
    return fixtures


def _open_owner_only(path: Path, flags: int) -> int:
    descriptor = os.open(
        path,
        flags | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    os.fchmod(descriptor, 0o600)
    return descriptor


def _write_trial_configuration(
    control_directory: Path,
    value: Mapping[str, object],
) -> None:
    temporary_path = control_directory / (
        f".{TRIAL_CONFIG_FILENAME}.{uuid.uuid4().hex}.tmp"
    )
    descriptor = _open_owner_only(
        temporary_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, control_directory / TRIAL_CONFIG_FILENAME)
    except Exception:
        try:
            temporary_path.unlink()
        except OSError:
            pass
        raise


def _reset_capture(control_directory: Path) -> None:
    descriptor = _open_owner_only(
        control_directory / CAPTURE_FILENAME,
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
    )
    os.close(descriptor)


def _read_captures(control_directory: Path) -> tuple[Mapping[str, object], ...]:
    path = control_directory / CAPTURE_FILENAME
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return ()
    except OSError as error:
        raise EvalRunnerError(
            f"could not read broker capture {path}: {error}"
        ) from error
    captures: list[Mapping[str, object]] = []
    for line_number, line in enumerate(lines, start=1):
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise EvalRunnerError(
                f"broker capture {path}:{line_number} is malformed"
            ) from error
        if not isinstance(record, Mapping):
            raise EvalRunnerError(
                f"broker capture {path}:{line_number} is not an object"
            )
        captures.append(record)
    return tuple(captures)


class DockerRuntime:
    def __init__(
        self,
        executor: CommandExecutor,
        image: str,
        platform: str,
        environment_values: Mapping[str, str],
        credential_provider: CredentialProvider,
        *,
        boot_timeout_seconds: int,
        invocation_timeout_seconds: int,
        poll_interval_seconds: float,
        name_prefix: str,
        broker_stub_path: Path | None = None,
        use_broker_stub: bool = False,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._executor = executor
        self._image = image
        self._platform = platform
        self._environment_values = dict(environment_values)
        self._credential_provider = credential_provider
        self._boot_timeout_seconds = boot_timeout_seconds
        self._invocation_timeout_seconds = invocation_timeout_seconds
        self._poll_interval_seconds = poll_interval_seconds
        self._name_prefix = name_prefix
        self._broker_stub_path = broker_stub_path
        self._use_broker_stub = use_broker_stub
        self._name = self._new_name()
        self._monotonic = monotonic
        self._sleep = sleep
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._container_id: str | None = None
        self._active_credentials: AwsCredentials | None = None
        self._broker_control_directory: Path | None = None
        self._trial_log_since: datetime | None = None
        self._capture_tools_catalog = False
        self._trial_active = False

    def _new_name(self) -> str:
        return f"{self._name_prefix}-{uuid.uuid4().hex[:10]}"

    @property
    def container_id(self) -> str:
        if self._container_id is None:
            raise EvalRunnerError("container has not been started")
        return self._container_id

    def _resolve_credentials_for_invocation(self) -> AwsCredentials:
        credentials = self._credential_provider.resolve()
        if (
            credentials.environment.get("AWS_SESSION_TOKEN")
            and credentials.expires_at is None
        ):
            raise EvalRunnerError(
                "active AWS temporary credentials have unknown expiration; "
                "refresh the AWS login before continuing"
            )
        if credentials.expires_at is not None:
            required_seconds = (
                self._invocation_timeout_seconds
                + AWS_CREDENTIAL_EXPIRY_MARGIN_SECONDS
            )
            remaining_seconds = (
                credentials.expires_at - self._now()
            ).total_seconds()
            if remaining_seconds < required_seconds:
                raise EvalRunnerError(
                    "active AWS credentials expire before the configured invocation "
                    "timeout; refresh the AWS login before continuing"
                )
        return credentials

    def prepare(self) -> bool:
        restarted = False
        try:
            credentials = self._resolve_credentials_for_invocation()
            # A boot can consume a meaningful part of a temporary credential's
            # remaining life. Re-resolve after every start, recycling if the
            # provider rotated during boot, and bound pathological churn.
            for _ in range(3):
                if (
                    self._container_id is not None
                    and self._active_credentials is not None
                    and credentials.identity == self._active_credentials.identity
                ):
                    self._active_credentials = credentials
                    return restarted
                if self._container_id is not None:
                    LOGGER.info(
                        "AWS credentials rotated; recycling candidate container"
                    )
                    self.stop()
                    self._name = self._new_name()
                self._active_credentials = credentials
                self._start()
                restarted = True
                credentials = self._resolve_credentials_for_invocation()
                if credentials.identity == self._active_credentials.identity:
                    self._active_credentials = credentials
                    return restarted
            self.stop()
            raise EvalRunnerError(
                "AWS credentials kept rotating while the candidate container booted"
            )
        except Exception:
            self.stop()
            raise

    def _start(self) -> None:
        if self._container_id is not None:
            raise EvalRunnerError("container was already started")
        if self._active_credentials is None:
            raise EvalRunnerError("AWS credentials were not prepared")
        if self._use_broker_stub:
            if (
                self._broker_stub_path is None
                or not self._broker_stub_path.is_file()
            ):
                raise EvalRunnerError("eval broker stub source is unavailable")
            if self._broker_control_directory is not None:
                raise EvalRunnerError("eval broker control directory was not cleaned")
            self._broker_control_directory = Path(
                tempfile.mkdtemp(
                    prefix=f"issue-1424-broker-{os.getpid()}-",
                )
            )
            os.chmod(self._broker_control_directory, 0o700)
        arguments = [
            "docker",
            "run",
            "-d",
            "--platform",
            self._platform,
            "--name",
            self._name,
        ]
        if self._use_broker_stub:
            if self._broker_control_directory is None:
                raise EvalRunnerError("eval broker control directory was not created")
            arguments.extend(
                [
                    "--mount",
                    (
                        "type=bind,"
                        f"src={self._broker_stub_path.resolve()},"
                        "dst=/app/mantle_proxy.py,readonly"
                    ),
                    "--mount",
                    (
                        "type=bind,"
                        f"src={self._broker_control_directory.resolve()},"
                        "dst=/run/psd-agent-eval-broker"
                    ),
                ]
            )
        environment_values = {
            **self._environment_values,
            **self._active_credentials.environment,
        }
        if self._use_broker_stub:
            environment_values[CONTROL_DIRECTORY_ENV] = (
                "/run/psd-agent-eval-broker"
            )
        for key, value in sorted(environment_values.items()):
            arguments.extend(["-e", f"{key}={value}"])
        arguments.append(self._image)
        result = self._executor.run(arguments, timeout=60)
        container_id = result.stdout.strip()
        if not container_id:
            raise EvalRunnerError("docker run returned no container id")
        self._container_id = container_id
        try:
            self._wait_for_boot()
            self._wait_for_listener()
        except Exception:
            self._log_tail()
            self.stop()
            raise

    def _wait_for_boot(self) -> None:
        deadline = self._monotonic() + self._boot_timeout_seconds
        while self._monotonic() < deadline:
            logs = self._executor.run(
                ["docker", "logs", self.container_id],
                check=False,
                timeout=15,
            )
            if "BOOT_OK" in f"{logs.stdout}\n{logs.stderr}":
                return
            state = self._executor.run(
                [
                    "docker",
                    "inspect",
                    "--format={{.State.Running}}",
                    self.container_id,
                ],
                check=False,
                timeout=10,
            )
            if state.returncode != 0 or state.stdout.strip() != "true":
                raise EvalRunnerError("container exited before logging BOOT_OK")
            remaining_seconds = deadline - self._monotonic()
            if remaining_seconds <= 0:
                break
            self._sleep(
                min(
                    max(self._poll_interval_seconds, 0.1),
                    remaining_seconds,
                )
            )
        raise EvalRunnerError(
            f"container did not log BOOT_OK within {self._boot_timeout_seconds}s"
        )

    def _wait_for_listener(self) -> None:
        listener_timeout_seconds = 30
        deadline = self._monotonic() + listener_timeout_seconds
        while self._monotonic() < deadline:
            response = self._executor.run(
                [
                    "docker",
                    "exec",
                    self.container_id,
                    "curl",
                    "-s",
                    "-o",
                    "/dev/null",
                    "-m",
                    "2",
                    "http://127.0.0.1:8080/ping",
                ],
                check=False,
                timeout=5,
            )
            if response.returncode == 0:
                return
            remaining_seconds = deadline - self._monotonic()
            if remaining_seconds <= 0:
                break
            self._sleep(
                min(
                    max(self._poll_interval_seconds, 0.1),
                    remaining_seconds,
                )
            )
        raise EvalRunnerError(
            "container logged BOOT_OK but listener never became ready"
        )

    def invoke(
        self,
        task: Task,
        session_id: str,
        authority: InvocationAuthority,
    ) -> dict[str, object]:
        if authority.session_id != session_id:
            raise EvalRunnerError("invocation authority does not match trial session")
        payload = build_invocation_payload(
            task.prompt,
            authority.owner_email,
            authority.invocation_context,
            authority.request_proof_key,
        )
        response = self._executor.run(
            [
                "docker",
                "exec",
                self.container_id,
                "curl",
                "-sS",
                "-N",
                "-f",
                "-m",
                str(self._invocation_timeout_seconds),
                "-X",
                "POST",
                "http://127.0.0.1:8080/invocations",
                "-H",
                "Content-Type: application/json",
                "-H",
                f"X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: {session_id}",
                "-d",
                payload,
            ],
            check=False,
            timeout=self._invocation_timeout_seconds + 15,
        )
        if response.returncode != 0:
            self._log_tail()
            detail = (response.stderr or response.stdout).strip()
            raise EvalRunnerError(
                f"invocation curl exited {response.returncode}: {detail[-2000:]}"
            )
        try:
            return extract_last_result_event(response.stdout)
        except ProbeProtocolError as error:
            raise EvalRunnerError(f"invalid invocation response: {error}") from error

    def begin_trial(
        self,
        task: Task,
        trial_number: int,
        session_id: str,
    ) -> None:
        if self._trial_active:
            raise EvalRunnerError("a broker capture trial is already active")
        self._trial_log_since = self._now()
        self._capture_tools_catalog = any(
            spec.get("type") == "tools_catalog" for spec in task.graders
        )
        if not self._use_broker_stub:
            if task.level == "L1":
                raise EvalRunnerError("L1 task started without the eval broker stub")
            self._trial_active = True
            return
        if self._broker_control_directory is None:
            raise EvalRunnerError("eval broker control directory is unavailable")
        fixtures = _load_fixture_files(task.fixture_paths)
        _reset_capture(self._broker_control_directory)
        _write_trial_configuration(
            self._broker_control_directory,
            {
                "task_id": task.id,
                "trial_id": f"{task.id}:{trial_number}:{session_id}",
                "fixtures": fixtures,
            },
        )
        self._trial_active = True

    def end_trial(self) -> TrialArtifacts:
        if not self._trial_active:
            raise EvalRunnerError("no broker capture trial is active")
        try:
            captures: tuple[Mapping[str, object], ...] = ()
            if self._use_broker_stub:
                if self._broker_control_directory is None:
                    raise EvalRunnerError(
                        "eval broker control directory is unavailable"
                    )
                captures = _read_captures(self._broker_control_directory)
                try:
                    (
                        self._broker_control_directory
                        / TRIAL_CONFIG_FILENAME
                    ).unlink()
                except FileNotFoundError:
                    pass
            broker_errors = tuple(
                str(capture["stub_error"])
                for capture in captures
                if capture.get("stub_error")
            )
            catalog_log = ""
            if (
                self._capture_tools_catalog
                and self._trial_log_since is not None
                and self._container_id is not None
            ):
                logs = self._executor.run(
                    [
                        "docker",
                        "logs",
                        "--since",
                        self._trial_log_since.isoformat(),
                        self.container_id,
                    ],
                    check=False,
                    timeout=15,
                )
                catalog_log = "\n".join(
                    line
                    for line in f"{logs.stdout}\n{logs.stderr}".splitlines()
                    if "tools.catalog " in line
                )
            return TrialArtifacts(
                broker_requests=captures,
                broker_errors=broker_errors,
                tools_catalog_log=catalog_log,
            )
        finally:
            self._trial_active = False
            self._trial_log_since = None
            self._capture_tools_catalog = False

    def _log_tail(self) -> None:
        if self._container_id is None:
            return
        logs = self._executor.run(
            ["docker", "logs", "--tail", "60", self._container_id],
            check=False,
            timeout=15,
        )
        detail = f"{logs.stdout}\n{logs.stderr}".strip()
        if detail:
            LOGGER.error("candidate container log tail:\n%s", detail)

    def stop(self) -> None:
        removed = True
        if self._container_id is not None:
            container_id = self._container_id
            result = self._executor.run(
                ["docker", "rm", "-f", container_id],
                check=False,
                timeout=30,
            )
            removed = result.returncode == 0
            if removed:
                self._container_id = None
            else:
                detail = (result.stderr or result.stdout).strip()
                LOGGER.warning(
                    "failed to remove candidate container %s: %s",
                    container_id,
                    detail[-500:] or f"docker rm exited {result.returncode}",
                )
        if self._broker_control_directory is not None and removed:
            control_directory = self._broker_control_directory
            self._broker_control_directory = None
            try:
                shutil.rmtree(control_directory)
            except OSError as error:
                LOGGER.warning(
                    "failed to remove eval broker control directory %s: %s",
                    control_directory,
                    error,
                )
        self._trial_active = False
        self._trial_log_since = None
        self._capture_tools_catalog = False


class DockerRuntimeFactory:
    def __init__(
        self,
        executor: CommandExecutor,
        image: str,
        platform: str,
        environment_values: Mapping[str, str],
        credential_provider: CredentialProvider,
        *,
        boot_timeout_seconds: int,
        invocation_timeout_seconds: int,
        poll_interval_seconds: float,
        name_prefix: str,
        broker_stub_path: Path,
    ) -> None:
        self._executor = executor
        self._image = image
        self._platform = platform
        self._environment_values = dict(environment_values)
        self._credential_provider = credential_provider
        self._boot_timeout_seconds = boot_timeout_seconds
        self._invocation_timeout_seconds = invocation_timeout_seconds
        self._poll_interval_seconds = poll_interval_seconds
        self._name_prefix = name_prefix
        self._broker_stub_path = broker_stub_path

    def create(self, task: Task) -> DockerRuntime:
        return DockerRuntime(
            self._executor,
            self._image,
            self._platform,
            self._environment_values,
            self._credential_provider,
            boot_timeout_seconds=self._boot_timeout_seconds,
            invocation_timeout_seconds=self._invocation_timeout_seconds,
            poll_interval_seconds=self._poll_interval_seconds,
            name_prefix=self._name_prefix,
            broker_stub_path=self._broker_stub_path,
            use_broker_stub=task.level == "L1",
        )


class EvaluationRunner:
    def __init__(
        self,
        runtime_factory: RuntimeFactory,
        context_minter: ContextMinter,
        image: str = "unknown",
        *,
        session_id_factory: Callable[[], str] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._runtime_factory = runtime_factory
        self._context_minter = context_minter
        self._image = image
        self._session_id_factory = session_id_factory or (lambda: str(uuid.uuid4()))
        self._now = now or (lambda: datetime.now(timezone.utc))

    def run(
        self,
        tasks: Sequence[Task],
        output: TextIO,
        *,
        trials_override: int | None = None,
    ) -> list[dict[str, object]]:
        records: list[dict[str, object]] = []
        pure_runtimes: dict[str, Runtime] = {}
        try:
            for task in tasks:
                trial_count = (
                    trials_override if trials_override is not None else task.trials
                )
                if trial_count < 1:
                    raise EvalRunnerError("trial count must be positive")
                for trial_number in range(1, trial_count + 1):
                    owns_runtime = task.workspace == "mutating"
                    runtime_mode = "stubbed" if task.level == "L1" else "live"
                    if owns_runtime:
                        runtime = self._runtime_factory.create(task)
                    else:
                        if runtime_mode not in pure_runtimes:
                            pure_runtimes[runtime_mode] = (
                                self._runtime_factory.create(task)
                            )
                        runtime = pure_runtimes[runtime_mode]
                    try:
                        # Re-resolve the active credential chain before every
                        # trial. Pure runtimes remain shared while credentials
                        # are stable and are recycled immediately on rotation.
                        runtime.prepare()
                        session_id = self._session_id_factory()
                        if len(session_id) < 33 or len(session_id) > 256:
                            raise EvalRunnerError(
                                "session id must contain 33-256 characters"
                            )
                        # Mint immediately before every trial. This is stronger
                        # than a timer-based refresh: even a multi-hour suite can
                        # never begin a turn with a context from an earlier trial.
                        for _ in range(3):
                            authority = self._context_minter.mint(session_id)
                            # Context minting can take up to 90 seconds.
                            # Revalidate afterward. If that check rebooted the
                            # container, discard the aged authority and remint
                            # for the now-ready runtime.
                            if not runtime.prepare():
                                break
                        else:
                            raise EvalRunnerError(
                                "runtime kept restarting while invocation "
                                "authority was minted"
                            )
                        runtime.begin_trial(task, trial_number, session_id)
                        try:
                            event = runtime.invoke(task, session_id, authority)
                        finally:
                            artifacts = runtime.end_trial()
                        record = self._make_record(
                            task,
                            trial_number,
                            trial_count,
                            session_id,
                            event,
                            artifacts,
                        )
                        output.write(json.dumps(record, separators=(",", ":")) + "\n")
                        output.flush()
                        records.append(record)
                    finally:
                        if owns_runtime:
                            runtime.stop()
        finally:
            for runtime in pure_runtimes.values():
                runtime.stop()
        return records

    def _make_record(
        self,
        task: Task,
        trial_number: int,
        trial_count: int,
        session_id: str,
        event: Mapping[str, object],
        artifacts: TrialArtifacts,
    ) -> dict[str, object]:
        result = event.get("result")
        metadata = event.get("metadata")
        if not isinstance(metadata, dict):
            raise EvalRunnerError(
                f"task {task.id} trial {trial_number} returned no metadata object"
            )
        missing = sorted(REQUIRED_METADATA_FIELDS.difference(metadata))
        if missing:
            raise EvalRunnerError(
                f"task {task.id} trial {trial_number} dropped metadata fields: "
                + ", ".join(missing)
            )
        metadata_session = metadata.get("session_id")
        if metadata_session != session_id:
            raise EvalRunnerError(
                f"task {task.id} trial {trial_number} returned a mismatched session"
            )
        error_class = metadata.get("error_class")
        if error_class in {"InvocationContextInvalid", "WorkspaceAuthorityChanged"}:
            raise EvalRunnerError(
                f"task {task.id} trial {trial_number} hit runner isolation error "
                f"{error_class}"
            )
        grade = grade_trial(
            task.graders,
            result="" if result is None else str(result),
            metadata=metadata,
            artifacts=artifacts,
        )
        return {
            "task_id": task.id,
            "image": self._image,
            "skill": task.skill,
            "level": task.level,
            "workspace": task.workspace,
            "trial": trial_number,
            "trials": trial_count,
            "prompt": task.prompt,
            "session_id": session_id,
            "result": "" if result is None else str(result),
            # Preserve the complete final-event metadata object. Later grader
            # issues can consume new telemetry without changing this runner.
            "metadata": metadata,
            "broker_requests": list(artifacts.broker_requests),
            "grade": grade,
            "recorded_at": self._now().isoformat(),
        }


def _parse_scalar(value: str, path: Path, line_number: int) -> object:
    stripped = value.strip()
    if not stripped:
        return ""
    if stripped[0] == "'":
        if len(stripped) < 2 or stripped[-1] != "'":
            raise EvalRunnerError(
                f"{path}:{line_number}: invalid single-quoted YAML value"
            )
        content = stripped[1:-1]
        parsed: list[str] = []
        index = 0
        while index < len(content):
            character = content[index]
            if character != "'":
                parsed.append(character)
                index += 1
                continue
            if index + 1 >= len(content) or content[index + 1] != "'":
                raise EvalRunnerError(
                    f"{path}:{line_number}: invalid single-quoted YAML value"
                )
            parsed.append("'")
            index += 2
        return "".join(parsed)
    if stripped[0] in {'"', "[", "{"}:
        try:
            return json.loads(stripped)
        except json.JSONDecodeError as error:
            raise EvalRunnerError(
                f"{path}:{line_number}: invalid JSON-compatible quoted/inline value"
            ) from error
    lowered = stripped.lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    if lowered in {"null", "none", "~"}:
        return None
    if re.fullmatch(r"-?\d+", stripped):
        return int(stripped)
    return stripped


def _load_document(path: Path) -> object:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise EvalRunnerError(
            f"could not read suite/task file {path}: {error}"
        ) from error
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # The task contract stays dependency-free: grader objects use inline
    # JSON-compatible mappings inside top-level YAML lists.
    document: dict[str, object] = {}
    active_list: list[object] | None = None
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if "\t" in raw_line[: len(raw_line) - len(raw_line.lstrip())]:
            raise EvalRunnerError(
                f"{path}:{line_number}: tabs are not valid indentation"
            )
        indent = len(raw_line) - len(raw_line.lstrip())
        content = raw_line.strip()
        if indent == 0:
            active_list = None
            if ":" not in content:
                raise EvalRunnerError(f"{path}:{line_number}: expected key: value")
            key, value = content.split(":", 1)
            key = key.strip()
            if not key:
                raise EvalRunnerError(f"{path}:{line_number}: empty key")
            if value.strip():
                document[key] = _parse_scalar(value, path, line_number)
            else:
                active_list = []
                document[key] = active_list
            continue
        if active_list is None or indent < 2 or not content.startswith("- "):
            raise EvalRunnerError(
                f"{path}:{line_number}: only a top-level scalar list is supported"
            )
        active_list.append(_parse_scalar(content[2:], path, line_number))
    return document


def _task_from_mapping(value: Mapping[str, object], source: Path) -> Task:
    text_fields: dict[str, str] = {}
    for field in ("id", "skill", "level", "workspace", "prompt"):
        raw_value = value.get(field)
        if not isinstance(raw_value, str):
            raise EvalRunnerError(f"{source}: task {field} must be a string")
        text_fields[field] = raw_value
    raw_trials = value.get("trials", 3)
    if isinstance(raw_trials, bool) or not isinstance(raw_trials, int):
        raise EvalRunnerError(f"{source}: task trials must be an integer")
    raw_fixture_paths = value.get("fixtures", [])
    if (
        not isinstance(raw_fixture_paths, list)
        or any(not isinstance(path, str) or not path for path in raw_fixture_paths)
    ):
        raise EvalRunnerError(f"{source}: task fixtures must be a string list")
    fixture_paths: list[Path] = []
    for raw_path in raw_fixture_paths:
        candidate = Path(raw_path)
        if candidate.is_absolute():
            raise EvalRunnerError(f"{source}: fixture paths must be relative")
        resolved = (source.parent / candidate).resolve()
        if not resolved.is_file():
            raise EvalRunnerError(f"{source}: fixture file does not exist: {raw_path}")
        fixture_paths.append(resolved)
    raw_graders = value.get("graders", [])
    if (
        not isinstance(raw_graders, list)
        or any(not isinstance(spec, Mapping) for spec in raw_graders)
    ):
        raise EvalRunnerError(f"{source}: task graders must be a mapping list")
    try:
        graders = validate_grader_specs(raw_graders)
    except GraderConfigurationError as error:
        raise EvalRunnerError(f"{source}: {error}") from error
    task = Task(
        id=text_fields["id"],
        skill=text_fields["skill"],
        level=text_fields["level"],
        workspace=text_fields["workspace"],
        prompt=text_fields["prompt"],
        trials=raw_trials,
        fixture_paths=tuple(fixture_paths),
        graders=graders,
    )
    if not task.id or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", task.id):
        raise EvalRunnerError(f"{source}: task id must be lowercase kebab-case")
    if not task.skill or not task.prompt.strip():
        raise EvalRunnerError(f"{source}: skill and prompt must be non-empty")
    if task.level not in {"L0", "L1", "L2"}:
        raise EvalRunnerError(f"{source}: level must be L0, L1, or L2")
    if task.workspace not in {"pure", "mutating"}:
        raise EvalRunnerError(f"{source}: workspace must be pure or mutating")
    if task.trials < 1 or task.trials > 20:
        raise EvalRunnerError(f"{source}: trials must be between 1 and 20")
    if task.level == "L1" and not task.graders:
        raise EvalRunnerError(f"{source}: L1 tasks must configure at least one grader")
    return task


def load_suite(path: Path) -> list[Task]:
    document = _load_document(path)
    if isinstance(document, dict) and "id" in document:
        tasks = [_task_from_mapping(document, path)]
    else:
        entries: object
        if isinstance(document, dict):
            entries = document.get("tasks")
        else:
            entries = document
        if not isinstance(entries, list) or not entries:
            raise EvalRunnerError(f"{path}: suite must contain a non-empty tasks list")
        tasks = []
        for entry in entries:
            if isinstance(entry, dict):
                tasks.append(_task_from_mapping(entry, path))
                continue
            if not isinstance(entry, str):
                raise EvalRunnerError(
                    f"{path}: suite task entries must be paths or mappings"
                )
            task_path = (path.parent / entry).resolve()
            task_document = _load_document(task_path)
            if not isinstance(task_document, dict):
                raise EvalRunnerError(f"{task_path}: task must be a mapping")
            tasks.append(_task_from_mapping(task_document, task_path))
    ids = [task.id for task in tasks]
    duplicates = sorted({task_id for task_id in ids if ids.count(task_id) > 1})
    if duplicates:
        raise EvalRunnerError(f"{path}: duplicate task ids: {', '.join(duplicates)}")
    return tasks


def _resolve_app_base_url(
    executor: CommandExecutor,
    environment: str,
    region: str,
    explicit: str | None,
) -> str:
    configured = (
        explicit
        or os.environ.get("AGENT_EVAL_APP_BASE_URL")
        or os.environ.get("AGENT_PROBE_APP_BASE_URL")
    )
    if configured:
        return configured
    env_capitalized = environment[:1].upper() + environment[1:]
    stack_name = f"AIStudio-AgentPlatformStack-{env_capitalized}"
    stack = executor.run(
        [
            "aws",
            "cloudformation",
            "describe-stacks",
            "--stack-name",
            stack_name,
            "--query",
            "Stacks[0].Outputs[?OutputKey=='RouterLambdaArn'].OutputValue",
            "--output",
            "text",
            "--region",
            region,
        ],
        timeout=30,
    )
    router_arn = stack.stdout.strip()
    if not router_arn or router_arn == "None":
        raise EvalRunnerError(f"stack {stack_name} has no RouterLambdaArn output")
    configuration = executor.run(
        [
            "aws",
            "lambda",
            "get-function-configuration",
            "--function-name",
            router_arn,
            "--query",
            "Environment.Variables.APP_BASE_URL",
            "--output",
            "text",
            "--region",
            region,
        ],
        timeout=30,
    )
    resolved = configuration.stdout.strip()
    if not resolved or resolved == "None":
        raise EvalRunnerError("router Lambda has no APP_BASE_URL")
    return resolved


def _resolve_aws_credentials(executor: CommandExecutor) -> AwsCredentials:
    allowed = {
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
    }
    exported = executor.run(
        ["aws", "configure", "export-credentials", "--format", "process"],
        check=False,
        timeout=30,
    )
    credentials: dict[str, str] = {}
    expires_at: datetime | None = None
    if exported.returncode == 0:
        try:
            process_credentials = json.loads(exported.stdout)
            credentials = {
                "AWS_ACCESS_KEY_ID": str(process_credentials["AccessKeyId"]),
                "AWS_SECRET_ACCESS_KEY": str(process_credentials["SecretAccessKey"]),
            }
            session_token = process_credentials.get("SessionToken")
            if session_token:
                credentials["AWS_SESSION_TOKEN"] = str(session_token)
            expiration = process_credentials.get("Expiration")
            if expiration:
                expires_at = datetime.fromisoformat(
                    str(expiration).replace("Z", "+00:00")
                )
                if expires_at.tzinfo is None:
                    expires_at = expires_at.replace(tzinfo=timezone.utc)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            credentials = {}
            expires_at = None
    if not {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}.issubset(credentials):
        credentials = {
            key: os.environ[key]
            for key in allowed
            if os.environ.get(key)
        }
        expires_at = None
    if not {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}.issubset(credentials):
        raise EvalRunnerError(
            "could not resolve AWS credentials for the candidate container"
        )
    return AwsCredentials(environment=credentials, expires_at=expires_at)


def _positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _trial_count(value: str) -> int:
    parsed = _positive_integer(value)
    if parsed > 20:
        raise argparse.ArgumentTypeError("must be 20 or fewer")
    return parsed


def _positive_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be a finite number greater than zero")
    return parsed


def _context_ttl_seconds(invocation_timeout_seconds: int) -> int:
    ttl_seconds = (
        invocation_timeout_seconds
        + INVOCATION_AUTHORITY_EXPIRY_MARGIN_SECONDS
        + CONTEXT_MINT_ROUNDING_SECONDS
    )
    if ttl_seconds > MAX_CONTEXT_TTL_SECONDS:
        maximum_timeout = (
            MAX_CONTEXT_TTL_SECONDS
            - INVOCATION_AUTHORITY_EXPIRY_MARGIN_SECONDS
            - CONTEXT_MINT_ROUNDING_SECONDS
        )
        raise EvalRunnerError(
            "invocation timeout exceeds the context verifier limit; "
            f"use {maximum_timeout} seconds or fewer"
        )
    return ttl_seconds


def _open_output(path: Path, overwrite: bool) -> TextIO:
    flags = os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    flags |= os.O_TRUNC if overwrite else os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    try:
        os.chmod(path, 0o600)
        return os.fdopen(descriptor, "w", encoding="utf-8")
    except Exception:
        os.close(descriptor)
        raise


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="candidate image tag or digest")
    parser.add_argument("--suite", required=True, type=Path)
    parser.add_argument("--trials", type=_trial_count)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--environment", default=os.environ.get("ENVIRONMENT", "dev"))
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    parser.add_argument("--app-base-url")
    parser.add_argument("--platform", default="linux/arm64")
    parser.add_argument("--boot-timeout", type=_positive_integer, default=120)
    parser.add_argument("--invocation-timeout", type=_positive_integer, default=900)
    parser.add_argument("--poll-interval", type=_positive_float, default=2.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        tasks = load_suite(args.suite.resolve())
        executor = CommandExecutor()
        repo_root = Path(__file__).resolve().parents[3]
        app_base_url = _resolve_app_base_url(
            executor,
            args.environment,
            args.region,
            args.app_base_url,
        )
        environment_values = {
            "ENVIRONMENT": args.environment,
            "AWS_REGION": args.region,
            "APP_BASE_URL": app_base_url,
            "BUILD_MARKER": f"eval:{args.image}",
        }
        credential_provider = ActiveAwsCredentialProvider(executor)
        name_token = re.sub(
            r"[^a-z0-9-]",
            "-",
            f"issue-1424-{os.getpid()}".lower(),
        )
        runtime_factory = DockerRuntimeFactory(
            executor,
            args.image,
            args.platform,
            environment_values,
            credential_provider,
            boot_timeout_seconds=args.boot_timeout,
            invocation_timeout_seconds=args.invocation_timeout,
            poll_interval_seconds=args.poll_interval,
            name_prefix=f"psd-agent-eval-{name_token}",
            broker_stub_path=repo_root
            / "infra"
            / "agent-image"
            / "eval"
            / "broker_stub.py",
        )
        minter = ProbeContextMinter(
            executor,
            repo_root,
            args.environment,
            args.region,
            credential_provider=credential_provider,
            ttl_seconds=_context_ttl_seconds(args.invocation_timeout),
            minimum_remaining_seconds=(
                args.invocation_timeout
                + INVOCATION_AUTHORITY_EXPIRY_MARGIN_SECONDS
            ),
        )
        runner = EvaluationRunner(runtime_factory, minter, image=args.image)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with _open_output(args.out, args.overwrite) as output:
            records = runner.run(tasks, output, trials_override=args.trials)
        graded_records = [
            record
            for record in records
            if isinstance(record.get("grade"), Mapping)
            and isinstance(record["grade"].get("passed"), bool)
        ]
        for summary in aggregate_pass_k(graded_records):
            LOGGER.info(
                "task %s pass^%s=%s (%s/%s trials)",
                summary["task_id"],
                summary["trials"],
                summary["pass^k"],
                summary["passed_trials"],
                summary["trials"],
            )
        LOGGER.info("wrote %d trial records to %s", len(records), args.out)
        return 0
    except (EvalRunnerError, OSError) as error:
        LOGGER.error("%s", error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
