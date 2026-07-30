"""Hermetic tests for the issue #1424 in-container broker stub.

Run:
    uv run --python 3.12 --no-project -m unittest \
      infra/agent-image/test_broker_stub.py
"""

from __future__ import annotations

import ast
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock


AGENT_IMAGE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(AGENT_IMAGE_DIR / "eval"))

import broker_stub  # noqa: E402


def _python_allowlist(path: Path, variable: str) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(
            isinstance(target, ast.Name) and target.id == variable
            for target in node.targets
        ):
            continue
        value = node.value
        if (
            isinstance(value, ast.Call)
            and isinstance(value.func, ast.Name)
            and value.func.id == "frozenset"
            and len(value.args) == 1
        ):
            return set(ast.literal_eval(value.args[0]))
    raise AssertionError(f"{variable} was not found in {path}")


def _python_literal(path: Path, variable: str) -> object:
    """Read a literal assignment, including nested ``frozenset`` calls."""

    def resolve(node: ast.AST) -> object:
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "frozenset"
            and len(node.args) == 1
            and not node.keywords
        ):
            return frozenset(resolve(node.args[0]))
        if isinstance(node, ast.Dict):
            return {
                resolve(key): resolve(value)
                for key, value in zip(node.keys, node.values, strict=True)
            }
        if isinstance(node, ast.Tuple):
            return tuple(resolve(element) for element in node.elts)
        if isinstance(node, ast.Set):
            return {resolve(element) for element in node.elts}
        return ast.literal_eval(node)

    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if any(
            isinstance(target, ast.Name) and target.id == variable
            for target in node.targets
        ):
            return resolve(node.value)
    raise AssertionError(f"{variable} was not found in {path}")


def _javascript_allowlist(path: Path) -> set[str]:
    source = path.read_text(encoding="utf-8")
    match = re.search(
        r"const ALLOWED_ROUTES = new Set\(\[(.*?)\]\);",
        source,
        flags=re.DOTALL,
    )
    if match is None:
        raise AssertionError(f"ALLOWED_ROUTES was not found in {path}")
    return set(re.findall(r"'(/api/agent/[^']+)'", match.group(1)))


class RunningStub:
    def __init__(
        self,
        *,
        model_upstream_base_url: str = "http://127.0.0.1:9",
        candidate_mantle_environment: dict[str, str] | None = None,
    ) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory(
            prefix="issue-1424-broker-test-"
        )
        self.control_directory = Path(self.temporary_directory.name)
        self.flush_token = "f" * 43
        self.flush_token_path = self.control_directory / "workspace-flush-token"
        self.flush_token_path.write_text(self.flush_token, encoding="ascii")
        os.chmod(self.flush_token_path, 0o600)
        self.invocation_context = "signed-invocation-context"
        self.invocation_context_path = (
            self.control_directory / "invocation-context"
        )
        self.invocation_context_path.write_text(
            self.invocation_context,
            encoding="ascii",
        )
        self.request_proof_key = b"r" * 32
        encoded_proof_key = base64.urlsafe_b64encode(
            self.request_proof_key
        ).rstrip(b"=")
        self.request_proof_key_path = (
            self.control_directory / "request-proof-key"
        )
        self.request_proof_key_path.write_bytes(encoded_proof_key)
        create_arguments = {
            "port": 0,
            "workspace_flush_token_path": self.flush_token_path,
            "invocation_context_path": self.invocation_context_path,
            "request_proof_key_path": self.request_proof_key_path,
            "model_upstream_base_url": model_upstream_base_url,
        }
        if candidate_mantle_environment is None:
            self.server = broker_stub.create_server(
                self.control_directory,
                **create_arguments,
            )
        else:
            with mock.patch.multiple(
                broker_stub,
                **candidate_mantle_environment,
            ):
                self.server = broker_stub.create_server(
                    self.control_directory,
                    **create_arguments,
                )
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            daemon=True,
        )
        self.thread.start()

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def configure(self, fixtures: list[dict[str, object]]) -> None:
        serialized = json.dumps(
            {
                "task_id": "stub-test",
                "trial_id": "stub-test:1:session",
                "fixtures": fixtures,
            }
        ).encode("utf-8")
        if self.server.state.finalization_state == "closed":
            broker_stub.install_and_activate_trial(
                self.control_directory,
                serialized,
                port=self.server.server_address[1],
            )
            return
        broker_stub.install_trial_configuration(
            self.control_directory,
            serialized,
        )

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: object | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, object]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request_headers = {"Content-Type": "application/json"}
        request_headers.update(headers or {})
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers=request_headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def captures(self) -> list[dict[str, object]]:
        capture = self.control_directory / broker_stub.CAPTURE_FILENAME
        if not capture.exists():
            return []
        return [
            json.loads(line)
            for line in capture.read_text(encoding="utf-8").splitlines()
            if line
        ]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary_directory.cleanup()


class BrokerRouteParityTests(unittest.TestCase):
    def test_stub_matches_both_production_allowlists_exactly(self):
        javascript_routes = _javascript_allowlist(
            AGENT_IMAGE_DIR / "skills" / "_shared" / "agent-broker.js"
        )
        proxy_routes = _python_allowlist(
            AGENT_IMAGE_DIR / "mantle_proxy.py",
            "ALLOWED_AGENT_BROKER_ROUTES",
        )

        self.assertEqual(len(javascript_routes), 16)
        self.assertEqual(proxy_routes, javascript_routes)
        self.assertEqual(
            broker_stub.ALLOWED_AGENT_BROKER_ROUTES,
            javascript_routes,
        )

    def test_stub_matches_the_production_candidate_mantle_contract(self):
        proxy_path = AGENT_IMAGE_DIR / "mantle_proxy.py"

        self.assertEqual(
            broker_stub.CANDIDATE_MANTLE_PREFIX,
            _python_literal(proxy_path, "CANDIDATE_MANTLE_PREFIX"),
        )
        self.assertEqual(
            broker_stub.CANDIDATE_MANTLE_OPERATIONS,
            _python_literal(proxy_path, "CANDIDATE_MANTLE_OPERATIONS"),
        )


class BrokerControlStorageTests(unittest.TestCase):
    def test_runner_control_token_survives_a_proxy_restart(self):
        with tempfile.TemporaryDirectory(
            prefix="issue-1424-control-test-"
        ) as directory:
            control_directory = Path(directory)
            first = broker_stub._ensure_runner_control_token(
                control_directory
            )
            second = broker_stub._ensure_runner_control_token(
                control_directory
            )

            self.assertEqual(first, second)
            self.assertEqual(len(first), 43)
            self.assertEqual(
                (
                    control_directory
                    / broker_stub.RUNNER_CONTROL_TOKEN_FILENAME
                ).stat().st_mode
                & 0o777,
                0o600,
            )

    def test_runner_commands_install_and_collect_owner_only_state(self):
        with tempfile.TemporaryDirectory(
            prefix="issue-1424-control-test-"
        ) as directory:
            control_directory = Path(directory) / "control"
            serialized = json.dumps(
                {
                    "task_id": "control-test",
                    "trial_id": "control-test:1:session",
                    "fixtures": [],
                }
            ).encode("utf-8")

            broker_stub.install_trial_configuration(
                control_directory,
                serialized,
            )
            trial_path = (
                control_directory / broker_stub.TRIAL_CONFIG_FILENAME
            )
            capture_path = control_directory / broker_stub.CAPTURE_FILENAME
            self.assertEqual(
                control_directory.stat().st_mode & 0o777,
                0o700,
            )
            self.assertEqual(trial_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(capture_path.stat().st_mode & 0o777, 0o600)
            capture_path.write_bytes(b'{"route":"/api/agent/skills"}\n')

            captured = broker_stub.collect_trial_captures(control_directory)

            self.assertEqual(
                captured,
                b'{"route":"/api/agent/skills"}\n',
            )
            self.assertFalse(trial_path.exists())

    def test_runner_write_rejects_non_object_configuration(self):
        with tempfile.TemporaryDirectory(
            prefix="issue-1424-control-test-"
        ) as directory:
            with self.assertRaisesRegex(
                broker_stub.BrokerStubConfigurationError,
                "must be an object",
            ):
                broker_stub.install_trial_configuration(
                    Path(directory),
                    b"[]",
                )


class CandidateMantleRelayTests(unittest.TestCase):
    def _environment(self) -> dict[str, str]:
        return {
            "CANDIDATE_MANTLE_API": "openai-completions",
            "CANDIDATE_MANTLE_BASE_URL": (
                "https://bedrock-mantle.us-east-1.api.aws/v1"
            ),
            "CANDIDATE_MANTLE_BEARER_TOKEN": "root-only-token",
            "CANDIDATE_MANTLE_MODEL_ID": "openai.gpt-oss-120b",
        }

    def test_configuration_rejects_a_lookalike_mantle_origin(self):
        environment = {
            **self._environment(),
            "CANDIDATE_MANTLE_BASE_URL": (
                "https://bedrock-mantle.us-east-1.api.aws.attacker.test/v1"
            ),
        }
        with mock.patch.multiple(
            broker_stub,
            **environment,
        ), self.assertRaisesRegex(
            broker_stub.BrokerStubConfigurationError,
            "exact AWS endpoint",
        ):
            broker_stub._candidate_mantle_configuration()

    def test_openai_tool_shapes_relay_byte_for_byte_with_root_bearer(self):
        stub = RunningStub(
            candidate_mantle_environment=self._environment()
        )
        received: dict[str, object] = {}
        response_body = {
            "id": "chatcmpl-eval",
            "model": "openai.gpt-oss-120b",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Capability is granted.",
                    },
                    "finish_reason": "stop",
                }
            ],
        }

        class Response:
            status = 200
            headers = {"Content-Type": "application/json"}

            def read(self, limit: int) -> bytes:
                self.limit = limit
                return json.dumps(response_body).encode("utf-8")

            def close(self) -> None:
                return

        class Opener:
            def open(
                self,
                request: urllib.request.Request,
                timeout: int,
            ) -> Response:
                received["url"] = request.full_url
                received["body"] = request.data
                received["headers"] = {
                    key.lower(): value
                    for key, value in request.header_items()
                }
                received["timeout"] = timeout
                return Response()

        tool_request = {
            "model": "openai.gpt-oss-120b",
            "messages": [
                {"role": "user", "content": "Check capability"},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_123",
                            "type": "function",
                            "function": {
                                "name": "exec",
                                "arguments": "{\"command\":\"check\"}",
                            },
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_123",
                    "content": "{\"granted\":true}",
                },
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec",
                        "parameters": {"type": "object"},
                    },
                }
            ],
            "stream": True,
        }
        serialized_request = json.dumps(tool_request).encode("utf-8")
        try:
            stub.configure([])
            with mock.patch.object(
                broker_stub.urllib_request,
                "build_opener",
                return_value=Opener(),
            ):
                status, response = stub.request(
                    "/candidate-mantle/chat/completions",
                    method="POST",
                    body=tool_request,
                    headers={"Authorization": "Bearer model-supplied"},
                )
        finally:
            stub.close()

        self.assertEqual(status, 200)
        self.assertEqual(response, response_body)
        self.assertEqual(
            received["url"],
            (
                "https://bedrock-mantle.us-east-1.api.aws/v1"
                "/chat/completions"
            ),
        )
        self.assertEqual(
            json.loads(received["body"]),
            json.loads(serialized_request),
        )
        self.assertEqual(
            received["headers"]["authorization"],
            "Bearer root-only-token",
        )
        self.assertEqual(received["timeout"], 300)
        self.assertEqual(stub.captures(), [])

    def test_candidate_relay_rejects_the_wrong_model_without_upstream_call(self):
        stub = RunningStub(
            candidate_mantle_environment=self._environment()
        )
        try:
            stub.configure([])
            with mock.patch.object(
                broker_stub.urllib_request,
                "build_opener",
            ) as build_opener:
                status, response = stub.request(
                    "/candidate-mantle/chat/completions",
                    method="POST",
                    body={"model": "attacker-model", "messages": []},
                )
        finally:
            stub.close()

        self.assertEqual(status, 404)
        self.assertEqual(
            response["error"],
            "EvalUnsupportedCandidateModelOperation",
        )
        build_opener.assert_not_called()

    def test_paid_candidate_inference_requires_turn_authority(self):
        stub = RunningStub(
            candidate_mantle_environment=self._environment()
        )
        try:
            stub.configure([])
            stub.invocation_context_path.unlink()
            status, response = stub.request(
                "/candidate-mantle/chat/completions",
                method="POST",
                body={
                    "model": "openai.gpt-oss-120b",
                    "messages": [],
                },
            )
        finally:
            stub.close()

        self.assertEqual(status, 503)
        self.assertEqual(
            response,
            {"error": "Invocation authority is unavailable"},
        )


class BrokerStubHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stub = RunningStub()

    def tearDown(self) -> None:
        self.stub.close()

    def test_runner_gate_rejects_an_untrusted_transition(self):
        status, response = self.stub.request(
            broker_stub.RUNNER_OPEN_TRIAL_PATH,
            method="POST",
            headers={broker_stub.RUNNER_CONTROL_HEADER: "not-the-token"},
        )

        self.assertEqual(status, 404)
        self.assertEqual(response, {"error": "NotFound"})
        self.assertEqual(
            self.stub.server.state.finalization_state,
            "closed",
        )
        self.assertEqual(
            (
                self.stub.control_directory
                / broker_stub.RUNNER_CONTROL_TOKEN_FILENAME
            ).stat().st_mode
            & 0o777,
            0o600,
        )

    def test_replays_every_allowlisted_route_and_captures_each_request(self):
        fixtures = [
            {
                "route": route,
                "method": "POST",
                "response": {
                    "status": 200,
                    "body": {"fixture": route},
                },
            }
            for route in sorted(broker_stub.ALLOWED_AGENT_BROKER_ROUTES)
        ]
        self.stub.configure(fixtures)

        for route in sorted(broker_stub.ALLOWED_AGENT_BROKER_ROUTES):
            status, response = self.stub.request(
                f"/agent-broker{route}",
                method="POST",
                body={"route": route},
            )
            self.assertEqual(status, 200)
            self.assertEqual(response, {"fixture": route})

        captures = self.stub.captures()
        self.assertEqual(len(captures), 16)
        self.assertEqual(
            {capture["route"] for capture in captures},
            broker_stub.ALLOWED_AGENT_BROKER_ROUTES,
        )

    def test_fixture_response_and_complete_request_capture(self):
        self.stub.configure(
            [
                {
                    "route": "/api/agent/directory-lookup",
                    "method": "POST",
                    "request_body": {"query": "Ada"},
                    "response": {
                        "status": 201,
                        "body": {"people": [{"name": "Ada Lovelace"}]},
                    },
                }
            ]
        )

        status, response = self.stub.request(
            "/agent-broker/api/agent/directory-lookup",
            method="POST",
            body={"query": "Ada", "limit": 5},
        )

        self.assertEqual(status, 201)
        self.assertEqual(response["people"][0]["name"], "Ada Lovelace")
        capture = self.stub.captures()[0]
        self.assertEqual(capture["route"], "/api/agent/directory-lookup")
        self.assertEqual(capture["method"], "POST")
        self.assertEqual(capture["body"], {"query": "Ada", "limit": 5})
        self.assertEqual(
            capture["headers"]["content-type"],
            "application/json",
        )
        self.assertIsNone(capture["stub_error"])
        mode = os.stat(
            self.stub.control_directory / broker_stub.CAPTURE_FILENAME
        ).st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_fixture_selector_matches_indexed_argv_and_decoded_json_subsets(self):
        self.stub.configure(
            [
                {
                    "route": "/api/agent/workspace-execute",
                    "method": "POST",
                    "request_body": {
                        "scope": "user",
                        "note": {"$text_equals": "body text"},
                        "argv": {
                            "$matches_any": [
                                {
                                    "0": "calendar",
                                    "1": "events",
                                    "2": "insert",
                                    "3": "--params",
                                    "4": {"calendarId": "primary"},
                                    "5": "--json",
                                    "6": {
                                        "summary": "Library projector check",
                                        "start": {
                                            "dateTime": (
                                                "2026-08-03T09:00:00-07:00"
                                            )
                                        },
                                    },
                                },
                                {"0": "calendar", "1": "+insert"},
                            ]
                        },
                    },
                    "response": {"body": {"created": True}},
                }
            ]
        )
        correct_argv = [
            "calendar",
            "events",
            "insert",
            "--params",
            '{"calendarId":"primary","conferenceDataVersion":1}',
            "--json",
            (
                '{"summary":"Library projector check",'
                '"start":{"dateTime":"2026-08-03T09:00:00-07:00"},'
                '"description":"injected marker"}'
            ),
        ]

        status, response = self.stub.request(
            "/agent-broker/api/agent/workspace-execute",
            method="POST",
            body={"scope": "user", "note": "body text\n", "argv": correct_argv},
        )
        self.assertEqual((status, response), (200, {"created": True}))

        wrong_argv = list(correct_argv)
        wrong_argv[6] = (
            '{"summary":"Wrong title",'
            '"start":{"dateTime":"2026-08-03T09:00:00-07:00"}}'
        )
        status, response = self.stub.request(
            "/agent-broker/api/agent/workspace-execute",
            method="POST",
            body={"scope": "user", "note": "body text\n", "argv": wrong_argv},
        )
        self.assertEqual(status, 501)
        self.assertEqual(response["error"], broker_stub.MISSING_FIXTURE_ERROR)

    def test_summarization_endpoint_relays_with_root_authority(self):
        received: dict[str, object] = {}

        class ModelBrokerHandler(BaseHTTPRequestHandler):
            def log_message(
                self,
                format_string: str,
                *arguments: object,
            ) -> None:
                return

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(length)
                received.update(
                    {
                        "path": self.path,
                        "body": raw_body,
                        "headers": dict(self.headers.items()),
                    }
                )
                response = json.dumps(
                    {
                        "content": [
                            {"type": "text", "text": "Safe summary"}
                        ]
                    }
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), ModelBrokerHandler)
        upstream_thread = threading.Thread(
            target=upstream.serve_forever,
            daemon=True,
        )
        upstream_thread.start()
        self.stub.close()
        self.stub = RunningStub(
            model_upstream_base_url=(
                f"http://127.0.0.1:{upstream.server_address[1]}"
            )
        )
        try:
            self.stub.configure([])
            status, response = self.stub.request(
                broker_stub.MODEL_MESSAGES_PATH,
                method="POST",
                body={
                    "model": "anthropic.claude-haiku-4-5",
                    "messages": [{"role": "user", "content": "Summarize"}],
                },
            )
        finally:
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=2)

        self.assertEqual(status, 200)
        self.assertEqual(
            response,
            {
                "content": [
                    {"type": "text", "text": "Safe summary"}
                ]
            },
        )
        self.assertEqual(received["path"], broker_stub.MODEL_PROXY_ROUTE)
        raw_body = received["body"]
        self.assertIsInstance(raw_body, bytes)
        headers = {
            key.lower(): value
            for key, value in received["headers"].items()
        }
        self.assertEqual(
            headers["x-agent-invocation-context"],
            self.stub.invocation_context,
        )
        self.assertEqual(
            headers["x-agent-request-proof-body-sha256"],
            hashlib.sha256(raw_body).hexdigest(),
        )
        canonical = "\n".join(
            [
                "v1",
                headers["x-agent-request-proof-timestamp"],
                headers["x-agent-request-proof-nonce"],
                "POST",
                broker_stub.MODEL_PROXY_ROUTE,
                headers["x-agent-request-proof-body-sha256"],
            ]
        ).encode("utf-8")
        expected_signature = base64.urlsafe_b64encode(
            hmac.new(
                self.stub.request_proof_key,
                canonical,
                hashlib.sha256,
            ).digest()
        ).rstrip(b"=").decode("ascii")
        self.assertEqual(
            headers["x-agent-request-proof-signature"],
            expected_signature,
        )
        self.assertEqual(self.stub.captures(), [])

    def test_informational_fixture_status_is_rejected(self):
        self.stub.configure(
            [
                {
                    "route": "/api/agent/directory-lookup",
                    "response": {"status": 199, "body": {}},
                }
            ]
        )

        status, response = self.stub.request(
            "/agent-broker/api/agent/directory-lookup",
            method="POST",
            body={"query": "Ada"},
        )

        self.assertEqual(status, 500)
        self.assertIn("status", response["message"])

    def test_missing_fixture_is_loud_and_named_in_response_and_capture(self):
        self.stub.configure([])

        status, response = self.stub.request(
            "/agent-broker/api/agent/workspace-execute",
            method="POST",
            body={"operation": "calendar.events.create"},
        )

        self.assertEqual(status, 501)
        self.assertEqual(response["error"], broker_stub.MISSING_FIXTURE_ERROR)
        capture = self.stub.captures()[0]
        self.assertIn(
            broker_stub.MISSING_FIXTURE_ERROR,
            capture["stub_error"],
        )

    def test_unallowlisted_route_is_rejected_and_captured_loudly(self):
        self.stub.configure([])

        status, response = self.stub.request(
            "/agent-broker/api/agent/arbitrary-proxy",
            method="POST",
            body={"url": "https://example.com"},
        )

        self.assertEqual(status, 404)
        self.assertEqual(response["error"], "EvalUnsupportedAgentRoute")
        [capture] = self.stub.captures()
        self.assertEqual(capture["route"], "/api/agent/arbitrary-proxy")
        self.assertEqual(capture["body"], {"url": "https://example.com"})
        self.assertIn("EvalUnsupportedAgentRoute", capture["stub_error"])

    def test_non_post_method_is_rejected_even_when_a_fixture_would_match(self):
        self.stub.configure(
            [
                {
                    "route": "/api/agent/directory-lookup",
                    "method": "GET",
                    "response": {"body": {"people": []}},
                }
            ]
        )

        status, response = self.stub.request(
            "/agent-broker/api/agent/directory-lookup",
            method="GET",
        )

        self.assertEqual(status, 404)
        self.assertEqual(
            response["error"],
            broker_stub.UNSUPPORTED_METHOD_ERROR,
        )
        [capture] = self.stub.captures()
        self.assertIn(
            broker_stub.UNSUPPORTED_METHOD_ERROR,
            capture["stub_error"],
        )

    def test_standard_and_custom_http_methods_are_rejected_and_captured(self):
        for method in ("OPTIONS", "BREW"):
            with self.subTest(method=method):
                self.stub.configure([])

                status, response = self.stub.request(
                    "/agent-broker/api/agent/directory-lookup",
                    method=method,
                )

                self.assertEqual(status, 404)
                self.assertEqual(
                    response["error"],
                    broker_stub.UNSUPPORTED_METHOD_ERROR,
                )
                [capture] = self.stub.captures()
                self.assertEqual(capture["method"], method)
                self.assertIn(
                    broker_stub.UNSUPPORTED_METHOD_ERROR,
                    capture["stub_error"],
                )

    def test_non_object_json_bodies_are_rejected_and_captured(self):
        for body in ("not-an-object", ["Ada"]):
            with self.subTest(body=body):
                self.stub.configure(
                    [
                        {
                            "route": "/api/agent/directory-lookup",
                            "response": {"body": {"people": []}},
                        }
                    ]
                )
                status, response = self.stub.request(
                    "/agent-broker/api/agent/directory-lookup",
                    method="POST",
                    body=body,
                )

                self.assertEqual(status, 400)
                self.assertEqual(
                    response["error"],
                    broker_stub.INVALID_REQUEST_BODY_ERROR,
                )
                [capture] = self.stub.captures()
                self.assertEqual(capture["body"], body)
                self.assertIn(
                    broker_stub.INVALID_REQUEST_BODY_ERROR,
                    capture["stub_error"],
                )

    def test_unavailable_trial_config_preserves_the_request_body_in_capture(self):
        self.stub.configure([])
        (
            self.stub.control_directory / broker_stub.TRIAL_CONFIG_FILENAME
        ).unlink()

        status, response = self.stub.request(
            "/agent-broker/api/agent/directory-lookup",
            method="POST",
            body={"query": "Ada"},
        )

        self.assertEqual(status, 500)
        self.assertEqual(response["error"], broker_stub.MISSING_FIXTURE_ERROR)
        [capture] = self.stub.captures()
        self.assertEqual(capture["body"], {"query": "Ada"})
        self.assertIn(
            broker_stub.MISSING_FIXTURE_ERROR,
            capture["stub_error"],
        )

    def test_wrapper_control_endpoints_remain_healthy(self):
        self.stub.configure([])

        health_status, health = self.stub.request("/health")
        usage_status, usage = self.stub.request("/usage")
        begin_status, begin = self.stub.request(
            "/internal/finalization/begin",
            method="POST",
            headers={"X-Agent-Workspace-Flush": self.stub.flush_token},
        )
        end_status, end = self.stub.request(
            "/internal/finalization/end",
            method="POST",
            headers={"X-Agent-Workspace-Flush": self.stub.flush_token},
        )

        self.assertEqual(health_status, 200)
        self.assertEqual(health, {"ok": True, "mode": "eval-stub"})
        self.assertEqual(usage_status, 200)
        self.assertEqual(usage["usage_events"], 0)
        self.assertEqual((begin_status, begin), (200, {"finalizing": True}))
        self.assertEqual((end_status, end), (200, {"finalizing": False}))

    def test_finalization_drains_in_flight_request_and_rejects_new_work(self):
        self.stub.configure(
            [
                {
                    "route": "/api/agent/directory-lookup",
                    "response": {"body": {"people": []}},
                },
                {
                    "route": "/api/agent/workspace-storage",
                    "request_body": {"operation": "upload"},
                    "response": {"body": {"stored": True}},
                }
            ]
        )
        entered_fixture = threading.Event()
        release_fixture = threading.Event()
        original_find_fixture = self.stub.server.state.find_fixture

        def blocking_find_fixture(*args, **kwargs):
            entered_fixture.set()
            if not release_fixture.wait(timeout=2):
                raise AssertionError("test did not release the in-flight request")
            return original_find_fixture(*args, **kwargs)

        self.stub.server.state.find_fixture = blocking_find_fixture
        results: dict[str, tuple[int, object]] = {}

        in_flight = threading.Thread(
            target=lambda: results.setdefault(
                "in_flight",
                self.stub.request(
                    "/agent-broker/api/agent/directory-lookup",
                    method="POST",
                    body={"query": "Ada"},
                ),
            ),
            daemon=True,
        )
        in_flight.start()
        self.assertTrue(entered_fixture.wait(timeout=1))

        begin = threading.Thread(
            target=lambda: results.setdefault(
                "begin",
                self.stub.request(
                    "/internal/finalization/begin",
                    method="POST",
                    headers={
                        "X-Agent-Workspace-Flush": self.stub.flush_token,
                    },
                ),
            ),
            daemon=True,
        )
        begin.start()
        deadline = time.monotonic() + 1
        while (
            self.stub.server.state.finalization_state != "draining"
            and time.monotonic() < deadline
        ):
            time.sleep(0.005)
        self.assertEqual(
            self.stub.server.state.finalization_state,
            "draining",
        )
        self.assertTrue(begin.is_alive())

        rejected_status, rejected = self.stub.request(
            "/agent-broker/api/agent/directory-lookup",
            method="POST",
            body={"query": "Grace"},
        )
        self.assertEqual(rejected_status, 503)
        self.assertEqual(rejected["error"], broker_stub.FINALIZING_ERROR)

        release_fixture.set()
        in_flight.join(timeout=1)
        begin.join(timeout=1)
        self.assertFalse(in_flight.is_alive())
        self.assertFalse(begin.is_alive())
        self.assertEqual(results["in_flight"][0], 200)
        self.assertEqual(results["begin"], (200, {"finalizing": True}))
        self.assertTrue(
            any(
                capture["body"] == {"query": "Ada"}
                for capture in self.stub.captures()
            )
        )

        rejected_status, rejected = self.stub.request(
            "/agent-broker/api/agent/directory-lookup",
            method="POST",
            body={"query": "Katherine"},
        )
        self.assertEqual(rejected_status, 503)
        self.assertEqual(rejected["error"], broker_stub.FINALIZING_ERROR)

        flush_status, flush = self.stub.request(
            "/agent-broker/api/agent/workspace-storage",
            method="POST",
            body={"operation": "upload"},
            headers={"X-Agent-Workspace-Flush": self.stub.flush_token},
        )
        self.assertEqual((flush_status, flush), (200, {"stored": True}))

        end_status, end = self.stub.request(
            "/internal/finalization/end",
            method="POST",
            headers={"X-Agent-Workspace-Flush": self.stub.flush_token},
        )
        self.assertEqual((end_status, end), (200, {"finalizing": False}))
        self.assertEqual(
            self.stub.server.state.finalization_state,
            "closed",
        )
        capture_count = len(self.stub.captures())

        late_status, late = self.stub.request(
            "/agent-broker/api/agent/directory-lookup",
            method="POST",
            body={"query": "Late"},
        )
        self.assertEqual(late_status, 503)
        self.assertEqual(late["error"], broker_stub.FINALIZING_ERROR)
        self.assertEqual(len(self.stub.captures()), capture_count)

        self.stub.configure(
            [
                {
                    "route": "/api/agent/directory-lookup",
                    "response": {"body": {"people": ["new-trial"]}},
                }
            ]
        )
        next_status, next_response = self.stub.request(
            "/agent-broker/api/agent/directory-lookup",
            method="POST",
            body={"query": "Next"},
        )
        self.assertEqual(next_status, 200)
        self.assertEqual(next_response, {"people": ["new-trial"]})


if __name__ == "__main__":
    unittest.main()
