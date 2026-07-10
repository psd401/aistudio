"""Tests for iteration telemetry + boot verification (#1161).

Covers:
  - agentcore_wrapper._resolve_boot_model / verify_boot_and_emit_ok (BOOT_OK)
  - agentcore_wrapper.read_proxy_usage threads usage_events
  - harness_adapter.TurnResult.nudged
  - agent_failures.emit_agent_metric shape

Run:
    uv run --with pytest python3 -m pytest infra/agent-image/test_iteration_telemetry.py
"""

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

# Stub the Docker-only deps so agentcore_wrapper imports on a laptop (mirrors
# test_agentcore_wrapper.py). Idempotent: only stub what isn't already loaded,
# and remove our stubs after import so the real modules resolve for other tests.
_STUB_MODULES = ("harness_adapter", "workspace_sync", "bedrock_agentcore")
_stubbed_by_us = [_m for _m in _STUB_MODULES if _m not in sys.modules]
for _m in _stubbed_by_us:
    sys.modules[_m] = mock.MagicMock()
sys.path.insert(0, os.path.dirname(__file__))

import agentcore_wrapper  # noqa: E402

for _m in _stubbed_by_us:
    del sys.modules[_m]


def _config(providers, primary, defaults_extra=None) -> dict:
    defaults = {"model": {"primary": primary}}
    if defaults_extra:
        defaults.update(defaults_extra)
    return {
        "models": {"providers": providers},
        "agents": {"defaults": defaults},
    }


_GOOD_PROVIDERS = {
    "amazon-bedrock-mantle": {
        "apiKey": "sk-hydrated-literal-token",
        "models": [{"id": "anthropic.claude-sonnet-5"}],
    }
}
_GOOD_PRIMARY = "amazon-bedrock-mantle/anthropic.claude-sonnet-5"


class ResolveBootModelTests(unittest.TestCase):
    def _run(self, config: dict):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "openclaw.json")
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(config, fh)
        with mock.patch.object(agentcore_wrapper, "OPENCLAW_CONFIG_PATH", p):
            return agentcore_wrapper._resolve_boot_model()

    def test_resolves_valid_config(self):
        ok, provider, model = self._run(_config(_GOOD_PROVIDERS, _GOOD_PRIMARY))
        self.assertTrue(ok)
        self.assertEqual(provider, "amazon-bedrock-mantle")
        self.assertEqual(model, "anthropic.claude-sonnet-5")

    def test_unregistered_provider_fails(self):
        ok, _, _ = self._run(_config({}, _GOOD_PRIMARY))
        self.assertFalse(ok)

    def test_undeclared_model_fails(self):
        providers = {"amazon-bedrock-mantle": {"apiKey": "sk-x", "models": [{"id": "other"}]}}
        ok, _, _ = self._run(_config(providers, _GOOD_PRIMARY))
        self.assertFalse(ok)

    def test_unhydrated_apikey_placeholder_fails(self):
        providers = {
            "amazon-bedrock-mantle": {
                "apiKey": "env:AWS_BEARER_TOKEN_BEDROCK",
                "models": [{"id": "anthropic.claude-sonnet-5"}],
            }
        }
        ok, _, _ = self._run(_config(providers, _GOOD_PRIMARY))
        self.assertFalse(ok)

    def test_native_provider_without_apikey_ok(self):
        providers = {"amazon-bedrock": {"models": [{"id": "anthropic.claude-sonnet-5"}]}}
        ok, provider, _ = self._run(
            _config(providers, "amazon-bedrock/anthropic.claude-sonnet-5"))
        self.assertTrue(ok)

    def test_malformed_primary_fails(self):
        ok, _, _ = self._run(_config(_GOOD_PROVIDERS, "no-slash-here"))
        self.assertFalse(ok)

    def test_missing_config_file_fails(self):
        with mock.patch.object(
            agentcore_wrapper, "OPENCLAW_CONFIG_PATH", "/nonexistent/openclaw.json"):
            ok, _, _ = agentcore_wrapper._resolve_boot_model()
        self.assertFalse(ok)


class VerifyBootAndEmitOkTests(unittest.TestCase):
    def _run(self, config: dict, runtime_files=None):
        d = tempfile.mkdtemp()
        cfg = os.path.join(d, "openclaw.json")
        with open(cfg, "w", encoding="utf-8") as fh:
            json.dump(config, fh)
        for name, text in (runtime_files or {}).items():
            with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
                fh.write(text)
        with mock.patch.object(agentcore_wrapper, "OPENCLAW_CONFIG_PATH", cfg), \
             mock.patch.object(agentcore_wrapper, "OPENCLAW_WORKSPACE_DIR", d), \
             mock.patch.object(agentcore_wrapper, "emit_agent_metric") as emit:
            result = agentcore_wrapper.verify_boot_and_emit_ok()
        return result, emit

    def test_emits_boot_ok_on_success(self):
        result, emit = self._run(_config(_GOOD_PROVIDERS, _GOOD_PRIMARY))
        self.assertTrue(result)
        emit.assert_any_call("BootOk")

    def test_withholds_boot_ok_on_resolution_failure(self):
        result, emit = self._run(_config({}, _GOOD_PRIMARY))
        self.assertFalse(result)
        # BootOk must NOT be emitted when resolution fails (dead-boot signature).
        self.assertNotIn(mock.call("BootOk"), emit.call_args_list)

    def test_emits_truncation_metric_when_over_budget(self):
        cfg = _config(
            _GOOD_PROVIDERS, _GOOD_PRIMARY,
            defaults_extra={"bootstrapMaxChars": 3, "bootstrapTotalMaxChars": 100},
        )
        result, emit = self._run(cfg, runtime_files={"SOUL.md": "way too long"})
        self.assertTrue(result)  # resolution still succeeds
        emit.assert_any_call("BootTruncationWarn")


class ReadProxyUsageTests(unittest.TestCase):
    def test_usage_events_threaded_from_proxy(self):
        payload = json.dumps({
            "input_tokens": 10, "output_tokens": 5,
            "cache_read_input_tokens": 2, "cache_write_input_tokens": 1,
            "usage_events": 4, "model": "claude-sonnet-5",
        }).encode("utf-8")

        class _Resp:
            status = 200
            def read(self):
                return payload
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False

        with mock.patch("urllib.request.urlopen", return_value=_Resp()):
            usage = agentcore_wrapper.read_proxy_usage()
        self.assertTrue(usage["ok"])
        self.assertEqual(usage["usage_events"], 4)

    def test_usage_events_defaults_zero_on_read_failure(self):
        with mock.patch("urllib.request.urlopen", side_effect=OSError("boom")):
            usage = agentcore_wrapper.read_proxy_usage()
        self.assertFalse(usage["ok"])
        self.assertEqual(usage["usage_events"], 0)


class TurnResultNudgedTests(unittest.TestCase):
    def test_turnresult_has_nudged_default_false(self):
        # Import the REAL harness_adapter (stubs already removed above).
        from harness_adapter import TurnResult
        self.assertFalse(TurnResult(text="hi").nudged)
        self.assertTrue(TurnResult(text="hi", nudged=True).nudged)


class EmitAgentMetricTests(unittest.TestCase):
    def test_put_metric_data_shape(self):
        from agent_failures import emit_agent_metric
        fake_client = mock.MagicMock()
        with mock.patch("agent_failures._get_cloudwatch_client", return_value=fake_client):
            emit_agent_metric("BootOk")
            emit_agent_metric("AgentFailuresHarness", dimensions={"Source": "harness"})
        # First call: no dimensions; second: one Source dimension.
        first = fake_client.put_metric_data.call_args_list[0].kwargs
        self.assertEqual(first["MetricData"][0]["MetricName"], "BootOk")
        self.assertNotIn("Dimensions", first["MetricData"][0])
        second = fake_client.put_metric_data.call_args_list[1].kwargs
        self.assertEqual(second["MetricData"][0]["Dimensions"],
                         [{"Name": "Source", "Value": "harness"}])

    def test_never_raises_without_client(self):
        from agent_failures import emit_agent_metric
        with mock.patch("agent_failures._get_cloudwatch_client", return_value=None):
            emit_agent_metric("BootOk")  # must not raise


if __name__ == "__main__":
    unittest.main()
