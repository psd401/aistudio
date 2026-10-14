"""The platform must never tell the model that the USER stopped it (#1897).

#1740 removed one source of false "you interrupted me" replies: an orphaned
`ask_user` tool call whose synthetic error result the model read as a stop.
The replies continued after it shipped, clustered on turns cut short by a chat
deadline expiry, a gateway restart, or promotion to a background job.

This is the second, independent source, and unlike the first it is not an
inference the model makes: a turn cut off by the platform leaves the session
`abortedLastRun`, and upstream's `applySessionHints` then prepends "The previous
agent run was aborted by the user ... ask for clarification" to the next turn.
The full causal chain and the incident counts live in the header of
openclaw_aborted_hint.mjs; the fix replaces that sentence at image-build time.

These tests pin, in order: the replacement text's content rules; that the real
rewrite runs against a realistic bundle; that the next turn's composed context
blames the platform and never the user; that a host bump which reworks
`applySessionHints` fails the build instead of silently shipping the old text;
that the build actually applies the rewrite; and that psd-rules matches.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

SOURCE_DIR = os.path.dirname(os.path.abspath(__file__))
HINT_MODULE = os.path.join(SOURCE_DIR, "openclaw_aborted_hint.mjs")
PATCH_TEXT_MODULE = os.path.join(SOURCE_DIR, "openclaw_patch_text.mjs")
PATCH_SCRIPT = os.path.join(SOURCE_DIR, "openclaw_runtime_patch.mjs")
DOCKERFILE = os.path.join(SOURCE_DIR, "Dockerfile")
RULES_PATH = os.path.join(SOURCE_DIR, "skills", "psd-rules", "SKILL.md")

# Verbatim from the pinned bundle (get-reply-*.js). The rewrite anchors on the
# whole assignment, so this is also the anchor.
UPSTREAM_HINT_ASSIGNMENT = (
    'const abortedHint = params.abortedLastRun ? '
    '"Note: The previous agent run was aborted by the user. '
    'Resume carefully or ask for clarification." : "";'
)

def _js_runtime() -> str:
    """Whichever ESM runtime this environment has.

    CI installs bun explicitly and GitHub's ubuntu images ship node, so one of
    the two is always present. Resolved rather than skipped: a test that
    quietly skips is a test that stops guarding anything.
    """
    for candidate in ("node", "bun"):
        found = shutil.which(candidate)
        if found:
            return found
    raise AssertionError(
        "neither node nor bun is available; this suite exercises the real "
        "ESM rewrite and must not be skipped"
    )


def _run_js(script: str) -> str:
    """Run one ESM script from a temp dir and return its stdout."""
    with tempfile.TemporaryDirectory() as workdir:
        script_path = os.path.join(workdir, "driver.mjs")
        with open(script_path, "w", encoding="utf-8") as handle:
            handle.write(script)
        completed = subprocess.run(
            [_js_runtime(), script_path],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=workdir,
        )
    if completed.returncode != 0:
        raise AssertionError(
            f"driver exited {completed.returncode}\n"
            f"stdout: {completed.stdout}\nstderr: {completed.stderr}"
        )
    return completed.stdout


def _hint_constants() -> dict:
    """The real exported constants, read by executing the shipped module."""
    out = _run_js(
        f"import {{ SYSTEM_CUTOFF_HINT, UPSTREAM_ABORTED_HINT_ANCHOR, "
        f"FORBIDDEN_HINT_PHRASES }} from {json.dumps(HINT_MODULE)};\n"
        "process.stdout.write(JSON.stringify({ "
        "hint: SYSTEM_CUTOFF_HINT, anchor: UPSTREAM_ABORTED_HINT_ANCHOR, "
        "forbidden: FORBIDDEN_HINT_PHRASES }));\n"
    )
    return json.loads(out)


class TheAnchorMatchesThePinnedHost(unittest.TestCase):
    def test_the_module_anchor_is_the_verbatim_upstream_assignment(self):
        # If upstream's text drifts, the build fails loudly (see the drift
        # tests below) rather than shipping an image that blames users. This
        # keeps the expected text in a second place so a careless edit to the
        # module is caught here instead of at image-build time.
        self.assertEqual(
            _hint_constants()["anchor"], UPSTREAM_HINT_ASSIGNMENT
        )


class TheReplacementTextIsHonest(unittest.TestCase):
    def setUp(self):
        self.hint = _hint_constants()["hint"]

    def test_it_names_the_platform_as_the_cause(self):
        self.assertIn("cut off by the platform", self.hint)

    def test_it_names_every_platform_cutoff_cause(self):
        # The October cases clustered on the first three; the fourth is the
        # OPENCLAW_PRESEND_ABORT kill switch replacing a background job's run
        # when the user sends a new message. A note that omits a cause reads
        # as wrong every time that cause fires.
        for cause in (
            "turn time limit",
            "gateway restart",
            "background job",
            "overlapped a newer message",
        ):
            self.assertIn(cause, self.hint, cause)

    def test_it_denies_the_user_stop_reading_explicitly(self):
        # Not optional politeness. The false claim is self-reinforcing: once
        # "you stopped me" is in the history the next turn reads it and
        # repeats it, which is why users experienced this as constant.
        self.assertIn("did NOT stop", self.hint)

    def test_it_does_not_invite_a_permission_check(self):
        self.assertIn("without asking permission to continue", self.hint)

    def test_it_defers_to_the_message_it_is_prepended_to(self):
        # The note sits above the user's newest message, which may change or
        # cancel the earlier request ("never mind", "do X instead"). Resuming
        # the old work must not override that.
        self.assertIn("message below comes first", self.hint)
        self.assertIn("changes or cancels the earlier request", self.hint)
        self.assertLess(
            self.hint.index("changes or cancels"),
            self.hint.index("pick the work back up"),
        )

    def test_it_keeps_the_real_reasons_to_ask(self):
        # psd-rules R15: missing information and destructive actions still
        # warrant a question; the hint must not override that.
        self.assertIn("information you cannot obtain", self.hint)
        self.assertIn("destructive or irreversible", self.hint)

    def test_it_keeps_the_note_out_of_the_reply(self):
        # Every line the agent writes reaches the user (psd-rules R1).
        self.assertIn("Do not mention this note", self.hint)

    def test_it_keeps_the_side_effect_safety_upstream_intended(self):
        self.assertIn("already completed", self.hint)

    def test_it_contains_no_user_stop_wording(self):
        forbidden = _hint_constants()["forbidden"]
        self.assertTrue(forbidden)
        for phrase in forbidden:
            self.assertNotIn(phrase, self.hint, phrase)


class TheNextTurnContextBlamesThePlatform(unittest.TestCase):
    """The headline contract: a deadline-aborted turn, then "please continue".

    Builds the session transcript the way the runtime leaves it after a chat
    deadline expiry, drives it through upstream's two steps —
    `mark_interrupted` and `applySessionHints`'s hint composition — and
    asserts on the body the model is actually handed.

    Both steps are hand-ported copies, not the pinned bundle's code. This pins
    the hint text and its placement; it would not catch upstream changing how
    the hint is composed. The anchor tests and the image build's
    `findUniqueBundle` markers are what fail on that kind of upstream change.
    """

    DRIVER = """
import { SYSTEM_CUTOFF_HINT } from %(module)s;

// --- the transcript the runtime leaves behind ------------------------------
// A turn that ran past the chat deadline: the harness stopped listening and
// SIGKILLed the gateway process group mid-run, so the session entry is still
// at status "running" with no owner process.
const transcript = [
  { role: "user", text: "Sort my inbox into the usual folders." },
  { role: "assistant", text: "", toolCalls: ["gmail_list", "gmail_move"] },
];
const sessionEntry = {
  sessionId: "s-deadline-1897",
  status: "running",
  abortedLastRun: undefined,
  updatedAt: 1,
};
const cutoffReason = "chat deadline expired without final event";

// --- upstream step 1: transitionMainSessionRecovery "mark_interrupted" -----
// main-session-restart-recovery -> markStartupOrphanedMainSessionsForRecovery
// marks every entry still at status "running" with no live owner.
function markInterrupted(entry) {
  entry.status = "running";
  entry.abortedLastRun = true;
  entry.updatedAt = Date.now();
}
if (sessionEntry.status === "running") markInterrupted(sessionEntry);

// --- upstream step 2: applySessionHints body composition ------------------
// src/auto-reply/reply/body.ts, with the hint text as this image patches it.
function applySessionHints(params) {
  let prefixedBodyBase = params.baseBody;
  const abortedHint = params.abortedLastRun ? SYSTEM_CUTOFF_HINT : "";
  if (abortedHint) prefixedBodyBase = abortedHint + "\\n\\n" + prefixedBodyBase;
  return prefixedBodyBase;
}

const injected = applySessionHints({
  abortedLastRun: sessionEntry.abortedLastRun,
  baseBody: "please continue",
});

process.stdout.write(JSON.stringify({
  injected,
  transcriptTurns: transcript.length,
  cutoffReason,
  flagWasSet: sessionEntry.abortedLastRun === true,
}));
"""

    def setUp(self):
        payload = json.loads(
            _run_js(self.DRIVER % {"module": json.dumps(HINT_MODULE)})
        )
        self.injected = payload["injected"]
        self.assertTrue(
            payload["flagWasSet"],
            "the fixture must actually reach the aborted-hint path",
        )

    def test_the_note_precedes_the_users_actual_message(self):
        # Ordering matters: upstream prefixes, and a note that landed after
        # the user's words would read as part of their message.
        self.assertTrue(self.injected.startswith("Note:"), self.injected[:80])
        self.assertTrue(self.injected.endswith("please continue"))

    def test_the_users_message_survives_untouched(self):
        self.assertIn("\n\nplease continue", self.injected)


REWRITE_PRELUDE = (
    f"import {{ UPSTREAM_ABORTED_HINT_ANCHOR, PATCHED_ABORTED_HINT_ASSIGNMENT, "
    f"SYSTEM_CUTOFF_HINT }} from {json.dumps(HINT_MODULE)};\n"
    f"import {{ replaceOnce }} from {json.dumps(PATCH_TEXT_MODULE)};\n"
    "const rewrite = (source) => replaceOnce(source, "
    "UPSTREAM_ABORTED_HINT_ANCHOR, PATCHED_ABORTED_HINT_ASSIGNMENT, "
    "'aborted-last-run session hint');\n"
)


class AHostBumpMustFailTheBuild(unittest.TestCase):
    DRIVER = """
import { UPSTREAM_ABORTED_HINT_ANCHOR, PATCHED_ABORTED_HINT_ASSIGNMENT }
  from %(module)s;
import { replaceOnce } from %(patch_text)s;
const results = [];
for (const [label, source] of %(cases)s) {
  try {
    replaceOnce(source, UPSTREAM_ABORTED_HINT_ANCHOR,
      PATCHED_ABORTED_HINT_ASSIGNMENT, "aborted-last-run session hint");
    results.push([label, "no-throw"]);
  } catch (error) {
    results.push([label, String(error.message)]);
  }
}
process.stdout.write(JSON.stringify(results));
"""

    def _outcomes(self, cases):
        payload = _run_js(
            self.DRIVER
            % {
                "module": json.dumps(HINT_MODULE),
                "patch_text": json.dumps(PATCH_TEXT_MODULE),
                "cases": json.dumps(cases),
            }
        )
        return dict(json.loads(payload))

    def test_a_missing_anchor_throws(self):
        outcomes = self._outcomes(
            [["reworded", "const abortedHint = params.abortedLastRun ? 'x' : '';"]]
        )
        self.assertIn("was not found", outcomes["reworded"])
        # Routed through the patch script's shared failure format, so the
        # build log names the step that broke.
        self.assertIn(
            "OpenClaw runtime patch failed: aborted-last-run session hint",
            outcomes["reworded"],
        )

    def test_a_duplicated_anchor_throws(self):
        doubled = UPSTREAM_HINT_ASSIGNMENT + "\n" + UPSTREAM_HINT_ASSIGNMENT
        outcomes = self._outcomes([["doubled", doubled]])
        self.assertIn("more than once", outcomes["doubled"])

    def test_rerunning_the_rewrite_throws(self):
        # The patch is single-shot by design: a second run must fail on the
        # missing original anchor so a duplicated Dockerfile invocation is
        # caught rather than masked.
        once = _run_js(
            REWRITE_PRELUDE
            + f"const first = rewrite({json.dumps(UPSTREAM_HINT_ASSIGNMENT)});\n"
            "let second = 'no-throw';\n"
            "try { rewrite(first); }\n"
            "catch (error) { second = String(error.message); }\n"
            "process.stdout.write(JSON.stringify({ first, second }));\n"
        )
        payload = json.loads(once)
        self.assertNotIn("aborted by the user", payload["first"])
        self.assertIn("was not found", payload["second"])


class TheRewriteRunsOnARealisticBundle(unittest.TestCase):
    # The surrounding lines are verbatim from get-reply-*.js so the rewrite is
    # exercised against the real shape, not just the isolated assignment.
    BUNDLE = (
        "async function applySessionHints(params) {\n"
        "\tlet prefixedBodyBase = params.baseBody;\n"
        f"\t{UPSTREAM_HINT_ASSIGNMENT}\n"
        "\tif (abortedHint) {\n"
        "\t\tprefixedBodyBase = `${abortedHint}\\n\\n${prefixedBodyBase}`;\n"
        "\t}\n"
        "\treturn prefixedBodyBase;\n"
        "}\n"
    )

    def test_only_the_hint_text_changes(self):
        payload = json.loads(
            _run_js(
                REWRITE_PRELUDE
                + f"const out = rewrite({json.dumps(self.BUNDLE)});\n"
                "process.stdout.write(JSON.stringify({ out, "
                "hint: SYSTEM_CUTOFF_HINT }));\n"
            )
        )
        patched = payload["out"]
        # The hint is in, the fabrication is out...
        self.assertIn(payload["hint"], patched)
        self.assertNotIn("aborted by the user", patched)
        # ...and every other line of the function is byte-identical, so the
        # patch cannot have disturbed the composition around it.
        for line in self.BUNDLE.splitlines():
            if "abortedHint = params.abortedLastRun" in line:
                continue
            self.assertIn(line, patched, line)

    def test_the_result_is_valid_javascript(self):
        # A replacement that produced a syntax error would break the whole
        # gateway, not just this hint. The replacement text carries an em
        # dash, a semicolon and parentheses, so prove the emitted assignment
        # still parses: `new Function` raises SyntaxError if it does not.
        self.assertEqual(
            _run_js(
                REWRITE_PRELUDE
                + f"const out = rewrite({json.dumps(self.BUNDLE)});\n"
                "new Function(out);\n"
                "process.stdout.write('parsed');\n"
            ),
            "parsed",
        )


class TheBuildAppliesTheRewrite(unittest.TestCase):
    """A correct rewrite that the image build never calls fixes nothing."""

    def setUp(self):
        with open(PATCH_SCRIPT, encoding="utf-8") as handle:
            self.patch_source = handle.read()

    def test_the_patch_script_imports_the_rewrite(self):
        self.assertIn("PATCHED_ABORTED_HINT_ASSIGNMENT", self.patch_source)
        self.assertIn("./openclaw_aborted_hint.mjs", self.patch_source)
        self.assertIn("./openclaw_patch_text.mjs", self.patch_source)

    def test_the_patch_script_applies_it_to_the_reply_body_bundle(self):
        self.assertIn(
            "replyBody.source = replaceOnce(\n"
            "  replyBody.source,\n"
            "  UPSTREAM_ABORTED_HINT_ANCHOR,\n"
            "  PATCHED_ABORTED_HINT_ASSIGNMENT,\n",
            self.patch_source,
        )
        # Located by the anchor AND the enclosing function, so it cannot bind
        # to a control-UI bundle that merely mentions the sentence.
        self.assertIn("async function applySessionHints(params)", self.patch_source)

    def test_the_patched_bundle_is_written_back_and_reported(self):
        # Two separate lists in that script (the write loop and the log line);
        # a rewrite missing from the first is silently discarded.
        self.assertEqual(
            len(re.findall(r"^\s+replyBody,$", self.patch_source, re.MULTILINE)),
            2,
            "replyBody must appear in both the write set and the log set",
        )

    def test_the_build_only_modules_do_not_ship_in_the_runtime_image(self):
        with open(DOCKERFILE, encoding="utf-8") as handle:
            dockerfile = handle.read()
        self.assertIn(
            "rm /app/openclaw_runtime_patch.mjs /app/openclaw_aborted_hint.mjs "
            "\\\n       /app/openclaw_patch_text.mjs &&",
            dockerfile,
        )


class RulesMatchTheNewBehaviour(unittest.TestCase):
    def setUp(self):
        with open(RULES_PATH, encoding="utf-8") as handle:
            self.rules = handle.read()

    def test_psd_rules_quotes_the_new_note_so_the_model_recognises_it(self):
        # Derived from the shipped constant, not retyped, so a reword of the
        # note's opening cannot silently desync from what psd-rules quotes.
        opening = _hint_constants()["hint"].split(" — ", 1)[0]
        self.assertEqual(
            opening,
            "Note: your previous run on this session was cut off by the platform",
        )
        self.assertIn(opening, self.rules)

    def test_psd_rules_carries_the_same_instructions_as_the_note(self):
        # The model reads both; they must not drift into disagreement.
        flat = " ".join(self.rules.split())
        for clause in (
            "do not ask whether to continue",
            "do not tell the user they stopped you",
            "Re-check any side effect",
            "destructive or irreversible",
            "Never mention the note",
            "changes or cancels the earlier request, follow it",
        ):
            self.assertIn(clause, flat, clause)

    def test_psd_rules_states_the_user_cannot_be_the_cause(self):
        self.assertIn("Chat has no stop control", self.rules)

    def test_psd_rules_still_names_the_1740_repair_marker(self):
        # The two sources are independent; fixing this one must not quietly
        # drop the guidance that covers the other.
        self.assertIn(
            "inserted synthetic\n  error result for transcript repair.",
            self.rules,
        )


if __name__ == "__main__":
    unittest.main()
