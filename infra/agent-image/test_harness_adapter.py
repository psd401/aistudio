"""Tests for the per-container gateway token (REV-INFRA-005).

The adapter used to hardcode `GATEWAY_TOKEN = "psd-agent-internal-gateway-token"`
in source (readable by the sandboxed `node` agent, and committed to the repo).
It now generates a random token in `__init__` and reuses it for both the
`openclaw gateway --token` launcher and its own connect envelope, so launcher and
client always agree without any static secret.

Run:
    uv run --python 3.12 --no-project python3 -m unittest infra/agent-image/test_harness_adapter.py

harness_adapter only imports stdlib + two local pure-Python modules
(agent_failures, chat_format), so no dependency stubbing is required.
Instantiating OpenClawAdapter runs no subprocess/network — __init__ only sets
plain attributes.
"""

import os
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import harness_adapter  # noqa: E402

OLD_LITERAL = "psd-agent-internal-gateway-token"


class GatewayTokenTests(unittest.TestCase):
    def test_token_generated_and_nonempty(self):
        a = harness_adapter.OpenClawAdapter()
        # secrets.token_urlsafe(32) yields ~43 url-safe chars; assert it is a
        # substantial random string, not a short/blank placeholder.
        self.assertIsInstance(a._gateway_token, str)
        self.assertGreaterEqual(len(a._gateway_token), 32)
        self.assertNotIn(a._gateway_token, ("", OLD_LITERAL))

    def test_token_is_per_instance_random(self):
        a = harness_adapter.OpenClawAdapter()
        b = harness_adapter.OpenClawAdapter()
        self.assertNotEqual(a._gateway_token, b._gateway_token)

    def test_no_hardcoded_class_constant(self):
        # The old committed literal must not survive as a class attribute.
        self.assertFalse(hasattr(harness_adapter.OpenClawAdapter, "GATEWAY_TOKEN"))

    def test_literal_absent_from_source(self):
        src = pathlib.Path(harness_adapter.__file__).read_text(encoding="utf-8")
        self.assertNotIn(OLD_LITERAL, src)

    def test_configure_passes_runtime_token_to_gateway_cli(self):
        # Behavioral check: the value handed to `openclaw gateway --token` is
        # exactly this instance's generated token — the same attribute the
        # connect envelope reads (harness_adapter.py: `gateway_token =
        # self._gateway_token`), so launcher and client cannot diverge.
        a = harness_adapter.OpenClawAdapter()
        with mock.patch.object(harness_adapter.subprocess, "Popen") as popen, \
                mock.patch.object(harness_adapter.OpenClawAdapter, "_wait_for_ready"), \
                mock.patch.object(harness_adapter.time, "sleep"):
            a.configure({"gateway_port": 3100})

        popen.assert_called_once()
        argv = popen.call_args[0][0]
        self.assertIn("--token", argv)
        token_value = argv[argv.index("--token") + 1]
        self.assertEqual(token_value, a._gateway_token)
        self.assertNotEqual(token_value, OLD_LITERAL)


if __name__ == "__main__":
    unittest.main()
