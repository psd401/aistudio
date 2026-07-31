"""Compare live workspace metadata with the actual Python image contract."""

import hashlib
import json
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "infra" / "agent-image"))

import workspace_sync  # noqa: E402


def _short_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def main() -> None:
    payload = json.load(sys.stdin)
    workspaces = payload.get("workspaces")
    if not isinstance(workspaces, list):
        raise ValueError("invalid parity-probe payload")

    classification_mismatches = []
    generation_mismatches = []
    for workspace in workspaces:
        if not isinstance(workspace, dict):
            raise ValueError("invalid parity-probe workspace")
        owner_hash = workspace.get("ownerHash")
        entries = workspace.get("entries")
        if not isinstance(owner_hash, str) or not isinstance(entries, list):
            raise ValueError("invalid parity-probe workspace")
        generation_entries = {}
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("invalid parity-probe entry")
            path = entry.get("path")
            size = entry.get("size")
            e_tag = entry.get("eTag")
            if (
                not isinstance(path, str)
                or not isinstance(size, int)
                or not isinstance(e_tag, str)
            ):
                raise ValueError("invalid parity-probe entry")
            python_reason = (
                workspace_sync._workspace_relative_rejection_reason(path)
            )
            python_managed = (
                workspace_sync._is_checkpoint_managed_relative(path)
            )
            if (
                python_reason != entry.get("expectedReason")
                or python_managed != entry.get("expectedManaged")
            ):
                classification_mismatches.append(
                    f"{owner_hash}:{_short_hash(path)}"
                )
            generation_entries[path] = (size, e_tag)
        generation = workspace_sync._generation_for_entries(
            generation_entries
        )
        if generation != workspace.get("expectedGeneration"):
            generation_mismatches.append(owner_hash)

    json.dump(
        {
            "classificationMismatches": classification_mismatches,
            "generationMismatches": generation_mismatches,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
