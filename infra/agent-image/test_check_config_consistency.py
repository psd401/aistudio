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


class VersionKeyTests(unittest.TestCase):
    """Prerelease-below-release ordering is load-bearing for the caching gate."""

    def test_prerelease_sorts_below_its_release(self):
        # The exact trap: plugin 2026.7.1 requires openclaw >= 2026.7.1, which
        # the 2026.7.1-beta.2 image does NOT satisfy.
        self.assertLess(ccc._version_key("2026.7.1-beta.2"),
                        ccc._version_key("2026.7.1"))

    def test_older_release_sorts_below_newer(self):
        self.assertLess(ccc._version_key("2026.6.11"), ccc._version_key("2026.7.1"))
        self.assertLess(ccc._version_key("2026.6.33"), ccc._version_key("2026.7.1"))

    def test_equal_versions_compare_equal(self):
        self.assertEqual(ccc._version_key("2026.7.1"), ccc._version_key("2026.7.1"))

    def test_later_prerelease_outranks_earlier_release(self):
        self.assertGreater(ccc._version_key("2026.7.2-beta.1"),
                           ccc._version_key("2026.7.1"))

    def test_prerelease_ordinals_compare_without_raising(self):
        # Mixed int/str prerelease tags must not blow up the comparison.
        self.assertLess(ccc._version_key("2026.7.1-beta.2"),
                        ccc._version_key("2026.7.1-beta.10"))


class PromptCachingReachabilityTests(unittest.TestCase):
    """The gate that would have caught silent caching loss from #1384 onward."""

    CONFIG = {
        "agents": {"defaults": {"params": {"cacheRetention": "long"}}},
        "models": {"providers": {"amazon-bedrock": {
            "models": [{"id": "us.anthropic.claude-sonnet-5"}]}}},
    }

    def _dockerfile(self, version: str) -> str:
        d = tempfile.mkdtemp()
        p = os.path.join(d, "Dockerfile")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(
                f"RUN npm pack @openclaw/amazon-bedrock-provider@{version} && \\\n"
                f"    tar -xzf openclaw-amazon-bedrock-provider-{version}.tgz && \\\n"
                f"    rm openclaw-amazon-bedrock-provider-{version}.tgz\n"
            )
        return p

    def test_capable_plugin_passes(self):
        self.assertEqual(
            ccc.check_prompt_caching_reachable(
                self.CONFIG, self._dockerfile("2026.7.1")),
            [],
        )

    def test_downgraded_plugin_flagged(self):
        # Reverting to 2026.6.11 silently disables caching for this model.
        v = ccc.check_prompt_caching_reachable(
            self.CONFIG, self._dockerfile("2026.6.11"))
        self.assertEqual(len(v), 1)
        self.assertIn(">= 2026.7.1", v[0])
        self.assertIn("2026.6.11", v[0])

    def test_prerelease_of_required_version_flagged(self):
        v = ccc.check_prompt_caching_reachable(
            self.CONFIG, self._dockerfile("2026.7.1-beta.2"))
        self.assertTrue(any(">= 2026.7.1" in item for item in v))

    def test_caching_disabled_skips_the_check(self):
        cfg = {
            "agents": {"defaults": {"params": {"cacheRetention": "none"}}},
            "models": {"providers": {"amazon-bedrock": {
                "models": [{"id": "us.anthropic.claude-sonnet-5"}]}}},
        }
        self.assertEqual(
            ccc.check_prompt_caching_reachable(cfg, self._dockerfile("2026.6.11")),
            [],
        )

    def test_unknown_model_is_flagged_not_silently_passed(self):
        # A new model nobody checked against the allowlist must fail loudly —
        # silently assuming caching works is the whole bug.
        cfg = {
            "agents": {"defaults": {"params": {"cacheRetention": "long"}}},
            "models": {"providers": {"amazon-bedrock": {
                "models": [{"id": "us.anthropic.claude-brandnew-9"}]}}},
        }
        v = ccc.check_prompt_caching_reachable(cfg, self._dockerfile("2026.7.1"))
        self.assertEqual(len(v), 1)
        self.assertIn("not in the caching-support table", v[0])

    def test_non_bedrock_provider_not_subject_to_the_check(self):
        # The Mantle path negotiates caching over the Anthropic Messages API;
        # this plugin is not in that loop.
        cfg = {
            "agents": {"defaults": {"params": {"cacheRetention": "long"}}},
            "models": {"providers": {"amazon-bedrock-mantle": {
                "models": [{"id": "us.anthropic.claude-sonnet-5"}]}}},
        }
        self.assertEqual(
            ccc.check_prompt_caching_reachable(cfg, self._dockerfile("2026.6.11")),
            [],
        )

    def test_mismatched_tarball_filenames_flagged(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "Dockerfile")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(
                "RUN npm pack @openclaw/amazon-bedrock-provider@2026.7.1 && \\\n"
                "    tar -xzf openclaw-amazon-bedrock-provider-2026.6.11.tgz\n"
            )
        v = ccc.check_prompt_caching_reachable(self.CONFIG, p)
        self.assertTrue(any("tar/rm filenames" in item for item in v))

    def test_missing_pin_line_flagged(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "Dockerfile")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("FROM scratch\n")
        v = ccc.check_prompt_caching_reachable(self.CONFIG, p)
        self.assertTrue(any("no `npm pack" in item for item in v))


class RealFilesTests(unittest.TestCase):
    def test_repo_config_is_consistent(self):
        here = os.path.dirname(os.path.abspath(__file__))
        rc = ccc.main(["--config", os.path.join(here, "openclaw.json"),
                       "--wrapper", os.path.join(here, "agentcore_wrapper.py"),
                       "--dockerfile", os.path.join(here, "Dockerfile")])
        self.assertEqual(rc, 0)

    def test_repo_dockerfile_pins_a_caching_capable_plugin(self):
        # Guards the live pin, not a fixture: a downgrade in a future PR fails here.
        here = os.path.dirname(os.path.abspath(__file__))
        version, violations = ccc.parse_pinned_plugin_version(
            os.path.join(here, "Dockerfile"))
        self.assertEqual(violations, [])
        self.assertIsNotNone(version)
        self.assertGreaterEqual(
            ccc._version_key(version),
            ccc._version_key(ccc._CACHE_CAPABLE_PLUGIN_MIN["claude-sonnet-5"]),
        )


if __name__ == "__main__":
    unittest.main()
