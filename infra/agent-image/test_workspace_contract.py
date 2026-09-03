"""The cutover guard must fire on format drift and stay quiet otherwise.

The guard this replaces was `git diff --name-only` on three paths, so a
comment demanded the same ingress pause and writer drain as a generation
rewrite. It cried wolf on 2026-09-02 over a change that only added an optional
`journaledReplay` flag to proof verification.

The danger of making a safety guard quieter is making it quiet on the case it
exists for. So these tests are mostly the other direction: every persisted
shape that a mixed-version fleet must agree on, mutated, asserting the
fingerprint MOVES. A test that only proved "the false positive is gone" would
pass just as well against a guard that never fires at all.
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import workspace_contract as wc  # noqa: E402

BROKER = '''
const MAX_LIST_KEYS = 1_000
const WORKSPACE_CHECKPOINT_VERSION = 2 as const
const WORKSPACE_CHECKPOINT_CONTROL_PREFIX = ".workspace-checkpoints/v2"
const WORKSPACE_FINALIZATION_PROOF_VERSION = "v1"
const PUBLIC_CONTENT_TYPES = new Map([
  [".csv", new Set(["text/csv"])],
  [".html", new Set(["text/html"])],
])

type WorkspaceCheckpointManifest = {
  version: typeof WORKSPACE_CHECKPOINT_VERSION
  signedWorkspacePrefix: string
  workspaceGeneration: string
}

type WorkspaceFinalizationJournal =
  | PendingWorkspaceFinalizationJournal
  | PreparedWorkspaceFinalizationJournal

// a comment mentioning VERSION and MANIFEST
function verify(proof: string): void {
  if (!proof) throw new Error("bad")
}
'''

SYNC = '''
WORKSPACE_DIR = Path("/home/node/.openclaw")
MAX_SYNC_FILES = 250_000
WORKSPACE_UPLOAD_CONTENT_TYPE = "application/octet-stream"
_SKIP_RELATIVE_PREFIXES = tuple(
    _CHECKPOINT_EXCLUSIONS["relativePrefixes"]
)
'''


class TheFingerprintIgnoresWhatCannotCorruptAWorkspace(unittest.TestCase):
    """Behaviour changes on one side of the fleet are not format changes."""

    def test_a_comment_change_does_not_move_it(self):
        before = wc.broker_anchors(BROKER)
        after = wc.broker_anchors(
            BROKER.replace("// a comment mentioning VERSION and MANIFEST",
                           "// entirely different prose")
        )
        self.assertEqual(before, after)

    def test_added_validation_logic_does_not_move_it(self):
        # The real 2026-09-02 change: an extra option on a verify function.
        after = wc.broker_anchors(
            BROKER.replace(
                "function verify(proof: string): void {",
                "function verify(proof: string, "
                "options: { journaledReplay?: boolean } = {}): void {",
            )
        )
        self.assertEqual(wc.broker_anchors(BROKER), after)

    def test_a_non_contract_constant_is_not_an_anchor(self):
        after = wc.broker_anchors(BROKER.replace("MAX_LIST_KEYS = 1_000",
                                                 "MAX_LIST_KEYS = 2_000"))
        self.assertEqual(wc.broker_anchors(BROKER), after)


class TheFingerprintCatchesEveryPersistedShape(unittest.TestCase):
    """Each of these would let an old writer misread a new object."""

    def _moves(self, before_text, after_text, extractor=None):
        extract = extractor or wc.broker_anchors
        self.assertNotEqual(
            extract(before_text), extract(after_text),
            "fingerprint did not move on a real format change"
        )

    def test_proof_version_bump(self):
        self._moves(BROKER, BROKER.replace(
            'PROOF_VERSION = "v1"', 'PROOF_VERSION = "v2"'))

    def test_checkpoint_version_bump(self):
        self._moves(BROKER, BROKER.replace(
            "CHECKPOINT_VERSION = 2 as const", "CHECKPOINT_VERSION = 3 as const"))

    def test_control_prefix_move(self):
        self._moves(BROKER, BROKER.replace(
            '".workspace-checkpoints/v2"', '".workspace-checkpoints/v3"'))

    def test_manifest_field_rename(self):
        self._moves(BROKER, BROKER.replace(
            "workspaceGeneration: string", "generation: string"))

    def test_manifest_field_retype(self):
        self._moves(BROKER, BROKER.replace(
            "workspaceGeneration: string", "workspaceGeneration: number"))

    def test_manifest_field_removed(self):
        self._moves(BROKER, BROKER.replace(
            "  signedWorkspacePrefix: string\n", ""))

    def test_a_dropped_union_member(self):
        # Caught only because the extractor follows leading `|` continuations.
        self._moves(BROKER, BROKER.replace(
            "  | PreparedWorkspaceFinalizationJournal\n", ""))

    def test_a_changed_multiline_constant_body(self):
        # Caught only because the extractor reads past the opening line.
        self._moves(BROKER, BROKER.replace(
            '[".html", new Set(["text/html"])],', ""))

    def test_sync_upload_content_type(self):
        self._moves(SYNC, SYNC.replace(
            '"application/octet-stream"', '"application/x-tar"'),
            wc.sync_anchors)

    def test_sync_multiline_constant_body(self):
        self._moves(SYNC, SYNC.replace(
            '_CHECKPOINT_EXCLUSIONS["relativePrefixes"]',
            '_CHECKPOINT_EXCLUSIONS["other"]'),
            wc.sync_anchors)


class ExtractionFailsClosed(unittest.TestCase):
    """A guard that silently extracts nothing reports 'unchanged' forever."""

    def test_a_file_with_no_anchors_raises(self):
        with self.assertRaises(wc.ContractExtractionError):
            wc.fingerprint_from_sources(
                {wc.BROKER: "const UNRELATED = 1\n"}
            )

    def test_anchors_are_found_in_the_real_files(self):
        # Guards against the extractor drifting out of date with the source:
        # if the constants are ever renamed wholesale this fails loudly
        # instead of quietly fingerprinting an empty set.
        root = pathlib.Path(__file__).resolve().parents[2]
        broker = (root / wc.BROKER).read_text()
        sync = (root / wc.SYNC).read_text()
        self.assertTrue(wc.broker_anchors(broker))
        self.assertTrue(wc.sync_anchors(sync))

    def test_the_proof_and_manifest_anchors_are_actually_present(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        anchors = " ".join(wc.broker_anchors((root / wc.BROKER).read_text()))
        for required in (
            "WORKSPACE_FINALIZATION_PROOF_VERSION",
            "WORKSPACE_CHECKPOINT_VERSION",
            "WORKSPACE_CHECKPOINT_CONTROL_PREFIX",
            "type WorkspaceCheckpointManifest",
            "type WorkspaceFinalizationProofClaims",
        ):
            self.assertIn(required, anchors,
                          f"{required} is no longer fingerprinted")


if __name__ == "__main__":
    unittest.main()
