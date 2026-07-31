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

    def test_traversal_key_is_skipped_not_written(self):
        keys = [
            "../../home/node/.ssh/authorized_keys",  # classic zip-slip
            "../evil.txt",                            # single-level escape
            "notes/ok.md",                            # benign control
        ]
        count, downloaded, escaped = self._run_pull(keys)
        # Only the benign file downloads; both traversal keys are skipped.
        self.assertEqual(count, 1)
        self.assertEqual([k for (k, _) in downloaded], ["notes/ok.md"])
        self.assertEqual(escaped, [])
        self.assertTrue((self.root / "notes" / "ok.md").exists())

    def test_no_write_outside_workspace_dir(self):
        # Even if download_file were reached, assert nothing lands outside root.
        keys = ["../../tmp/pwned"]
        count, downloaded, escaped = self._run_pull(keys)
        self.assertEqual(count, 0)
        self.assertEqual(downloaded, [])
        self.assertEqual(escaped, [])

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

        self.assertEqual(count, 0)
        self.assertEqual(downloaded, [])
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
        ):
            with self.assertRaisesRegex(RuntimeError, "ended before"):
                workspace_sync._download_workspace_file(
                    "https://download.invalid/x",
                    destination,
                    self.root,
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
        ) as sleep:
            workspace_sync._download_workspace_file(
                "https://download.invalid/x",
                destination,
                self.root,
                8,
                {"Range": "bytes=0-7"},
            )

        self.assertEqual(destination.read_bytes(), b"restored")
        self.assertEqual(download.call_count, 2)
        self.assertEqual(
            sleep.call_args_list.count(mock.call(0.25)),
            1,
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
            (metadata.st_size, metadata.st_mtime_ns),
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
        token_path.write_text("a" * 43)
        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_FLUSH_TOKEN_PATH",
            str(token_path),
        ), mock.patch.object(
            workspace_sync.os, "geteuid", return_value=0
        ):
            self.assertEqual(
                workspace_sync._workspace_flush_headers(),
                {"X-Agent-Workspace-Flush": "a" * 43},
            )
        with mock.patch.object(
            workspace_sync,
            "WORKSPACE_FLUSH_TOKEN_PATH",
            str(token_path),
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
        # THE SAFETY INVARIANT. Skipping a download is only safe because the
        # push is additive: it walks LOCAL files and uploads them, and nothing
        # in the sync path enumerates S3 to remove keys. If a delete ever
        # appeared, an unrestored transcript would become a deleted one — the
        # same failed-READ-becomes-destructive-WRITE shape that destroyed a
        # user's agent memory on 2026-07-27.
        source = pathlib.Path(__file__).with_name("workspace_sync.py").read_text()
        for forbidden in (
            "DeleteObject",
            "delete_object",
            "DeleteObjects",
            '"operation": "delete"',
            "'operation': 'delete'",
        ):
            self.assertNotIn(
                forbidden,
                source,
                f"workspace_sync must never delete remote objects (found {forbidden})",
            )


if __name__ == "__main__":
    unittest.main()
