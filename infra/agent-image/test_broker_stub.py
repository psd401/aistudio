"""Hermetic tests for the issue #1424 in-container broker stub.

Run:
    uv run --python 3.12 --no-project -m unittest \
      infra/agent-image/test_broker_stub.py
"""

from __future__ import annotations

import ast
import json
import os
import re
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path


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
    def __init__(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory(
            prefix="issue-1424-broker-test-"
        )
        self.control_directory = Path(self.temporary_directory.name)
        self.server = broker_stub.create_server(
            self.control_directory,
            port=0,
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
        path = self.control_directory / broker_stub.TRIAL_CONFIG_FILENAME
        temporary = path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(
                {
                    "task_id": "stub-test",
                    "trial_id": "stub-test:1:session",
                    "fixtures": fixtures,
                }
            ),
            encoding="utf-8",
        )
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        capture = self.control_directory / broker_stub.CAPTURE_FILENAME
        capture.write_text("", encoding="utf-8")
        os.chmod(capture, 0o600)

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: object | None = None,
    ) -> tuple[int, object]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def captures(self) -> list[dict[str, object]]:
        capture = self.control_directory / broker_stub.CAPTURE_FILENAME
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


class BrokerStubHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stub = RunningStub()

    def tearDown(self) -> None:
        self.stub.close()

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
        )
        end_status, end = self.stub.request(
            "/internal/finalization/end",
            method="POST",
        )

        self.assertEqual(health_status, 200)
        self.assertEqual(health, {"ok": True, "mode": "eval-stub"})
        self.assertEqual(usage_status, 200)
        self.assertEqual(usage["usage_events"], 0)
        self.assertEqual((begin_status, begin), (200, {"finalizing": True}))
        self.assertEqual((end_status, end), (200, {"finalizing": False}))


if __name__ == "__main__":
    unittest.main()
