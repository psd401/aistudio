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
import pwd
import shutil
import subprocess
import sys
import tempfile
import threading
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

    def _run_pull(self, keys, prefix="userA"):
        downloaded = []

        def fake_broker(payload):
            self.assertEqual(payload, {"operation": "list"})
            return {"paths": keys}

        def fake_download_spec(relative):
            downloaded.append((relative, str(self.root / relative)))
            return (
                f"https://download.invalid/{relative}",
                1,
                {"Range": "bytes=0-0"},
            )

        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root), \
                mock.patch.object(workspace_sync, "_broker_request", side_effect=fake_broker), \
                mock.patch.object(workspace_sync, "_download_spec", side_effect=fake_download_spec), \
                mock.patch.object(
                    workspace_sync.urllib.request,
                    "urlopen",
                    side_effect=lambda *_args, **_kwargs: _FakeResponse(b"x"),
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

    def test_symlink_destination_cannot_change_protected_target(self):
        protected = self.root.parent / "protected-root-file"
        protected.write_text("unchanged")
        protected.chmod(0o600)
        original = protected.stat()
        (self.root / "escape.md").symlink_to(protected)

        count, downloaded, _ = self._run_pull(["escape.md"])

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


class PeriodicPushLifecycleTests(unittest.TestCase):
    def tearDown(self):
        workspace_sync.stop_periodic_push()
        t = workspace_sync._periodic_thread
        if t is not None:
            t.join(2)
        workspace_sync._periodic_thread = None

    def test_stop_resets_thread_state_and_restart_is_live(self):
        with mock.patch.object(workspace_sync, "push_workspace", return_value=0):
            workspace_sync.start_periodic_push("p", interval_s=60)
            t1 = workspace_sync._periodic_thread
            self.assertIsNotNone(t1)
            self.assertTrue(t1.is_alive())

            workspace_sync.stop_periodic_push()
            # Bug was: thread ref never reset, so restart was blocked.
            self.assertIsNone(workspace_sync._periodic_thread)
            t1.join(2)
            self.assertFalse(t1.is_alive())

            workspace_sync.start_periodic_push("p", interval_s=60)
            t2 = workspace_sync._periodic_thread
            self.assertIsNotNone(t2)
            self.assertTrue(t2.is_alive())
            self.assertIsNot(t2, t1)  # genuinely a new pusher
            # Bug was: reused, already-set Event → new pusher exits immediately.
            self.assertFalse(workspace_sync._periodic_stop.is_set())

    def test_restart_actually_resumes_pushing(self):
        pushed = threading.Event()
        calls = []

        def fake_push(prefix):
            calls.append(prefix)
            pushed.set()
            return 0

        with mock.patch.object(workspace_sync, "push_workspace", side_effect=fake_push):
            workspace_sync.start_periodic_push("p", interval_s=0.02)
            self.assertTrue(pushed.wait(3), "first pusher never pushed")
            t1 = workspace_sync._periodic_thread

            workspace_sync.stop_periodic_push()
            if t1 is not None:
                t1.join(3)
            pushed.clear()

            workspace_sync.start_periodic_push("p", interval_s=0.02)
            self.assertTrue(pushed.wait(3), "restarted pusher never resumed pushing")

    def test_double_start_is_noop_while_alive(self):
        with mock.patch.object(workspace_sync, "push_workspace", return_value=0):
            workspace_sync.start_periodic_push("p", interval_s=60)
            t1 = workspace_sync._periodic_thread
            workspace_sync.start_periodic_push("p", interval_s=60)
            self.assertIs(workspace_sync._periodic_thread, t1)  # no second thread

    def test_stop_joins_thread_before_returning(self):
        # gemini-code-assist review: stop_periodic_push signaled the thread to
        # stop but never joined it, so a caller could observe _periodic_thread
        # as None while the old thread was still mid-push_workspace(),
        # potentially racing a freshly started replacement thread.
        with mock.patch.object(workspace_sync, "push_workspace", return_value=0):
            workspace_sync.start_periodic_push("p", interval_s=0.01)
            t1 = workspace_sync._periodic_thread
            self.assertTrue(t1.is_alive())

            workspace_sync.stop_periodic_push()
            # If stop_periodic_push joined (rather than just signaling), the
            # thread must already be dead the instant it returns — no separate
            # join() call needed here.
            self.assertFalse(t1.is_alive(), "thread still alive immediately after stop_periodic_push() returned")


if __name__ == "__main__":
    unittest.main()
