"""Tests for mantle_proxy request-body logging redaction/gating (REV-INFRA-001).

Run: python3 -m unittest infra/agent-image/test_mantle_proxy.py

aiohttp is only installed in the agent Docker image, so we stub it in
sys.modules before importing the module under test.
"""

import io
import json
import logging
import os
import sys
import unittest
from unittest import mock

sys.modules.setdefault("aiohttp", mock.MagicMock())
sys.path.insert(0, os.path.dirname(__file__))

import mantle_proxy  # noqa: E402

SECRET = "sk-super-secret-value-123"


class RedactionHelperTests(unittest.TestCase):
    def test_redacts_tool_and_system_content_keeps_user(self):
        parsed = {
            "messages": [
                {"role": "user", "content": "please fetch my key"},
                {"role": "tool", "content": SECRET},
                {"role": "system", "content": "system-prompt-text"},
            ]
        }
        out = mantle_proxy._redact_messages_for_log(parsed)
        dumped = json.dumps(out)
        self.assertNotIn(SECRET, dumped)
        self.assertNotIn("system-prompt-text", dumped)
        self.assertIn("please fetch my key", dumped)  # non-sensitive role preserved

    def test_returns_none_when_not_a_chat_body(self):
        self.assertIsNone(mantle_proxy._redact_messages_for_log("not-a-dict"))
        self.assertIsNone(mantle_proxy._redact_messages_for_log({"no": "messages"}))


class LoggingGateTests(unittest.TestCase):
    def _run_and_capture(self, body):
        buf = io.StringIO()
        handler = logging.StreamHandler(buf)
        mantle_proxy.log.addHandler(handler)
        try:
            mantle_proxy._log_request_body("rid-1", body, json.loads(body))
        finally:
            mantle_proxy.log.removeHandler(handler)
        return buf.getvalue()

    def test_flag_defaults_off_when_env_unset(self):
        if "MANTLE_PROXY_LOG_BODIES" not in os.environ:
            self.assertFalse(mantle_proxy.LOG_BODIES)

    def test_default_off_emits_no_body_logs_and_no_secret(self):
        body = json.dumps({"messages": [{"role": "tool", "content": SECRET}]}).encode()
        with mock.patch.object(mantle_proxy, "LOG_BODIES", False):
            out = self._run_and_capture(body)
        self.assertEqual(out, "")
        self.assertNotIn(SECRET, out)

    def test_enabled_redacts_tool_content_but_keeps_shape(self):
        body = json.dumps(
            {"messages": [
                {"role": "tool", "content": SECRET},
                {"role": "user", "content": "hello there"},
            ]}
        ).encode()
        with mock.patch.object(mantle_proxy, "LOG_BODIES", True):
            out = self._run_and_capture(body)
        self.assertNotIn(SECRET, out)          # secret never logged
        self.assertIn("req_message", out)       # shape logging still happens
        self.assertIn("hello there", out)       # non-sensitive content still visible

    def test_safe_summary_helpers_unaffected(self):
        # req_summary / upstream_fetched / resp_done are count-only and not gated
        # by LOG_BODIES; sanity-check the j() formatter still produces them.
        self.assertIn("req_summary", mantle_proxy.j("req_summary", req_id="x", n=1))
        self.assertIn("resp_done", mantle_proxy.j("resp_done", req_id="x", status=200))


if __name__ == "__main__":
    unittest.main()
