"""Tests for check_config_consistency — the config self-consistency gate (#1161).

Run: uv run --with pytest python3 -m pytest infra/agent-image/test_check_config_consistency.py
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import check_config_consistency as ccc  # noqa: E402


class ContextWindowTests(unittest.TestCase):
    def test_known_model_matching_window_ok(self):
        cfg = {"models": {"providers": {"p": {"models": [
            {"id": "claude-sonnet-5", "contextWindow": 200000}]}}}}
        self.assertEqual(ccc.check_context_windows(cfg), [])

    def test_known_model_wrong_window_flagged(self):
        cfg = {"models": {"providers": {"p": {"models": [
            {"id": "claude-sonnet-5", "contextWindow": 20000}]}}}}
        v = ccc.check_context_windows(cfg)
        self.assertEqual(len(v), 1)
        self.assertIn("!= known value 200000", v[0])

    def test_unknown_model_out_of_band_flagged(self):
        cfg = {"models": {"providers": {"p": {"models": [
            {"id": "mystery", "contextWindow": 5_000_000}]}}}}
        self.assertTrue(ccc.check_context_windows(cfg))

    def test_unknown_model_in_band_ok(self):
        cfg = {"models": {"providers": {"p": {"models": [
            {"id": "mystery", "contextWindow": 128000}]}}}}
        self.assertEqual(ccc.check_context_windows(cfg), [])

    def test_missing_window_flagged(self):
        cfg = {"models": {"providers": {"p": {"models": [{"id": "x"}]}}}}
        self.assertTrue(ccc.check_context_windows(cfg))


class ApiKeyHydrationTests(unittest.TestCase):
    def _wrapper(self, text: str) -> str:
        d = tempfile.mkdtemp()
        p = os.path.join(d, "agentcore_wrapper.py")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(text)
        return p

    def test_hydrated_env_var_ok(self):
        cfg = {"models": {"providers": {"mantle": {"apiKey": "env:MY_TOKEN"}}}}
        wrapper = self._wrapper('os.environ["MY_TOKEN"] = value')
        self.assertEqual(ccc.check_apikey_hydration(cfg, wrapper), [])

    def test_unhydrated_env_var_flagged(self):
        cfg = {"models": {"providers": {"mantle": {"apiKey": "env:GHOST_TOKEN"}}}}
        wrapper = self._wrapper("nothing here sets it")
        v = ccc.check_apikey_hydration(cfg, wrapper)
        self.assertEqual(len(v), 1)
        self.assertIn("GHOST_TOKEN", v[0])

    def test_native_provider_without_apikey_skipped(self):
        cfg = {"models": {"providers": {"native": {"models": [{"id": "x"}]}}}}
        wrapper = self._wrapper("")
        self.assertEqual(ccc.check_apikey_hydration(cfg, wrapper), [])


class RealFilesTests(unittest.TestCase):
    def test_repo_config_is_consistent(self):
        here = os.path.dirname(os.path.abspath(__file__))
        rc = ccc.main(["--config", os.path.join(here, "openclaw.json"),
                       "--wrapper", os.path.join(here, "agentcore_wrapper.py")])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
