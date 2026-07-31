#!/usr/bin/env python3
"""Verify the built image cannot restore retired exec-approval host state."""

import workspace_sync


RETIRED_PATHS = (
    "exec-approvals.json",
    "exec-approvals.json.doctor-importing",
)


def main() -> None:
    for relative in RETIRED_PATHS:
        if not workspace_sync._should_skip_relative(relative):
            raise RuntimeError(f"retired host state is sync-eligible: {relative}")
        if workspace_sync._is_checkpoint_managed_relative(relative):
            raise RuntimeError(f"retired host state is checkpoint-managed: {relative}")
        if (workspace_sync.WORKSPACE_DIR / relative).exists():
            raise RuntimeError(f"retired host state is baked into image: {relative}")

    # Exercise the actual warm-microVM cleanup path in the built image. The
    # source is a regular file and the interrupted claim is a directory so the
    # no-follow removal contract covers both shapes OpenClaw would otherwise
    # treat as a blocking legacy presence.
    source = workspace_sync.WORKSPACE_DIR / RETIRED_PATHS[0]
    claim = workspace_sync.WORKSPACE_DIR / RETIRED_PATHS[1]
    source.write_bytes(b"stale host token")
    claim.mkdir()
    (claim / "partial").write_bytes(b"interrupted")
    workspace_sync._discard_retired_local_control_state()
    for path in (source, claim):
        if path.exists():
            raise RuntimeError(f"retired host state survived cleanup: {path.name}")

    canonical_state = workspace_sync.WORKSPACE_DIR / "state/openclaw.sqlite"
    if not canonical_state.is_file():
        raise RuntimeError("canonical OpenClaw SQLite state is missing")

    print("Workspace host-state contract probe PASSED")


if __name__ == "__main__":
    main()
