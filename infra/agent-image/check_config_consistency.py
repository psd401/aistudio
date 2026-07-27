#!/usr/bin/env python3
"""
Config self-consistency gate for the agent image (issue #1161).

Four static asserts over openclaw.json + the Dockerfile, run on the host before
build (no Docker):

  1. contextWindow sanity — every declared model's contextWindow must be a
     positive int inside a sane range, and if the model id is in the known-models
     table it must match. A fat-fingered contextWindow (20_000 instead of
     200_000, or 2_000_000) silently changes pruning behavior and cost.

  2. apiKey hydration path — every provider whose apiKey is an `env:VAR`
     placeholder must have VAR actually hydrated in agentcore_wrapper.py. A
     provider that points at an env var nothing sets boots with no credential
     and every model call 401s (the r11-class "missing provider" failure).

  3. prompt-caching reachability — if openclaw.json asks for prompt caching
     (`params.cacheRetention` other than "none"), the @openclaw/amazon-bedrock-
     provider version pinned in the Dockerfile must actually be able to deliver
     it for the declared model. The plugin only emits Bedrock Converse
     `cachePoint` blocks when its internal supportsBedrockPromptCaching()
     allowlist recognizes the model id; an unrecognized model silently gets NO
     caching and every turn pays full input rate. That is not a config error,
     not a runtime error, and not visible anywhere except the token bill —
     which is exactly how it went unnoticed from #1384 until 2026-07-27.

  4. host/plugin compatibility — the OpenClaw base image must satisfy the
     plugin's `peerDependencies.openclaw`. The plugin is vendored with
     `npm pack`, which downloads a tarball and runs no install, so that peer
     requirement is enforced NOWHERE else in the build. This check is the only
     thing standing between a mismatched host/plugin pair and production.

Exit 0 when consistent, 1 on any violation.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Dict, List, Optional, Tuple

# Known model context windows. A declared value that contradicts this table is a
# typo, not a new model. Keep in sync with the provider docs; add rows as models
# are added to openclaw.json. Bare + inference-profile aliases share a window.
KNOWN_CONTEXT_WINDOWS: Dict[str, int] = {
    "anthropic.claude-sonnet-5": 200000,
    "us.anthropic.claude-sonnet-5": 200000,
    "claude-sonnet-5": 200000,
}

# Generic sanity band for models not in the known table (catches order-of-
# magnitude typos without hardcoding every model).
_MIN_CONTEXT_WINDOW = 8000
_MAX_CONTEXT_WINDOW = 2_000_000

# Providers that serve through @openclaw/amazon-bedrock-provider. Only these are
# subject to the prompt-caching reachability check; the Mantle path reaches
# Bedrock over the Anthropic Messages API, where caching is negotiated
# differently and this plugin is not in the loop.
_BEDROCK_NATIVE_PROVIDERS = frozenset({"amazon-bedrock"})

# First @openclaw/amazon-bedrock-provider release whose
# supportsBedrockPromptCaching() allowlist recognizes a model. Keys are the
# plugin's OWN match tokens, tested against the same candidates it builds.
# Verified by reading dist/bedrock-options.js per version: 2026.6.11 matched
# `-4-`, `claude-fable-5`, `claude-3-7-sonnet` and `claude-3-5-haiku`;
# 2026.7.1 added `claude-sonnet-5` and `claude-mythos-5`.
#
# Keep this table a faithful mirror of that function. Omitting one of its
# tokens does not fail safe — it fails LOUD in the wrong direction: a model the
# plugin would happily cache gets rejected here and a valid rollout is blocked.
# `-4-` is in the table for exactly that reason (Codex P2 on PR #1388): every
# versioned Claude 4 id — us.anthropic.claude-sonnet-4-5-… — matches it.
_CACHE_CAPABLE_PLUGIN_MIN: Dict[str, str] = {
    "-4-": "2026.6.11",
    "claude-sonnet-5": "2026.7.1",
    "claude-mythos-5": "2026.7.1",
    "claude-fable-5": "2026.6.11",
    "claude-3-7-sonnet": "2026.6.11",
    "claude-3-5-haiku": "2026.6.11",
}

_PLUGIN_PACK_RE = re.compile(
    r"npm pack @openclaw/amazon-bedrock-provider@([0-9A-Za-z.\-]+)"
)

# The base image is pinned by immutable digest, with the human-readable tag
# recorded directly above it. Parsing both lets us cross-check them AND compare
# the host version against the plugin's peer requirement.
_HOST_TAG_RE = re.compile(
    r"^#\s*ghcr\.io/openclaw/openclaw:([0-9A-Za-z.\-]+)\s*$\n"
    r"^#\s*index:\s*(sha256:[0-9a-f]{64})\s*$",
    re.MULTILINE,
)
_HOST_FROM_RE = re.compile(
    r"^FROM\s+ghcr\.io/openclaw/openclaw@(sha256:[0-9a-f]{64})", re.MULTILINE,
)


def _match_candidates(model_id: str) -> Tuple[str, ...]:
    """Mirror the plugin's getModelMatchCandidates() for one id.

    It lowercases and ALSO tries a variant with `[\\s_.:]+` collapsed to `-`,
    which is how a dotted id like `anthropic.claude.sonnet.4` still matches the
    `-4-` rule. Testing only the raw id would under-match and reject a model the
    plugin actually caches.
    """
    lowered = model_id.lower()
    return (lowered, re.sub(r"[\s_.:]+", "-", lowered))


def _version_key(version: str) -> tuple:
    """Sort key for the plugin's YYYY.M.P[-beta.N] versions.

    A prerelease sorts BELOW its release (2026.7.1-beta.2 < 2026.7.1), matching
    semver. That specific rule is load-bearing here: plugin 2026.7.1 declares
    `peerDependencies.openclaw >=2026.7.1`, so pinning the beta of the same
    number would NOT satisfy it — the trap this check exists to keep flagging.
    """
    release, _, prerelease = version.partition("-")
    numbers = tuple(
        int(part) if part.isdigit() else 0 for part in release.split(".")
    )
    if not prerelease:
        # 1 outranks 0, so a release beats any prerelease of the same numbers.
        return (numbers, 1, ())
    # Each tag becomes (kind, value) so a mixed numeric/alpha prerelease never
    # raises on compare AND numeric tags order numerically — plain str() would
    # sort beta.10 below beta.2. Numeric identifiers rank below alphanumeric,
    # per semver.
    tags = tuple(
        (0, int(part), "") if part.isdigit() else (1, 0, part)
        for part in re.split(r"[.\-]", prerelease)
        if part
    )
    return (numbers, 0, tags)


def parse_pinned_plugin_version(dockerfile_path: str) -> Tuple[Optional[str], List[str]]:
    """Read the @openclaw/amazon-bedrock-provider version pinned in the Dockerfile."""
    try:
        with open(dockerfile_path, "r", encoding="utf-8") as fh:
            source = fh.read()
    except OSError as exc:
        return None, [f"cannot read Dockerfile {dockerfile_path}: {exc}"]

    matches = _PLUGIN_PACK_RE.findall(source)
    if not matches:
        return None, [
            "Dockerfile has no `npm pack @openclaw/amazon-bedrock-provider@<version>` "
            "line — the prompt-caching gate cannot verify the pin"
        ]
    if len(set(matches)) > 1:
        return None, [
            "Dockerfile pins conflicting amazon-bedrock-provider versions: "
            + ", ".join(sorted(set(matches)))
        ]
    version = matches[0]
    violations: List[str] = []
    # The same version appears in the tar/rm filenames right after npm pack; a
    # copy-paste slip there fails the build deep in the RUN with a confusing
    # "No such file" instead of a clear version mismatch.
    for filename in (
        f"openclaw-amazon-bedrock-provider-{version}.tgz",
    ):
        if source.count(filename) < 2:
            violations.append(
                f"Dockerfile pins plugin {version} but its tar/rm filenames do "
                f"not both reference {filename}"
            )
    return version, violations


def check_host_plugin_compatibility(dockerfile_path: str) -> List[str]:
    """Assert the OpenClaw base image satisfies the plugin's host requirement.

    `npm pack` only downloads a tarball — it runs no install, so the plugin's
    `peerDependencies.openclaw` is NEVER enforced anywhere in the build. Nothing
    but this check stands between a mismatched pair and production. That matters
    most on the rollback path the Dockerfile documents: reverting the base image
    to 2026.7.1-beta.2 while leaving plugin 2026.7.1 in place produces exactly
    such a pair, and every other gate here would pass it (Codex P2 on PR #1388).

    Across every published release this plugin's peer requirement has tracked
    its own version (2026.6.11 -> >=2026.6.11, 2026.6.33 -> >=2026.6.33,
    2026.7.1 -> >=2026.7.1), so `host >= plugin` is the invariant enforced. The
    prerelease-below-release rule in _version_key is what makes the beta case
    fail rather than silently pass.
    """
    violations: List[str] = []
    try:
        with open(dockerfile_path, "r", encoding="utf-8") as fh:
            source = fh.read()
    except OSError as exc:
        return [f"cannot read Dockerfile {dockerfile_path}: {exc}"]

    plugin_version, plugin_violations = parse_pinned_plugin_version(dockerfile_path)
    violations.extend(plugin_violations)

    tag_match = _HOST_TAG_RE.search(source)
    from_match = _HOST_FROM_RE.search(source)
    if not tag_match:
        return violations + [
            "Dockerfile has no `# ghcr.io/openclaw/openclaw:<tag>` + `# index: "
            "sha256:…` pair recording the base-image version — host/plugin "
            "compatibility cannot be verified"
        ]
    if not from_match:
        return violations + [
            "Dockerfile has no digest-pinned "
            "`FROM ghcr.io/openclaw/openclaw@sha256:…` line"
        ]

    host_tag, recorded_digest = tag_match.group(1), tag_match.group(2)
    if from_match.group(1) != recorded_digest:
        # Without this the tag comment is decoration: someone could bump the
        # FROM digest and leave a stale tag, and the version check below would
        # then be comparing against a version that is not actually deployed.
        violations.append(
            f"Dockerfile FROM digest {from_match.group(1)[:19]}… does not match "
            f"the digest recorded for tag {host_tag} "
            f"({recorded_digest[:19]}…) — update the comment and the FROM "
            f"together, or the version below is not the one being built"
        )
    if plugin_version and _version_key(host_tag) < _version_key(plugin_version):
        violations.append(
            f"OpenClaw base image {host_tag} is older than amazon-bedrock-provider "
            f"{plugin_version}, which requires openclaw >= {plugin_version}. "
            f"`npm pack` does not enforce peerDependencies, so this mismatch "
            f"would ship. Move the host and plugin together."
        )
    return violations


def check_prompt_caching_reachable(
    config: dict, dockerfile_path: str,
) -> List[str]:
    """Assert a requested cacheRetention can actually be honored by the pinned plugin."""
    defaults = (config.get("agents") or {}).get("defaults") or {}
    retention = (defaults.get("params") or {}).get("cacheRetention")
    if not isinstance(retention, str) or retention == "none":
        return []  # caching not requested — nothing to guarantee

    pinned, violations = parse_pinned_plugin_version(dockerfile_path)
    if pinned is None:
        return violations

    providers = (config.get("models") or {}).get("providers") or {}
    for provider_name, provider in providers.items():
        if provider_name not in _BEDROCK_NATIVE_PROVIDERS or not isinstance(provider, dict):
            continue
        for model in provider.get("models") or []:
            if not isinstance(model, dict):
                continue
            model_id = model.get("id")
            if not isinstance(model_id, str) or not model_id:
                continue
            candidates = _match_candidates(model_id)
            # Lowest minimum among ALL matching tokens: the plugin caches as
            # soon as any one of its rules fires, so requiring the strictest
            # match would over-report.
            matched = [
                minimum
                for token, minimum in _CACHE_CAPABLE_PLUGIN_MIN.items()
                if any(token in candidate for candidate in candidates)
            ]
            required = min(matched, key=_version_key) if matched else None
            if required is None:
                violations.append(
                    f"{provider_name}/{model_id}: cacheRetention={retention!r} is "
                    f"requested but this model is not in the caching-support table "
                    f"— confirm the pinned plugin's supportsBedrockPromptCaching() "
                    f"allowlist matches it, then add it to "
                    f"_CACHE_CAPABLE_PLUGIN_MIN"
                )
                continue
            if _version_key(pinned) < _version_key(required):
                violations.append(
                    f"{provider_name}/{model_id}: cacheRetention={retention!r} needs "
                    f"amazon-bedrock-provider >= {required}, but the Dockerfile pins "
                    f"{pinned} — caching would be SILENTLY off and every turn would "
                    f"pay full input rate"
                )
    return violations


def _load(config_path: str) -> dict:
    with open(config_path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def check_context_windows(config: dict) -> List[str]:
    violations: List[str] = []
    providers = (config.get("models") or {}).get("providers") or {}
    for provider_name, provider in providers.items():
        if not isinstance(provider, dict):
            continue
        for model in provider.get("models") or []:
            if not isinstance(model, dict):
                continue
            model_id = model.get("id", "<no-id>")
            cw = model.get("contextWindow")
            if not isinstance(cw, int) or cw <= 0:
                violations.append(
                    f"{provider_name}/{model_id}: contextWindow missing or not a "
                    f"positive int ({cw!r})"
                )
                continue
            known = KNOWN_CONTEXT_WINDOWS.get(model_id)
            if known is not None and cw != known:
                violations.append(
                    f"{provider_name}/{model_id}: contextWindow {cw} != known "
                    f"value {known}"
                )
            elif known is None and not (_MIN_CONTEXT_WINDOW <= cw <= _MAX_CONTEXT_WINDOW):
                violations.append(
                    f"{provider_name}/{model_id}: contextWindow {cw} outside sane "
                    f"range [{_MIN_CONTEXT_WINDOW}, {_MAX_CONTEXT_WINDOW}]"
                )
    return violations


def check_apikey_hydration(config: dict, wrapper_path: str) -> List[str]:
    violations: List[str] = []
    try:
        with open(wrapper_path, "r", encoding="utf-8") as fh:
            wrapper_src = fh.read()
    except OSError as exc:
        return [f"cannot read wrapper {wrapper_path}: {exc}"]

    providers = (config.get("models") or {}).get("providers") or {}
    for provider_name, provider in providers.items():
        if not isinstance(provider, dict):
            continue
        api_key = provider.get("apiKey")
        if not isinstance(api_key, str) or not api_key.startswith("env:"):
            continue  # native aws-sdk providers / inline keys: nothing to hydrate
        env_var = api_key[len("env:"):].strip()
        if not env_var:
            violations.append(f"{provider_name}: apiKey 'env:' has no variable name")
            continue
        # The wrapper must actually SET this env var (hydration), i.e. contain an
        # `os.environ["VAR"]` reference — not merely the bare name as a substring.
        # A bare-name match false-passes when the var is a substring of another
        # name (e.g. `TOKEN` inside `AWS_BEARER_TOKEN_BEDROCK`) or appears only in
        # a comment, exactly the r11 "missing provider" class this gate exists to
        # catch. Accept single- or double-quoted subscript.
        hydration_markers = (
            f'os.environ["{env_var}"]',
            f"os.environ['{env_var}']",
        )
        if not any(marker in wrapper_src for marker in hydration_markers):
            violations.append(
                f"{provider_name}: apiKey env:{env_var} has no hydration path "
                f'(os.environ["{env_var}"]) in {os.path.basename(wrapper_path)}'
            )
    return violations


def run_checks(
    config_path: str, wrapper_path: str, dockerfile_path: str,
) -> Tuple[List[str], dict]:
    config = _load(config_path)
    violations = (
        check_context_windows(config)
        + check_apikey_hydration(config, wrapper_path)
        + check_prompt_caching_reachable(config, dockerfile_path)
        + check_host_plugin_compatibility(dockerfile_path)
    )
    # parse_pinned_plugin_version runs in both Dockerfile checks, so the same
    # pin complaint can arrive twice. De-duplicate, order-preserving.
    return list(dict.fromkeys(violations)), config


def main(argv: Optional[List[str]] = None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=os.path.join(here, "openclaw.json"))
    parser.add_argument("--wrapper", default=os.path.join(here, "agentcore_wrapper.py"))
    parser.add_argument("--dockerfile", default=os.path.join(here, "Dockerfile"))
    args = parser.parse_args(argv)

    try:
        violations, _ = run_checks(args.config, args.wrapper, args.dockerfile)
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if violations:
        print("CONFIG SELF-CONSISTENCY GATE FAILED:", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        return 1

    print(
        "OK — openclaw.json context windows + apiKey hydration paths + "
        "prompt-caching reachability + host/plugin compatibility consistent."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
