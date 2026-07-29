#!/usr/bin/env python3
"""Validate and materialize one-axis PSD Agent image candidates.

The committed manifest is the reproducibility contract. ``prepare`` resolves
its provider template, proves that exactly one axis differs from the committed
baseline, and writes build inputs plus a metadata draft. ``finalize`` binds
that draft to the pushed image digest.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Sequence
from urllib.parse import urlparse


class CandidateError(RuntimeError):
    """A candidate contract is invalid or cannot be materialized safely."""


SCRIPT_PATH = Path(__file__).resolve()
CANDIDATES_DIR = SCRIPT_PATH.parent
AGENT_IMAGE_DIR = SCRIPT_PATH.parents[2]
CANONICAL_CONFIG = AGENT_IMAGE_DIR / "openclaw.json"
CANONICAL_DOCKERFILE = AGENT_IMAGE_DIR / "Dockerfile"
AXES = ("model", "harness", "prompt")
PROVIDER_PATH_CONTRACTS: Mapping[str, tuple[str, str, str]] = {
    "native-bedrock-sigv4": (
        "bedrock-converse-stream",
        "aws-sdk",
        "https://bedrock-runtime.",
    ),
    "mantle-openai-compatible": (
        "openai-completions",
        "api-key",
        "https://bedrock-mantle.",
    ),
    "mantle-anthropic-messages": (
        "anthropic-messages",
        "api-key",
        "https://bedrock-mantle.",
    ),
}
REQUIRED_SOURCE_FIELDS = ("api", "auth", "baseUrl", "iam", "model", "pricing")
REQUIRED_COST_FIELDS = ("input", "output", "cacheRead", "cacheWrite")
SAFE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
PIN_RE = re.compile(r"^[0-9A-Za-z.-]+$")
IMAGE_RE = re.compile(
    r"^ghcr\.io/openclaw/openclaw@sha256:[0-9a-f]{64}$"
)
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
SOURCE_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _load_json(path: Path, label: str) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise CandidateError(f"cannot read {label} {path}: {error}") from error
    if not isinstance(value, dict):
        raise CandidateError(f"{label} {path} must be a JSON object")
    return value


def _mapping(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise CandidateError(f"{label} must be an object")
    return value


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CandidateError(f"{label} must be a non-empty string")
    return value


def _safe_relative_file(raw_path: object, label: str) -> Path:
    value = _string(raw_path, label)
    candidate = Path(value)
    if candidate.is_absolute():
        raise CandidateError(f"{label} must be relative to {AGENT_IMAGE_DIR}")
    resolved = (AGENT_IMAGE_DIR / candidate).resolve()
    try:
        resolved.relative_to(AGENT_IMAGE_DIR)
    except ValueError as error:
        raise CandidateError(f"{label} escapes {AGENT_IMAGE_DIR}") from error
    if not resolved.is_file():
        raise CandidateError(f"{label} does not exist: {value}")
    return resolved


def _resolve_manifest_path(raw_path: object, manifest_path: Path, label: str) -> Path:
    value = _string(raw_path, label)
    candidate = Path(value)
    if candidate.is_absolute():
        raise CandidateError(f"{label} must be relative to its manifest")
    resolved = (manifest_path.parent / candidate).resolve()
    try:
        resolved.relative_to(CANDIDATES_DIR)
    except ValueError as error:
        raise CandidateError(f"{label} escapes {CANDIDATES_DIR}") from error
    if not resolved.is_file():
        raise CandidateError(f"{label} does not exist: {value}")
    return resolved


def _validate_manifest(
    manifest: dict[str, object],
    manifest_path: Path,
    *,
    is_baseline: bool,
) -> tuple[str, dict[str, object]]:
    if manifest.get("schemaVersion") != 1:
        raise CandidateError(f"{manifest_path}: schemaVersion must be 1")
    candidate_id = _string(manifest.get("id"), f"{manifest_path}: id")
    if not SAFE_ID_RE.fullmatch(candidate_id):
        raise CandidateError(f"{manifest_path}: id must be lowercase kebab-case")
    axes = _mapping(manifest.get("axes"), f"{manifest_path}: axes")
    if set(axes) != set(AXES):
        raise CandidateError(
            f"{manifest_path}: axes must be exactly {', '.join(AXES)}"
        )
    declared = _string(
        manifest.get("declaredAxis"), f"{manifest_path}: declaredAxis"
    )
    if is_baseline:
        if declared != "baseline" or manifest.get("baseline") is not None:
            raise CandidateError(
                f"{manifest_path}: baseline must declare axis 'baseline' "
                "and set baseline to null"
            )
    elif declared not in AXES:
        raise CandidateError(
            f"{manifest_path}: declaredAxis must be one of {', '.join(AXES)}"
        )
    return candidate_id, axes


def _validate_source_url(value: object, label: str) -> str:
    source = _string(value, label)
    parsed = urlparse(source)
    if parsed.scheme != "https":
        raise CandidateError(f"{label} must be an HTTPS source URL")
    hostname = parsed.hostname or ""
    if hostname != "aws.amazon.com" and not hostname.endswith(".aws.amazon.com"):
        raise CandidateError(f"{label} must cite an official AWS source")
    return source


def _provider_template(
    axes: dict[str, object],
    manifest_path: Path,
) -> tuple[dict[str, object], Path]:
    model_axis = _mapping(axes["model"], f"{manifest_path}: axes.model")
    template_path = _resolve_manifest_path(
        model_axis.get("providerTemplate"),
        manifest_path,
        f"{manifest_path}: axes.model.providerTemplate",
    )
    template = _load_json(template_path, "provider template")
    if template.get("schemaVersion") != 1:
        raise CandidateError(f"{template_path}: schemaVersion must be 1")
    verified_at = _string(
        template.get("verifiedAt"), f"{template_path}: verifiedAt"
    )
    if not re.fullmatch(r"20[0-9]{2}-[0-9]{2}-[0-9]{2}", verified_at):
        raise CandidateError(f"{template_path}: verifiedAt must be YYYY-MM-DD")

    provider_path = _string(
        template.get("providerPath"), f"{template_path}: providerPath"
    )
    contract = PROVIDER_PATH_CONTRACTS.get(provider_path)
    if contract is None:
        raise CandidateError(
            f"{template_path}: unsupported providerPath {provider_path!r}"
        )
    provider_name = _string(
        template.get("providerName"), f"{template_path}: providerName"
    )
    provider = _mapping(
        template.get("provider"), f"{template_path}: provider"
    )
    expected_api, expected_auth, base_prefix = contract
    if provider.get("api") != expected_api:
        raise CandidateError(
            f"{template_path}: {provider_path} requires api={expected_api!r}"
        )
    if provider.get("auth") != expected_auth:
        raise CandidateError(
            f"{template_path}: {provider_path} requires auth={expected_auth!r}"
        )
    base_url = _string(provider.get("baseUrl"), f"{template_path}: baseUrl")
    if not base_url.startswith(base_prefix):
        raise CandidateError(
            f"{template_path}: {provider_path} requires an AWS {base_prefix} baseUrl"
        )
    if provider_path == "mantle-openai-compatible" and not base_url.endswith("/v1"):
        raise CandidateError(f"{template_path}: Mantle OpenAI baseUrl must end in /v1")
    if (
        provider_path == "mantle-anthropic-messages"
        and not base_url.endswith("/anthropic")
    ):
        raise CandidateError(
            f"{template_path}: Mantle Anthropic baseUrl must end in /anthropic"
        )
    if provider_path.startswith("mantle-") and provider.get("apiKey") != (
        "env:AWS_BEARER_TOKEN_BEDROCK"
    ):
        raise CandidateError(
            f"{template_path}: Mantle templates must hydrate "
            "env:AWS_BEARER_TOKEN_BEDROCK"
        )
    if provider_path == "native-bedrock-sigv4" and "apiKey" in provider:
        raise CandidateError(f"{template_path}: native SigV4 must not declare apiKey")

    models = provider.get("models")
    if not isinstance(models, list) or len(models) != 1 or not isinstance(models[0], dict):
        raise CandidateError(f"{template_path}: provider must declare exactly one model")
    model = models[0]
    model_id = _string(model.get("id"), f"{template_path}: model.id")
    if template.get("primaryModelId") != model_id:
        raise CandidateError(f"{template_path}: primaryModelId must match model.id")
    cost = _mapping(model.get("cost"), f"{template_path}: model.cost")
    if set(cost) != set(REQUIRED_COST_FIELDS):
        raise CandidateError(
            f"{template_path}: model.cost must contain exactly "
            + ", ".join(REQUIRED_COST_FIELDS)
        )
    for field, value in cost.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
            raise CandidateError(
                f"{template_path}: model.cost.{field} must be non-negative"
            )
    cost_sources = _mapping(
        template.get("costSources"), f"{template_path}: costSources"
    )
    if set(cost_sources) != set(cost):
        raise CandidateError(
            f"{template_path}: every cost field must have one costSources entry"
        )
    for field, source in cost_sources.items():
        _validate_source_url(source, f"{template_path}: costSources.{field}")

    sources = _mapping(template.get("sources"), f"{template_path}: sources")
    if set(sources) != set(REQUIRED_SOURCE_FIELDS):
        raise CandidateError(
            f"{template_path}: sources must be exactly "
            + ", ".join(REQUIRED_SOURCE_FIELDS)
        )
    for field, source in sources.items():
        _validate_source_url(source, f"{template_path}: sources.{field}")

    cache_retention = _string(
        template.get("cacheRetention"), f"{template_path}: cacheRetention"
    )
    if "claude" not in model_id.lower() and cache_retention != "none":
        raise CandidateError(
            f"{template_path}: non-Claude candidates must use cacheRetention=none"
        )
    context_tokens = template.get("contextTokens")
    context_window = model.get("contextWindow")
    if (
        isinstance(context_tokens, bool)
        or not isinstance(context_tokens, int)
        or context_tokens <= 0
        or not isinstance(context_window, int)
        or context_tokens > context_window
    ):
        raise CandidateError(
            f"{template_path}: contextTokens must be a positive integer no "
            "larger than the model contextWindow"
        )

    iam = _mapping(template.get("iam"), f"{template_path}: iam")
    actions = iam.get("actions")
    resources = iam.get("resources")
    if (
        not isinstance(actions, list)
        or not actions
        or any(not isinstance(item, str) or not item for item in actions)
        or not isinstance(resources, list)
        or not resources
        or any(not isinstance(item, str) or not item for item in resources)
    ):
        raise CandidateError(f"{template_path}: iam actions/resources must be lists")
    inference_profile = iam.get("inferenceProfileId")
    member_models = iam.get("crossRegionFoundationModelArns")
    if inference_profile is not None and (
        not isinstance(member_models, list)
        or not member_models
        or any(not isinstance(item, str) or not item for item in member_models)
    ):
        raise CandidateError(
            f"{template_path}: cross-region profiles must enumerate every "
            "destination foundation-model ARN pattern"
        )

    # Provider name is validated here even though composition uses the template
    # field directly; this catches whitespace/slash values that would make the
    # OpenClaw primary reference ambiguous.
    if "/" in provider_name or provider_name.strip() != provider_name:
        raise CandidateError(f"{template_path}: providerName is malformed")
    return template, template_path


def _load_contract(
    manifest_path: Path,
) -> tuple[
    dict[str, object],
    dict[str, object],
    dict[str, object],
    Path,
    dict[str, object],
]:
    manifest_path = manifest_path.resolve()
    try:
        manifest_path.relative_to(CANDIDATES_DIR)
    except ValueError as error:
        raise CandidateError(
            f"candidate manifest must live under {CANDIDATES_DIR}"
        ) from error
    manifest = _load_json(manifest_path, "candidate manifest")
    candidate_id, axes = _validate_manifest(
        manifest, manifest_path, is_baseline=False
    )
    baseline_path = _resolve_manifest_path(
        manifest.get("baseline"), manifest_path, f"{manifest_path}: baseline"
    )
    baseline = _load_json(baseline_path, "baseline manifest")
    baseline_id, baseline_axes = _validate_manifest(
        baseline, baseline_path, is_baseline=True
    )

    changed_axes = [axis for axis in AXES if axes[axis] != baseline_axes[axis]]
    declared_axis = _string(
        manifest.get("declaredAxis"), f"{manifest_path}: declaredAxis"
    )
    if changed_axes != [declared_axis]:
        rendered = ", ".join(changed_axes) if changed_axes else "none"
        raise CandidateError(
            f"{manifest_path}: declaredAxis={declared_axis!r}, but changed axes "
            f"are {rendered}; candidates must vary exactly one axis"
        )
    template, template_path = _provider_template(axes, manifest_path)

    # The baseline itself is executable documentation: it must continue to
    # resolve to the checked-in production config, or comparisons have drifted.
    baseline_template, _ = _provider_template(baseline_axes, baseline_path)
    baseline_config = _compose_config(baseline_template)
    canonical_config = _load_json(CANONICAL_CONFIG, "canonical OpenClaw config")
    if baseline_config != canonical_config:
        raise CandidateError(
            f"{baseline_path}: composed baseline no longer matches "
            f"{CANONICAL_CONFIG}"
        )
    manifest["_resolvedId"] = candidate_id
    baseline["_resolvedId"] = baseline_id
    return manifest, axes, baseline, template_path, template


def _compose_config(template: dict[str, object]) -> dict[str, object]:
    config = copy.deepcopy(_load_json(CANONICAL_CONFIG, "canonical config"))
    provider_name = _string(template.get("providerName"), "providerName")
    provider = copy.deepcopy(_mapping(template.get("provider"), "provider"))
    model_id = _string(template.get("primaryModelId"), "primaryModelId")
    cache_retention = _string(template.get("cacheRetention"), "cacheRetention")
    models = _mapping(config["models"], "canonical models")
    models["providers"] = {provider_name: provider}
    agents = _mapping(config["agents"], "canonical agents")
    defaults = _mapping(agents["defaults"], "canonical agents.defaults")
    defaults["model"] = {"primary": f"{provider_name}/{model_id}"}
    defaults["contextTokens"] = template["contextTokens"]
    params = _mapping(defaults["params"], "canonical agents.defaults.params")
    params["cacheRetention"] = cache_retention
    return config


def _validate_harness(
    axis: object, label: str
) -> tuple[str, str, str, str]:
    harness = _mapping(axis, label)
    if set(harness) != {
        "baseImage",
        "hostVersion",
        "bedrockPluginVersion",
        "expectedPluginToken",
    }:
        raise CandidateError(
            f"{label} must define baseImage, hostVersion, "
            "bedrockPluginVersion, and expectedPluginToken"
        )
    base_image = _string(harness.get("baseImage"), f"{label}.baseImage")
    host_version = _string(harness.get("hostVersion"), f"{label}.hostVersion")
    plugin_version = _string(
        harness.get("bedrockPluginVersion"), f"{label}.bedrockPluginVersion"
    )
    expected_token = _string(
        harness.get("expectedPluginToken"), f"{label}.expectedPluginToken"
    )
    if not IMAGE_RE.fullmatch(base_image):
        raise CandidateError(f"{label}.baseImage must be an immutable OpenClaw digest")
    if not PIN_RE.fullmatch(host_version) or not PIN_RE.fullmatch(plugin_version):
        raise CandidateError(f"{label}: host/plugin versions are malformed")
    if not re.fullmatch(r"^[0-9A-Za-z._:-]+$", expected_token):
        raise CandidateError(f"{label}.expectedPluginToken is malformed")
    return base_image, host_version, plugin_version, expected_token


def _validate_prompt(axis: object, label: str) -> tuple[str, Path, Path]:
    prompt = _mapping(axis, label)
    if set(prompt) != {"variant", "soul", "rules"}:
        raise CandidateError(f"{label} must define variant, soul, and rules")
    variant = _string(prompt.get("variant"), f"{label}.variant")
    if not SAFE_ID_RE.fullmatch(variant):
        raise CandidateError(f"{label}.variant must be lowercase kebab-case")
    soul = _safe_relative_file(prompt.get("soul"), f"{label}.soul")
    rules = _safe_relative_file(prompt.get("rules"), f"{label}.rules")
    return variant, soul, rules


def _atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def _staging_build_path(path: Path) -> str:
    try:
        relative = path.resolve().relative_to(AGENT_IMAGE_DIR)
    except ValueError as error:
        raise CandidateError(
            f"staging directory must be inside {AGENT_IMAGE_DIR}"
        ) from error
    return relative.as_posix()


def _render_pin_contract(
    base_image: str,
    host_version: str,
    plugin_version: str,
    expected_token: str,
) -> str:
    source = CANONICAL_DOCKERFILE.read_text(encoding="utf-8")
    base_digest = base_image.rsplit("@", 1)[1]
    replacements = (
        (
            r"^#   ghcr\.io/openclaw/openclaw:[0-9A-Za-z.-]+\s*$",
            f"#   ghcr.io/openclaw/openclaw:{host_version}",
        ),
        (
            r"^#   index: sha256:[0-9a-f]{64}\s*$",
            f"#   index: {base_digest}",
        ),
        (
            r"^ARG OPENCLAW_BASE_IMAGE=.*$",
            f"ARG OPENCLAW_BASE_IMAGE={base_image}",
        ),
        (
            r"^ARG BEDROCK_PLUGIN_VERSION=.*$",
            f"ARG BEDROCK_PLUGIN_VERSION={plugin_version}",
        ),
        (
            r"^ARG BEDROCK_PLUGIN_ASSERTION=.*$",
            f"ARG BEDROCK_PLUGIN_ASSERTION={expected_token}",
        ),
    )
    for pattern, replacement in replacements:
        source, count = re.subn(pattern, replacement, source, count=1, flags=re.MULTILINE)
        if count != 1:
            raise CandidateError(
                f"{CANONICAL_DOCKERFILE}: missing parameter contract {pattern}"
            )
    return source


def prepare(manifest_path: Path, output_dir: Path, source_commit: str) -> dict[str, object]:
    if not SOURCE_COMMIT_RE.fullmatch(source_commit):
        raise CandidateError("source commit must be a full lowercase Git SHA")
    (
        manifest,
        axes,
        baseline,
        template_path,
        template,
    ) = _load_contract(manifest_path)
    candidate_id = _string(manifest["_resolvedId"], "candidate id")
    baseline_id = _string(baseline["_resolvedId"], "baseline id")
    declared_axis = _string(manifest.get("declaredAxis"), "declaredAxis")
    base_image, host_version, plugin_version, expected_token = _validate_harness(
        axes["harness"], "axes.harness"
    )
    prompt_variant, soul_path, rules_path = _validate_prompt(
        axes["prompt"], "axes.prompt"
    )
    output_dir = output_dir.resolve()
    _staging_build_path(output_dir)
    if output_dir.exists() and any(output_dir.iterdir()):
        raise CandidateError(f"output directory is not empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    config_path = output_dir / "openclaw.json"
    dockerfile_path = output_dir / "pin-contract.Dockerfile"
    soul_output = output_dir / "SOUL.md"
    rules_output = output_dir / "skills" / "psd-rules" / "SKILL.md"
    metadata_path = output_dir / "metadata.json"
    _atomic_json(config_path, _compose_config(template))
    dockerfile_path.write_text(
        _render_pin_contract(
            base_image, host_version, plugin_version, expected_token
        ),
        encoding="utf-8",
    )
    shutil.copyfile(soul_path, soul_output)
    rules_output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(rules_path, rules_output)

    provider = _mapping(template["provider"], "provider")
    model = _mapping(provider["models"][0], "model")  # type: ignore[index]
    manifest_bytes = manifest_path.resolve().read_bytes()
    metadata: dict[str, object] = {
        "schemaVersion": 1,
        "candidateId": candidate_id,
        "baselineId": baseline_id,
        "variedAxis": declared_axis,
        "axisDiff": {
            "baseline": baseline["axes"][declared_axis],  # type: ignore[index]
            "candidate": axes[declared_axis],
        },
        "modelId": model["id"],
        "providerName": template["providerName"],
        "providerPath": template["providerPath"],
        "providerApi": provider["api"],
        "providerAuth": provider["auth"],
        "providerBaseUrl": provider["baseUrl"],
        "harness": {
            "baseImage": base_image,
            "hostVersion": host_version,
            "bedrockPluginVersion": plugin_version,
            "expectedPluginToken": expected_token,
        },
        "prompt": {
            "variant": prompt_variant,
            "soul": axes["prompt"]["soul"],  # type: ignore[index]
            "rules": axes["prompt"]["rules"],  # type: ignore[index]
        },
        "cacheRetention": template["cacheRetention"],
        "contextTokens": template["contextTokens"],
        "cost": model["cost"],
        "costSources": template["costSources"],
        "sources": template["sources"],
        "sourcesVerifiedAt": template["verifiedAt"],
        "iam": template["iam"],
        "providerTemplate": str(template_path.relative_to(CANDIDATES_DIR)),
        "manifest": str(manifest_path.resolve().relative_to(CANDIDATES_DIR)),
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "sourceCommit": source_commit,
        "preparedAt": _utc_now(),
        "image": None,
        "imageDigest": None,
        "finalizedAt": None,
    }
    _atomic_json(metadata_path, metadata)

    plan = {
        "candidateId": candidate_id,
        "providerPath": template["providerPath"],
        "requiresBearerToken": str(template["providerPath"]).startswith("mantle-"),
        "openclawConfig": _staging_build_path(config_path),
        "dockerfile": str(dockerfile_path),
        "soulPreamble": _staging_build_path(soul_output),
        "psdRulesSkill": _staging_build_path(rules_output),
        "baseImage": base_image,
        "bedrockPluginVersion": plugin_version,
        "expectedPluginToken": expected_token,
        "metadata": str(metadata_path),
    }
    _atomic_json(output_dir / "plan.json", plan)
    return plan


def finalize(metadata_path: Path, output_path: Path, image: str, digest: str) -> None:
    if not image or any(character.isspace() for character in image):
        raise CandidateError("image must be a non-empty reference without whitespace")
    if not DIGEST_RE.fullmatch(digest):
        raise CandidateError("digest must be sha256:<64 lowercase hex characters>")
    metadata = _load_json(metadata_path.resolve(), "candidate metadata")
    if metadata.get("image") is not None or metadata.get("imageDigest") is not None:
        raise CandidateError("candidate metadata has already been finalized")
    metadata["image"] = image
    metadata["imageDigest"] = digest
    metadata["finalizedAt"] = _utc_now()
    _atomic_json(output_path.resolve(), metadata)


def validate(manifest_path: Path) -> dict[str, object]:
    manifest, axes, baseline, template_path, template = _load_contract(manifest_path)
    _validate_harness(axes["harness"], "axes.harness")
    _validate_prompt(axes["prompt"], "axes.prompt")
    return {
        "candidateId": manifest["_resolvedId"],
        "baselineId": baseline["_resolvedId"],
        "variedAxis": manifest["declaredAxis"],
        "providerTemplate": str(template_path.relative_to(CANDIDATES_DIR)),
        "providerPath": template["providerPath"],
        "modelId": template["primaryModelId"],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--manifest", required=True, type=Path)
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--manifest", required=True, type=Path)
    prepare_parser.add_argument("--output-dir", required=True, type=Path)
    prepare_parser.add_argument("--source-commit", required=True)
    finalize_parser = subparsers.add_parser("finalize")
    finalize_parser.add_argument("--metadata", required=True, type=Path)
    finalize_parser.add_argument("--out", required=True, type=Path)
    finalize_parser.add_argument("--image", required=True)
    finalize_parser.add_argument("--digest", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "validate":
            result = validate(args.manifest)
            print(json.dumps(result, sort_keys=True))
        elif args.command == "prepare":
            result = prepare(args.manifest, args.output_dir, args.source_commit)
            print(json.dumps(result, sort_keys=True))
        else:
            finalize(
                args.metadata,
                args.out,
                args.image,
                args.digest,
            )
            print(args.out)
        return 0
    except (CandidateError, OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
