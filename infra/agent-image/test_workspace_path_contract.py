import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import workspace_sync


class WorkspacePathContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cases_path = Path(__file__).with_name(
            "workspace_path_contract_cases.json"
        )
        cls.cases = json.loads(cases_path.read_text(encoding="utf-8"))

    def test_shared_valid_cases(self):
        for relative in self.cases["valid"]:
            with self.subTest(relative=relative):
                self.assertIsNone(
                    workspace_sync._workspace_relative_rejection_reason(
                        relative
                    )
                )
                self.assertEqual(
                    workspace_sync._validate_workspace_relative(relative),
                    tuple(relative.split("/")),
                )

    def test_shared_invalid_cases(self):
        for case in self.cases["invalid"]:
            with self.subTest(reason=case["reason"]):
                self.assertEqual(
                    workspace_sync._workspace_relative_rejection_reason(
                        case["path"]
                    ),
                    case["reason"],
                )
                with self.assertRaises(OSError):
                    workspace_sync._validate_workspace_relative(case["path"])

    def test_utf8_segment_and_depth_bounds(self):
        self.assertEqual(
            workspace_sync._workspace_relative_rejection_reason("a" * 769),
            "too-long",
        )
        self.assertEqual(
            workspace_sync._workspace_relative_rejection_reason(
                f"{'a' * 256}/file"
            ),
            "segment-too-long",
        )
        self.assertEqual(
            workspace_sync._workspace_relative_rejection_reason(
                "/".join("a" for _ in range(65))
            ),
            "too-deep",
        )
        self.assertEqual(
            workspace_sync._workspace_relative_rejection_reason("\u00e9" * 385),
            "too-long",
        )
        self.assertEqual(
            workspace_sync._workspace_relative_rejection_reason(
                "surrogate-\ud800"
            ),
            "unsupported-character",
        )

    def test_checkpoint_exclusions_are_loaded_from_shared_policy(self):
        self.assertFalse(
            workspace_sync._is_checkpoint_managed_relative(
                "skills/example/.tts-venv/lib/site-packages/pkg/file.py"
            )
        )
        self.assertFalse(
            workspace_sync._is_checkpoint_managed_relative(
                "node_modules/pkg/index.js"
            )
        )
        self.assertTrue(
            workspace_sync._is_checkpoint_managed_relative(
                "memory/notes (v2).md"
            )
        )

    def test_exec_approvals_compatibility_state_is_checkpoint_excluded(self):
        for relative in (
            "exec-approvals.json",
            "exec-approvals.json.doctor-importing",
        ):
            with self.subTest(relative=relative):
                self.assertTrue(workspace_sync._should_skip_relative(relative))
                self.assertFalse(
                    workspace_sync._is_checkpoint_managed_relative(relative)
                )
        self.assertTrue(
            workspace_sync._is_checkpoint_managed_relative(
                "exec-approvals.json.backup"
            )
        )

    def test_shallow_image_layout_uses_adjacent_staged_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            image_dir = Path(directory) / "app"
            image_dir.mkdir()
            module_path = image_dir / "workspace_sync.py"
            module_path.touch()
            policy_path = image_dir / "workspace_policy.json"
            policy_path.write_text("{}", encoding="utf-8")

            self.assertEqual(
                workspace_sync._workspace_policy_path(module_path),
                policy_path.resolve(),
            )

    def test_generation_excludes_the_same_regenerable_tree(self):
        durable_only = workspace_sync._generation_for_entries({
            "memory/notes (v2).md": (4, '"durable"'),
        })
        with_regenerable_tree = workspace_sync._generation_for_entries({
            "memory/notes (v2).md": (4, '"durable"'),
            "skills/example/.tts-venv/lib/site-packages/pkg/"
            "script (dev).tmpl": (1, '"generated"'),
        })
        self.assertEqual(with_regenerable_tree, durable_only)

    def test_invalid_authoritative_path_fails_before_local_mutation(self):
        invalid = "/".join("a" for _ in range(65))
        snapshot = workspace_sync._RemoteWorkspaceSnapshot(
            paths=(invalid,),
            sizes={invalid: 1},
            e_tags={invalid: '"etag"'},
            generation=None,
        )
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "workspace"
            with mock.patch.object(
                workspace_sync,
                "WORKSPACE_DIR",
                workspace,
            ):
                with self.assertRaises(
                    workspace_sync.WorkspaceRestoreIncomplete
                ):
                    workspace_sync.pull_workspace("owner", snapshot)
            self.assertFalse(workspace.exists())

    def test_invalid_local_path_fails_push_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "bad\\name").write_text("unsafe", encoding="utf-8")
            with mock.patch.object(
                workspace_sync,
                "WORKSPACE_DIR",
                workspace,
            ):
                with self.assertRaises(
                    workspace_sync.WorkspacePushIncomplete
                ):
                    list(workspace_sync._iter_workspace_files())


if __name__ == "__main__":
    unittest.main()
