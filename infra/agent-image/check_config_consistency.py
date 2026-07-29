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
    "zai.glm-5": 200000,
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
_PLUGIN_VERSION_ARG_RE = re.compile(
    r"^ARG\s+BEDROCK_PLUGIN_VERSION=([0-9A-Za-z.\-]+)\s*$", re.MULTILINE,
)
_PLUGIN_PACK_ARG_RE = re.compile(
    r'npm pack ["\']?@openclaw/amazon-bedrock-provider@'
    r'\$\{BEDROCK_PLUGIN_VERSION\}["\']?'
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
_HOST_IMAGE_ARG_RE = re.compile(
    r"^ARG\s+OPENCLAW_BASE_IMAGE="
    r"ghcr\.io/openclaw/openclaw@(sha256:[0-9a-f]{64})\s*$",
    re.MULTILINE,
)
_HOST_FROM_ARG_RE = re.compile(
    r"^FROM\s+\$\{OPENCLAW_BASE_IMAGE\}\s*$", re.MULTILINE,
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


def _is_claude_candidate(candidates: Tuple[str, ...]) -> bool:
    """Mirror supportsBedrockPromptCaching()'s FIRST gate.

    Before any version token is considered, the plugin requires a candidate to
    contain "claude"; a non-Claude model returns false outright. Omitting this
    made the mirror fail OPEN — `amazon.nova-4-pro` matches the `-4-` token, so
    the gate would have waved through a model the plugin never caches, shipping
    full-rate input billing exactly like the bug this gate exists to prevent
    (Codex P2 on PR #1388).

    The plugin's `AWS_BEDROCK_FORCE_CACHE=1` escape hatch is deliberately NOT
    honored here: it lives inside the non-Claude branch and we do not set it in
    this image, so treating it as an override would re-open the same hole.
    """
    return any("claude" in candidate for candidate in candidates)


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
    argument_match = _PLUGIN_VERSION_ARG_RE.search(source)
    if argument_match and _PLUGIN_PACK_ARG_RE.search(source):
        matches.append(argument_match.group(1))
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
    # The tar/rm filenames must use the same literal version or the same
    # parameter. A copy-paste slip otherwise fails deep in the RUN.
    literal_filename = f"openclaw-amazon-bedrock-provider-{version}.tgz"
    parameter_filename = (
        "openclaw-amazon-bedrock-provider-${BEDROCK_PLUGIN_VERSION}.tgz"
    )
    if (
        source.count(literal_filename) < 2
        and source.count(parameter_filename) < 2
    ):
        violations.append(
            f"Dockerfile pins plugin {version} but its tar/rm filenames do "
            "not both reference the same version parameter"
        )
    return version, violations


def resolve_ghcr_digest(tag: str) -> Tuple[Optional[str], Optional[str]]:
    """Ask ghcr what digest a tag actually resolves to. Returns (digest, error)."""
    import urllib.error
    import urllib.request

    repo = "openclaw/openclaw"
    try:
        token_url = (
            f"https://ghcr.io/token?scope=repository:{repo}:pull&service=ghcr.io"
        )
        with urllib.request.urlopen(token_url, timeout=15) as resp:
            token = json.loads(resp.read().decode("utf-8")).get("token")
        if not token:
            return None, "ghcr returned no pull token"
        request = urllib.request.Request(
            f"https://ghcr.io/v2/{repo}/manifests/{tag}", method="HEAD",
        )
        request.add_header("Authorization", f"Bearer {token}")
        request.add_header(
            "Accept",
            "application/vnd.oci.image.index.v1+json,"
            "application/vnd.docker.distribution.manifest.list.v2+json",
        )
        with urllib.request.urlopen(request, timeout=15) as resp:
            digest = resp.headers.get("Docker-Content-Digest")
        if not digest:
            return None, f"ghcr returned no digest for tag {tag}"
        return digest, None
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return None, f"ghcr lookup for {tag} failed: {str(exc)[:200]}"


def resolve_plugin_peer_requirement(version: str) -> Tuple[Optional[str], Optional[str]]:
    """Read the plugin's PUBLISHED peerDependencies.openclaw. Returns (spec, error).

    Uses the npm registry HTTP API directly so the gate needs no npm binary.
    """
    import urllib.error
    import urllib.request

    url = (
        "https://registry.npmjs.org/"
        f"@openclaw%2Famazon-bedrock-provider/{version}"
    )
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return None, f"npm lookup for plugin {version} failed: {str(exc)[:200]}"
    spec = (payload.get("peerDependencies") or {}).get("openclaw")
    if not isinstance(spec, str) or not spec:
        return None, f"plugin {version} declares no peerDependencies.openclaw"
    return spec, None


def check_upstream_pins(dockerfile_path: str) -> List[str]:
    """Network-backed half of the pin gate — the half local files cannot prove.

    Two things the offline checks structurally CANNOT establish (both Codex P2s
    on PR #1388):

      1. That the recorded tag resolves to the pinned digest. Offline we only
         compare two hand-maintained copies of the same digest, so a bump that
         updates both copies but leaves the tag stale still passes — and the
         host-version comparison then runs against a version that is not being
         built. Only the registry knows the real tag -> digest mapping.

      2. That `host >= plugin` is the actual contract. That rule was INFERRED
         from this plugin's peer requirement tracking its own version across
         five releases. A pattern is not a contract: if a later release's
         `peerDependencies.openclaw` diverges, the inferred rule could admit an
         incompatible pair or block a compatible rollback. The published
         peerDependencies is the authority.

    Opt-in (`--verify-upstream`) because the offline gate must stay runnable
    without network. build-and-push.sh passes it — that is where it matters,
    since it is the step that actually produces the image.
    """
    violations: List[str] = []
    try:
        with open(dockerfile_path, "r", encoding="utf-8") as fh:
            source = fh.read()
    except OSError as exc:
        return [f"cannot read Dockerfile {dockerfile_path}: {exc}"]

    tag_match = _HOST_TAG_RE.search(source)
    from_match = _HOST_FROM_RE.search(source)
    host_argument_match = _HOST_IMAGE_ARG_RE.search(source)
    if not from_match and host_argument_match and _HOST_FROM_ARG_RE.search(source):
        from_match = host_argument_match
    plugin_version, _ = parse_pinned_plugin_version(dockerfile_path)
    if not tag_match or not from_match:
        return ["cannot verify upstream pins — Dockerfile tag/FROM lines unreadable"]

    host_tag, from_digest = tag_match.group(1), from_match.group(1)

    actual_digest, error = resolve_ghcr_digest(host_tag)
    if error:
        violations.append(error)
    elif actual_digest != from_digest:
        violations.append(
            f"tag {host_tag} resolves to {actual_digest[:19]}… but the Dockerfile "
            f"pins {from_digest[:19]}… — the recorded tag is NOT the image being "
            f"built, so the host/plugin version check is comparing the wrong "
            f"version"
        )

    if plugin_version:
        spec, error = resolve_plugin_peer_requirement(plugin_version)
        if error:
            violations.append(error)
        else:
            minimum = re.match(r"^>=\s*([0-9A-Za-z.\-]+)$", spec.strip())
            if not minimum:
                violations.append(
                    f"plugin {plugin_version} declares peerDependencies.openclaw="
                    f"{spec!r}, which this gate cannot interpret — check it by hand "
                    f"against host {host_tag}"
                )
            elif _version_key(host_tag) < _version_key(minimum.group(1)):
                violations.append(
                    f"OpenClaw host {host_tag} does not satisfy the PUBLISHED "
                    f"requirement of plugin {plugin_version} "
                    f"(peerDependencies.openclaw={spec!r})"
                )
    return violations


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

    That rule is an INFERRED pattern, not the published contract — if a future
    release's peerDependencies stops tracking its own version, this could admit
    an incompatible pair or block a compatible rollback. check_upstream_pins
    (--verify-upstream) reads the real peerDependencies and is what the build
    actually gates on; this offline check is the fast local approximation.
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
    host_argument_match = _HOST_IMAGE_ARG_RE.search(source)
    if not from_match and host_argument_match and _HOST_FROM_ARG_RE.search(source):
        from_match = host_argument_match
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
        # NOTE the limit of this check: it compares two hand-maintained copies
        # of the same digest, so it catches "updated one, forgot the other" but
        # CANNOT prove the tag really resolves to that digest. A bump that
        # updates both copies and leaves the tag stale passes here. Only
        # check_upstream_pins (--verify-upstream) establishes the real mapping.
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
            if not _is_claude_candidate(candidates):
                violations.append(
                    f"{provider_name}/{model_id}: cacheRetention={retention!r} is "
                    f"requested but supportsBedrockPromptCaching() rejects every "
                    f"non-Claude model outright, so this would run UNCACHED at "
                    f"full input rate. Drop cacheRetention or use a model the "
                    f"plugin caches"
                )
                continue
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
    config_path: str,
    wrapper_path: str,
    dockerfile_path: str,
    verify_upstream: bool = False,
) -> Tuple[List[str], dict]:
    config = _load(config_path)
    violations = (
        check_context_windows(config)
        + check_apikey_hydration(config, wrapper_path)
        + check_prompt_caching_reachable(config, dockerfile_path)
        + check_host_plugin_compatibility(dockerfile_path)
    )
    if verify_upstream:
        violations += check_upstream_pins(dockerfile_path)
    # parse_pinned_plugin_version runs in both Dockerfile checks, so the same
    # pin complaint can arrive twice. De-duplicate, order-preserving.
    return list(dict.fromkeys(violations)), config


def main(argv: Optional[List[str]] = None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=os.path.join(here, "openclaw.json"))
    parser.add_argument("--wrapper", default=os.path.join(here, "agentcore_wrapper.py"))
    parser.add_argument("--dockerfile", default=os.path.join(here, "Dockerfile"))
    parser.add_argument(
        "--verify-upstream",
        action="store_true",
        help=(
            "Additionally verify the pins against ghcr and the npm registry: "
            "that the recorded tag really resolves to the pinned digest, and "
            "that the host satisfies the plugin's PUBLISHED "
            "peerDependencies.openclaw. Requires network; the offline checks "
            "cannot establish either fact."
        ),
    )
    args = parser.parse_args(argv)

    try:
        violations, _ = run_checks(
            args.config, args.wrapper, args.dockerfile, args.verify_upstream,
        )
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
