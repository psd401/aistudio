"""Tool-policy contracts that keep the agent from inventing user interruptions.

`ask_user` is a BLOCKING tool: it registers a question on the OpenClaw gateway
and waits for `question.resolve`. That contract cannot hold here, because this
runtime stops the gateway after every turn (harness_adapter "Stopping OpenClaw
gateway", ~3ms after the final event) and starts a fresh one for the next
invocation. The question dies with the gateway it was registered on.

Measured on prod between 2026-08-31 and 2026-09-05: nineteen `question.resolve`
attempts, nineteen `ok=False`, every one paired with
`errorCode=INVALID_REQUEST errorMessage=question '<id>' was not found`. Zero
successes in the whole retained log history.

The cost is not the failed resolve, it is the wreckage it leaves. The assistant
turn keeps its `ask_user` toolCall and never gets a toolResult, so on EVERY
later turn OpenClaw repairs the pairing with a synthetic `isError: true` result
reading "[openclaw] missing tool result in session history; inserted synthetic
error result for transcript repair." The model reads its own question coming
back as an error and concludes the user stopped it. Observed verbatim in dev
session 5a1baef7 on 2026-09-06: the thinking block "The user stopped their
request" (the user had said "It's in a private collection"), and four turns
later "Got it — pausing since you interrupted that run." The scar is permanent
for the life of the session, which is why it reads as the agent doing this
"all the time" rather than once.

Asking in prose loses nothing: the question text is delivered to Google Chat
either way, and Chat renders no option chips for `ask_user`.
"""

from __future__ import annotations

import json
import os
import unittest

SOURCE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SOURCE_DIR, "openclaw.json")
RULES_PATH = os.path.join(SOURCE_DIR, "skills", "psd-rules", "SKILL.md")

# The literal OpenClaw inserts for an orphaned tool call
# (DEFAULT_MISSING_TOOL_RESULT_TEXT in the shipped ai-transport-runtime-host
# bundle). psd-rules quotes it so the model can recognise the marker; if
# upstream ever reworks the wording the rule silently stops matching, so the
# two are pinned together here.
SYNTHETIC_REPAIR_MARKER = (
    "[openclaw] missing tool result in session history; "
    "inserted synthetic error result for transcript repair."
)


def _load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as handle:
        return json.load(handle)


class AskUserIsDenied(unittest.TestCase):
    def test_ask_user_is_in_the_tool_deny_list(self):
        deny = _load_config()["tools"]["deny"]
        self.assertIn(
            "ask_user",
            deny,
            "ask_user must stay denied: the gateway is restarted between "
            "turns, so its question can never be resolved and the orphaned "
            "tool call poisons the session with a synthetic error result the "
            "model reports as the user interrupting it",
        )

    def test_the_existing_denials_survive(self):
        # A replacement rather than an append would silently hand the model
        # back cron/gateway/nodes/sessions/agents.
        deny = set(_load_config()["tools"]["deny"])
        self.assertLessEqual(
            {"cron", "nodes", "gateway", "sessions", "agents"},
            deny,
        )

    def test_the_deny_name_matches_the_registered_tool_name(self):
        # The shipped gate is
        #   isToolAllowedByPolicyName("ask_user", { deny })
        # in shouldIncludeAskUserToolForOpenClawTools, and that matcher
        # compares NORMALIZED names. A near-miss spelling ("askUser",
        # "ask-user") denies nothing and fails open.
        deny = _load_config()["tools"]["deny"]
        self.assertNotIn("askUser", deny)
        self.assertNotIn("ask-user", deny)


class RulesNameTheRepairMarker(unittest.TestCase):
    def test_psd_rules_quotes_the_synthetic_repair_text_verbatim(self):
        # Denying ask_user stops new orphans; it does not clean the ones
        # already sitting in long-lived sessions, and a turn killed at the
        # AgentCore deadline can still orphan a tool call. The rule is what
        # covers those, and it only works if it quotes the exact string.
        with open(RULES_PATH, encoding="utf-8") as handle:
            rules = handle.read()
        collapsed = " ".join(rules.split())
        self.assertIn(SYNTHETIC_REPAIR_MARKER, collapsed)


if __name__ == "__main__":
    unittest.main()
