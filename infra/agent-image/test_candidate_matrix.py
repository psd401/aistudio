"""Hermetic tests for the one-axis candidate-image matrix (#1423)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "eval" / "candidates"))

import check_bootstrap_budget as budget  # noqa: E402
import check_config_consistency as consistency  # noqa: E402
import candidate  # noqa: E402


class CandidateMatrixTests(unittest.TestCase):
    manifests_dir = HERE / "eval" / "candidates" / "manifests"

    def test_committed_matrix_covers_models_and_provider_paths(self):
        manifest_paths = [
            path
            for path in sorted(self.manifests_dir.glob("*.json"))
            if path.name != "baseline.json"
        ]
        summaries = [candidate.validate(path) for path in manifest_paths]
        self.assertEqual(
            {summary["candidateId"] for summary in summaries},
            {
                "glm-5-mantle-openai",
                "glm-5-native",
                "kimi-k2-5",
                "openai-gpt-oss-120b",
                "qwen3-coder-next",
                "sonnet-5-mantle-anthropic",
            },
        )
        for manifest_path in manifest_paths:
            with self.subTest(manifest=manifest_path.name), tempfile.TemporaryDirectory(
                dir=HERE, prefix=".candidate-test."
            ) as directory:
                plan = candidate.prepare(
                    manifest_path,
                    Path(directory),
                    "d" * 40,
                )
                violations, _ = consistency.run_checks(
                    str(Path(directory) / "openclaw.json"),
                    str(HERE / "agentcore_wrapper.py"),
                    str(plan["dockerfile"]),
                )
                self.assertEqual(violations, [])
        self.assertEqual(
            {summary["providerPath"] for summary in summaries},
            {
                "native-bedrock-sigv4",
                "mantle-openai-compatible",
                "mantle-anthropic-messages",
            },
        )

    def test_glm_native_prepares_reproducible_build_inputs_and_metadata(self):
        manifest = self.manifests_dir / "glm-5-native.json"
        with tempfile.TemporaryDirectory(
            dir=HERE, prefix=".candidate-test."
        ) as directory:
            plan = candidate.prepare(
                manifest,
                Path(directory),
                "a" * 40,
            )
            config = json.loads(
                (Path(directory) / "openclaw.json").read_text(encoding="utf-8")
            )
            provider = config["models"]["providers"]["amazon-bedrock"]
            self.assertEqual(provider["models"][0]["id"], "zai.glm-5")
            self.assertEqual(
                config["agents"]["defaults"]["params"]["cacheRetention"], "none"
            )
            self.assertEqual(plan["providerPath"], "native-bedrock-sigv4")
            self.assertFalse(plan["requiresBearerToken"])
            self.assertTrue(
                (Path(directory) / "skills" / "psd-rules" / "SKILL.md").is_file()
            )
            self.assertEqual(
                budget.effective_bootstrap_sizes(directory),
                budget.effective_bootstrap_sizes(str(HERE)),
            )
            self.assertEqual(
                consistency.run_checks(
                    str(Path(directory) / "openclaw.json"),
                    str(HERE / "agentcore_wrapper.py"),
                    str(Path(directory) / "pin-contract.Dockerfile"),
                )[0],
                [],
            )
            metadata = json.loads(
                Path(plan["metadata"]).read_text(encoding="utf-8")
            )
            self.assertEqual(metadata["variedAxis"], "model")
            self.assertEqual(metadata["modelId"], "zai.glm-5")
            self.assertEqual(metadata["cacheRetention"], "none")
            self.assertEqual(metadata["contextTokens"], 180000)
            self.assertIsNone(metadata["imageDigest"])
            self.assertEqual(set(metadata["cost"]), set(metadata["costSources"]))

    def test_finalize_binds_metadata_to_immutable_digest(self):
        manifest = self.manifests_dir / "glm-5-native.json"
        with tempfile.TemporaryDirectory(
            dir=HERE, prefix=".candidate-test."
        ) as directory:
            output_dir = Path(directory)
            plan = candidate.prepare(manifest, output_dir, "b" * 40)
            finalized = output_dir / "final.json"
            candidate.finalize(
                Path(plan["metadata"]),
                finalized,
                "example.dkr.ecr.us-east-1.amazonaws.com/agent:test",
                "sha256:" + "c" * 64,
            )
            metadata = json.loads(finalized.read_text(encoding="utf-8"))
            self.assertEqual(metadata["imageDigest"], "sha256:" + "c" * 64)
            self.assertTrue(metadata["finalizedAt"].endswith("Z"))

    def test_rejects_candidate_that_changes_more_than_declared_axis(self):
        source = json.loads(
            (self.manifests_dir / "glm-5-native.json").read_text(encoding="utf-8")
        )
        source["axes"]["harness"]["hostVersion"] = "2099.1.1"
        with tempfile.TemporaryDirectory(
            dir=self.manifests_dir.parent, prefix=".candidate-contract-test."
        ) as directory:
            temporary_manifest = Path(directory) / "invalid.json"
            # The temporary manifest lives one directory above manifests, so
            # make its committed references relative to that location.
            source["baseline"] = "../manifests/baseline.json"
            source["axes"]["model"]["providerTemplate"] = (
                "../providers/native-bedrock-glm-5.json"
            )
            temporary_manifest.write_text(json.dumps(source), encoding="utf-8")
            with self.assertRaisesRegex(
                candidate.CandidateError, "must vary exactly one axis"
            ):
                candidate.validate(temporary_manifest)

    def test_rejects_candidate_paths_that_escape_the_candidate_tree(self):
        baseline = json.loads(
            (self.manifests_dir / "baseline.json").read_text(encoding="utf-8")
        )
        model_candidate = json.loads(
            (self.manifests_dir / "glm-5-native.json").read_text(encoding="utf-8")
        )
        cases = (
            (
                "provider-template",
                model_candidate,
                ("model", "providerTemplate"),
                "../../../../etc/passwd",
            ),
            (
                "prompt-file",
                baseline,
                ("prompt", "soul"),
                "../../../../etc/passwd",
            ),
        )
        for name, original, path, escape in cases:
            with self.subTest(case=name), tempfile.TemporaryDirectory(
                dir=self.manifests_dir.parent, prefix=".candidate-contract-test."
            ) as directory:
                source = json.loads(json.dumps(original))
                source["id"] = f"escape-{name}"
                source["baseline"] = "../manifests/baseline.json"
                source["declaredAxis"] = path[0]
                source["axes"]["model"]["providerTemplate"] = (
                    "../providers/native-bedrock-sonnet-5.json"
                )
                source["axes"][path[0]][path[1]] = escape
                temporary_manifest = Path(directory) / "candidate.json"
                temporary_manifest.write_text(json.dumps(source), encoding="utf-8")

                with self.assertRaisesRegex(candidate.CandidateError, "escapes"):
                    candidate.validate(temporary_manifest)

    def test_accepts_harness_only_and_prompt_only_candidates(self):
        baseline = json.loads(
            (self.manifests_dir / "baseline.json").read_text(encoding="utf-8")
        )
        for declared_axis in ("harness", "prompt"):
            with self.subTest(axis=declared_axis), tempfile.TemporaryDirectory(
                dir=self.manifests_dir.parent, prefix=".candidate-contract-test."
            ) as directory:
                source = json.loads(json.dumps(baseline))
                source["id"] = f"{declared_axis}-only"
                source["baseline"] = "../manifests/baseline.json"
                source["declaredAxis"] = declared_axis
                source["axes"]["model"]["providerTemplate"] = (
                    "../providers/native-bedrock-sonnet-5.json"
                )
                if declared_axis == "harness":
                    source["axes"]["harness"]["hostVersion"] = "2026.7.2"
                else:
                    source["axes"]["prompt"]["variant"] = "alternate"
                    alternate_soul = Path(directory) / "alternate-SOUL.md"
                    alternate_soul.write_text(
                        (HERE / "SOUL.md").read_text(encoding="utf-8")
                        + "\nCandidate prompt delta.\n",
                        encoding="utf-8",
                    )
                    source["axes"]["prompt"]["soul"] = (
                        alternate_soul.relative_to(HERE).as_posix()
                    )
                temporary_manifest = Path(directory) / "candidate.json"
                temporary_manifest.write_text(json.dumps(source), encoding="utf-8")

                summary = candidate.validate(temporary_manifest)

                self.assertEqual(summary["variedAxis"], declared_axis)

    def test_rejects_prompt_axis_without_materialized_byte_change(self):
        baseline = json.loads(
            (self.manifests_dir / "baseline.json").read_text(encoding="utf-8")
        )
        for case in ("variant-only", "identical-file"):
            with self.subTest(case=case), tempfile.TemporaryDirectory(
                dir=self.manifests_dir.parent, prefix=".candidate-contract-test."
            ) as directory:
                source = json.loads(json.dumps(baseline))
                source["id"] = f"prompt-{case}"
                source["baseline"] = "../manifests/baseline.json"
                source["declaredAxis"] = "prompt"
                source["axes"]["model"]["providerTemplate"] = (
                    "../providers/native-bedrock-sonnet-5.json"
                )
                if case == "variant-only":
                    source["axes"]["prompt"]["variant"] = "alternate"
                else:
                    identical_soul = Path(directory) / "identical-SOUL.md"
                    identical_soul.write_bytes((HERE / "SOUL.md").read_bytes())
                    source["axes"]["prompt"]["soul"] = (
                        identical_soul.relative_to(HERE).as_posix()
                    )
                temporary_manifest = Path(directory) / "candidate.json"
                temporary_manifest.write_text(json.dumps(source), encoding="utf-8")

                with self.assertRaisesRegex(
                    candidate.CandidateError, "must change materialized"
                ):
                    candidate.validate(temporary_manifest)

    def test_rejects_lookalike_aws_provider_hostnames(self):
        providers_dir = self.manifests_dir.parent / "providers"
        cases = (
            (
                "glm-5-mantle-openai.json",
                "mantle-openai-glm-5.json",
                "https://bedrock-mantle.us-east-1.api.aws.attacker.example/v1",
            ),
            (
                "glm-5-native.json",
                "native-bedrock-glm-5.json",
                "https://bedrock-runtime.us-east-1.amazonaws.com.attacker.example",
            ),
        )
        for manifest_name, provider_name, base_url in cases:
            with self.subTest(provider=provider_name), tempfile.TemporaryDirectory(
                dir=self.manifests_dir.parent, prefix=".candidate-contract-test."
            ) as directory:
                source = json.loads(
                    (self.manifests_dir / manifest_name).read_text(encoding="utf-8")
                )
                provider = json.loads(
                    (providers_dir / provider_name).read_text(encoding="utf-8")
                )
                source["baseline"] = "../manifests/baseline.json"
                source["axes"]["model"]["providerTemplate"] = "provider.json"
                provider["provider"]["baseUrl"] = base_url
                directory_path = Path(directory)
                (directory_path / "provider.json").write_text(
                    json.dumps(provider), encoding="utf-8"
                )
                temporary_manifest = directory_path / "candidate.json"
                temporary_manifest.write_text(json.dumps(source), encoding="utf-8")

                with self.assertRaisesRegex(
                    candidate.CandidateError, "exact AWS endpoint hostname"
                ):
                    candidate.validate(temporary_manifest)

    def test_rejects_baseline_harness_or_prompt_drift_from_production(self):
        original_baseline = json.loads(
            (self.manifests_dir / "baseline.json").read_text(encoding="utf-8")
        )
        original_candidate = json.loads(
            (self.manifests_dir / "glm-5-native.json").read_text(encoding="utf-8")
        )
        for drifted_axis in ("harness", "prompt"):
            with self.subTest(axis=drifted_axis), tempfile.TemporaryDirectory(
                dir=self.manifests_dir.parent, prefix=".candidate-contract-test."
            ) as directory:
                baseline = json.loads(json.dumps(original_baseline))
                source = json.loads(json.dumps(original_candidate))
                baseline["axes"]["model"]["providerTemplate"] = (
                    "../providers/native-bedrock-sonnet-5.json"
                )
                source["baseline"] = "baseline.json"
                source["axes"]["model"]["providerTemplate"] = (
                    "../providers/native-bedrock-glm-5.json"
                )
                if drifted_axis == "harness":
                    baseline["axes"]["harness"]["hostVersion"] = "2099.1.1"
                else:
                    baseline["axes"]["prompt"]["variant"] = "stale-default"
                source["axes"][drifted_axis] = baseline["axes"][drifted_axis]

                directory_path = Path(directory)
                (directory_path / "baseline.json").write_text(
                    json.dumps(baseline), encoding="utf-8"
                )
                temporary_manifest = directory_path / "candidate.json"
                temporary_manifest.write_text(
                    json.dumps(source), encoding="utf-8"
                )

                with self.assertRaisesRegex(
                    candidate.CandidateError,
                    rf"baseline {drifted_axis} no longer matches",
                ):
                    candidate.validate(temporary_manifest)

    def test_mantle_templates_use_the_mantle_iam_service_prefix(self):
        providers_dir = self.manifests_dir.parent / "providers"
        for template_path in providers_dir.glob("mantle-*.json"):
            with self.subTest(template=template_path.name):
                template = json.loads(template_path.read_text(encoding="utf-8"))
                self.assertEqual(
                    template["iam"]["actions"],
                    ["bedrock-mantle:CallWithBearerToken"],
                )
                self.assertEqual(template["iam"]["resources"], ["*"])

    def test_dockerfile_defaults_keep_production_pins_and_assertion(self):
        dockerfile = (HERE / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn(
            "ARG OPENCLAW_BASE_IMAGE=ghcr.io/openclaw/openclaw@sha256:"
            "6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c",
            dockerfile,
        )
        self.assertIn("ARG BEDROCK_PLUGIN_VERSION=2026.7.1", dockerfile)
        self.assertIn(
            "ARG BEDROCK_PLUGIN_ASSERTION=claude-sonnet-5", dockerfile
        )
        self.assertIn(
            'grep -Fq -- "${BEDROCK_PLUGIN_ASSERTION}"', dockerfile
        )

    def test_build_command_wires_manifest_inputs_and_digest_sidecar(self):
        script = (HERE / "build-and-push.sh").read_text(encoding="utf-8")
        for token in (
            "--candidate",
            "OPENCLAW_CONFIG=",
            "OPENCLAW_BASE_IMAGE=",
            "BEDROCK_PLUGIN_VERSION=",
            "BEDROCK_PLUGIN_ASSERTION=",
            "candidate.py\" finalize",
            '"grader":"output_match"',
        ):
            self.assertIn(token, script)


if __name__ == "__main__":
    unittest.main()
