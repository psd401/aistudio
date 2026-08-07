"""Tests for workspace_sync restore-traversal guard + periodic-push lifecycle
(REV-COR-358).

Run:
    uv run --python 3.12 --no-project python3 -m unittest infra/agent-image/test_workspace_sync.py

workspace_sync imports only stdlib at module load (boto3 is imported lazily
inside _s3()), so no dependency stubbing is required. Tests monkeypatch
WORKSPACE_DIR to a temp dir and replace _s3()/_bucket()/push_workspace so no
network or real filesystem outside the temp dir is touched.
"""

import os
import io
import json
import pathlib
import pwd
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import re
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import workspace_sync  # noqa: E402


class _FakeResponse(io.BytesIO):
    def __init__(self, body, content_length=None):
        super().__init__(body)
        self.headers = {}
        if content_length is not None:
            self.headers["Content-Length"] = str(content_length)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()


class PullTraversalTests(unittest.TestCase):
    def setUp(self):
        # Persistent temp dir (not a context manager) so on-disk assertions in
        # the test body run before cleanup. `.resolve()` normalizes the macOS
        # /var -> /private/var symlink so containment comparisons are stable.
        td = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, td, ignore_errors=True)
        self.root = (Path(td) / "workspace")
        self.root.mkdir()
        self.root = self.root.resolve()
        if os.geteuid() == 0:
            node = pwd.getpwnam("node")
            os.chmod(Path(td), 0o755)
            os.chown(self.root, node.pw_uid, node.pw_gid)
        workspace_sync._uploaded_state.clear()
        self.addCleanup(workspace_sync._uploaded_state.clear)
        workspace_sync._force_exact_workspace_restores.clear()
        self.addCleanup(
            workspace_sync._force_exact_workspace_restores.clear
        )

    def _run_pull(self, keys, prefix="userA", entries=None, contents=None):
        downloaded = []
        response_bodies = {}

        def fake_broker(payload, **_kwargs):
            self.assertEqual(payload, {"operation": "list"})
            result = {"paths": keys}
            if entries is not None:
                result["entries"] = entries
            return result

        def fake_download_spec(relative):
            downloaded.append((relative, str(self.root / relative)))
            body = (
                contents.get(relative, b"x")
                if contents is not None
                else (
                    workspace_sync._OPENCLAW_MIGRATION_MARKER_BYTES
                    if relative == workspace_sync.OPENCLAW_MIGRATION_MARKER
                    else b"x"
                )
            )
            url = f"https://download.invalid/{relative}"
            response_bodies[url] = body
            return (
                url,
                len(body),
                {"Range": f"bytes=0-{len(body) - 1}"},
            )

        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root), \
                mock.patch.object(workspace_sync, "_broker_request", side_effect=fake_broker), \
                mock.patch.object(workspace_sync, "_download_spec", side_effect=fake_download_spec), \
                mock.patch.object(
                    workspace_sync.urllib.request,
                    "urlopen",
                    side_effect=lambda request, **_kwargs: _FakeResponse(
                        response_bodies[request.full_url]
                    ),
                ):
            count = workspace_sync.pull_workspace(prefix)
        escaped = [d for (_, d) in downloaded
                   if not Path(d).resolve().is_relative_to(self.root)]
        return count, downloaded, escaped

    def test_traversal_key_fails_the_entire_restore_before_writing(self):
        keys = [
            "../../home/node/.ssh/authorized_keys",  # classic zip-slip
            "../evil.txt",                            # single-level escape
            "notes/ok.md",                            # benign control
        ]
        with self.assertRaises(workspace_sync.WorkspaceRestoreIncomplete):
            self._run_pull(keys)
        self.assertFalse((self.root / "notes" / "ok.md").exists())

    def test_forced_restore_prunes_uncommitted_local_extras_and_restores_seed(self):
        # Dirty turn changed a required parent from a directory to a file.
        (self.root / "memory").write_bytes(b"blocking file")
        (self.root / "new-local.md").write_bytes(b"uncommitted")
        outside = self.root.parent / "outside"
        outside.mkdir()
        (outside / "sentinel").write_bytes(b"outside")
        (self.root / "state").symlink_to(outside, target_is_directory=True)
        (self.root / "leaf.md").symlink_to(outside / "sentinel")
        (self.root / "absent-link").symlink_to(outside / "sentinel")
        os.mkfifo(self.root / "absent-fifo")
        (self.root / "absent-empty-directory").mkdir()
        directory_leaf = self.root / "directory-leaf.md"
        directory_leaf.mkdir()
        (directory_leaf / "dirty-child").write_bytes(b"uncommitted")
        sidecar = (
            self.root
            / "agents"
            / "main"
            / "agent"
            / "openclaw.sqlite-wal"
        )
        sidecar.parent.mkdir(parents=True)
        sidecar.mkdir()
        (sidecar / "uncommitted-pages").write_bytes(b"WAL pages")
        reindex_lock = sidecar.parent / ".reindex-lock.sqlite"
        reindex_lock.symlink_to(outside / "sentinel")
        authored_wal = self.root / "notes-wal"
        authored_journal = self.root / "project-journal"
        authored_wal.write_bytes(b"authored")
        authored_journal.write_bytes(b"authored")
        (self.root / "IDENTITY.md").write_bytes(b"dirty identity")
        (self.root / "SOUL.md").write_bytes(b"image-owned soul")
        attachment = self.root / "attachments" / "input.pdf"
        attachment.parent.mkdir()
        attachment.write_bytes(b"router input")
        workspace_sync.invalidate_local_workspace("owner-exact")

        with mock.patch.object(
            workspace_sync,
            "_IMAGE_WORKSPACE_SEEDS",
            {"IDENTITY.md": b"image identity"},
        ):
            self._run_pull(
                [
                    "memory/committed.md",
                    "state/openclaw.sqlite",
                    "leaf.md",
                    "directory-leaf.md",
                    "notes-wal",
                    "project-journal",
                ],
                prefix="owner-exact",
                contents={
                    "memory/committed.md": b"committed",
                    "state/openclaw.sqlite": b"database",
                    "leaf.md": b"committed leaf",
                    "directory-leaf.md": b"committed directory leaf",
                    "notes-wal": b"authored",
                    "project-journal": b"authored",
                },
            )

        self.assertEqual(
            (self.root / "memory" / "committed.md").read_bytes(),
            b"committed",
        )
        self.assertFalse((self.root / "new-local.md").exists())
        self.assertFalse((self.root / "absent-link").exists())
        self.assertFalse((self.root / "absent-fifo").exists())
        self.assertFalse((self.root / "absent-empty-directory").exists())
        self.assertEqual(
            (self.root / "state" / "openclaw.sqlite").read_bytes(),
            b"database",
        )
        self.assertEqual((outside / "sentinel").read_bytes(), b"outside")
        self.assertFalse((self.root / "leaf.md").is_symlink())
        self.assertEqual(
            (self.root / "leaf.md").read_bytes(),
            b"committed leaf",
        )
        self.assertTrue((self.root / "directory-leaf.md").is_file())
        self.assertEqual(
            (self.root / "directory-leaf.md").read_bytes(),
            b"committed directory leaf",
        )
        self.assertFalse(sidecar.exists())
        self.assertFalse(reindex_lock.exists())
        self.assertEqual(authored_wal.read_bytes(), b"authored")
        self.assertEqual(authored_journal.read_bytes(), b"authored")
        self.assertEqual(
            (self.root / "IDENTITY.md").read_bytes(),
            b"image identity",
        )
        self.assertEqual(
            (self.root / "SOUL.md").read_bytes(),
            b"image-owned soul",
        )
        self.assertEqual(attachment.read_bytes(), b"router input")
        self.assertNotIn(
            "owner-exact",
            workspace_sync._force_exact_workspace_restores,
        )

    def test_no_write_outside_workspace_dir(self):
        # Even if download_file were reached, assert nothing lands outside root.
        keys = ["../../tmp/pwned"]
        with self.assertRaises(workspace_sync.WorkspaceRestoreIncomplete):
            self._run_pull(keys)
        self.assertFalse((self.root.parent / "tmp" / "pwned").exists())

    def test_forced_restore_removes_attachment_root_symlink_only(self):
        outside = self.root.parent / "outside-attachments"
        outside.mkdir()
        sentinel = outside / "sentinel"
        sentinel.write_bytes(b"outside")
        (self.root / "attachments").symlink_to(
            outside,
            target_is_directory=True,
        )
        workspace_sync.invalidate_local_workspace("owner-attachments")

        self._run_pull([], prefix="owner-attachments")

        self.assertFalse((self.root / "attachments").exists())
        self.assertEqual(sentinel.read_bytes(), b"outside")

    def test_benign_nested_key_downloads(self):
        keys = ["a/b/c.md"]
        count, downloaded, escaped = self._run_pull(keys)
        self.assertEqual(count, 1)
        self.assertTrue((self.root / "a" / "b" / "c.md").exists())

    def test_declared_empty_object_replaces_image_default_without_download(self):
        destination = self.root / "memory" / "cleared.md"
        destination.parent.mkdir()
        destination.write_bytes(b"image default")
        relative = "memory/cleared.md"

        count, downloaded, escaped = self._run_pull(
            [relative],
            entries=[{"path": relative, "size": 0, "lastModified": 123}],
        )

        self.assertEqual(count, 1)
        self.assertEqual(downloaded, [])
        self.assertEqual(escaped, [])
        self.assertEqual(destination.read_bytes(), b"")

    def test_first_migration_restores_every_legacy_transcript(self):
        keys = [
            "agents/main/sessions/s0001.jsonl",
            "agents/main/sessions/s0002.jsonl",
            "openclaw-workspace-state.json",
            "workspace-attestations/setup.attested",
            "memory/MEMORY.md",
        ]
        count, downloaded, _ = self._run_pull(keys)
        self.assertEqual(count, len(keys))
        self.assertEqual({path for path, _ in downloaded}, set(keys))

    def test_completed_migration_restores_sqlite_not_legacy_archive(self):
        keys = [
            workspace_sync.OPENCLAW_MIGRATION_MARKER,
            "state/openclaw.sqlite",
            "state/openclaw.sqlite-wal",
            "agents/main/agent/openclaw-agent.sqlite",
            "agents/main/agent/openclaw-agent.sqlite-shm",
            "agents/main/sessions/s0001.jsonl",
            (
                "agents/main/session-sqlite-import-archive/"
                "s0001.jsonl.imported-123"
            ),
            "openclaw-workspace-state.json",
            "workspace-attestations/setup.attested",
            "memory/MEMORY.md",
        ]
        count, downloaded, _ = self._run_pull(keys)
        restored = {path for path, _ in downloaded}
        self.assertEqual(count, 4)
        self.assertEqual(
            restored,
            {
                workspace_sync.OPENCLAW_MIGRATION_MARKER,
                "state/openclaw.sqlite",
                "agents/main/agent/openclaw-agent.sqlite",
                "memory/MEMORY.md",
            },
        )

    def test_successful_pull_primes_unchanged_push_cache(self):
        count, _, _ = self._run_pull(
            ["memory/MEMORY.md"],
            prefix="owner-cache",
            contents={"memory/MEMORY.md": b"durable"},
        )
        self.assertEqual(count, 1)

        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            self.root,
        ), mock.patch.object(
            workspace_sync,
            "_upload_spec",
        ) as prepare:
            self.assertEqual(
                workspace_sync.push_workspace("owner-cache"),
                0,
            )

        prepare.assert_not_called()

    def test_file_changed_after_pull_still_uploads(self):
        self._run_pull(
            ["memory/MEMORY.md"],
            prefix="owner-changed",
            contents={"memory/MEMORY.md": b"before"},
        )
        restored = self.root / "memory" / "MEMORY.md"
        restored.write_bytes(b"after-change")

        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            self.root,
        ), mock.patch.object(
            workspace_sync,
            "_upload_spec",
            return_value=None,
        ) as prepare:
            self.assertEqual(
                workspace_sync.push_workspace("owner-changed"),
                1,
            )

        prepare.assert_called_once()

    def test_same_size_same_mtime_replacement_still_uploads(self):
        self._run_pull(
            ["memory/MEMORY.md"],
            prefix="owner-replaced",
            contents={"memory/MEMORY.md": b"before"},
        )
        restored = self.root / "memory" / "MEMORY.md"
        original = restored.stat()
        replacement = restored.with_name("replacement.tmp")
        replacement.write_bytes(b"after!")
        os.replace(replacement, restored)
        os.utime(
            restored,
            ns=(original.st_atime_ns, original.st_mtime_ns),
        )
        self.assertEqual(restored.stat().st_mtime_ns, original.st_mtime_ns)

        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            self.root,
        ), mock.patch.object(
            workspace_sync,
            "_upload_spec",
            return_value=None,
        ) as prepare:
            self.assertEqual(
                workspace_sync.push_workspace("owner-replaced"),
                1,
            )

        prepare.assert_called_once()

    def test_incomplete_pull_commits_no_upload_cache_entries(self):
        def fake_broker(payload, **_kwargs):
            self.assertEqual(payload, {"operation": "list"})
            return {"paths": ["memory/ok.md", "memory/fail.md"]}

        def fake_download_spec(relative):
            if relative == "memory/fail.md":
                raise RuntimeError("temporary download failure")
            return ("https://download.invalid/ok", 2, {})

        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            self.root,
        ), mock.patch.object(
            workspace_sync,
            "SYNC_WORKERS",
            1,
        ), mock.patch.object(
            workspace_sync,
            "_broker_request",
            side_effect=fake_broker,
        ), mock.patch.object(
            workspace_sync,
            "_download_spec",
            side_effect=fake_download_spec,
        ), mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            return_value=_FakeResponse(b"ok"),
        ):
            with self.assertRaises(workspace_sync.WorkspaceRestoreIncomplete):
                workspace_sync.pull_workspace("owner-incomplete")

        self.assertFalse(
            any(
                key[0] == "owner-incomplete"
                for key in workspace_sync._uploaded_state
            )
        )

    def test_restored_sqlite_discards_boot_generation_sidecars(self):
        restored_source = self.root.parent / "restored.sqlite"
        connection = sqlite3.connect(restored_source)
        connection.execute("CREATE TABLE history (value TEXT NOT NULL)")
        connection.execute("INSERT INTO history VALUES ('preserved')")
        connection.commit()
        connection.close()
        restored_bytes = restored_source.read_bytes()

        destination = self.root / "state" / "openclaw.sqlite"
        destination.parent.mkdir()
        boot_connection = sqlite3.connect(destination)
        boot_connection.execute("PRAGMA journal_mode=WAL")
        boot_connection.execute("PRAGMA wal_autocheckpoint=0")
        boot_connection.execute("CREATE TABLE boot_state (value TEXT NOT NULL)")
        boot_connection.execute("INSERT INTO boot_state VALUES ('discard me')")
        boot_connection.commit()
        boot_wal = destination.with_name(f"{destination.name}-wal").read_bytes()
        boot_shm = destination.with_name(f"{destination.name}-shm").read_bytes()
        boot_connection.close()

        transient_paths = [
            destination.with_name(f"{destination.name}-wal"),
            destination.with_name(f"{destination.name}-shm"),
            destination.with_name(f"{destination.name}-journal"),
            destination.with_name(".reindex-lock.sqlite"),
            destination.with_name(".reindex-lock.sqlite-wal"),
            destination.with_name(".reindex-lock.sqlite-shm"),
            destination.with_name(".reindex-lock.sqlite-journal"),
            destination.with_name(
                f"{destination.name}.reindex-lock.sqlite"
            ),
            destination.with_name(
                f"{destination.name}.reindex-lock.sqlite-wal"
            ),
            destination.with_name(
                f"{destination.name}.reindex-lock.sqlite-shm"
            ),
            destination.with_name(
                f"{destination.name}.reindex-lock.sqlite-journal"
            ),
            destination.with_name(
                f"{destination.name}.memory-reindex-"
                "8c8ed445-b794-4d99-89f0-a309631f2977"
            ),
            destination.with_name(
                f"{destination.name}.memory-reindex-"
                "8c8ed445-b794-4d99-89f0-a309631f2977-wal"
            ),
            destination.with_name(
                f"{destination.name}.memory-reindex-"
                "8c8ed445-b794-4d99-89f0-a309631f2977-shm"
            ),
            destination.with_name(
                f"{destination.name}.memory-reindex-"
                "8c8ed445-b794-4d99-89f0-a309631f2977-journal"
            ),
        ]
        transient_paths[0].write_bytes(boot_wal)
        transient_paths[1].write_bytes(boot_shm)
        protected = self.root.parent / "protected-sidecar-target"
        protected.write_bytes(b"unchanged")
        transient_paths[2].symlink_to(protected)
        for transient in transient_paths[3:]:
            transient.write_bytes(b"boot-generation transient state")
        unrelated = destination.with_name(f"{destination.name}.backup")
        unrelated.write_bytes(b"keep")

        count, _, escaped = self._run_pull(
            ["state/openclaw.sqlite"],
            contents={"state/openclaw.sqlite": restored_bytes},
        )

        self.assertEqual(count, 1)
        self.assertEqual(escaped, [])
        self.assertTrue(all(not path.exists() for path in transient_paths))
        self.assertEqual(protected.read_bytes(), b"unchanged")
        self.assertEqual(unrelated.read_bytes(), b"keep")
        restored = sqlite3.connect(destination)
        self.assertEqual(
            restored.execute("SELECT value FROM history").fetchall(),
            [("preserved",)],
        )
        self.assertEqual(
            restored.execute("PRAGMA integrity_check").fetchone(),
            ("ok",),
        )
        restored.close()

    def test_invalid_marker_bytes_restore_legacy_archive(self):
        keys = [
            workspace_sync.OPENCLAW_MIGRATION_MARKER,
            "state/openclaw.sqlite",
            "agents/main/sessions/s0001.jsonl",
            "openclaw-workspace-state.json",
        ]

        count, downloaded, _ = self._run_pull(
            keys,
            contents={workspace_sync.OPENCLAW_MIGRATION_MARKER: b"invalid"},
        )

        self.assertEqual(count, len(keys))
        self.assertEqual({path for path, _ in downloaded}, set(keys))

    def test_restored_file_is_writable_by_model_uid(self):
        count, _, _ = self._run_pull(["memory/new.md"])
        self.assertEqual(count, 1)
        restored = self.root / "memory" / "new.md"
        if os.geteuid() == 0:
            node = pwd.getpwnam("node")
            os.chmod(self.root.parent, 0o755)

            def drop_to_node():
                os.setgid(node.pw_gid)
                os.setuid(node.pw_uid)

            result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "from pathlib import Path; "
                    f"Path({str(restored)!r}).open('a').write('node')",
                ],
                check=False,
                preexec_fn=drop_to_node,
            )
            self.assertEqual(result.returncode, 0)
        else:
            with restored.open("a") as output:
                output.write("node")

    def test_failed_object_download_marks_restore_incomplete(self):
        def fake_broker(payload, **_kwargs):
            self.assertEqual(payload, {"operation": "list"})
            return {"paths": ["memory/MEMORY.md"]}

        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            self.root,
        ), mock.patch.object(
            workspace_sync,
            "_broker_request",
            side_effect=fake_broker,
        ), mock.patch.object(
            workspace_sync,
            "_download_spec",
            side_effect=RuntimeError("temporary download failure"),
        ):
            with self.assertRaisesRegex(
                workspace_sync.WorkspaceRestoreIncomplete,
                "1 object download",
            ):
                workspace_sync.pull_workspace("userA")

    def test_symlink_destination_cannot_change_protected_target(self):
        protected = self.root.parent / "protected-root-file"
        protected.write_text("unchanged")
        protected.chmod(0o600)
        original = protected.stat()
        (self.root / "escape.md").symlink_to(protected)

        count, downloaded, _ = self._run_pull(
            ["escape.md"],
            entries=[{"path": "escape.md", "size": 0, "lastModified": 123}],
        )

        self.assertEqual(count, 1)
        self.assertEqual(downloaded, [])
        self.assertFalse((self.root / "escape.md").is_symlink())
        self.assertEqual((self.root / "escape.md").read_bytes(), b"")
        self.assertEqual(protected.read_text(), "unchanged")
        after = protected.stat()
        self.assertEqual(after.st_uid, original.st_uid)
        self.assertEqual(after.st_gid, original.st_gid)
        self.assertEqual(after.st_mode & 0o777, 0o600)

    def test_push_refuses_symlink_to_authority_file(self):
        authority = self.root.parent / "request-proof-key"
        authority.write_text("do-not-upload")
        (self.root / "memory-link").symlink_to(authority)
        broker = mock.Mock()

        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root), \
                mock.patch.object(workspace_sync.os, "geteuid", return_value=1000), \
                mock.patch.object(workspace_sync, "_broker_request", broker):
            count = workspace_sync.push_workspace("userA")

        self.assertEqual(count, 0)
        broker.assert_not_called()
        self.assertEqual(authority.read_text(), "do-not-upload")

    def test_push_rejects_symlinked_workspace_root(self):
        outside = self.root.parent / "outside-workspace"
        outside.mkdir()
        (outside / "secret").write_text("do-not-upload")
        linked_workspace = self.root.parent / "linked-workspace"
        linked_workspace.symlink_to(outside, target_is_directory=True)
        broker = mock.Mock()

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", linked_workspace
        ), mock.patch.object(workspace_sync, "_broker_request", broker):
            with self.assertRaisesRegex(
                workspace_sync.WorkspacePushIncomplete,
                "could not open directory",
            ):
                workspace_sync.push_workspace("owner")

        broker.assert_not_called()

    def test_traversal_limit_fails_before_any_upload(self):
        for index in range(10):
            (self.root / f"unsafe-{index}").symlink_to("/dev/null")
        marker = self.root / workspace_sync.OPENCLAW_MIGRATION_MARKER
        marker.parent.mkdir()
        marker.write_bytes(workspace_sync._OPENCLAW_MIGRATION_MARKER_BYTES)
        broker = mock.Mock()

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync, "MAX_SYNC_ENTRIES", 3
        ), mock.patch.object(workspace_sync, "_broker_request", broker):
            with self.assertRaisesRegex(
                workspace_sync.WorkspacePushIncomplete,
                "entry-count limit",
            ):
                workspace_sync.push_workspace("owner")

        broker.assert_not_called()

    def test_expired_final_flush_deadline_stops_before_upload(self):
        (self.root / "memory.md").write_text("state")
        broker = mock.Mock()

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(workspace_sync, "_broker_request", broker):
            with self.assertRaisesRegex(TimeoutError, "deadline exceeded"):
                workspace_sync.push_workspace(
                    "owner",
                    deadline_monotonic=workspace_sync.time.monotonic() - 1,
                )

        broker.assert_not_called()


class WorkspaceGenerationFenceTests(unittest.TestCase):
    def setUp(self):
        td = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, td, ignore_errors=True)
        self.root = (Path(td) / "workspace").resolve()
        self.root.mkdir()
        workspace_sync._uploaded_state.clear()
        workspace_sync._remote_workspace_snapshots.clear()
        workspace_sync._committed_workspace_generations.clear()
        workspace_sync._atomic_checkpoint_finalization_capabilities.clear()
        workspace_sync._pending_workspace_generations.clear()
        workspace_sync._pending_workspace_completions.clear()
        workspace_sync._pending_atomic_workspace_finalizations.clear()
        workspace_sync._force_exact_workspace_restores.clear()
        self.addCleanup(workspace_sync._uploaded_state.clear)
        self.addCleanup(workspace_sync._remote_workspace_snapshots.clear)
        self.addCleanup(
            workspace_sync._committed_workspace_generations.clear
        )
        self.addCleanup(
            workspace_sync._atomic_checkpoint_finalization_capabilities.clear
        )
        self.addCleanup(workspace_sync._pending_workspace_generations.clear)
        self.addCleanup(workspace_sync._pending_workspace_completions.clear)
        self.addCleanup(
            workspace_sync._pending_atomic_workspace_finalizations.clear
        )
        self.addCleanup(
            workspace_sync._force_exact_workspace_restores.clear
        )

    def test_stale_warm_runtime_rehydrates_after_another_runtime_push(self):
        remote = {"eTag": '"generation-a"', "body": b"from-runtime-a"}
        downloads = []

        def broker(payload, **_kwargs):
            self.assertEqual(payload, {"operation": "list"})
            return {
                "paths": ["memory/MEMORY.md"],
                "entries": [{
                    "path": "memory/MEMORY.md",
                    "size": len(remote["body"]),
                    "lastModified": 1,
                    "eTag": remote["eTag"],
                }],
            }

        def download_spec(relative):
            downloads.append((relative, remote["eTag"]))
            return (
                "https://download.invalid/memory",
                len(remote["body"]),
                {"Range": f"bytes=0-{len(remote['body']) - 1}"},
            )

        def ensure(_prefix, _deadline=None):
            generation = workspace_sync._generation_for_entries({
                "memory/MEMORY.md": (
                    len(remote["body"]),
                    remote["eTag"],
                ),
            })
            return workspace_sync._EnsuredWorkspaceCheckpoint(
                generation=generation,
                snapshot=None,
            )

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_ensure_workspace_checkpoint",
            side_effect=ensure,
        ), mock.patch.object(
            workspace_sync, "_broker_request", side_effect=broker
        ), mock.patch.object(
            workspace_sync, "_download_spec", side_effect=download_spec
        ), mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            side_effect=lambda *_args, **_kwargs: _FakeResponse(
                remote["body"]
            ),
        ):
            self.assertEqual(workspace_sync.refresh_workspace("owner"), 1)
            remote.update({
                "eTag": '"generation-b"',
                "body": b"newer-history-from-runtime-a",
            })
            self.assertEqual(workspace_sync.refresh_workspace("owner"), 1)
            self.assertEqual(
                (self.root / "memory" / "MEMORY.md").read_bytes(),
                remote["body"],
            )
            retired_source = self.root / "exec-approvals.json"
            retired_source.write_bytes(b"stale host token")
            retired_claim = (
                self.root / "exec-approvals.json.doctor-importing"
            )
            retired_claim.mkdir()
            self.assertEqual(workspace_sync.refresh_workspace("owner"), 0)
            self.assertFalse(retired_source.exists())
            self.assertFalse(retired_claim.exists())

        self.assertEqual(
            downloads,
            [
                ("memory/MEMORY.md", '"generation-a"'),
                ("memory/MEMORY.md", '"generation-b"'),
            ],
        )

    def test_stale_warm_runtime_prunes_a_remote_deletion_before_next_push(self):
        remote = {
            "memory/keep.md": (b"keep", '"keep-a"'),
            "memory/deleted.md": (b"delete-me", '"delete-a"'),
        }
        downloads = []

        def broker(payload, **_kwargs):
            self.assertEqual(payload, {"operation": "list"})
            paths = sorted(remote)
            return {
                "paths": paths,
                "entries": [
                    {
                        "path": relative,
                        "size": len(remote[relative][0]),
                        "lastModified": 1,
                        "eTag": remote[relative][1],
                    }
                    for relative in paths
                ],
            }

        def download_spec(relative):
            body, e_tag = remote[relative]
            downloads.append((relative, e_tag))
            return (
                f"https://download.invalid/{relative}",
                len(body),
                {"Range": f"bytes=0-{len(body) - 1}"},
            )

        def ensure(_prefix, _deadline=None):
            generation = workspace_sync._generation_for_entries({
                relative: (len(body), e_tag)
                for relative, (body, e_tag) in remote.items()
            })
            return workspace_sync._EnsuredWorkspaceCheckpoint(
                generation=generation,
                snapshot=None,
            )

        def download(request, **_kwargs):
            relative = request.full_url.removeprefix(
                "https://download.invalid/"
            )
            return _FakeResponse(remote[relative][0])

        attachment = self.root / "attachments" / "input.pdf"
        attachment.parent.mkdir()
        attachment.write_bytes(b"router-owned")
        (self.root / "IDENTITY.md").write_bytes(b"stale model bytes")
        (self.root / "SOUL.md").write_bytes(b"image-owned soul")

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_IMAGE_WORKSPACE_SEEDS",
            {"IDENTITY.md": b"image identity"},
        ), mock.patch.object(
            workspace_sync,
            "_ensure_workspace_checkpoint",
            side_effect=ensure,
        ), mock.patch.object(
            workspace_sync, "_broker_request", side_effect=broker
        ), mock.patch.object(
            workspace_sync, "_download_spec", side_effect=download_spec
        ), mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            side_effect=download,
        ):
            self.assertEqual(workspace_sync.refresh_workspace("owner"), 2)
            self.assertTrue((self.root / "memory" / "deleted.md").exists())

            del remote["memory/deleted.md"]
            self.assertEqual(workspace_sync.refresh_workspace("owner"), 1)
            self.assertFalse(
                (self.root / "memory" / "deleted.md").exists()
            )
            self.assertEqual(
                (self.root / "memory" / "keep.md").read_bytes(),
                b"keep",
            )
            self.assertEqual(attachment.read_bytes(), b"router-owned")
            self.assertEqual(
                (self.root / "IDENTITY.md").read_bytes(),
                b"image identity",
            )
            self.assertEqual(
                (self.root / "SOUL.md").read_bytes(),
                b"image-owned soul",
            )
            self.assertEqual(workspace_sync.refresh_workspace("owner"), 0)

        self.assertEqual(
            downloads,
            [
                ("memory/deleted.md", '"delete-a"'),
                ("memory/keep.md", '"keep-a"'),
                ("memory/keep.md", '"keep-a"'),
            ],
        )
        self.assertNotIn(
            "owner",
            workspace_sync._force_exact_workspace_restores,
        )

    def test_cacheless_restart_prunes_stale_local_state_exactly(self):
        stale = self.root / "deleted-remotely.md"
        stale.write_bytes(b"must not be resurrected")
        attachment = self.root / "attachments" / "input.pdf"
        attachment.parent.mkdir()
        attachment.write_bytes(b"router-owned")
        (self.root / "IDENTITY.md").write_bytes(b"stale model bytes")
        (self.root / "SOUL.md").write_bytes(b"image-owned soul")
        retired_source = self.root / "exec-approvals.json"
        retired_source.write_bytes(b"stale runtime control")
        retired_claim = self.root / "exec-approvals.json.doctor-importing"
        retired_claim.write_bytes(b"interrupted migration")
        empty_generation = workspace_sync._generation_for_entries({})

        def broker(payload, **_kwargs):
            self.assertEqual(payload, {"operation": "list"})
            return {"paths": [], "entries": []}

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_IMAGE_WORKSPACE_SEEDS",
            {"IDENTITY.md": b"image identity"},
        ), mock.patch.object(
            workspace_sync,
            "_ensure_workspace_checkpoint",
            return_value=workspace_sync._EnsuredWorkspaceCheckpoint(
                generation=empty_generation,
                snapshot=None,
            ),
        ), mock.patch.object(
            workspace_sync, "_broker_request", side_effect=broker
        ), mock.patch.object(
            workspace_sync, "_download_spec"
        ) as download:
            self.assertNotIn(
                "owner",
                workspace_sync._remote_workspace_snapshots,
            )
            self.assertEqual(workspace_sync.refresh_workspace("owner"), 0)

        download.assert_not_called()
        self.assertFalse(stale.exists())
        self.assertEqual(attachment.read_bytes(), b"router-owned")
        self.assertEqual(
            (self.root / "IDENTITY.md").read_bytes(),
            b"image identity",
        )
        self.assertEqual(
            (self.root / "SOUL.md").read_bytes(),
            b"image-owned soul",
        )
        self.assertFalse(retired_source.exists())
        self.assertFalse(retired_claim.exists())
        self.assertNotIn(
            "owner",
            workspace_sync._force_exact_workspace_restores,
        )

    def test_incomplete_metadata_cannot_cross_checkpoint_boundary(self):
        downloads = 0

        def broker(payload, **_kwargs):
            self.assertEqual(payload, {"operation": "list"})
            return {
                "paths": ["memory/MEMORY.md"],
                "entries": [{
                    "path": "memory/MEMORY.md",
                    "size": 3,
                    "lastModified": 1,
                }],
            }

        def download_spec(_relative):
            nonlocal downloads
            downloads += 1
            return (
                "https://download.invalid/memory",
                3,
                {"Range": "bytes=0-2"},
            )

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_ensure_workspace_checkpoint",
            return_value=workspace_sync._EnsuredWorkspaceCheckpoint(
                generation="1" * 64,
                snapshot=None,
            ),
        ), mock.patch.object(
            workspace_sync, "_broker_request", side_effect=broker
        ), mock.patch.object(
            workspace_sync, "_download_spec", side_effect=download_spec
        ), mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            side_effect=lambda *_args, **_kwargs: _FakeResponse(b"old"),
        ):
            with self.assertRaises(
                workspace_sync.WorkspaceGenerationUnavailable
            ):
                workspace_sync.refresh_workspace("owner")

        self.assertEqual(downloads, 0)

    def test_refresh_consumes_inline_checkpoint_snapshot_without_list(self):
        relative = "memory/empty.md"
        e_tag = '"empty"'
        generation = workspace_sync._generation_for_entries({
            relative: (0, e_tag),
        })
        response = {
            "checkpointReady": True,
            "workspaceGeneration": generation,
            "checkpointSnapshot": {
                "workspaceGeneration": generation,
                "entries": [{
                    "path": relative,
                    "size": 0,
                    "eTag": e_tag,
                }],
            },
        }

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_broker_request",
            return_value=response,
        ) as broker, mock.patch.object(
            workspace_sync,
            "_list_remote_workspace_snapshot",
        ) as list_snapshot:
            self.assertEqual(workspace_sync.refresh_workspace("owner"), 1)

        broker.assert_called_once()
        self.assertEqual(
            broker.call_args.args[0],
            {"operation": "ensure-checkpoint"},
        )
        list_snapshot.assert_not_called()
        self.assertEqual((self.root / relative).read_bytes(), b"")
        self.assertEqual(
            workspace_sync._remote_workspace_snapshots["owner"].generation,
            generation,
        )
        self.assertEqual(
            workspace_sync._committed_workspace_generations["owner"],
            generation,
        )

    def test_refresh_falls_back_when_checkpoint_snapshot_is_absent(self):
        generation = workspace_sync._generation_for_entries({})
        response = {
            "checkpointReady": True,
            "workspaceGeneration": generation,
        }
        listed = workspace_sync._RemoteWorkspaceSnapshot(
            paths=(),
            sizes={},
            e_tags={},
            generation=generation,
        )

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_broker_request",
            return_value=response,
        ), mock.patch.object(
            workspace_sync,
            "_list_remote_workspace_snapshot",
            return_value=listed,
        ) as list_snapshot:
            self.assertEqual(workspace_sync.refresh_workspace("owner"), 0)

        list_snapshot.assert_called_once_with("owner")

    def test_refresh_records_atomic_finalization_capability_and_proof(self):
        generation = workspace_sync._generation_for_entries({})
        response = {
            "checkpointReady": True,
            "workspaceGeneration": generation,
            "atomicCheckpointCommitVersion": 1,
            "checkpointFinalizationProof": "opaque-proof",
            "checkpointSnapshot": {
                "workspaceGeneration": generation,
                "entries": [],
            },
        }

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_broker_request",
            return_value=response,
        ):
            self.assertEqual(workspace_sync.refresh_workspace("owner"), 0)

        self.assertEqual(
            workspace_sync._atomic_checkpoint_finalization_capabilities[
                "owner"
            ],
            workspace_sync._AtomicCheckpointFinalizationCapability(
                version=1,
                proof="opaque-proof",
            ),
        )

    def test_malformed_atomic_finalization_capability_fails_closed(self):
        generation = workspace_sync._generation_for_entries({})
        malformed = [
            {"atomicCheckpointCommitVersion": 1},
            {"checkpointFinalizationProof": "proof"},
            {
                "atomicCheckpointCommitVersion": True,
                "checkpointFinalizationProof": "proof",
            },
            {
                "atomicCheckpointCommitVersion": 2,
                "checkpointFinalizationProof": "proof",
            },
            {
                "atomicCheckpointCommitVersion": 1,
                "checkpointFinalizationProof": "",
            },
            {
                "atomicCheckpointCommitVersion": 1,
                "checkpointFinalizationProof": "x" * 4_097,
            },
            {
                "atomicCheckpointCommitVersion": 1,
                "checkpointFinalizationProof": "\ud800",
            },
        ]

        for capability in malformed:
            with self.subTest(capability=capability), mock.patch.object(
                workspace_sync,
                "_broker_request",
                return_value={
                    "checkpointReady": True,
                    "workspaceGeneration": generation,
                    **capability,
                },
            ):
                with self.assertRaises(
                    workspace_sync.WorkspaceGenerationUnavailable
                ):
                    workspace_sync._ensure_workspace_checkpoint("owner")

    def test_present_malformed_checkpoint_snapshot_fails_closed(self):
        generation = workspace_sync._generation_for_entries({})
        valid_entry = {
            "path": "memory/MEMORY.md",
            "size": 3,
            "eTag": '"memory"',
        }
        malformed_snapshots = [
            None,
            {},
            {
                "workspaceGeneration": generation,
                "entries": "not-an-array",
            },
            {
                "workspaceGeneration": generation,
                "entries": [{**valid_entry, "size": False}],
            },
            {
                "workspaceGeneration": generation,
                "entries": [valid_entry, valid_entry],
            },
            {
                "workspaceGeneration": generation,
                "entries": [{**valid_entry, "extra": True}],
            },
            {
                "workspaceGeneration": generation,
                "entries": [{
                    "path": "attachments/input.pdf",
                    "size": 3,
                    "eTag": '"attachment"',
                }],
            },
        ]

        for snapshot in malformed_snapshots:
            with self.subTest(snapshot=snapshot), mock.patch.object(
                workspace_sync,
                "_broker_request",
                return_value={
                    "checkpointReady": True,
                    "workspaceGeneration": generation,
                    "checkpointSnapshot": snapshot,
                },
            ):
                with self.assertRaises(
                    workspace_sync.WorkspaceGenerationUnavailable
                ):
                    workspace_sync._ensure_workspace_checkpoint("owner")

    def test_checkpoint_snapshot_generation_mismatches_fail_closed(self):
        entry = {
            "path": "memory/MEMORY.md",
            "size": 3,
            "eTag": '"memory"',
        }
        top_generation = "a" * 64
        snapshots = [
            {
                "workspaceGeneration": "b" * 64,
                "entries": [],
            },
            {
                "workspaceGeneration": top_generation,
                "entries": [entry],
            },
        ]

        for snapshot in snapshots:
            with self.subTest(snapshot=snapshot), mock.patch.object(
                workspace_sync,
                "_broker_request",
                return_value={
                    "checkpointReady": True,
                    "workspaceGeneration": top_generation,
                    "checkpointSnapshot": snapshot,
                },
            ):
                with self.assertRaises(
                    workspace_sync.WorkspaceGenerationConflict
                ):
                    workspace_sync._ensure_workspace_checkpoint("owner")

    def test_generation_mismatch_aborts_before_any_upload(self):
        (self.root / "state.sqlite").write_bytes(b"local-history")
        workspace_sync._committed_workspace_generations["owner"] = "1" * 64
        changed = workspace_sync._RemoteWorkspaceSnapshot(
            paths=(),
            sizes={},
            e_tags={},
            generation="2" * 64,
        )

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_ensure_workspace_checkpoint",
        ) as ensure, mock.patch.object(
            workspace_sync,
            "_list_remote_workspace_snapshot",
            return_value=changed,
        ), mock.patch.object(
            workspace_sync, "_upload_spec"
        ) as prepare:
            with self.assertRaises(
                workspace_sync.WorkspaceGenerationConflict
            ):
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation="1" * 64,
                    require_generation=True,
                )

        ensure.assert_not_called()
        prepare.assert_not_called()

    def test_lost_completion_response_retries_the_same_reservation(self):
        local = self.root / "state.sqlite"
        local.write_bytes(b"local-history")
        metadata = local.stat()
        old_generation = "1" * 64
        advanced_generation = workspace_sync._generation_for_entries({
            "state.sqlite": (metadata.st_size, '"new"'),
        })
        workspace_sync._pending_workspace_generations["owner"] = (
            old_generation
        )
        workspace_sync._committed_workspace_generations["owner"] = (
            old_generation
        )
        workspace_sync._pending_workspace_completions["owner"] = (
            workspace_sync._PendingWorkspaceCompletion(
                reservation_id="36bb0456-1c51-4fb8-97d1-4e87d02765ce",
                relative="state.sqlite",
                content_length=metadata.st_size,
                modified_ns=metadata.st_mtime_ns,
                changed_ns=metadata.st_ctime_ns,
            )
        )
        committed = workspace_sync._RemoteWorkspaceSnapshot(
            paths=("state.sqlite",),
            sizes={"state.sqlite": metadata.st_size},
            e_tags={"state.sqlite": '"new"'},
            generation=advanced_generation,
        )

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_ensure_workspace_checkpoint",
        ) as ensure, mock.patch.object(
            workspace_sync,
            "_list_remote_workspace_snapshot",
            return_value=committed,
        ) as list_snapshot, mock.patch.object(
            workspace_sync,
            "_complete_upload_reservation",
            return_value=(advanced_generation, '"new"'),
        ) as complete, mock.patch.object(
            workspace_sync,
            "_commit_workspace_checkpoint",
            return_value=advanced_generation,
        ), mock.patch.object(
            workspace_sync, "_upload_spec"
        ) as prepare:
            self.assertEqual(
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation=old_generation,
                    require_generation=True,
                ),
                0,
            )

        ensure.assert_not_called()
        list_snapshot.assert_called_once_with("owner", None)
        complete.assert_called_once_with(
            "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
            old_generation,
            None,
        )
        prepare.assert_not_called()
        self.assertNotIn(
            "owner", workspace_sync._pending_workspace_completions
        )
        self.assertEqual(
            workspace_sync.workspace_generation("owner"),
            advanced_generation,
        )

    def test_file_to_directory_deletes_parent_before_child_promotion(self):
        child = self.root / "a" / "b"
        child.parent.mkdir()
        child.write_bytes(b"child")
        base_generation = workspace_sync._generation_for_entries({
            "a": (4, '"old"'),
        })
        deleted_generation = workspace_sync._generation_for_entries({})
        final_generation = workspace_sync._generation_for_entries({
            "a/b": (5, '"child"'),
        })
        workspace_sync._committed_workspace_generations["owner"] = (
            base_generation
        )
        before = workspace_sync._RemoteWorkspaceSnapshot(
            paths=("a",),
            sizes={"a": 4},
            e_tags={"a": '"old"'},
            generation=base_generation,
        )
        events = []
        reservation = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
        prepared = (
            "https://upload.invalid/a-b",
            reservation,
            {
                "Content-Length": "5",
                "Content-Type": "application/octet-stream",
                "x-amz-checksum-sha256":
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            },
        )

        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            self.root,
        ), mock.patch.object(
            workspace_sync,
            "_ensure_workspace_checkpoint",
        ) as ensure, mock.patch.object(
            workspace_sync,
            "_list_remote_workspace_snapshot",
            return_value=before,
        ), mock.patch.object(
            workspace_sync,
            "_upload_spec",
            return_value=prepared,
        ), mock.patch.object(
            workspace_sync,
            "_stream_upload",
            side_effect=lambda *_args: events.append("stage"),
        ), mock.patch.object(
            workspace_sync,
            "_delete_workspace_path",
            side_effect=lambda *_args: (
                events.append("delete") or deleted_generation
            ),
        ) as delete, mock.patch.object(
            workspace_sync,
            "_complete_upload_reservation",
            side_effect=lambda *_args: (
                events.append("promote") or (final_generation, '"child"')
            ),
        ), mock.patch.object(
            workspace_sync,
            "_commit_workspace_checkpoint",
            side_effect=lambda *_args: events.append("commit")
            or final_generation,
        ):
            self.assertEqual(
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation=base_generation,
                    require_generation=True,
                ),
                2,
            )

        ensure.assert_not_called()
        delete.assert_called_once_with("a", base_generation, None)
        self.assertLess(events.index("delete"), events.index("promote"))
        self.assertLess(events.index("promote"), events.index("commit"))

    def test_fresh_push_requires_checkpoint_and_expected_generation_match(self):
        (self.root / "state.sqlite").write_bytes(b"local-history")
        expected_generation = workspace_sync._generation_for_entries({})
        workspace_sync._committed_workspace_generations["owner"] = "1" * 64
        workspace_sync._remote_workspace_snapshots["owner"] = (
            workspace_sync._RemoteWorkspaceSnapshot(
                paths=(),
                sizes={},
                e_tags={},
                generation=expected_generation,
            )
        )

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_ensure_workspace_checkpoint",
        ) as ensure, mock.patch.object(
            workspace_sync,
            "_list_remote_workspace_snapshot",
        ) as list_snapshot, mock.patch.object(
            workspace_sync,
            "_upload_spec",
        ) as prepare:
            with self.assertRaises(
                workspace_sync.WorkspaceGenerationConflict
            ):
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation=expected_generation,
                    require_generation=True,
                )

        ensure.assert_not_called()
        list_snapshot.assert_not_called()
        prepare.assert_not_called()

    def test_fresh_push_uses_verified_cache_without_preflight_scan(self):
        local = self.root / "state.sqlite"
        local.write_bytes(b"local-history")
        size = local.stat().st_size
        base_generation = workspace_sync._generation_for_entries({
            "state.sqlite": (3, '"old"'),
        })
        final_generation = workspace_sync._generation_for_entries({
            "state.sqlite": (size, '"new"'),
        })
        cached = workspace_sync._RemoteWorkspaceSnapshot(
            paths=("state.sqlite",),
            sizes={"state.sqlite": 3},
            e_tags={"state.sqlite": '"old"'},
            generation=base_generation,
        )
        workspace_sync._remote_workspace_snapshots["owner"] = cached
        workspace_sync._committed_workspace_generations["owner"] = (
            base_generation
        )
        prepared = (
            "https://upload.invalid/state",
            "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
            {
                "Content-Length": str(size),
                "Content-Type": "application/octet-stream",
                "x-amz-checksum-sha256":
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            },
        )

        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            self.root,
        ), mock.patch.object(
            workspace_sync,
            "_ensure_workspace_checkpoint",
        ) as ensure, mock.patch.object(
            workspace_sync,
            "_list_remote_workspace_snapshot",
        ) as list_snapshot, mock.patch.object(
            workspace_sync,
            "_upload_spec",
            return_value=prepared,
        ), mock.patch.object(
            workspace_sync,
            "_stream_upload",
        ), mock.patch.object(
            workspace_sync,
            "_complete_upload_reservation",
            return_value=(final_generation, '"new"'),
        ), mock.patch.object(
            workspace_sync,
            "_commit_workspace_checkpoint",
            return_value=final_generation,
        ) as commit:
            self.assertEqual(
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation=base_generation,
                    require_generation=True,
                ),
                1,
            )

        ensure.assert_not_called()
        list_snapshot.assert_not_called()
        commit.assert_called_once_with(
            "owner",
            base_generation,
            final_generation,
            None,
        )
        self.assertEqual(
            workspace_sync._remote_workspace_snapshots["owner"].generation,
            final_generation,
        )

    def test_atomic_push_finalizes_uploads_and_deletions_in_one_request(self):
        local = self.root / "state.sqlite"
        local.write_bytes(b"new-history")
        metadata = local.stat()
        reservation = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
        base_entries = {
            "deleted.md": (4, '"deleted"'),
            "state.sqlite": (3, '"old"'),
        }
        base_generation = workspace_sync._generation_for_entries(
            base_entries
        )
        final_generation = workspace_sync._generation_for_entries({
            "state.sqlite": (metadata.st_size, '"new"'),
        })
        workspace_sync._remote_workspace_snapshots["owner"] = (
            workspace_sync._RemoteWorkspaceSnapshot(
                paths=tuple(sorted(base_entries)),
                sizes={
                    relative: value[0]
                    for relative, value in base_entries.items()
                },
                e_tags={
                    relative: value[1]
                    for relative, value in base_entries.items()
                },
                generation=base_generation,
            )
        )
        workspace_sync._committed_workspace_generations["owner"] = (
            base_generation
        )
        workspace_sync._atomic_checkpoint_finalization_capabilities[
            "owner"
        ] = workspace_sync._AtomicCheckpointFinalizationCapability(
            version=1,
            proof="opaque-proof",
        )
        prepared = workspace_sync._PreparedWorkspaceUpload(
            upload_url="https://upload.invalid/state",
            reservation_id=reservation,
            required_headers={
                "Content-Length": str(metadata.st_size),
                "Content-Type": "application/octet-stream",
                "x-amz-checksum-sha256":
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            },
        )
        response = {
            "checkpointCommitted": True,
            "workspaceGeneration": final_generation,
            "uploads": [{
                "reservationId": reservation,
                "key": "owner/state.sqlite",
                "eTag": '"new"',
            }],
            "deletions": [{"path": "deleted.md", "deleted": True}],
        }

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_upload_spec",
            return_value=prepared,
        ), mock.patch.object(
            workspace_sync, "_stream_upload"
        ), mock.patch.object(
            workspace_sync,
            "_broker_request",
            return_value=response,
        ) as broker, mock.patch.object(
            workspace_sync, "_delete_workspace_path"
        ) as legacy_delete, mock.patch.object(
            workspace_sync, "_complete_upload_reservation"
        ) as legacy_complete, mock.patch.object(
            workspace_sync, "_commit_workspace_checkpoint"
        ) as legacy_commit:
            self.assertEqual(
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation=base_generation,
                    require_generation=True,
                ),
                2,
            )

        self.assertEqual(
            broker.call_args.args[0],
            {
                "operation": "finalize-checkpoint",
                "baseWorkspaceGeneration": base_generation,
                "checkpointFinalizationProof": "opaque-proof",
                "reservationIds": [reservation],
                "deletedPaths": ["deleted.md"],
            },
        )
        legacy_delete.assert_not_called()
        legacy_complete.assert_not_called()
        legacy_commit.assert_not_called()
        self.assertEqual(
            workspace_sync.workspace_generation("owner"),
            final_generation,
        )
        self.assertEqual(
            workspace_sync._uploaded_state[("owner", "state.sqlite")],
            (
                metadata.st_size,
                metadata.st_mtime_ns,
                metadata.st_ctime_ns,
            ),
        )
        self.assertNotIn(
            "owner", workspace_sync._pending_atomic_workspace_finalizations
        )
        self.assertNotIn(
            "owner",
            workspace_sync._atomic_checkpoint_finalization_capabilities,
        )

    def test_atomic_push_commits_an_empty_batch_without_legacy_calls(self):
        generation = workspace_sync._generation_for_entries({})
        workspace_sync._remote_workspace_snapshots["owner"] = (
            workspace_sync._RemoteWorkspaceSnapshot(
                paths=(), sizes={}, e_tags={}, generation=generation
            )
        )
        workspace_sync._committed_workspace_generations["owner"] = generation
        workspace_sync._atomic_checkpoint_finalization_capabilities[
            "owner"
        ] = workspace_sync._AtomicCheckpointFinalizationCapability(
            version=1,
            proof="opaque-proof",
        )
        response = {
            "checkpointCommitted": True,
            "workspaceGeneration": generation,
            "uploads": [],
            "deletions": [],
        }

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync, "_broker_request", return_value=response
        ) as broker, mock.patch.object(
            workspace_sync, "_upload_spec"
        ) as upload, mock.patch.object(
            workspace_sync, "_commit_workspace_checkpoint"
        ) as legacy_commit:
            self.assertEqual(
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation=generation,
                    require_generation=True,
                ),
                0,
            )

        self.assertEqual(
            broker.call_args.args[0],
            {
                "operation": "finalize-checkpoint",
                "baseWorkspaceGeneration": generation,
                "checkpointFinalizationProof": "opaque-proof",
                "reservationIds": [],
                "deletedPaths": [],
            },
        )
        upload.assert_not_called()
        legacy_commit.assert_not_called()

    def test_atomic_push_retries_exact_pending_batch_after_bad_generation(self):
        local = self.root / "state.sqlite"
        local.write_bytes(b"new-history")
        metadata = local.stat()
        reservation = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
        base_generation = workspace_sync._generation_for_entries({})
        final_generation = workspace_sync._generation_for_entries({
            "state.sqlite": (metadata.st_size, '"new"'),
        })
        workspace_sync._remote_workspace_snapshots["owner"] = (
            workspace_sync._RemoteWorkspaceSnapshot(
                paths=(),
                sizes={},
                e_tags={},
                generation=base_generation,
            )
        )
        workspace_sync._committed_workspace_generations["owner"] = (
            base_generation
        )
        workspace_sync._atomic_checkpoint_finalization_capabilities[
            "owner"
        ] = workspace_sync._AtomicCheckpointFinalizationCapability(
            version=1,
            proof="opaque-proof",
        )
        prepared = workspace_sync._PreparedWorkspaceUpload(
            upload_url="https://upload.invalid/state",
            reservation_id=reservation,
            required_headers={},
        )

        def response(generation):
            return {
                "checkpointCommitted": True,
                "workspaceGeneration": generation,
                "uploads": [{
                    "reservationId": reservation,
                    "key": "owner/state.sqlite",
                    "eTag": '"new"',
                }],
                "deletions": [],
            }

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_upload_spec",
            return_value=prepared,
        ) as prepare, mock.patch.object(
            workspace_sync, "_stream_upload"
        ) as stream, mock.patch.object(
            workspace_sync,
            "_broker_request",
            side_effect=[response("f" * 64), response(final_generation)],
        ) as broker:
            with self.assertRaises(
                workspace_sync.WorkspaceGenerationConflict
            ):
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation=base_generation,
                    require_generation=True,
                )
            self.assertIn(
                "owner",
                workspace_sync._pending_atomic_workspace_finalizations,
            )
            # A retry runs under a newly authenticated invocation. Its fresh
            # capability must not rewrite the exact old batch journal key.
            workspace_sync._atomic_checkpoint_finalization_capabilities[
                "owner"
            ] = workspace_sync._AtomicCheckpointFinalizationCapability(
                version=1,
                proof="new-invocation-proof",
            )
            self.assertEqual(
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation=base_generation,
                    require_generation=True,
                ),
                0,
            )

        self.assertEqual(prepare.call_count, 1)
        self.assertEqual(stream.call_count, 1)
        self.assertEqual(broker.call_count, 2)
        self.assertEqual(
            broker.call_args_list[1].args[0][
                "checkpointFinalizationProof"
            ],
            "opaque-proof",
        )
        self.assertEqual(
            workspace_sync.workspace_generation("owner"),
            final_generation,
        )

    def test_atomic_apply_rejects_upload_key_for_another_workspace(self):
        reservation = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
        pending = workspace_sync._PendingAtomicWorkspaceFinalization(
            base_generation=workspace_sync._generation_for_entries({}),
            proof="opaque-proof",
            uploads=(workspace_sync._PendingWorkspaceCompletion(
                reservation_id=reservation,
                relative="state.sqlite",
                content_length=3,
                modified_ns=1,
                changed_ns=2,
            ),),
            unchanged_uploads=(),
            deleted_paths=(),
            base_entries=(),
        )
        finalized = workspace_sync._FinalizedWorkspaceCheckpoint(
            generation=workspace_sync._generation_for_entries({
                "state.sqlite": (3, '"new"'),
            }),
            uploads=((reservation, "other-owner/state.sqlite", '"new"'),),
            deletions=(),
        )

        with self.assertRaises(workspace_sync.WorkspacePushIncomplete):
            workspace_sync._apply_atomic_workspace_finalization(
                "owner",
                pending,
                finalized,
            )

        self.assertNotIn(("owner", "state.sqlite"), workspace_sync._uploaded_state)
        self.assertNotIn("owner", workspace_sync._remote_workspace_snapshots)

    def test_atomic_finalize_response_is_exactly_validated(self):
        reservation = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
        valid = {
            "checkpointCommitted": True,
            "workspaceGeneration": "a" * 64,
            "uploads": [{
                "reservationId": reservation,
                "key": "owner/state.sqlite",
                "eTag": '"new"',
            }],
            "deletions": [{"path": "deleted.md", "deleted": True}],
        }
        malformed = [
            {**valid, "extra": True},
            {**valid, "checkpointCommitted": False},
            {**valid, "workspaceGeneration": "A" * 64},
            {**valid, "uploads": []},
            {
                **valid,
                "uploads": [{**valid["uploads"][0], "extra": True}],
            },
            {
                **valid,
                "uploads": [{
                    **valid["uploads"][0],
                    "reservationId":
                        "46bb0456-1c51-4fb8-97d1-4e87d02765ce",
                }],
            },
            {**valid, "deletions": []},
            {
                **valid,
                "deletions": [{"path": "other.md", "deleted": True}],
            },
            {
                **valid,
                "deletions": [{"path": "deleted.md", "deleted": 1}],
            },
        ]

        for result in malformed:
            with self.subTest(result=result), mock.patch.object(
                workspace_sync,
                "_broker_request",
                return_value=result,
            ):
                with self.assertRaises(
                    workspace_sync.WorkspacePushIncomplete
                ):
                    workspace_sync._finalize_workspace_checkpoint(
                        "0" * 64,
                        "opaque-proof",
                        (reservation,),
                        ("deleted.md",),
                    )

    def test_atomic_finalize_rejects_untransportable_proof_before_request(self):
        reservation = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
        for proof in ("x" * 4_097, "\ud800"):
            with self.subTest(proof_length=len(proof)), mock.patch.object(
                workspace_sync,
                "_broker_request",
            ) as broker:
                with self.assertRaises(
                    workspace_sync.WorkspacePushIncomplete
                ):
                    workspace_sync._finalize_workspace_checkpoint(
                        "0" * 64,
                        proof,
                        (reservation,),
                        (),
                    )
            broker.assert_not_called()

    def test_atomic_finalize_request_matches_route_uuid_and_item_limits(self):
        invalid_reservations = (
            # UUID version nibble must be RFC 1-8.
            "36bb0456-1c51-0fb8-97d1-4e87d02765ce",
            # UUID variant nibble must be RFC 8, 9, a, or b.
            "36bb0456-1c51-4fb8-77d1-4e87d02765ce",
        )
        for reservation in invalid_reservations:
            with self.subTest(reservation=reservation), mock.patch.object(
                workspace_sync,
                "_broker_request",
            ) as broker:
                with self.assertRaises(
                    workspace_sync.WorkspacePushIncomplete
                ):
                    workspace_sync._finalize_workspace_checkpoint(
                        "0" * 64,
                        "opaque-proof",
                        (reservation,),
                        (),
                    )
            broker.assert_not_called()

        valid_reservation = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
        with mock.patch.object(
            workspace_sync,
            "MAX_WORKSPACE_FINALIZATION_ITEMS",
            1,
        ), mock.patch.object(
            workspace_sync,
            "_broker_request",
        ) as broker:
            with self.assertRaises(workspace_sync.WorkspacePushIncomplete):
                workspace_sync._finalize_workspace_checkpoint(
                    "0" * 64,
                    "opaque-proof",
                    (valid_reservation,),
                    ("deleted.md",),
                )
        broker.assert_not_called()

    def test_atomic_finalize_falls_back_only_for_parse_time_old_route_400(self):
        local = self.root / "state.sqlite"
        local.write_bytes(b"new-history")
        metadata = local.stat()
        reservation = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
        base_generation = workspace_sync._generation_for_entries({})
        final_generation = workspace_sync._generation_for_entries({
            "state.sqlite": (metadata.st_size, '"new"'),
        })
        workspace_sync._remote_workspace_snapshots["owner"] = (
            workspace_sync._RemoteWorkspaceSnapshot(
                paths=(), sizes={}, e_tags={}, generation=base_generation
            )
        )
        workspace_sync._committed_workspace_generations["owner"] = (
            base_generation
        )
        workspace_sync._atomic_checkpoint_finalization_capabilities[
            "owner"
        ] = workspace_sync._AtomicCheckpointFinalizationCapability(
            version=1,
            proof="opaque-proof",
        )
        prepared = workspace_sync._PreparedWorkspaceUpload(
            upload_url="https://upload.invalid/state",
            reservation_id=reservation,
            required_headers={},
        )
        old_route_rejection = workspace_sync._WorkspaceBrokerHttpError(
            400,
            '{"error":"Invalid storage request"}',
            {"error": "Invalid storage request"},
        )

        def commit(prefix, base, final, _deadline):
            self.assertEqual((prefix, base, final), (
                "owner", base_generation, final_generation
            ))
            workspace_sync._committed_workspace_generations[prefix] = final
            return final

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync, "_upload_spec", return_value=prepared
        ), mock.patch.object(
            workspace_sync, "_stream_upload"
        ), mock.patch.object(
            workspace_sync,
            "_broker_request",
            side_effect=old_route_rejection,
        ), mock.patch.object(
            workspace_sync,
            "_complete_upload_reservation",
            return_value=(final_generation, '"new"'),
        ) as complete, mock.patch.object(
            workspace_sync,
            "_commit_workspace_checkpoint",
            side_effect=commit,
        ) as checkpoint:
            self.assertEqual(
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation=base_generation,
                    require_generation=True,
                ),
                1,
            )

        complete.assert_called_once_with(reservation, base_generation, None)
        checkpoint.assert_called_once()
        self.assertNotIn(
            "owner",
            workspace_sync._atomic_checkpoint_finalization_capabilities,
        )
        self.assertEqual(
            workspace_sync.workspace_generation("owner"),
            final_generation,
        )

    def test_old_route_fallback_completes_migration_marker_last(self):
        database = self.root / "state" / "openclaw.sqlite"
        database.parent.mkdir(parents=True)
        database.write_bytes(b"database")
        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root):
            workspace_sync.mark_openclaw_migration_complete()
        marker = self.root / workspace_sync.OPENCLAW_MIGRATION_MARKER
        base_generation = workspace_sync._generation_for_entries({})
        database_generation = workspace_sync._generation_for_entries({
            "state/openclaw.sqlite": (database.stat().st_size, '"database"'),
        })
        final_generation = workspace_sync._generation_for_entries({
            "state/openclaw.sqlite": (database.stat().st_size, '"database"'),
            workspace_sync.OPENCLAW_MIGRATION_MARKER: (
                marker.stat().st_size,
                '"marker"',
            ),
        })
        workspace_sync._remote_workspace_snapshots["owner"] = (
            workspace_sync._RemoteWorkspaceSnapshot(
                paths=(),
                sizes={},
                e_tags={},
                generation=base_generation,
            )
        )
        workspace_sync._committed_workspace_generations["owner"] = (
            base_generation
        )
        workspace_sync._atomic_checkpoint_finalization_capabilities[
            "owner"
        ] = workspace_sync._AtomicCheckpointFinalizationCapability(
            version=1,
            proof="opaque-proof",
        )
        reservations = {
            "state/openclaw.sqlite":
                "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
            workspace_sync.OPENCLAW_MIGRATION_MARKER:
                "46bb0456-1c51-4fb8-97d1-4e87d02765ce",
        }
        staged_paths = []
        completion_order = []

        def prepare(relative, *_args):
            staged_paths.append(relative)
            return workspace_sync._PreparedWorkspaceUpload(
                upload_url=f"https://upload.invalid/{relative}",
                reservation_id=reservations[relative],
                required_headers={},
            )

        def complete(reservation, generation, _deadline):
            completion_order.append(reservation)
            if reservation == reservations["state/openclaw.sqlite"]:
                self.assertEqual(generation, base_generation)
                return database_generation, '"database"'
            self.assertEqual(generation, database_generation)
            return final_generation, '"marker"'

        def commit(prefix, base, final, _deadline):
            self.assertEqual(
                (prefix, base, final),
                ("owner", base_generation, final_generation),
            )
            workspace_sync._committed_workspace_generations[prefix] = final
            return final

        old_route_rejection = workspace_sync._WorkspaceBrokerHttpError(
            400,
            '{"error":"Invalid storage request"}',
            {"error": "Invalid storage request"},
        )
        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync, "_upload_spec", side_effect=prepare
        ), mock.patch.object(
            workspace_sync, "_stream_upload"
        ), mock.patch.object(
            workspace_sync,
            "_broker_request",
            side_effect=old_route_rejection,
        ), mock.patch.object(
            workspace_sync,
            "_complete_upload_reservation",
            side_effect=complete,
        ), mock.patch.object(
            workspace_sync,
            "_commit_workspace_checkpoint",
            side_effect=commit,
        ):
            self.assertEqual(
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation=base_generation,
                    require_generation=True,
                ),
                2,
            )

        self.assertEqual(
            staged_paths,
            [
                "state/openclaw.sqlite",
                workspace_sync.OPENCLAW_MIGRATION_MARKER,
            ],
        )
        self.assertEqual(
            completion_order,
            [
                reservations["state/openclaw.sqlite"],
                reservations[workspace_sync.OPENCLAW_MIGRATION_MARKER],
            ],
        )

    def test_atomic_finalize_does_not_fallback_for_ambiguous_400(self):
        pending = workspace_sync._PendingAtomicWorkspaceFinalization(
            base_generation="0" * 64,
            proof="opaque-proof",
            uploads=(),
            unchanged_uploads=(),
            deleted_paths=(),
            base_entries=(),
        )
        workspace_sync._pending_workspace_generations["owner"] = "0" * 64
        workspace_sync._pending_atomic_workspace_finalizations[
            "owner"
        ] = pending
        workspace_sync._committed_workspace_generations["owner"] = "0" * 64
        ambiguous = workspace_sync._WorkspaceBrokerHttpError(
            400,
            '{"error":"Workspace storage operation failed"}',
            {"error": "Workspace storage operation failed"},
        )

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync,
            "_broker_request",
            side_effect=ambiguous,
        ), mock.patch.object(
            workspace_sync, "_commit_workspace_checkpoint"
        ) as legacy_commit:
            with self.assertRaises(workspace_sync._WorkspaceBrokerHttpError):
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation="0" * 64,
                    require_generation=True,
                )

        legacy_commit.assert_not_called()
        self.assertIs(
            workspace_sync._pending_atomic_workspace_finalizations["owner"],
            pending,
        )

    def test_pending_atomic_retry_never_falls_back_after_prior_ambiguity(self):
        generation = workspace_sync._generation_for_entries({})
        workspace_sync._remote_workspace_snapshots["owner"] = (
            workspace_sync._RemoteWorkspaceSnapshot(
                paths=(), sizes={}, e_tags={}, generation=generation
            )
        )
        workspace_sync._committed_workspace_generations["owner"] = generation
        workspace_sync._atomic_checkpoint_finalization_capabilities[
            "owner"
        ] = workspace_sync._AtomicCheckpointFinalizationCapability(
            version=1,
            proof="opaque-proof",
        )
        broker_url = (
            "http://127.0.0.1:18791"
            "/agent-broker/api/agent/workspace-storage"
        )
        transient = workspace_sync.urllib.error.HTTPError(
            broker_url,
            502,
            "Bad Gateway",
            {},
            io.BytesIO(b"temporary"),
        )
        old_route_rejection = workspace_sync.urllib.error.HTTPError(
            broker_url,
            400,
            "Bad Request",
            {},
            io.BytesIO(b'{"error":"Invalid storage request"}'),
        )
        next_invocation_old_route_rejection = (
            workspace_sync.urllib.error.HTTPError(
                broker_url,
                400,
                "Bad Request",
                {},
                io.BytesIO(b'{"error":"Invalid storage request"}'),
            )
        )

        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            side_effect=[
                transient,
                old_route_rejection,
                next_invocation_old_route_rejection,
            ],
        ) as request, mock.patch.object(
            workspace_sync.time, "sleep"
        ) as sleep, mock.patch.object(
            workspace_sync,
            "_legacy_finalize_pending_atomic_workspace",
        ) as legacy_fallback:
            with self.assertRaises(
                workspace_sync._WorkspaceBrokerHttpError
            ) as raised:
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation=generation,
                    require_generation=True,
                )
            pending = (
                workspace_sync._pending_atomic_workspace_finalizations[
                    "owner"
                ]
            )
            # The next invocation reaches an old task on its first attempt.
            # That 400 is locally parse-time-safe but cannot erase ambiguity
            # from the retained batch's earlier new-task attempt.
            with self.assertRaises(
                workspace_sync._WorkspaceBrokerHttpError
            ) as retried:
                workspace_sync.push_workspace(
                    "owner",
                    expected_generation=generation,
                    require_generation=True,
                )

        self.assertEqual(request.call_count, 3)
        sleep.assert_called_once_with(0.25)
        self.assertEqual(raised.exception.status, 400)
        self.assertEqual(raised.exception.prior_transient_attempts, 1)
        self.assertFalse(
            workspace_sync._is_side_effect_free_finalize_rejection(
                raised.exception
            )
        )
        self.assertEqual(retried.exception.status, 400)
        self.assertEqual(retried.exception.prior_transient_attempts, 0)
        self.assertTrue(
            workspace_sync._is_side_effect_free_finalize_rejection(
                retried.exception
            )
        )
        legacy_fallback.assert_not_called()
        self.assertIs(
            workspace_sync._pending_atomic_workspace_finalizations["owner"],
            pending,
        )


class BoundedTransferTests(unittest.TestCase):
    def setUp(self):
        td = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, td, ignore_errors=True)
        self.root = Path(td).resolve()

    def test_exact_download_succeeds_and_one_over_is_deleted(self):
        exact = self.root / "exact.bin"
        with mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            return_value=_FakeResponse(b"abcd", 4),
        ):
            workspace_sync._download_bounded(
                "https://download.invalid/x",
                exact,
                4,
                {"Range": "bytes=0-3"},
            )
        self.assertEqual(exact.read_bytes(), b"abcd")

        oversized = self.root / "oversized.bin"
        with mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            return_value=_FakeResponse(b"abcde"),
        ):
            with self.assertRaisesRegex(RuntimeError, "exceeded"):
                workspace_sync._download_bounded(
                    "https://download.invalid/x",
                    oversized,
                    4,
                    {"Range": "bytes=0-3"},
                )
        self.assertFalse(oversized.exists())

    def test_short_workspace_download_preserves_existing_destination(self):
        destination = self.root / "existing.bin"
        destination.write_bytes(b"existing")
        with mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            return_value=_FakeResponse(b"abc", 4),
        ), mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            self.root,
        ):
            with self.assertRaisesRegex(RuntimeError, "ended before"):
                workspace_sync._download_workspace_file(
                    "https://download.invalid/x",
                    "existing.bin",
                    4,
                    {"Range": "bytes=0-3"},
                )
        self.assertEqual(destination.read_bytes(), b"existing")

    def test_workspace_download_retries_before_installing(self):
        destination = self.root / "restored.bin"
        transient = workspace_sync.urllib.error.HTTPError(
            "https://download.invalid/x",
            503,
            "Service Unavailable",
            {},
            io.BytesIO(b"temporary"),
        )
        with mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            side_effect=[
                transient,
                _FakeResponse(b"restored", 8),
            ],
        ) as download, mock.patch.object(
            workspace_sync.time,
            "sleep",
        ) as sleep, mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            self.root,
        ):
            workspace_sync._download_workspace_file(
                "https://download.invalid/x",
                "restored.bin",
                8,
                {"Range": "bytes=0-7"},
            )

        self.assertEqual(destination.read_bytes(), b"restored")
        self.assertEqual(download.call_count, 2)
        self.assertEqual(
            sleep.call_args_list.count(mock.call(0.25)),
            1,
        )

    def test_parallel_sibling_installs_share_missing_parents_safely(self):
        from concurrent.futures import ThreadPoolExecutor
        import threading

        sources = []
        for index in range(12):
            source = self.root / f"source-{index}"
            source.write_bytes(f"value-{index}".encode())
            sources.append(source)
        workspace = self.root / "workspace"
        workspace.mkdir()
        barrier = threading.Barrier(len(sources))

        def install(index):
            barrier.wait()
            workspace_sync._install_workspace_file(
                sources[index],
                f"shared/missing/child-{index}.txt",
            )

        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            workspace,
        ):
            with ThreadPoolExecutor(max_workers=len(sources)) as pool:
                list(pool.map(install, range(len(sources))))

        for index in range(len(sources)):
            self.assertEqual(
                (
                    workspace
                    / "shared"
                    / "missing"
                    / f"child-{index}.txt"
                ).read_bytes(),
                f"value-{index}".encode(),
            )

    def test_pull_retries_exact_transient_broker_502(self):
        workspace = self.root / "workspace"
        workspace.mkdir()
        relative = "agents/main/sessions/session.jsonl"
        broker_url = (
            "http://127.0.0.1:18791"
            "/agent-broker/api/agent/workspace-storage"
        )
        transient = workspace_sync.urllib.error.HTTPError(
            broker_url,
            502,
            "Bad Gateway",
            {},
            io.BytesIO(b"<html><h1>502 Bad Gateway</h1></html>"),
        )
        list_response = _FakeResponse(
            json.dumps({"paths": [relative]}).encode("utf-8")
        )
        download_response = _FakeResponse(
            json.dumps({
                "downloadUrl": "https://download.invalid/session",
                "contentLength": 10,
                "requiredHeaders": {"Range": "bytes=0-9"},
            }).encode("utf-8")
        )
        object_response = _FakeResponse(b"history-ok", 10)

        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            workspace,
        ), mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            side_effect=[
                list_response,
                transient,
                download_response,
                object_response,
            ],
        ) as request, mock.patch.object(
            workspace_sync.time,
            "sleep",
        ) as sleep:
            self.assertEqual(workspace_sync.pull_workspace("owner"), 1)

        self.assertEqual((workspace / relative).read_bytes(), b"history-ok")
        self.assertEqual(request.call_count, 4)
        self.assertEqual(
            sleep.call_args_list.count(mock.call(0.25)),
            1,
        )

    def test_broker_does_not_retry_non_transient_rejection(self):
        forbidden = workspace_sync.urllib.error.HTTPError(
            "http://127.0.0.1:18791/agent-broker",
            403,
            "Forbidden",
            {},
            io.BytesIO(b"forbidden"),
        )
        with mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            side_effect=forbidden,
        ) as request, mock.patch.object(
            workspace_sync.time,
            "sleep",
        ) as sleep:
            with self.assertRaisesRegex(
                RuntimeError,
                "workspace broker HTTP 403",
            ):
                workspace_sync._broker_request(
                    {"operation": "download", "path": "memory.md"},
                    retry_transient=True,
                )

        self.assertEqual(request.call_count, 1)
        sleep.assert_not_called()

    def test_checkpoint_uses_extended_single_inflight_timeout(self):
        generation = "a" * 64
        response = _FakeResponse(
            json.dumps({
                "checkpointReady": True,
                "workspaceGeneration": generation,
            }).encode("utf-8")
        )
        with mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            return_value=response,
        ) as request:
            checkpoint = workspace_sync._ensure_workspace_checkpoint("owner")
            self.assertEqual(checkpoint.generation, generation)
            self.assertIsNone(checkpoint.snapshot)
        self.assertEqual(
            request.call_args.kwargs["timeout"],
            workspace_sync.WORKSPACE_CHECKPOINT_BROKER_TIMEOUT_SECONDS,
        )

        with mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            side_effect=TimeoutError("still running upstream"),
        ) as timed_out, mock.patch.object(
            workspace_sync.time,
            "sleep",
        ) as sleep:
            with self.assertRaisesRegex(
                RuntimeError,
                "workspace broker network error",
            ):
                workspace_sync._ensure_workspace_checkpoint("owner")
        self.assertEqual(timed_out.call_count, 1)
        sleep.assert_not_called()

    def test_generation_mutations_use_extended_deadline_bounded_timeout(self):
        generation = "a" * 64
        advanced = "b" * 64
        completion = _FakeResponse(
            json.dumps({
                "key": "owner/state/openclaw.sqlite",
                "eTag": '"new"',
                "workspaceGeneration": advanced,
            }).encode("utf-8")
        )
        with mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            return_value=completion,
        ) as request:
            self.assertEqual(
                workspace_sync._complete_upload_reservation(
                    "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
                    generation,
                    None,
                ),
                (advanced, '"new"'),
            )
        self.assertEqual(
            request.call_args.kwargs["timeout"],
            workspace_sync.WORKSPACE_MUTATION_BROKER_TIMEOUT_SECONDS,
        )

        deletion = _FakeResponse(
            json.dumps({
                "deleted": True,
                "workspaceGeneration": advanced,
            }).encode("utf-8")
        )
        with mock.patch.object(
            workspace_sync.time,
            "monotonic",
            return_value=100.0,
        ), mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            return_value=deletion,
        ) as request:
            self.assertEqual(
                workspace_sync._delete_workspace_path(
                    "devices/pending.json",
                    generation,
                    107.0,
                ),
                advanced,
            )
        self.assertEqual(request.call_args.kwargs["timeout"], 7.0)

    def test_spent_deadline_does_not_launch_or_retry_broker_request(self):
        with mock.patch.object(
            workspace_sync.time,
            "monotonic",
            return_value=100.0,
        ), mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
        ) as request, mock.patch.object(
            workspace_sync.time,
            "sleep",
        ) as sleep:
            with self.assertRaisesRegex(
                TimeoutError,
                "workspace sync deadline exceeded",
            ):
                workspace_sync._delete_workspace_path(
                    "devices/pending.json",
                    "a" * 64,
                    100.0,
                )
        request.assert_not_called()
        sleep.assert_not_called()

    def test_broker_exhaustion_still_fails_closed(self):
        failures = [
            workspace_sync.urllib.error.HTTPError(
                "http://127.0.0.1:18791/agent-broker",
                502,
                "Bad Gateway",
                {},
                io.BytesIO(b"temporary"),
            )
            for _ in range(5)
        ]
        with mock.patch.object(
            workspace_sync.urllib.request,
            "urlopen",
            side_effect=failures,
        ) as request, mock.patch.object(
            workspace_sync.time,
            "sleep",
        ) as sleep:
            with self.assertRaisesRegex(
                RuntimeError,
                "workspace broker HTTP 502",
            ):
                workspace_sync._broker_request(
                    {"operation": "download", "path": "memory.md"},
                    retry_transient=True,
                )

        self.assertEqual(request.call_count, 5)
        for delay in (0.25, 0.5, 1.0, 2.0):
            self.assertEqual(
                sleep.call_args_list.count(mock.call(delay)),
                1,
            )

    def test_push_never_follows_model_created_symlink(self):
        secret = self.root / "secret"
        secret.write_text("authority-token")
        workspace = self.root / "workspace"
        workspace.mkdir()
        (workspace / "leak").symlink_to(secret)
        broker = mock.Mock()
        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", workspace), \
                mock.patch.object(workspace_sync, "_broker_request", broker):
            self.assertEqual(workspace_sync.push_workspace("owner"), 0)
        broker.assert_not_called()

    def test_cold_start_unchanged_response_avoids_upload_sink(self):
        workspace = self.root / "workspace"
        workspace.mkdir()
        (workspace / "note.txt").write_bytes(b"same")

        # Assert unchanged handling, without coupling this test to a literal
        # digest value from the implementation.
        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", workspace), \
                mock.patch.object(workspace_sync, "_broker_request") as broker_mock, \
                mock.patch.object(workspace_sync, "_stream_upload") as sink:
            broker_mock.return_value = {
                "unchanged": True,
                "key": "owner/note.txt",
            }
            self.assertEqual(workspace_sync.push_workspace("owner"), 1)
        sink.assert_not_called()
        payload = broker_mock.call_args.args[0]
        self.assertEqual(payload["operation"], "upload")
        self.assertEqual(payload["contentLength"], 4)
        self.assertEqual(len(payload["checksumSha256"]), 44)

    def test_zero_byte_file_is_uploaded_not_treated_as_deleted(self):
        workspace = self.root / "workspace"
        workspace.mkdir()
        (workspace / "empty.txt").write_bytes(b"")
        prepared = (
            "https://upload.invalid/empty",
            "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
            {
                "Content-Length": "0",
                "Content-Type": "application/octet-stream",
                "x-amz-checksum-sha256":
                    "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            },
        )

        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            workspace,
        ), mock.patch.object(
            workspace_sync,
            "_upload_spec",
            return_value=prepared,
        ) as prepare, mock.patch.object(
            workspace_sync,
            "_stream_upload",
        ) as stream, mock.patch.object(
            workspace_sync,
            "_broker_request",
            return_value={"key": "owner/empty.txt"},
        ):
            self.assertEqual(workspace_sync.push_workspace("owner"), 1)

        self.assertEqual(prepare.call_args.args[1], 0)
        self.assertEqual(
            prepare.call_args.args[3],
            "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
        )
        self.assertEqual(stream.call_args.args[2], 0)

    def test_upload_cache_is_isolated_by_signed_workspace_prefix(self):
        workspace = self.root / "workspace"
        workspace.mkdir()
        note = workspace / "note.txt"
        note.write_bytes(b"same")
        metadata = note.stat()
        workspace_sync._uploaded_state.clear()
        workspace_sync._uploaded_state[("owner-a", "note.txt")] = (
            metadata.st_size,
            metadata.st_mtime_ns,
            metadata.st_ctime_ns,
        )
        self.addCleanup(workspace_sync._uploaded_state.clear)

        prepared = (
            "https://upload.invalid/note",
            "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
            {
                "Content-Length": "4",
                "Content-Type": "application/octet-stream",
                "x-amz-checksum-sha256":
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            },
        )
        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", workspace), \
                mock.patch.object(
                    workspace_sync, "_upload_spec", return_value=prepared
                ) as prepare, \
                mock.patch.object(workspace_sync, "_stream_upload") as sink, \
                mock.patch.object(
                    workspace_sync,
                    "_broker_request",
                    return_value={"key": "owner-b/note.txt"},
                ):
            self.assertEqual(workspace_sync.push_workspace("owner-b"), 1)
        prepare.assert_called_once()
        sink.assert_called_once()
        self.assertEqual(
            workspace_sync._uploaded_state[("owner-b", "note.txt")],
            (
                metadata.st_size,
                metadata.st_mtime_ns,
                metadata.st_ctime_ns,
            ),
        )

    def test_root_push_keeps_the_prefix_cache_in_the_long_lived_process(self):
        workspace = self.root / "workspace"
        workspace.mkdir()
        (workspace / "note.txt").write_bytes(b"same")
        workspace_sync._uploaded_state.clear()
        self.addCleanup(workspace_sync._uploaded_state.clear)
        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", workspace), \
                mock.patch.object(workspace_sync.os, "geteuid", return_value=0), \
                mock.patch.object(
                    workspace_sync, "_upload_spec", return_value=None
                ) as prepare, \
                mock.patch.object(workspace_sync.subprocess, "run") as spawn:
            self.assertEqual(workspace_sync.push_workspace("owner"), 1)
            self.assertEqual(workspace_sync.push_workspace("owner"), 0)
        prepare.assert_called_once()
        spawn.assert_not_called()

    def test_only_root_can_attach_final_flush_authority(self):
        token_path = self.root / "workspace-flush-token"
        sync_path = self.root / "workspace-sync-token"
        token_path.write_text("a" * 43)
        sync_path.write_text("b" * 43)
        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_FLUSH_TOKEN_PATH",
            str(token_path),
        ), mock.patch.object(
            workspace_sync,
            "WORKSPACE_SYNC_TOKEN_PATH",
            str(sync_path),
        ), mock.patch.object(
            workspace_sync.os, "geteuid", return_value=0
        ):
            self.assertEqual(
                workspace_sync._workspace_flush_headers(),
                {
                    "X-Agent-Workspace-Sync": "b" * 43,
                    "X-Agent-Workspace-Flush": "a" * 43,
                },
            )
        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_FLUSH_TOKEN_PATH",
            str(token_path),
        ), mock.patch.object(
            workspace_sync,
            "WORKSPACE_SYNC_TOKEN_PATH",
            str(sync_path),
        ), mock.patch.object(
            workspace_sync.os, "geteuid", return_value=1000
        ):
            self.assertEqual(workspace_sync._workspace_flush_headers(), {})

    def test_upload_spec_rejects_untrusted_or_mismatched_headers(self):
        valid = {
            "uploadUrl": "https://upload.invalid/note",
            "reservationId": "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
            "requiredHeaders": {
                "Content-Length": "4",
                "Content-Type": "application/octet-stream",
                "x-amz-checksum-sha256":
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            },
        }
        with mock.patch.object(
            workspace_sync,
            "_broker_request",
            return_value=valid,
        ):
            self.assertEqual(
                workspace_sync._upload_spec(
                    "note.txt",
                    4,
                    "idempotency",
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                ),
                (
                    valid["uploadUrl"],
                    valid["reservationId"],
                    valid["requiredHeaders"],
                ),
            )
        for override in (
            {
                **valid,
                "requiredHeaders": {
                    **valid["requiredHeaders"],
                    "X-Injected": "unsafe",
                },
            },
            {
                **valid,
                "requiredHeaders": {
                    **valid["requiredHeaders"],
                    "Content-Length": "5",
                },
            },
            {
                **valid,
                "requiredHeaders": {
                    **valid["requiredHeaders"],
                    "Content-Type": "text/html",
                },
            },
            {
                **valid,
                "requiredHeaders": {
                    **valid["requiredHeaders"],
                    "x-amz-checksum-sha256":
                        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
                },
            },
        ):
            with self.subTest(headers=override["requiredHeaders"]), \
                    mock.patch.object(
                        workspace_sync,
                        "_broker_request",
                        return_value=override,
                    ):
                with self.assertRaisesRegex(RuntimeError, "bounded upload"):
                    workspace_sync._upload_spec(
                        "note.txt",
                        4,
                        "idempotency",
                        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                    )


class RestoreNeverClobbersTests(unittest.TestCase):
    """The 2026-07-27 data-loss regression.

    A restore that cannot faithfully reproduce S3 must NOT be followed by a
    push. The original failure chain was:

      restore raised (MAX_SYNC_FILES=1,000 vs a ~5,000-file workspace)
        -> container kept the image's default IDENTITY.md / MEMORY.md
        -> a later push uploaded those defaults over the real files in S3
        -> the agent lost its name and all memory

    A failed READ became a destructive WRITE.
    """

    def test_backstops_sit_above_real_workspaces(self):
        # Two live prefixes held ~5,000 objects when #1353 capped restore at
        # 1,000 and push traversal at 4,000. Any backstop below real usage is
        # a silent-truncation bug, not a safety feature.
        self.assertGreaterEqual(workspace_sync.MAX_SYNC_FILES, 100_000)
        self.assertGreaterEqual(workspace_sync.MAX_SYNC_ENTRIES, 100_000)

    def test_incomplete_restore_raises_a_typed_error(self):
        # The caller distinguishes "incomplete" from other failures so it can
        # suppress the push specifically.
        self.assertTrue(
            issubclass(workspace_sync.WorkspaceRestoreIncomplete, RuntimeError)
        )

    def test_wrapper_checkpoints_only_after_stop_and_successful_restore(self):
        # Asserted against the executable source: a push must be guarded by the
        # hydration flag and follow both gateway shutdown and SQLite checkpoint.
        with open(
            os.path.join(os.path.dirname(__file__), "agentcore_wrapper.py"),
            encoding="utf-8",
        ) as source:
            src = source.read()
        finalizer = src[
            src.index("async def _finalize_invocation_authority")
            :src.index("def _serialize_invocations")
        ]
        self.assertIn("and _workspace_prefix_hydrated", finalizer)
        self.assertLess(
            finalizer.index("adapter.shutdown"),
            finalizer.index("workspace_sync.prepare_sqlite_snapshot"),
        )
        self.assertLess(
            finalizer.index("workspace_sync.prepare_sqlite_snapshot"),
            finalizer.index("workspace_sync.push_workspace"),
        )


class RegenerableArtifactSkipTests(unittest.TestCase):
    """Dependency trees are not memory and must not be synced.

    A real workspace on 2026-07-27 held 4,989 objects, of which 3,886 (77.9%)
    were a pip virtualenv inside ONE skill. The cold-start restore took 161.7s
    before the agent could answer, while actual memory/ was 55 files.
    """

    def test_skips_regenerable_trees_at_any_depth(self):
        # These appear MID-path, which the prefix list cannot express.
        for rel in (
            "skills/hagelk-morning-brief/.tts-venv/lib/python3.11/site-packages/pip/x.py",
            "skills/foo/node_modules/left-pad/index.js",
            "skills/foo/.venv/bin/python",
            "skills/foo/venv/lib/thing.py",
            "skills/foo/__pycache__/mod.cpython-311.pyc",
            "workspace/.next/cache/blob",
        ):
            self.assertTrue(
                workspace_sync._should_skip_relative(rel),
                f"should skip regenerable path: {rel}",
            )

    def test_never_skips_memory_or_identity(self):
        # The whole point of the sync. A false positive here is data loss.
        for rel in (
            "IDENTITY.md",
            "MEMORY.md",
            "USER.md",
            "memory/2026-04-21.md",
            "memory/main.sqlite",
            "memory/.dreams/events.jsonl",
            "skills/user/my-skill/SKILL.md",
        ):
            self.assertFalse(
                workspace_sync._should_skip_relative(rel),
                f"must NOT skip user-owned path: {rel}",
            )

    def test_does_not_skip_lookalike_names(self):
        # Substring matching would wrongly catch these; segment matching does not.
        for rel in (
            "memory/venv-notes.md",
            "notes/site-packages-comparison.md",
            "memory/node_modules-explained.md",
        ):
            self.assertFalse(
                workspace_sync._should_skip_relative(rel),
                f"must NOT skip a file merely NAMED like a build dir: {rel}",
            )

    def test_visible_venv_suffix_does_not_swallow_authored_skills(self):
        # skills/user/ is the agent's OWN scratch space. A visible directory
        # that merely ends in "-venv" is an authored name, not a virtualenv,
        # and skipping it would drop the skill from both pull and push.
        for rel in (
            "skills/user/hagelk-python-venv/SKILL.md",
            "skills/user/build-a-venv/README.md",
            "memory/how-to-venv/notes.md",
        ):
            self.assertFalse(
                workspace_sync._should_skip_relative(rel),
                f"must NOT skip a visible authored dir ending in -venv: {rel}",
            )

    def test_hidden_venv_suffix_is_still_skipped(self):
        # The real-world form the skip exists for stays matched.
        for rel in (
            "skills/hagelk-morning-brief/.tts-venv/bin/python",
            "skills/foo/.build-venv/lib/thing.py",
        ):
            self.assertTrue(
                workspace_sync._should_skip_relative(rel),
                f"should skip hidden virtualenv: {rel}",
            )


class SQLitePersistenceTests(unittest.TestCase):
    """Migration keeps history and persistence never uploads live sidecars."""

    def setUp(self):
        td = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, td, ignore_errors=True)
        self.root = Path(td).resolve()
        self.root.mkdir(exist_ok=True)

    def test_transient_sqlite_files_are_skipped_in_both_directions(self):
        for relative in (
            "state/openclaw.sqlite-wal",
            "state/openclaw.sqlite-shm",
            "agents/main/agent/openclaw-agent.sqlite-journal",
            "agents/main/agent/.reindex-lock.sqlite",
            "agents/main/agent/openclaw-agent.sqlite.reindex-lock.sqlite",
            "agents/main/agent/openclaw-agent.sqlite.memory-reindex-"
            "8c8ed445-b794-4d99-89f0-a309631f2977",
            "agents/main/agent/openclaw-agent.sqlite.memory-reindex-"
            "8c8ed445-b794-4d99-89f0-a309631f2977-wal",
            "plugins.sync.lock",
        ):
            self.assertTrue(workspace_sync._should_skip_relative(relative))

    def test_marker_is_atomic_and_exact(self):
        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root):
            self.assertFalse(workspace_sync.openclaw_migration_complete())
            workspace_sync.mark_openclaw_migration_complete()
            self.assertTrue(workspace_sync.openclaw_migration_complete())

    def test_marker_upload_commits_after_database_uploads(self):
        database = self.root / "state" / "openclaw.sqlite"
        database.parent.mkdir(parents=True)
        database.write_bytes(b"database")
        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root):
            workspace_sync.mark_openclaw_migration_complete()

        prepared = []

        def prepare(relative, *_args):
            prepared.append(relative)
            return None

        workspace_sync._uploaded_state.clear()
        self.addCleanup(workspace_sync._uploaded_state.clear)
        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync, "_upload_spec", side_effect=prepare
        ):
            self.assertEqual(workspace_sync.push_workspace("owner"), 2)

        self.assertEqual(prepared[-1], workspace_sync.OPENCLAW_MIGRATION_MARKER)
        self.assertEqual(prepared[:-1], ["state/openclaw.sqlite"])

    def test_completed_migration_does_not_upload_generated_import_archive(self):
        database = self.root / "state" / "openclaw.sqlite"
        database.parent.mkdir(parents=True)
        database.write_bytes(b"database")
        archive = (
            self.root
            / "agents"
            / "main"
            / "session-sqlite-import-archive"
            / "legacy.jsonl.imported-123"
        )
        archive.parent.mkdir(parents=True)
        archive.write_bytes(b"redundant imported transcript")
        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root):
            workspace_sync.mark_openclaw_migration_complete()

        prepared = []

        def prepare(relative, *_args):
            prepared.append(relative)
            return None

        workspace_sync._uploaded_state.clear()
        self.addCleanup(workspace_sync._uploaded_state.clear)
        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_DIR",
            self.root,
        ), mock.patch.object(
            workspace_sync,
            "_upload_spec",
            side_effect=prepare,
        ):
            self.assertEqual(workspace_sync.push_workspace("owner"), 2)

        self.assertEqual(
            prepared,
            [
                "state/openclaw.sqlite",
                workspace_sync.OPENCLAW_MIGRATION_MARKER,
            ],
        )
        self.assertTrue(archive.exists())

    def test_marker_upload_is_withheld_when_database_upload_fails(self):
        database = self.root / "state" / "openclaw.sqlite"
        database.parent.mkdir(parents=True)
        database.write_bytes(b"database")
        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root):
            workspace_sync.mark_openclaw_migration_complete()

        prepared = []

        def prepare(relative, *_args):
            prepared.append(relative)
            if relative == "state/openclaw.sqlite":
                raise RuntimeError("database upload failed")
            return None

        workspace_sync._uploaded_state.clear()
        self.addCleanup(workspace_sync._uploaded_state.clear)
        with mock.patch.object(
            workspace_sync, "WORKSPACE_DIR", self.root
        ), mock.patch.object(
            workspace_sync, "_upload_spec", side_effect=prepare
        ):
            with self.assertRaisesRegex(
                workspace_sync.WorkspacePushIncomplete,
                "1 file error",
            ):
                workspace_sync.push_workspace("owner")

        self.assertEqual(prepared, ["state/openclaw.sqlite"])
        self.assertNotIn(workspace_sync.OPENCLAW_MIGRATION_MARKER, prepared)

    def test_checkpoint_includes_wal_and_validates_database(self):
        database = self.root / "state" / "openclaw.sqlite"
        database.parent.mkdir(parents=True)
        connection = sqlite3.connect(database)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE history (value TEXT NOT NULL)")
        connection.execute("INSERT INTO history VALUES ('preserved')")
        connection.commit()
        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root):
            self.assertEqual(workspace_sync.prepare_sqlite_snapshot(), 1)
        connection.close()
        restored = sqlite3.connect(database)
        self.assertEqual(
            restored.execute("SELECT value FROM history").fetchall(),
            [("preserved",)],
        )
        self.assertEqual(restored.execute("PRAGMA integrity_check").fetchone(), ("ok",))
        restored.close()

    def test_checkpoint_covers_every_persisted_sqlite_database(self):
        relative_databases = (
            "state/openclaw.sqlite",
            "tasks/runs.sqlite",
            "flows/registry.sqlite",
            "agents/main/agent/openclaw-agent.sqlite",
            "agents/main/agent/codex-home/goals_1.sqlite",
            "memory/main.sqlite",
        )
        connections = []
        for relative in relative_databases:
            database = self.root / relative
            database.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(database)
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA wal_autocheckpoint=0")
            connection.execute("CREATE TABLE durable (value TEXT NOT NULL)")
            connection.execute(
                "INSERT INTO durable VALUES (?)",
                (relative,),
            )
            connection.commit()
            connections.append(connection)
        reindex_lock = (
            self.root / "agents" / "main" / "agent" / ".reindex-lock.sqlite"
        )
        reindex_lock.write_bytes(b"not a database")

        try:
            with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root):
                self.assertEqual(
                    workspace_sync.prepare_sqlite_snapshot(),
                    len(relative_databases),
                )
        finally:
            for connection in connections:
                connection.close()

        for relative in relative_databases:
            database = self.root / relative
            restored = sqlite3.connect(database)
            self.assertEqual(
                restored.execute("SELECT value FROM durable").fetchall(),
                [(relative,)],
            )
            self.assertEqual(
                restored.execute("PRAGMA integrity_check").fetchone(),
                ("ok",),
            )
            restored.close()

    def test_checkpoint_ignores_unmanaged_sqlite_named_file(self):
        attachment = self.root / "attachments" / "not-a-database.sqlite"
        attachment.parent.mkdir()
        attachment.write_bytes(b"user attachment, not SQLite")

        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root):
            self.assertEqual(workspace_sync.prepare_sqlite_snapshot(), 0)

        self.assertEqual(
            attachment.read_bytes(),
            b"user attachment, not SQLite",
        )

    def test_legacy_archive_is_never_deleted_remotely(self):
        remote = (
            "agents/main/sessions/legacy.jsonl",
            "agents/main/session-sqlite-import-archive/"
            "legacy.jsonl.imported-123",
            "openclaw-workspace-state.json",
            "workspace-attestations/setup.attested",
            "attachments/input.pdf",
            "SOUL.md",
            "memory/removed.md",
        )

        self.assertEqual(
            workspace_sync._remote_mutable_paths_to_delete(
                remote,
                set(),
                migration_complete=True,
            ),
            ["memory/removed.md"],
        )


if __name__ == "__main__":
    unittest.main()


class ImageOwnedBootstrapExclusionTests(unittest.TestCase):
    """Every image-owned bootstrap file must be excluded from workspace sync.

    An image-owned file that is NOT excluded gets overwritten on cold-start by
    each user's S3 workspace, which predates it. It then works perfectly for a
    brand-new user and is silently absent for everyone else — which is exactly
    how it hides. This happened to SOUL.md on 2026-04-22 and again to AGENTS.md
    on 2026-08-07, when the operating rules moved into their own bootstrap file
    and the agent reported having no rules in context.

    IDENTITY/USER/MEMORY are deliberately NOT here: those are agent-written and
    user-owned, and must round-trip.
    """

    IMAGE_OWNED = ("SOUL.md", "AGENTS.md")
    USER_OWNED = ("IDENTITY.md", "USER.md", "MEMORY.md")

    def test_image_owned_bootstrap_files_never_sync(self):
        for name in self.IMAGE_OWNED:
            self.assertIn(
                name,
                workspace_sync._SKIP_RELATIVE_PREFIXES,
                f"{name} is image-owned and must be excluded from sync, or a "
                "pre-existing user's S3 workspace will overwrite it on pull",
            )

    def test_user_owned_memory_files_still_round_trip(self):
        for name in self.USER_OWNED:
            self.assertNotIn(
                name,
                workspace_sync._SKIP_RELATIVE_PREFIXES,
                f"{name} is agent-written and user-owned; excluding it would "
                "stop the agent's own memory from persisting",
            )

    def test_every_bootstrap_file_the_dockerfile_generates_is_covered(self):
        # Ties the exclusion to the Dockerfile rather than to a literal: if a
        # generated bootstrap filename changes, this fails instead of silently
        # leaving the new name unprotected.
        #
        # EVERY redirect target, not the first. `re.search` returned SOUL.md —
        # which is excluded — so the test passed while asserting nothing about
        # AGENTS.md, the very file it was written to guard. Renaming AGENTS.md
        # would not have failed it.
        dockerfile = pathlib.Path(__file__).with_name("Dockerfile").read_text()
        generated = set(
            re.findall(r"> /home/node/\.openclaw/([A-Za-z]+\.md)", dockerfile)
        )
        self.assertTrue(generated, "no generated bootstrap file found in the Dockerfile")
        # Both files the image generates today; a new one must be added here
        # AND to the policy, which is the point of the check.
        self.assertEqual(generated, {"SOUL.md", "AGENTS.md"})
        for name in sorted(generated):
            self.assertIn(
                name,
                workspace_sync._SKIP_RELATIVE_PREFIXES,
                f"the Dockerfile generates {name} but workspace sync would "
                "overwrite it from S3 on cold start",
            )
