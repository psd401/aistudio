#!/usr/bin/env python3
"""Fail when a shipped agent skill has no co-located eval task."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Collection, Mapping
from pathlib import Path


AGENT_IMAGE_DIR = Path(__file__).resolve().parent
DEFAULT_SKILLS_ROOT = AGENT_IMAGE_DIR / "skills"
DEFAULT_DOCKERFILE = AGENT_IMAGE_DIR / "Dockerfile"
DEFAULT_UPSTREAM_SKILL_MANIFEST = (
    AGENT_IMAGE_DIR / "eval" / "upstream-skill-inventory.json"
)

# These are shipped directories with SKILL.md files for which an invocation
# task would be misleading. Keep reasons here and in eval/README.md in sync.
LOCAL_EVAL_COVERAGE_OPT_OUTS: dict[str, str] = {
    "psd-rules": (
        "Concatenated into SOUL.md at image build time; it is global bootstrap "
        "policy rather than an independently invoked skill."
    ),
}


def load_upstream_skill_inventory(
    manifest_path: Path = DEFAULT_UPSTREAM_SKILL_MANIFEST,
    dockerfile_path: Path = DEFAULT_DOCKERFILE,
) -> tuple[set[str], dict[str, str]]:
    """Load and pin the build-added gws-* skill inventory."""

    try:
        document = json.loads(manifest_path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(
            f"could not read upstream skill manifest {manifest_path}: {error}"
        ) from error
    except json.JSONDecodeError as error:
        raise ValueError(
            f"upstream skill manifest is invalid JSON: {manifest_path}"
        ) from error
    if not isinstance(document, dict):
        raise ValueError("upstream skill manifest must be an object")

    version = document.get("version")
    source = document.get("source")
    reason = document.get("optOutReason")
    raw_skills = document.get("skills")
    if not isinstance(source, str) or not source.strip():
        raise ValueError("upstream skill manifest source must be non-empty")
    if not isinstance(version, str) or not re.fullmatch(
        r"\d+\.\d+\.\d+",
        version,
    ):
        raise ValueError(
            "upstream skill manifest version must be a semantic version"
        )
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError(
            "upstream skill manifest optOutReason must be non-empty"
        )
    if not isinstance(raw_skills, list) or not raw_skills:
        raise ValueError(
            "upstream skill manifest skills must be a non-empty list"
        )
    if not all(
        isinstance(skill, str)
        and re.fullmatch(r"gws-[a-z0-9]+(?:-[a-z0-9]+)*", skill)
        for skill in raw_skills
    ):
        raise ValueError(
            "upstream skill manifest entries must be valid gws-* names"
        )
    skills = set(raw_skills)
    if len(skills) != len(raw_skills):
        raise ValueError("upstream skill manifest contains duplicate names")
    if raw_skills != sorted(raw_skills):
        raise ValueError("upstream skill manifest skills must be sorted")

    try:
        dockerfile = dockerfile_path.read_text(encoding="utf-8")
    except OSError as error:
        raise ValueError(
            f"could not read agent Dockerfile {dockerfile_path}: {error}"
        ) from error
    docker_versions = re.findall(
        r"^ARG GWS_VERSION=([^\s#]+)\s*$",
        dockerfile,
        flags=re.MULTILINE,
    )
    if docker_versions != [version]:
        observed = ", ".join(docker_versions) or "missing"
        raise ValueError(
            "upstream skill manifest version "
            f"{version} does not match Dockerfile GWS_VERSION ({observed})"
        )
    if f"https://github.com/{source}" not in dockerfile:
        raise ValueError(
            "upstream skill manifest source does not match the Dockerfile clone"
        )
    if (
        "cp -r /tmp/gws-repo/skills/gws-* /opt/psd-skills/"
        not in dockerfile
    ):
        raise ValueError(
            "Dockerfile no longer installs the declared gws-* skill inventory"
        )

    opt_out_reason = f"Pinned {source} v{version}. {reason.strip()}"
    return skills, {skill: opt_out_reason for skill in skills}


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
    opt_outs: Mapping[str, str] | None = None,
    external_skills: Collection[str] = (),
) -> list[str]:
    """Return deterministic coverage/configuration errors."""

    active_opt_outs = (
        LOCAL_EVAL_COVERAGE_OPT_OUTS
        if opt_outs is None
        else opt_outs
    )
    local_skills = discover_skills(skills_root)
    skills = local_skills | set(external_skills)
    errors: list[str] = []

    for skill, reason in sorted(active_opt_outs.items()):
        if skill not in skills:
            errors.append(f"stale opt-out {skill!r}: no shipped SKILL.md exists")
        if not reason.strip():
            errors.append(f"opt-out {skill!r} must include a reason")

    for skill in sorted(skills - set(active_opt_outs)):
        if skill not in local_skills:
            errors.append(
                f"{skill}: build-added skill must be on the documented "
                "opt-out list"
            )
            continue
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
        upstream_skills, upstream_opt_outs = load_upstream_skill_inventory()
        opt_outs = {
            **LOCAL_EVAL_COVERAGE_OPT_OUTS,
            **upstream_opt_outs,
        }
        skills_root = args.skills_root.resolve()
        errors = coverage_gaps(
            skills_root,
            opt_outs,
            upstream_skills,
        )
    except ValueError as error:
        print(f"agent eval coverage check failed: {error}", file=sys.stderr)
        return 1
    if errors:
        print("agent eval coverage check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    skill_count = len(discover_skills(skills_root)) + len(upstream_skills)
    covered_count = skill_count - len(opt_outs)
    print(
        "agent eval coverage check passed: "
        f"{covered_count} covered, {len(opt_outs)} opted out"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
