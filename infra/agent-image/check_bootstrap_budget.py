#!/usr/bin/env python3
"""
Instruction-budget gate for the agent image (issue #1161).

OpenClaw auto-injects a fixed set of bootstrap files into every turn's system
prompt (SOUL.md and friends). Each file is truncated at
`agents.defaults.bootstrapMaxChars` and the whole set is capped at
`agents.defaults.bootstrapTotalMaxChars`. When a proposed rule addition pushes
a file past the per-file cap, OpenClaw SILENTLY truncates it — the tail of the
rulebook simply never reaches the model. That exact failure ran in prod for
weeks (SOUL.md truncated every boot, #1138). This module makes the budget
checkable so the build gate can reject an over-budget image on a laptop instead
of shipping a silently-lobotomized agent.

Budgets are ALWAYS read from openclaw.json — never hardcoded — so the gate
tracks the real runtime limits (32k / 80k today) automatically when they change.

Two entry modes (one source of truth for the file set + budgets):

  * --source-dir DIR  (build gate, host-side, no Docker/creds needed)
      Reconstructs the EFFECTIVE SOUL.md the Dockerfile builds
      (SOUL.md + the psd-rules SKILL.md body) and checks it alongside the other
      repo-provided bootstrap files. This is what runs in build-and-push.sh.

  * --runtime-dir DIR (in-container / runtime)
      Checks the already-built files as they sit in /home/node/.openclaw. The
      wrapper imports check_runtime_bootstrap() to emit a WARN + CloudWatch
      metric if a live image is ever over budget despite the gate.

Exit code: 0 within budget, 1 over budget (or on a usage/IO error).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, List, Optional, Tuple

# The bootstrap files OpenClaw auto-loads when present (Dockerfile lines ~326-354
# document SOUL/IDENTITY/USER/MEMORY as seeded, and AGENTS/TOOLS/HEARTBEAT/
# BOOTSTRAP as also-auto-loaded when present). SOUL.md is the only one the image
# builds by concatenation; the rest are copied/seeded as-is.
BOOTSTRAP_FILES: Tuple[str, ...] = (
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "MEMORY.md",
    "AGENTS.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "BOOTSTRAP.md",
)

# Separator the Dockerfile prints between SOUL.md and the psd-rules body. Kept
# byte-identical (including the U+2019 right single quote in "turn's") so the
# reconstructed effective size matches the built file. If the Dockerfile's
# printf changes, change it here too.
_PSD_RULES_SEPARATOR = (
    "\n\n---\n\n# Operating Rules (from psd-rules)\n\n"
    "_The following rules are concatenated from `skills/psd-rules/SKILL.md` at "
    "container build time so they are guaranteed to appear in every turn’s "
    "system prompt. Edit them in that file, not here._\n\n"
)


class BudgetError(RuntimeError):
    """Raised when budgets can't be read (missing config / bad values)."""


def read_budgets(config_path: str) -> Tuple[int, int]:
    """Return (bootstrapMaxChars, bootstrapTotalMaxChars) from openclaw.json.

    Never falls back to a hardcoded number — a missing/invalid budget is an
    error, because a gate that silently defaults would defeat its own purpose.
    """
    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            config = json.load(fh)
    except (OSError, ValueError) as exc:
        raise BudgetError(f"cannot read openclaw.json at {config_path}: {exc}") from exc

    defaults = (config.get("agents") or {}).get("defaults") or {}
    per_file = defaults.get("bootstrapMaxChars")
    total = defaults.get("bootstrapTotalMaxChars")
    if not isinstance(per_file, int) or per_file <= 0:
        raise BudgetError(
            "agents.defaults.bootstrapMaxChars missing or not a positive int "
            f"in {config_path}"
        )
    if not isinstance(total, int) or total <= 0:
        raise BudgetError(
            "agents.defaults.bootstrapTotalMaxChars missing or not a positive "
            f"int in {config_path}"
        )
    return per_file, total


def _strip_frontmatter(text: str) -> str:
    """Return everything after the SECOND `---` line (the closing YAML fence).

    Mirrors the Dockerfile awk EXACTLY (build.sh must measure what it builds):
      awk 'BEGIN{f=0} /^---[[:space:]]*$/{f++; next} f>=2{print}'
    The awk only prints once it has seen the second fence, so a file with fewer
    than two fence lines produces an EMPTY body — NOT the original text. A fence
    line is `---` anchored at the start with only trailing whitespace allowed
    (`^---[[:space:]]*$`), so a leading-indented `  ---` is NOT a fence. Using
    `line.rstrip()` (trailing only) rather than `.strip()` (both sides) matches
    that anchoring.
    """
    lines = text.splitlines(keepends=True)
    fence_count = 0
    body_start = 0
    for i, line in enumerate(lines):
        if line.rstrip() == "---":
            fence_count += 1
            if fence_count == 2:
                body_start = i + 1
                break
    if fence_count < 2:
        # awk never reached f>=2, so it printed nothing — the body is empty.
        return ""
    return "".join(lines[body_start:])


def _read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def effective_bootstrap_sizes(source_dir: str) -> Dict[str, int]:
    """Reconstruct the EFFECTIVE bootstrap file sizes the image builds.

    SOUL.md is rebuilt as `SOUL.md + separator + psd-rules body` exactly like the
    Dockerfile does; the other repo-provided files are measured as-is. Files not
    present in the repo (runtime-seeded empty stubs) contribute 0 and are
    omitted from the report.
    """
    sizes: Dict[str, int] = {}

    soul_path = os.path.join(source_dir, "SOUL.md")
    rules_path = os.path.join(source_dir, "skills", "psd-rules", "SKILL.md")
    if os.path.isfile(soul_path):
        soul = _read(soul_path)
        if os.path.isfile(rules_path):
            soul = soul + _PSD_RULES_SEPARATOR + _strip_frontmatter(_read(rules_path))
        sizes["SOUL.md"] = len(soul)

    for name in BOOTSTRAP_FILES:
        if name == "SOUL.md":
            continue
        path = os.path.join(source_dir, name)
        if os.path.isfile(path):
            sizes[name] = len(_read(path))
    return sizes


def runtime_bootstrap_sizes(runtime_dir: str) -> Dict[str, int]:
    """Measure the already-built bootstrap files in a runtime dir as-is."""
    sizes: Dict[str, int] = {}
    for name in BOOTSTRAP_FILES:
        path = os.path.join(runtime_dir, name)
        if os.path.isfile(path):
            try:
                sizes[name] = len(_read(path))
            except OSError:
                continue
    return sizes


def find_violations(
    sizes: Dict[str, int], per_file_max: int, total_max: int
) -> List[str]:
    """Return human-readable violation strings; empty list == within budget."""
    violations: List[str] = []
    for name, size in sizes.items():
        if size > per_file_max:
            violations.append(
                f"{name}: {size} chars > bootstrapMaxChars {per_file_max} "
                f"(over by {size - per_file_max})"
            )
    total = sum(sizes.values())
    if total > total_max:
        violations.append(
            f"TOTAL: {total} chars > bootstrapTotalMaxChars {total_max} "
            f"(over by {total - total_max})"
        )
    return violations


def check_runtime_bootstrap(
    config_path: str = "/home/node/.openclaw/openclaw.json",
    runtime_dir: str = "/home/node/.openclaw",
) -> List[str]:
    """Runtime helper for the wrapper. Returns violation strings (never raises).

    An empty list means within budget (or the check could not run). The wrapper
    turns a non-empty result into a WARN + BootTruncationWarn metric.
    """
    try:
        per_file, total = read_budgets(config_path)
        sizes = runtime_bootstrap_sizes(runtime_dir)
        return find_violations(sizes, per_file, total)
    except (BudgetError, OSError):
        return []


def _report(sizes: Dict[str, int], per_file_max: int, total_max: int) -> None:
    print(f"Bootstrap instruction budget (from openclaw.json):")
    print(f"  bootstrapMaxChars      = {per_file_max}")
    print(f"  bootstrapTotalMaxChars = {total_max}")
    print("Effective bootstrap files:")
    for name, size in sorted(sizes.items()):
        marker = "  OVER" if size > per_file_max else "  ok  "
        print(f"  {marker} {name:<14} {size:>7} chars")
    print(f"  ----- {'TOTAL':<14} {sum(sizes.values()):>7} chars")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "openclaw.json"),
        help="Path to openclaw.json (budgets are read from it, never hardcoded).",
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--source-dir",
        help="Repo agent-image dir; reconstructs the effective SOUL.md (build gate).",
    )
    group.add_argument(
        "--runtime-dir",
        help="Built bootstrap dir to check as-is (default /home/node/.openclaw).",
    )
    args = parser.parse_args(argv)

    try:
        per_file, total = read_budgets(args.config)
    except BudgetError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.runtime_dir:
        sizes = runtime_bootstrap_sizes(args.runtime_dir)
    else:
        source_dir = args.source_dir or os.path.dirname(os.path.abspath(__file__))
        sizes = effective_bootstrap_sizes(source_dir)

    if not sizes:
        print("ERROR: no bootstrap files found to check", file=sys.stderr)
        return 1

    _report(sizes, per_file, total)
    violations = find_violations(sizes, per_file, total)
    if violations:
        print("\nINSTRUCTION-BUDGET GATE FAILED:", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        print(
            "\nA bootstrap file exceeds the openclaw.json budget and OpenClaw "
            "would SILENTLY truncate it at boot. Trim the file (or split rules "
            "into an on-demand skill) before building.",
            file=sys.stderr,
        )
        return 1

    print("\nOK — all bootstrap files within budget.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
