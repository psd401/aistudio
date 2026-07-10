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
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import workspace_sync  # noqa: E402


class _FakePaginator:
    def __init__(self, keys):
        self._keys = keys

    def paginate(self, Bucket, Prefix):  # noqa: N803 (boto3 kw casing)
        yield {"Contents": [{"Key": k} for k in self._keys]}


class _FakeS3:
    def __init__(self, keys):
        self._keys = keys
        self.downloaded = []  # list of (key, dest_str)

    def get_paginator(self, name):
        return _FakePaginator(self._keys)

    def download_file(self, bucket, key, dest):
        # Record and actually create the file so an escape would be observable
        # on disk, not just in the call log.
        self.downloaded.append((key, dest))
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        Path(dest).write_text("x", encoding="utf-8")


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
        fake = _FakeS3(keys)
        with mock.patch.object(workspace_sync, "WORKSPACE_DIR", self.root), \
                mock.patch.object(workspace_sync, "_bucket", return_value="b"), \
                mock.patch.object(workspace_sync, "_s3", return_value=fake):
            count = workspace_sync.pull_workspace(prefix)
        escaped = [d for (_, d) in fake.downloaded
                   if not Path(d).resolve().is_relative_to(self.root)]
        return count, fake.downloaded, escaped

    def test_traversal_key_is_skipped_not_written(self):
        keys = [
            "userA/../../home/node/.ssh/authorized_keys",  # classic zip-slip
            "userA/../evil.txt",                            # single-level escape
            "userA/notes/ok.md",                            # benign control
        ]
        count, downloaded, escaped = self._run_pull(keys)
        # Only the benign file downloads; both traversal keys are skipped.
        self.assertEqual(count, 1)
        self.assertEqual([k for (k, _) in downloaded], ["userA/notes/ok.md"])
        self.assertEqual(escaped, [])
        self.assertTrue((self.root / "notes" / "ok.md").exists())

    def test_no_write_outside_workspace_dir(self):
        # Even if download_file were reached, assert nothing lands outside root.
        keys = ["userA/../../tmp/pwned"]
        count, downloaded, escaped = self._run_pull(keys)
        self.assertEqual(count, 0)
        self.assertEqual(downloaded, [])
        self.assertEqual(escaped, [])

    def test_benign_nested_key_downloads(self):
        keys = ["userA/a/b/c.md"]
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
