"""The platform must never tell the model that the USER stopped it (#1897).

#1740 removed one source of false "you interrupted me" replies: an orphaned
`ask_user` tool call whose synthetic error result the model read as a stop.
The replies continued after it shipped, clustered on turns cut short by a chat
deadline expiry, a gateway restart, or promotion to a background job.

This is the second, independent source, and unlike the first it is not an
inference the model makes — it is a sentence the platform hands it.

The chain, all of it inside the pinned OpenClaw 2026.7.2-beta.5 host:

  1. `harness_adapter.shutdown()` SIGTERMs then SIGKILLs the whole gateway
     process group at turn end. A turn that ran past the chat deadline is still
     mid-run when that happens, so its session entry is left at
     `status: "running"` in the SQLite session store — which lives in the
     workspace and is S3-synced, so it survives into the next turn.
  2. The next turn's gateway boots and runs
     `markStartupOrphanedMainSessionsForRecovery`
     (main-session-restart-recovery). Any entry still at `status: "running"`
     with no live owner process gets `transitionMainSessionRecovery(entry,
     { kind: "mark_interrupted" })`, whose body is exactly:
         entry.status = "running";
         entry.abortedLastRun = true;
  3. That turn's reply pipeline then runs `applySessionHints`
     (src/auto-reply/reply/body.ts) which, for `abortedLastRun`, PREPENDS a
     sentence to the agent-visible body and clears the flag:
         const abortedHint = params.abortedLastRun ? "Note: The previous
           agent run was aborted by the user. Resume carefully or ask for
           clarification." : "";
         if (abortedHint) prefixedBodyBase = `${abortedHint}\n\n${prefixedBodyBase}`;

So the first thing the model reads, above what the user actually typed, is the
platform asserting that the user aborted it, plus an invitation to ask for
clarification. Hence "it looks like you stopped the last run", and hence the
~25 false "continue?" pauses one deputy principal saw and the ~14 "yes,
continue" replies one case manager needed to finish a single bulk job.

The fix replaces that sentence at image-build time (openclaw_aborted_hint.mjs,
applied by openclaw_runtime_patch.mjs). Replacing rather than suppressing: the
hint is real information — the previous run genuinely did not finish — only its
attribution and its "ask for clarification" tail are wrong.

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

# Wording the model must never be handed. "interrupted" is deliberately NOT in
# this list: the replacement has to be able to deny the claim ("did NOT stop,
# interrupt, ..."), and banning the word would ban the denial.
FORBIDDEN_IN_HINT = (
    "aborted by the user",
    "ask for clarification",
    "you stopped",
    "you interrupted",
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
        f"import {{ SYSTEM_CUTOFF_HINT, UPSTREAM_ABORTED_HINT_ANCHOR }} "
        f"from {json.dumps(HINT_MODULE)};\n"
        "process.stdout.write(JSON.stringify({ "
        "hint: SYSTEM_CUTOFF_HINT, anchor: UPSTREAM_ABORTED_HINT_ANCHOR }));\n"
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

    def test_it_names_all_three_observed_cutoff_causes(self):
        # The October cases clustered on exactly these three, so the note has
        # to cover all of them or it reads as wrong on two thirds of its uses.
        for cause in ("turn time limit", "gateway restart", "background job"):
            self.assertIn(cause, self.hint, cause)

    def test_it_denies_the_user_stop_reading_explicitly(self):
        # Not optional politeness. The false claim is self-reinforcing: once
        # "you stopped me" is in the history the next turn reads it and
        # repeats it, which is why users experienced this as constant.
        self.assertIn("did NOT stop", self.hint)

    def test_it_does_not_invite_a_permission_check(self):
        self.assertIn("without asking permission to continue", self.hint)

    def test_it_keeps_the_side_effect_safety_upstream_intended(self):
        self.assertIn("already completed", self.hint)

    def test_it_contains_no_user_stop_wording(self):
        for phrase in FORBIDDEN_IN_HINT:
            self.assertNotIn(phrase, self.hint, phrase)


class TheNextTurnContextBlamesThePlatform(unittest.TestCase):
    """The headline contract: a deadline-aborted turn, then "please continue".

    Builds the session transcript the way the runtime leaves it after a chat
    deadline expiry, drives it through upstream's own two steps —
    `mark_interrupted` and `applySessionHints`'s hint composition, both ported
    verbatim and both pinned by the docstring at the top of this file — and
    asserts on the body the model is actually handed.
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

    def test_the_injected_context_carries_the_system_cutoff_note(self):
        self.assertIn("cut off by the platform", self.injected)
        self.assertIn("turn time limit", self.injected)

    def test_the_injected_context_has_no_user_stop_wording(self):
        for phrase in FORBIDDEN_IN_HINT:
            self.assertNotIn(phrase, self.injected, phrase)

    def test_the_note_precedes_the_users_actual_message(self):
        # Ordering matters: upstream prefixes, and a note that landed after
        # the user's words would read as part of their message.
        self.assertTrue(self.injected.startswith("Note:"), self.injected[:80])
        self.assertTrue(self.injected.endswith("please continue"))

    def test_the_users_message_survives_untouched(self):
        self.assertIn("\n\nplease continue", self.injected)


class AHostBumpMustFailTheBuild(unittest.TestCase):
    DRIVER = """
import { rewriteAbortedRunHint } from %(module)s;
const results = [];
for (const [label, source] of %(cases)s) {
  try {
    rewriteAbortedRunHint(source);
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
                "cases": json.dumps(cases),
            }
        )
        return dict(json.loads(payload))

    def test_a_missing_anchor_throws(self):
        outcomes = self._outcomes(
            [["reworded", "const abortedHint = params.abortedLastRun ? 'x' : '';"]]
        )
        self.assertIn("was not found", outcomes["reworded"])

    def test_a_duplicated_anchor_throws(self):
        doubled = UPSTREAM_HINT_ASSIGNMENT + "\n" + UPSTREAM_HINT_ASSIGNMENT
        outcomes = self._outcomes([["doubled", doubled]])
        self.assertIn("more than once", outcomes["doubled"])

    def test_rerunning_the_rewrite_throws(self):
        # The patch is single-shot by design: a second run must fail on the
        # missing original anchor so a duplicated Dockerfile invocation is
        # caught rather than masked.
        once = _run_js(
            f"import {{ rewriteAbortedRunHint }} from {json.dumps(HINT_MODULE)};\n"
            f"const first = rewriteAbortedRunHint("
            f"{json.dumps(UPSTREAM_HINT_ASSIGNMENT)});\n"
            "let second = 'no-throw';\n"
            "try { rewriteAbortedRunHint(first); }\n"
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
                f"import {{ rewriteAbortedRunHint, SYSTEM_CUTOFF_HINT }} from "
                f"{json.dumps(HINT_MODULE)};\n"
                f"const out = rewriteAbortedRunHint({json.dumps(self.BUNDLE)});\n"
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
                f"import {{ rewriteAbortedRunHint }} from "
                f"{json.dumps(HINT_MODULE)};\n"
                f"const out = rewriteAbortedRunHint("
                f"{json.dumps(self.BUNDLE)});\n"
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
        self.assertIn("rewriteAbortedRunHint", self.patch_source)
        self.assertIn("./openclaw_aborted_hint.mjs", self.patch_source)

    def test_the_patch_script_applies_it_to_the_reply_body_bundle(self):
        self.assertIn(
            "replyBody.source = rewriteAbortedRunHint(replyBody.source);",
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
            "rm /app/openclaw_runtime_patch.mjs /app/openclaw_aborted_hint.mjs",
            dockerfile,
        )


class RulesMatchTheNewBehaviour(unittest.TestCase):
    def setUp(self):
        with open(RULES_PATH, encoding="utf-8") as handle:
            self.rules = handle.read()

    def test_psd_rules_quotes_the_new_note_so_the_model_recognises_it(self):
        self.assertIn(
            "Note: your previous run on this session was cut off by the platform",
            self.rules,
        )

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
