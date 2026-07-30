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

    def test_glm_5_known_window_and_wrong_window(self):
        cfg = {"models": {"providers": {"p": {"models": [
            {"id": "zai.glm-5", "contextWindow": 200000}]}}}}
        self.assertEqual(ccc.check_context_windows(cfg), [])
        cfg["models"]["providers"]["p"]["models"][0]["contextWindow"] = 203000
        self.assertIn("!= known value 200000", ccc.check_context_windows(cfg)[0])

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


class TierEvalConfigSchemaTests(unittest.TestCase):
    CANONICAL = {
        "agents": {"defaults": {}},
        "memory": {
            "search": {
                "provider": "bedrock",
                "model": "amazon.titan-embed-text-v2:0",
            }
        },
        "gateway": {"controlUi": {"enabled": False}},
    }

    def test_canonical_memory_schema_passes(self):
        self.assertEqual(
            ccc.check_tier_eval_config_schema(self.CANONICAL),
            [],
        )

    def test_legacy_default_memory_search_is_rejected(self):
        cfg = {
            **self.CANONICAL,
            "agents": {
                "defaults": {
                    "memorySearch": {
                        "provider": "bedrock",
                        "model": "amazon.titan-embed-text-v2:0",
                    }
                }
            },
        }
        violations = ccc.check_tier_eval_config_schema(cfg)
        self.assertTrue(
            any("agents.defaults.memorySearch moved" in v for v in violations)
        )

    def test_retired_insecure_auth_toggle_is_rejected(self):
        cfg = {
            **self.CANONICAL,
            "gateway": {
                "controlUi": {
                    "enabled": False,
                    "allowInsecureAuth": True,
                }
            },
        }
        violations = ccc.check_tier_eval_config_schema(cfg)
        self.assertTrue(
            any("allowInsecureAuth is retired" in v for v in violations)
        )

    def test_semantic_memory_keeps_explicit_bedrock_model(self):
        cfg = {**self.CANONICAL, "memory": {"search": {}}}
        violations = ccc.check_tier_eval_config_schema(cfg)
        self.assertTrue(
            any("memory.search.provider" in v for v in violations)
        )
        self.assertTrue(any("memory.search.model" in v for v in violations))


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

    def test_bedrock_placeholder_accepts_complete_root_relay_contract(self):
        cfg = {"models": {"providers": {"mantle": {
            "apiKey": "env:AWS_BEARER_TOKEN_BEDROCK"}}}}
        wrapper = self._wrapper(
            'BEDROCK_BEARER_ENV = "AWS_BEARER_TOKEN_BEDROCK"\n'
            "value = os.environ.get(BEDROCK_BEARER_ENV, '')\n"
            "CANDIDATE_MANTLE_RELAY_API_KEY = 'sentinel'\n"
            'relay = {"CANDIDATE_MANTLE_BEARER_TOKEN": value}\n'
            "os.environ.pop(BEDROCK_BEARER_ENV, None)\n"
        )
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

    def test_claude_4_model_is_not_falsely_rejected(self):
        # Codex P2 on PR #1388: the plugin's `-4-` rule caches every versioned
        # Claude 4 id, so omitting that token from the table would BLOCK a valid
        # model rollout. This gate must not fail in that direction.
        for model_id in (
            "us.anthropic.claude-sonnet-4-5-20250929",
            "anthropic.claude-opus-4-1",
        ):
            cfg = {
                "agents": {"defaults": {"params": {"cacheRetention": "long"}}},
                "models": {"providers": {"amazon-bedrock": {
                    "models": [{"id": model_id}]}}},
            }
            self.assertEqual(
                ccc.check_prompt_caching_reachable(
                    cfg, self._dockerfile("2026.6.11")),
                [], f"{model_id} matches the plugin's -4- rule",
            )

    def test_dotted_model_id_matches_via_normalized_candidate(self):
        # The plugin also tries a `[\s_.:]+ -> -` normalized candidate, which is
        # how a dotted id reaches the `-4-` rule. Testing only the raw id would
        # under-match and reject a model the plugin actually caches.
        cfg = {
            "agents": {"defaults": {"params": {"cacheRetention": "long"}}},
            "models": {"providers": {"amazon-bedrock": {
                "models": [{"id": "anthropic.claude.sonnet.4.5"}]}}},
        }
        self.assertEqual(
            ccc.check_prompt_caching_reachable(cfg, self._dockerfile("2026.6.11")),
            [],
        )

    def test_lowest_matching_minimum_wins(self):
        # An id matching several tokens caches as soon as ANY rule fires, so the
        # gate must require the LOWEST minimum, not the strictest.
        self.assertEqual(
            ccc._match_candidates("US.Anthropic.Claude-Sonnet-4-5"),
            ("us.anthropic.claude-sonnet-4-5", "us-anthropic-claude-sonnet-4-5"),
        )

    def test_non_claude_model_with_a_matching_token_is_still_flagged(self):
        # Codex P2 on PR #1388: supportsBedrockPromptCaching() rejects every
        # non-Claude candidate BEFORE any version token is considered. Without
        # mirroring that first gate, `amazon.nova-4-pro` matches `-4-` and the
        # gate waves through a model the plugin never caches — failing OPEN,
        # the exact class of bug this check exists to prevent.
        for model_id in ("amazon.nova-4-pro", "meta.llama-4-70b"):
            cfg = {
                "agents": {"defaults": {"params": {"cacheRetention": "long"}}},
                "models": {"providers": {"amazon-bedrock": {
                    "models": [{"id": model_id}]}}},
            }
            v = ccc.check_prompt_caching_reachable(
                cfg, self._dockerfile("2026.7.1"))
            self.assertEqual(len(v), 1, f"{model_id} must be flagged")
            self.assertIn("non-Claude", v[0])

    def test_claude_gate_mirrors_the_plugin(self):
        self.assertTrue(
            ccc._is_claude_candidate(ccc._match_candidates("us.anthropic.claude-sonnet-5")))
        self.assertFalse(
            ccc._is_claude_candidate(ccc._match_candidates("amazon.nova-4-pro")))

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


class WebSearchProviderTests(unittest.TestCase):
    CONFIG = {
        "tools": {
            "web": {
                "search": {
                    "enabled": True,
                    "provider": "parallel-free",
                },
            },
        },
        "plugins": {
            "load": {
                "paths": [
                    "/opt/openclaw-plugins/amazon-bedrock",
                    "/opt/openclaw-plugins/parallel",
                ],
            },
            "entries": {
                "parallel": {"enabled": True},
            },
        },
    }

    def _dockerfile(
        self,
        *,
        host: str = "2026.7.1",
        plugin: str = "2026.7.1",
        endpoint: str = "https://search.parallel.ai/mcp",
        assert_endpoint: bool = True,
    ) -> str:
        directory = tempfile.mkdtemp()
        path = os.path.join(directory, "Dockerfile")
        endpoint_assertion = (
            '    grep -RFq -- "${PARALLEL_PLUGIN_ENDPOINT}" '
            "/opt/openclaw-plugins/parallel/dist\n"
            if assert_endpoint
            else ""
        )
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(
                f"#   ghcr.io/openclaw/openclaw:{host}\n"
                f"#   index: {'sha256:' + '1' * 64}\n"
                f"ARG PARALLEL_PLUGIN_VERSION={plugin}\n"
                f"ARG PARALLEL_PLUGIN_ENDPOINT={endpoint}\n"
                "RUN npm pack "
                '"@openclaw/parallel-plugin@${PARALLEL_PLUGIN_VERSION}" && \\\n'
                '    tar -xzf "openclaw-parallel-plugin-'
                '${PARALLEL_PLUGIN_VERSION}.tgz" && \\\n'
                '    rm "openclaw-parallel-plugin-'
                '${PARALLEL_PLUGIN_VERSION}.tgz" && \\\n'
                f"{endpoint_assertion}"
            )
        return path

    def test_ready_key_free_provider_passes(self):
        self.assertEqual(
            ccc.check_web_search_provider(self.CONFIG, self._dockerfile()),
            [],
        )

    def test_missing_search_config_fails_closed(self):
        violations = ccc.check_web_search_provider({}, self._dockerfile())
        self.assertEqual(len(violations), 1)
        self.assertIn("tools.web.search is missing", violations[0])

    def test_auto_detection_is_rejected_for_key_free_provider(self):
        config = {
            **self.CONFIG,
            "tools": {"web": {"search": {"enabled": True}}},
        }
        violations = ccc.check_web_search_provider(config, self._dockerfile())
        self.assertTrue(any("never auto-detected" in item for item in violations))

    def test_key_configuration_is_rejected_for_key_free_provider(self):
        config = {
            **self.CONFIG,
            "tools": {
                "web": {
                    "search": {
                        "enabled": True,
                        "provider": "parallel-free",
                        "apiKey": "not-needed",
                    },
                },
            },
        }
        violations = ccc.check_web_search_provider(config, self._dockerfile())
        self.assertTrue(any("must not contain an apiKey" in item for item in violations))

    def test_missing_plugin_load_path_is_rejected(self):
        config = {
            **self.CONFIG,
            "plugins": {
                "load": {"paths": ["/opt/openclaw-plugins/amazon-bedrock"]},
                "entries": {"parallel": {"enabled": True}},
            },
        }
        violations = ccc.check_web_search_provider(config, self._dockerfile())
        self.assertTrue(any("plugins.load.paths" in item for item in violations))

    def test_endpoint_drift_or_missing_build_assertion_is_rejected(self):
        violations = ccc.check_web_search_provider(
            self.CONFIG,
            self._dockerfile(
                endpoint="https://example.invalid/mcp",
                assert_endpoint=False,
            ),
        )
        self.assertTrue(any("must pin" in item for item in violations))
        self.assertTrue(any("does not assert" in item for item in violations))

    def test_plugin_newer_than_host_is_rejected(self):
        violations = ccc.check_web_search_provider(
            self.CONFIG,
            self._dockerfile(host="2026.6.11"),
        )
        self.assertTrue(any("older than parallel-plugin" in item for item in violations))


class HostPluginCompatibilityTests(unittest.TestCase):
    """`npm pack` never enforces peerDependencies — this gate is the only check.

    Codex P2 on PR #1388: the rollback path the Dockerfile documents (revert the
    base image, leave the plugin) produces an incompatible pair that every other
    check here passes.
    """

    BETA = ("2026.7.1-beta.2",
            "sha256:" + "0e5680d7d58d3b6c08afa0fc992f4ad319b5586f60923e1985b7c6f838c535d5")
    STABLE = ("2026.7.1",
              "sha256:" + "6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c")

    def _dockerfile(self, host, digest, plugin, from_digest=None):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "Dockerfile")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(
                f"#   ghcr.io/openclaw/openclaw:{host}\n"
                f"#   index: {digest}\n"
                f"FROM ghcr.io/openclaw/openclaw@{from_digest or digest}\n"
                f"RUN npm pack @openclaw/amazon-bedrock-provider@{plugin} && \\\n"
                f"    tar -xzf openclaw-amazon-bedrock-provider-{plugin}.tgz && \\\n"
                f"    rm openclaw-amazon-bedrock-provider-{plugin}.tgz\n"
            )
        return p

    def test_matched_host_and_plugin_pass(self):
        self.assertEqual(
            ccc.check_host_plugin_compatibility(
                self._dockerfile(*self.STABLE, "2026.7.1")),
            [],
        )

    def test_host_rolled_back_alone_is_flagged(self):
        v = ccc.check_host_plugin_compatibility(
            self._dockerfile(*self.BETA, "2026.7.1"))
        self.assertEqual(len(v), 1)
        self.assertIn("older than amazon-bedrock-provider", v[0])

    def test_host_and_plugin_rolled_back_together_pass(self):
        # The documented, correct rollback must not be blocked.
        self.assertEqual(
            ccc.check_host_plugin_compatibility(
                self._dockerfile(*self.BETA, "2026.6.11")),
            [],
        )

    def test_from_digest_diverging_from_the_recorded_tag_is_flagged(self):
        # Otherwise the tag comment is decoration and the version comparison
        # above is made against something that is not being built.
        v = ccc.check_host_plugin_compatibility(
            self._dockerfile(*self.STABLE, "2026.7.1",
                             from_digest=self.BETA[1]))
        self.assertTrue(any("does not match the digest recorded" in x for x in v))

    def test_missing_tag_comment_is_flagged(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "Dockerfile")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(
                f"FROM ghcr.io/openclaw/openclaw@{self.STABLE[1]}\n"
                "RUN npm pack @openclaw/amazon-bedrock-provider@2026.7.1 && \\\n"
                "    tar -xzf openclaw-amazon-bedrock-provider-2026.7.1.tgz && \\\n"
                "    rm openclaw-amazon-bedrock-provider-2026.7.1.tgz\n"
            )
        v = ccc.check_host_plugin_compatibility(p)
        self.assertTrue(any("recording the base-image version" in x for x in v))

    def test_repo_dockerfile_host_and_plugin_agree(self):
        # Guards the live pin, not a fixture.
        here = os.path.dirname(os.path.abspath(__file__))
        self.assertEqual(
            ccc.check_host_plugin_compatibility(os.path.join(here, "Dockerfile")),
            [],
        )

    def test_parameterized_repo_dockerfile_resolves_default_plugin_pin(self):
        here = os.path.dirname(os.path.abspath(__file__))
        version, violations = ccc.parse_pinned_plugin_version(
            os.path.join(here, "Dockerfile")
        )
        self.assertEqual(version, "2026.7.1")
        self.assertEqual(violations, [])


class SettledToolRecoveryContractTests(unittest.TestCase):
    """The host must recover settled tool turns without replaying effects."""

    FIXED = (
        "2026.7.2-beta.5",
        "sha256:" + "86e0a480a37d879311c9723ad2487cca9eb6c1925fa4732dec3f505b4728eee9",
    )
    OLD = (
        "2026.7.1",
        "sha256:" + "6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c",
    )

    def _dockerfile(self, host, digest, *, assert_runtime=True):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "Dockerfile")
        contract = ""
        if assert_runtime:
            contract = (
                'ARG OPENCLAW_SETTLED_TOOL_RECOVERY_LOG="settled post-tool turn '
                'lacked a final answer"\n'
                'ARG OPENCLAW_SETTLED_TOOL_RECOVERY_PROMPT="The previous assistant '
                'turn completed its tool calls but did not produce a user-visible '
                'answer."\n'
                'RUN grep -RFq -- "${OPENCLAW_SETTLED_TOOL_RECOVERY_LOG}" /app/dist '
                '&& \\\n'
                '    grep -RFq -- "${OPENCLAW_SETTLED_TOOL_RECOVERY_PROMPT}" '
                "/app/dist\n"
            )
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(
                f"#   ghcr.io/openclaw/openclaw:{host}\n"
                f"#   index: {digest}\n"
                f"FROM ghcr.io/openclaw/openclaw@{digest}\n"
                f"{contract}"
            )
        return p

    def test_first_fixed_release_with_runtime_assertions_passes(self):
        self.assertEqual(
            ccc.check_settled_tool_recovery(self._dockerfile(*self.FIXED)),
            [],
        )

    def test_previous_stable_release_is_rejected(self):
        violations = ccc.check_settled_tool_recovery(
            self._dockerfile(*self.OLD)
        )
        self.assertTrue(any("predates settled-tool recovery" in v for v in violations))

    def test_missing_compiled_runtime_assertions_are_rejected(self):
        violations = ccc.check_settled_tool_recovery(
            self._dockerfile(*self.FIXED, assert_runtime=False)
        )
        self.assertTrue(
            any("does not assert the compiled settled-tool recovery" in v
                for v in violations)
        )

    def test_repo_dockerfile_keeps_recovery_contract(self):
        here = os.path.dirname(os.path.abspath(__file__))
        self.assertEqual(
            ccc.check_settled_tool_recovery(
                os.path.join(here, "Dockerfile")
            ),
            [],
        )


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

    def test_repo_dockerfile_pins_the_web_search_plugin(self):
        here = os.path.dirname(os.path.abspath(__file__))
        version, violations = ccc.parse_pinned_parallel_plugin_version(
            os.path.join(here, "Dockerfile"))
        self.assertEqual(version, "2026.7.1")
        self.assertEqual(violations, [])


if __name__ == "__main__":
    unittest.main()
