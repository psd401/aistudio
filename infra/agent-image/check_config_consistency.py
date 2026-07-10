#!/usr/bin/env python3
"""
Config self-consistency gate for the agent image (issue #1161).

Two static asserts over openclaw.json, run on the host before build (no Docker):

  1. contextWindow sanity — every declared model's contextWindow must be a
     positive int inside a sane range, and if the model id is in the known-models
     table it must match. A fat-fingered contextWindow (20_000 instead of
     200_000, or 2_000_000) silently changes pruning behavior and cost.

  2. apiKey hydration path — every provider whose apiKey is an `env:VAR`
     placeholder must have VAR actually hydrated in agentcore_wrapper.py. A
     provider that points at an env var nothing sets boots with no credential
     and every model call 401s (the r11-class "missing provider" failure).

Exit 0 when consistent, 1 on any violation.
"""

from __future__ import annotations

import argparse
import json
import os
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


def run_checks(config_path: str, wrapper_path: str) -> Tuple[List[str], dict]:
    config = _load(config_path)
    violations = check_context_windows(config) + check_apikey_hydration(
        config, wrapper_path
    )
    return violations, config


def main(argv: Optional[List[str]] = None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=os.path.join(here, "openclaw.json"))
    parser.add_argument("--wrapper", default=os.path.join(here, "agentcore_wrapper.py"))
    args = parser.parse_args(argv)

    try:
        violations, _ = run_checks(args.config, args.wrapper)
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if violations:
        print("CONFIG SELF-CONSISTENCY GATE FAILED:", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        return 1

    print("OK — openclaw.json context windows + apiKey hydration paths consistent.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
