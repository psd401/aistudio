#!/usr/bin/env python3
"""Fail when a shipped agent skill has no co-located eval task."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Mapping
from pathlib import Path


AGENT_IMAGE_DIR = Path(__file__).resolve().parent
DEFAULT_SKILLS_ROOT = AGENT_IMAGE_DIR / "skills"

# These are shipped directories with SKILL.md files for which an invocation
# task would be misleading. Keep reasons here and in eval/README.md in sync.
EVAL_COVERAGE_OPT_OUTS: dict[str, str] = {
    "psd-rules": (
        "Concatenated into SOUL.md at image build time; it is global bootstrap "
        "policy rather than an independently invoked skill."
    ),
}


def discover_skills(skills_root: Path) -> set[str]:
    """Return directory names that represent shipped skills."""

    if not skills_root.is_dir():
        raise ValueError(f"skills root does not exist: {skills_root}")
    return {
        child.name
        for child in skills_root.iterdir()
        if child.is_dir() and (child / "SKILL.md").is_file()
    }


def coverage_gaps(
    skills_root: Path,
    opt_outs: Mapping[str, str] = EVAL_COVERAGE_OPT_OUTS,
) -> list[str]:
    """Return deterministic coverage/configuration errors."""

    skills = discover_skills(skills_root)
    errors: list[str] = []

    for skill, reason in sorted(opt_outs.items()):
        if skill not in skills:
            errors.append(f"stale opt-out {skill!r}: no shipped SKILL.md exists")
        if not reason.strip():
            errors.append(f"opt-out {skill!r} must include a reason")

    for skill in sorted(skills - set(opt_outs)):
        evals_directory = skills_root / skill / "evals"
        tasks = (
            sorted(evals_directory.glob("*.yaml"))
            if evals_directory.is_dir()
            else []
        )
        if not tasks:
            errors.append(
                f"{skill}: expected at least one task in "
                f"{evals_directory.relative_to(skills_root)}"
            )

    return errors


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skills-root",
        type=Path,
        default=DEFAULT_SKILLS_ROOT,
        help="skill directory to inspect (defaults to the shipped image skills)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        errors = coverage_gaps(args.skills_root.resolve())
    except ValueError as error:
        print(f"agent eval coverage check failed: {error}", file=sys.stderr)
        return 1
    if errors:
        print("agent eval coverage check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    skill_count = len(discover_skills(args.skills_root.resolve()))
    covered_count = skill_count - len(EVAL_COVERAGE_OPT_OUTS)
    print(
        "agent eval coverage check passed: "
        f"{covered_count} covered, {len(EVAL_COVERAGE_OPT_OUTS)} opted out"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
