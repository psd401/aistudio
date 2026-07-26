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
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import workspace_sync  # noqa: E402


class _FakeResponse(io.BytesIO):
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

    def _run_pull(self, keys, prefix="userA"):
        downloaded = []

        def fake_broker(payload):
            self.assertEqual(payload, {"operation": "list"})
            return {"paths": keys}

        def fake_download_url(relative):
            downloaded.append((relative, str(self.root / relative)))
            return f"https://download.invalid/{relative}"

        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root), \
                mock.patch.object(workspace_sync, "_broker_request", side_effect=fake_broker), \
                mock.patch.object(workspace_sync, "_download_url", side_effect=fake_download_url), \
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
