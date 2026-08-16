"""Replay tests for what the user actually RECEIVES from a turn.

`_process_once` decides the text that reaches Google Chat, but it only runs
against a live gateway WebSocket, so until now nothing could answer "given
this event sequence, what does the user see?" without building an image,
deploying it, and reading a screenshot. Scratchpad narration has leaked into
replies at least four times under that loop (2026-04-25; issue #1138 F4;
two scheduled briefs 2026-08-12; a Docs turn 2026-08-14), and each fix was
prompt text or a cosmetic separator because no test could prove otherwise.

`FakeGateway` closes that gap: it answers the handshake in-process and then
replays a scripted event sequence, so the real `_process_once` runs unmodified
and the assertion is on its returned text.

The event shapes are copied from what the dev runtime actually emits, captured
from the adapter's own `openclaw_event_sample` diagnostic in CloudWatch
(2026-08-14, log group /aws/bedrock-agentcore/runtimes/psd_agent_dev-
xzL5Pg90OH-DEFAULT). Two details matter and are easy to get wrong from the
protocol docs alone:

  * assistant events carry `{"text": ..., "delta": ...}` where BOTH fields are
    the increment. There is no cumulative `message` field on this build.
  * tool activity arrives as stream="item" with `kind: "tool"` and a `phase`,
    not as the protocol-v3 `tool_call` / `tool_result` streams.

If OpenClaw changes either shape, these tests keep passing while production
breaks. Re-capture from the same diagnostic before trusting them after a
gateway upgrade.

Run:
    uv run --python 3.12 --no-project python3 -m unittest infra/agent-image/test_reply_replay.py
"""

import collections
import json
import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import harness_adapter  # noqa: E402
from harness_adapter import OpenClawAdapter  # noqa: E402


class _FakeTimeout(Exception):
    """Stands in for websocket.WebSocketTimeoutException (an idle gap)."""


# The run FakeGateway reports for this turn via the chat.send res. Events
# carrying a different runId belong to somebody else's run.
TURN_RUN_ID = "run-replay"


def agent_event(stream, data, run_id=TURN_RUN_ID):
    """One `event:agent` frame, matching the captured envelope."""
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "runId": run_id,
            "stream": stream,
            "data": data,
            "sessionKey": "agent:main:replay",
            "agentId": "main",
            "isHeartbeat": False,
        },
    }


def foreign_says(text, run_id="run-somebody-else"):
    """An assistant delta from a run this turn did not start."""
    return agent_event("assistant", {"text": text, "delta": text}, run_id=run_id)


def says(text):
    """An assistant delta. `text` and `delta` are both the increment."""
    return agent_event("assistant", {"text": text, "delta": text})


def calls_tool(name="exec", phase="start"):
    """Tool activity — the boundary that ends an assistant segment."""
    return agent_event(
        "item",
        {
            "itemId": f"tool:tooluse_{name}",
            "phase": phase,
            "kind": "tool",
            "title": f"{name} run something",
            "status": "running" if phase == "start" else "ok",
            "name": name,
            "toolCallId": f"tooluse_{name}",
        },
    )


def uses_tool(name="exec"):
    """A complete tool call: start then end."""
    return [calls_tool(name, "start"), calls_tool(name, "end")]


class FakeGateway:
    """In-process stand-in for the OpenClaw gateway WebSocket.

    Responds to the handshake `_process_once` performs (connect.challenge ->
    connect -> tools.catalog -> chat.abort -> chat.send), then replays
    `agent_events` and closes the turn with a final `res`. Request ids are
    echoed from what the adapter sent, because the adapter generates fresh
    UUIDs and drains until it sees its own id come back.

    An empty outbox raises the timeout exception rather than blocking, which
    is what a real idle socket does and what the bounded drain loops expect.
    """

    def __init__(self, agent_events, resume_events=None, question_expired=False,
                 resume_before_ack=False, withhold_ack=False):
        self._agent_events = agent_events
        # The gateway accepts the resolve and the run resumes, but the ack
        # itself never lands inside our wait window. Nothing in the protocol
        # orders those two, and this is the case where guessing "refused"
        # costs the user a duplicate execution.
        self._withhold_ack = withhold_ack
        # Whether the resumed run's output lands BEFORE the question.resolve
        # ack. The gateway is async; nothing guarantees the ack wins that race,
        # and frames dropped during the resolve wait are gone for good.
        self._resume_before_ack = resume_before_ack
        # What the ORIGINAL run streams once its question is answered. Modelled
        # because that is what really happens: question.resolve unblocks the
        # run that asked, and it continues on this same socket.
        self._resume_events = resume_events or []
        self._question_expired = question_expired
        # Gateway-side question state, mirroring QuestionStatusSchema:
        # pending | answered | cancelled | expired.
        self.question_status = None
        self.question_answers = None
        self.aborted_a_pending_question = False
        self._outbox = collections.deque()
        self.sent = []
        self.closed = False
        self._outbox.append(
            json.dumps({"type": "event", "event": "connect.challenge", "payload": {}})
        )

    # -- socket surface used by _process_once -------------------------------
    def settimeout(self, _seconds):
        return None

    def close(self):
        self.closed = True

    def send(self, raw):
        message = json.loads(raw)
        self.sent.append(message)
        request_id = message.get("id")
        method = message.get("method")

        if method == "connect":
            self._reply(request_id, {"protocol": 4})
        elif method == "tools.catalog":
            self._reply(request_id, {"tools": ["exec", "read"]})
        elif method == "question.resolve":
            params = message.get("params") or {}
            if self._question_expired or self.question_status != "pending":
                # Terminal states are refused, exactly as the manager does.
                self._reply(request_id, {"status": "cancelled"}, ok=False)
            elif params.get("cancel"):
                self.question_status = "cancelled"
                self._reply(request_id, {"status": "cancelled"})
            else:
                self.question_status = "answered"
                self.question_answers = params.get("answers")

                def stream_the_resumed_run():
                    # The run that asked resumes and streams its continuation.
                    for event in self._resume_events:
                        self._outbox.append(json.dumps(event))
                    self._outbox.append(
                        json.dumps({
                            "type": "event", "event": "chat",
                            "payload": {"state": "final"},
                        })
                    )

                if self._withhold_ack:
                    # Accepted server-side; the ack is lost or slow.
                    stream_the_resumed_run()
                elif self._resume_before_ack:
                    stream_the_resumed_run()
                    self._reply(request_id, {"status": "answered"})
                else:
                    self._reply(request_id, {"status": "answered"})
                    stream_the_resumed_run()
        elif method == "chat.abort":
            # The bundle's ask-user tool registers an abort listener that fires
            # cancelPendingQuestion("run-abort"). This models that: aborting
            # while a question is pending destroys it.
            if self.question_status == "pending":
                self.question_status = "cancelled"
                self.aborted_a_pending_question = True
            self._reply(request_id, {})
        elif method == "chat.send":
            # The gateway names this turn's run before streaming anything —
            # `{"runId": ..., "status": "started"}` — then closes with a final
            # res. Both are replayed so the runId fence sees what it sees in
            # production.
            self._reply(request_id, {"status": "started", "runId": TURN_RUN_ID})
            for event in self._agent_events:
                self._outbox.append(json.dumps(event))
            self._reply(request_id, {"status": "final"})

    def recv(self):
        if not self._outbox:
            raise _FakeTimeout()
        return self._outbox.popleft()

    # -- helpers ------------------------------------------------------------
    def _reply(self, request_id, payload, ok=True):
        self._outbox.append(
            json.dumps({"type": "res", "id": request_id, "ok": ok, "payload": payload})
        )

    def hold_question(self):
        """Put the gateway into the state it is in after the agent asks.

        Returns self so it can be chained at construction.
        """
        self.question_status = "pending"
        return self


def aborts(stop_reason="cancelled"):
    """A chat event that ends the turn without a final answer."""
    return {
        "type": "event",
        "event": "chat",
        "payload": {"state": "aborted", "stopReason": stop_reason},
    }


def foreign_error(run_id="announce:v1:agent:main:subagent:4a5a5b24:7c6a718d"):
    """A chat error belonging to a subagent run, not to this turn."""
    return {
        "type": "event",
        "event": "chat",
        "payload": {
            "state": "error",
            "runId": run_id,
            "errorMessage": "LLM request failed.",
        },
    }


def replay(agent_events):
    """Run one turn against a scripted event sequence; return the reply text."""
    adapter = OpenClawAdapter()
    adapter._ready = True
    gateway = FakeGateway(agent_events)

    # Token usage is read from the on-disk SQLite transcript, which a replay
    # has no reason to create. Stubbed with the zeroed shape the real method
    # degrades to, so these tests stay hermetic and assert only on reply text.
    zero_usage = {
        "model_calls": 0,
        "input": 0,
        "output": 0,
        "cache_read": 0,
        "cache_write": 0,
    }

    # `_process_once` does `import websocket` at call time and references
    # `websocket.WebSocketTimeoutException`. The package is not a test
    # dependency (only the container installs it), so inject a module for the
    # duration of the call — scoped, so it neither depends on nor disturbs
    # whatever else is in sys.modules. Handing the socket back through
    # create_connection means `_open_gateway_socket` runs for real rather than
    # being patched out.
    fake_websocket = mock.Mock()
    fake_websocket.create_connection.return_value = gateway
    fake_websocket.WebSocketTimeoutException = _FakeTimeout

    with mock.patch.dict(sys.modules, {"websocket": fake_websocket}), mock.patch.object(
        OpenClawAdapter, "_read_turn_usage", return_value=zero_usage
    ), mock.patch.object(
        # Failure paths POST telemetry to the broker; without this the abort
        # tests emit a connection-refused traceback into the test output.
        harness_adapter,
        "record_failure",
    ):
        result = adapter._process_once("do the thing", "session-replay")
    return result.text


class ReplyIsTheAnswerOnly(unittest.TestCase):
    """Rule 1: the user sees the final answer, never the scratchpad.

    The adapter's own comments describe this contract — pre-tool narration is
    a separate assistant message and "only that terminal segment is returned
    to Chat". These assert it end to end rather than on the accumulator.
    """

    def test_narration_before_a_tool_is_dropped(self):
        text = replay(
            [
                says("Let me check the doc first."),
                *uses_tool("read"),
                says("Added three bullets to the summary."),
            ]
        )
        self.assertEqual(text, "Added three bullets to the summary.")

    def test_every_earlier_segment_is_dropped_not_just_the_last(self):
        # A multi-step turn narrates repeatedly. Dropping only the most recent
        # narration would still ship the earlier ones.
        text = replay(
            [
                says("Now add the three bullets."),
                *uses_tool("read"),
                says("Good, endIndex 260 is within bounds."),
                *uses_tool("exec"),
                says("Now run the batchUpdate."),
                *uses_tool("exec"),
                says("The summary is updated and shared with you."),
            ]
        )
        self.assertEqual(text, "The summary is updated and shared with you.")

    def test_segments_are_never_fused_together(self):
        # The signature of this bug in production is two sentences run
        # together with no separator, because a missed boundary concatenates
        # increments: "...Now run the batchUpdate.Bullets added."
        text = replay(
            [
                says("Now run the batchUpdate."),
                *uses_tool("exec"),
                says("Bullets added."),
            ]
        )
        self.assertNotIn("batchUpdate.Bullets", text)
        self.assertNotIn("Now run", text)

    def test_streamed_increments_within_one_segment_are_joined(self):
        # The flip side: increments inside a single segment must concatenate
        # exactly, with no separator inserted and nothing dropped.
        text = replay([says("Bullets "), says("added "), says("to the doc.")])
        self.assertEqual(text, "Bullets added to the doc.")

    def test_answer_survives_when_the_turn_used_no_tools(self):
        text = replay([says("The meeting is at 3pm on Thursday.")])
        self.assertEqual(text, "The meeting is at 3pm on Thursday.")

    def test_thinking_is_never_delivered(self):
        text = replay(
            [
                agent_event("thinking", {"text": "The user probably means the Q3 doc."}),
                says("It's the Q3 planning doc."),
            ]
        )
        self.assertEqual(text, "It's the Q3 planning doc.")


class AbortedTurnDoesNotShipScratchpad(unittest.TestCase):
    """A turn that dies mid-tool must not deliver the narration that preceded it.

    The success path already refuses to: the final-event handler assigns the
    accumulator to the reply only `if not assistant_boundary_pending`, because
    a pending boundary means the accumulated text was narration the model
    wrote BEFORE calling a tool, not its answer.

    The abort and deadline fallbacks reached the same assignment without that
    condition, so the exact text the success path suppresses was delivered
    whenever a turn ended on a tool instead of an answer.
    """

    def test_narration_before_the_failing_tool_is_not_delivered(self):
        text = replay(
            [
                says("Now run the batchUpdate."),
                *uses_tool("exec"),
                aborts(),
            ]
        )
        self.assertNotIn("Now run the batchUpdate.", text)

    def test_a_completed_answer_is_still_delivered_when_the_turn_aborts(self):
        # The guard must suppress only text we KNOW was pre-tool narration.
        # A finished segment with no tool after it is a real partial answer
        # and is worth keeping.
        text = replay(
            [
                *uses_tool("read"),
                says("The Q3 doc lists four owners."),
                aborts(),
            ]
        )
        self.assertIn("The Q3 doc lists four owners.", text)


class ForeignRunsCannotAnswerThisTurn(unittest.TestCase):
    """The reply must be built only from the run this turn started.

    The adapter's socket is not private to the turn: it connects as
    `role: operator` with operator.admin/read/write, so the gateway delivers
    agent events for runs this turn did not start — other sessions included.
    Assistant text was accumulated from all of them.

    On 2026-08-14 a Docs turn failed at the harness (subagent Bedrock error),
    kept running, and finished two minutes later. The next turn — a different
    request in a DIFFERENT session (6ef59dd1 -> 0093fbb5) — was answered with
    that stale run's text, and the user's real request was never processed.
    """

    def test_a_stale_runs_answer_is_not_returned(self):
        text = replay(
            [
                foreign_says("Done. Doc created and ownership transferred."),
                says("Updated the cell to 253.590.6433."),
            ]
        )
        self.assertEqual(text, "Updated the cell to 253.590.6433.")

    def test_a_foreign_run_cannot_supply_the_whole_reply(self):
        # The turn produced nothing of its own. Answering with someone else's
        # text is the exact failure; an empty reply is the honest outcome.
        text = replay([foreign_says("Done. Doc created and ownership transferred.")])
        self.assertNotIn("Doc created", text)

    def test_a_foreign_run_cannot_split_this_turns_answer(self):
        # Interleaving must not corrupt the real reply either.
        text = replay(
            [
                says("The sheet has "),
                foreign_says("Done. Doc created."),
                says("20 entries."),
            ]
        )
        self.assertEqual(text, "The sheet has 20 entries.")

    def test_a_subagents_failure_does_not_abort_the_parent_turn(self):
        # A chat event with state:"error" aborts the turn. A subagent's failure
        # arrives on that channel under its own announce: run id, so one
        # failing subagent killed a parent turn that went on to finish the
        # work — the user got "I couldn't complete that" for a doc that was
        # created and handed over two minutes later.
        text = replay(
            [
                says("Working on it."),
                foreign_error(),
                *uses_tool("exec"),
                says("Created the doc and transferred ownership to you."),
            ]
        )
        self.assertEqual(text, "Created the doc and transferred ownership to you.")

    def test_an_error_on_this_turns_own_run_still_fails_it(self):
        # The fence must not swallow a real failure of our own run.
        text = replay(
            [
                says("Working on it."),
                {
                    "type": "event",
                    "event": "chat",
                    "payload": {
                        "state": "error",
                        "runId": TURN_RUN_ID,
                        "errorMessage": "LLM request failed.",
                    },
                },
            ]
        )
        self.assertIn("couldn't", text.lower())

    def test_events_without_a_run_id_are_still_accepted(self):
        # Fails open: a gateway that does not name the run must behave exactly
        # as before rather than silently muting every reply.
        text = replay(
            [
                {
                    "type": "event",
                    "event": "agent",
                    "payload": {
                        "stream": "assistant",
                        "data": {"text": "No runId here.", "delta": "No runId here."},
                    },
                }
            ]
        )
        self.assertEqual(text, "No runId here.")


if __name__ == "__main__":
    unittest.main()


def asks_question(payload):
    """A `question.requested` event, as the gateway actually sends it."""
    return {"type": "event", "event": "question.requested", "payload": payload}


REAL_PAYLOAD = {
    "agentId": "main",
    "id": "q1",
    "runId": TURN_RUN_ID,
    "sessionKey": "agent:main:replay",
    "status": "pending",
    "questions": [
        {
            "id": "continue_report",
            "header": "Quartile report",
            "question": "Your last run got interrupted while I was building the "
            "Evergreen quartile growth Sheet. Want me to finish and post the link now?",
            "options": [
                {"label": "Yes, finish and share it now (Recommended)"},
                {"label": "Hold off for now"},
            ],
        }
    ],
}


class StructuredQuestionsReachTheUser(unittest.TestCase):
    """`questions` (PLURAL) is the shape the gateway sends.

    The extractor probed singular question/text/prompt/message/content and
    missed it, so every structured ask was replaced by "I need a bit more
    information to continue — could you clarify what you'd like me to do?".
    The user could not answer a question they never saw, the agent asked
    again, and the loop cost a whole report (dev 2026-08-15, payload_keys
    ['agentId','createdAtMs','expiresAtMs','id','questions','runId',
    'sessionKey','status']).
    """

    def test_the_real_question_text_reaches_the_user(self):
        text = replay([asks_question(REAL_PAYLOAD)])
        self.assertIn("Want me to finish and post the link now?", text)
        self.assertNotIn("I need a bit more information", text)

    def test_answer_options_are_included(self):
        # Without the options the user is guessing at what a valid reply is.
        text = replay([asks_question(REAL_PAYLOAD)])
        self.assertIn("Yes, finish and share it now", text)
        self.assertIn("Hold off for now", text)

    def test_work_streamed_before_the_question_is_kept(self):
        text = replay([says("Rollups are done."), asks_question(REAL_PAYLOAD)])
        self.assertIn("Rollups are done.", text)
        self.assertIn("Want me to finish", text)

    def test_multiple_questions_all_render(self):
        payload = {"questions": [{"question": "First?"}, {"question": "Second?"}]}
        text = replay([asks_question(payload)])
        self.assertIn("First?", text)
        self.assertIn("Second?", text)

    def test_plain_string_questions_render(self):
        text = replay([asks_question({"questions": ["Just a string?"]})])
        self.assertIn("Just a string?", text)

    def test_legacy_singular_shape_still_works(self):
        text = replay([asks_question({"question": "Legacy shape?"})])
        self.assertIn("Legacy shape?", text)

    def test_genuinely_empty_payload_still_falls_back(self):
        # The fallback must remain for a shape we truly cannot read — but it
        # is now the last resort, not the common path.
        text = replay([asks_question({"questions": []})])
        self.assertIn("I need a bit more information", text)


def turn_runner():
    """One adapter, many turns — the production shape.

    agentcore_wrapper holds a single module-level OpenClawAdapter for the life
    of the container, so state carried between turns (the pending question) is
    carried on THIS object. Sharing it is the point, not a shortcut.

    Returns (adapter, run) where run(gateway, text, session, env) -> TurnResult.
    """
    adapter = OpenClawAdapter()
    adapter._ready = True
    zero_usage = {"model_calls": 0, "input": 0, "output": 0,
                  "cache_read": 0, "cache_write": 0}

    def run(gateway, text, session="session-replay", env=None):
        fake_websocket = mock.Mock()
        fake_websocket.create_connection.return_value = gateway
        fake_websocket.WebSocketTimeoutException = _FakeTimeout
        with mock.patch.dict(sys.modules, {"websocket": fake_websocket}), \
             mock.patch.dict(os.environ, env or {}), \
             mock.patch.object(OpenClawAdapter, "_read_turn_usage",
                               return_value=zero_usage), \
             mock.patch.object(harness_adapter, "record_failure"):
            return adapter._process_once(text, session)

    return adapter, run


def two_turn_replay(first_events, answer_text, resume_events, question_expired=False,
                    resume_before_ack=False, interleaved_session=None, env=None,
                    withhold_ack=False):
    """Turn 1 asks a question; turn 2 is the user's answer, on ONE adapter.

    The adapter instance is shared deliberately — the pending question is
    carried on it between turns, which is the whole mechanism under test.

    `interleaved_session` runs an unrelated session's turn BETWEEN the two, on
    the same adapter. That is the production shape: agentcore_wrapper holds one
    module-level adapter for every user in the container, and turns from
    different sessions interleave freely.

    Returns (first_reply, second_reply, gateway_of_turn_2).
    """
    adapter, run_on = turn_runner()

    def run(gateway, text, session="session-replay"):
        return run_on(gateway, text, session, env)

    g1 = FakeGateway(first_events)
    first = run(g1, "Give me a quartile growth report")

    if interleaved_session:
        # Someone else's turn, start to finish, while our question waits.
        run(FakeGateway([says("Unrelated answer.")]),
            "What's the weather", interleaved_session)

    # The gateway is now holding that question open, as it does in production.
    g2 = FakeGateway([], resume_events=resume_events,
                     question_expired=question_expired,
                     resume_before_ack=resume_before_ack,
                     withhold_ack=withhold_ack).hold_question()
    second = run(g2, answer_text)
    return first.text, second.text, g2


ASK = {
    "type": "event",
    "event": "question.requested",
    "payload": {
        "id": "q-abc",
        "runId": TURN_RUN_ID,
        "sessionKey": "agent:main:replay",
        "status": "pending",
        "questions": [{
            "id": "continue_report",
            "question": "Want me to finish and post the link now?",
            "options": [{"label": "Keep going to completion (Recommended)"},
                        {"label": "Stop here"}],
        }],
    },
}


class AnsweringAQuestionDoesNotAbortIt(unittest.TestCase):
    """The user's answer must RESOLVE the pending question, not cancel it.

    The gateway holds an asked question in `pending` awaiting question.resolve.
    This adapter walked away from it, and the next turn's pre-send chat.abort
    hit the ask-user tool's abort listener — cancelPendingQuestion("run-abort")
    in the bundle — destroying it. The model then correctly reported that its
    question had been aborted, and users read that as a fabricated abort they
    never performed. They never did. We did, every turn.
    """

    def test_the_pending_question_is_answered_not_cancelled(self):
        _, _, g2 = two_turn_replay(
            [ASK], "Keep going", [says("Done — here is the link.")]
        )
        self.assertEqual(g2.question_status, "answered")
        self.assertFalse(
            g2.aborted_a_pending_question,
            "the pre-send abort cancelled the question the user was answering",
        )

    def test_the_answer_carries_the_users_text_in_the_schema_shape(self):
        # QuestionResolveParamsSchema: answers is {answers: {qid: [str]}}
        _, _, g2 = two_turn_replay(
            [ASK], "Keep going", [says("Done.")]
        )
        self.assertEqual(g2.question_answers, {"answers": {"continue_report": ["Keep going"]}})

    def test_no_second_chat_send_is_issued(self):
        # OpenClaw's own claim path returns without queueing; running the
        # answer again as a fresh prompt would double-execute the turn.
        _, _, g2 = two_turn_replay([ASK], "Keep going", [says("Done.")])
        sends = [m for m in g2.sent if m.get("method") == "chat.send"]
        self.assertEqual(sends, [])

    def test_the_resumed_run_reply_reaches_the_user(self):
        _, second, _ = two_turn_replay(
            [ASK], "Keep going", [says("Grades 3-5 written. Sheet shared.")]
        )
        self.assertIn("Grades 3-5 written", second)

    def test_the_question_still_reaches_the_user_on_turn_one(self):
        first, _, _ = two_turn_replay([ASK], "Keep going", [says("Done.")])
        self.assertIn("Want me to finish and post the link now?", first)
        self.assertIn("Keep going to completion", first)

    def test_an_expired_question_falls_back_to_a_normal_turn(self):
        # A question we cannot answer must never block the user's message.
        _, _, g2 = two_turn_replay(
            [ASK], "Keep going", [], question_expired=True
        )
        sends = [m for m in g2.sent if m.get("method") == "chat.send"]
        self.assertEqual(len(sends), 1, "expired question must fall back to chat.send")

    def test_another_users_turn_in_between_does_not_drop_the_question(self):
        # agentcore_wrapper holds ONE module-level adapter for every user in
        # the container, so turns from different sessions interleave. Holding
        # the pending question in a single scalar let any unrelated session's
        # turn clear it, dropping this user straight back onto the abort path
        # — the original bug, now intermittent and multi-user only.
        _, second, g2 = two_turn_replay(
            [ASK], "Keep going", [says("Grades 3-5 written.")],
            interleaved_session="someone-else",
        )
        self.assertEqual(g2.question_status, "answered")
        self.assertFalse(
            g2.aborted_a_pending_question,
            "another session's turn let the pre-send abort kill this question",
        )
        self.assertIn("Grades 3-5 written", second)

    def test_the_other_session_does_not_answer_our_question(self):
        # The converse: an unrelated turn must never resolve a question it did
        # not ask, which is what a global scalar would have allowed.
        adapter_sends = []

        _, _, g2 = two_turn_replay(
            [ASK], "Keep going", [says("Done.")],
            interleaved_session="someone-else",
        )
        adapter_sends.extend(g2.sent)
        resolves = [m for m in adapter_sends if m.get("method") == "question.resolve"]
        self.assertEqual(len(resolves), 1)
        self.assertEqual(resolves[0]["params"]["id"], "q-abc")

    def test_a_second_question_asked_inside_the_resumed_run_also_resolves(self):
        # The agent asks, is answered, and asks AGAIN from the resumed run —
        # a clarify-then-clarify-again exchange. The second ask arrives on the
        # resumed listen path rather than after a chat.send, so it has to be
        # remembered the same way or turn 3 falls back onto the abort that
        # started this whole bug.
        adapter, run = turn_runner()

        second_ask = dict(ASK)
        second_ask["payload"] = dict(ASK["payload"], id="q-def")

        run(FakeGateway([ASK]), "Quartile growth report for Purdy")

        # Turn 2: answers q-abc, and the resumed run immediately asks q-def.
        g2 = FakeGateway([], resume_events=[second_ask]).hold_question()
        second = run(g2, "Keep going")
        self.assertEqual(g2.question_status, "answered")
        self.assertIn("Want me to finish", second.text)
        self.assertEqual(adapter._pending_questions["session-replay"]["id"], "q-def")

        # Turn 3: the follow-up answer must resolve q-def, not abort it.
        g3 = FakeGateway([], resume_events=[says("Sheet shared.")]).hold_question()
        third = run(g3, "Yes, all grades")
        self.assertEqual(g3.question_status, "answered")
        self.assertFalse(g3.aborted_a_pending_question)
        resolves = [m for m in g3.sent if m.get("method") == "question.resolve"]
        self.assertEqual(resolves[0]["params"]["id"], "q-def")
        self.assertIn("Sheet shared", third.text)

    def test_a_foreign_run_cannot_contribute_to_the_resumed_reply(self):
        # turn_run_id is normally learned from the chat.send `started` res, and
        # BOTH fences are gated on it being truthy. A resumed-question turn
        # sends no chat.send — so without seeding it from the asking run, the
        # fence was off for exactly the turns that listen longest to a socket
        # carrying other runs. That is the 2026-08-14 incident's setup.
        _, second, _ = two_turn_replay(
            [ASK], "Keep going",
            [foreign_says("STOLEN: someone else's answer."),
             says("Grades 3-5 written.")],
        )
        self.assertNotIn("STOLEN", second)
        self.assertIn("Grades 3-5 written", second)

    def test_the_asking_runs_own_output_is_not_fenced_out(self):
        # The converse, and the way a fence like this usually breaks: seeding
        # the wrong id would silence the run we are actually waiting for.
        _, second, _ = two_turn_replay(
            [ASK], "Keep going", [says("Sheet shared.")]
        )
        self.assertIn("Sheet shared", second)

    def test_a_failed_resolve_still_counts_toward_reported_latency(self):
        # A resolve that times out and falls back has already burned the ack
        # wait and the abort drain — time the user spent waiting. Restarting
        # the clock afterwards reports the SLOWEST turns as the fastest, which
        # is worse than not measuring them at all.
        original = OpenClawAdapter._resolve_pending_question

        def slow(adapter_self, *args, **kwargs):
            time.sleep(0.15)
            return original(adapter_self, *args, **kwargs)

        adapter, run = turn_runner()
        run(FakeGateway([ASK]), "Quartile growth report")
        # Expired: the resolve is refused, so this turn takes the fallback.
        g2 = FakeGateway([says("Done.")], question_expired=True).hold_question()
        with mock.patch.object(OpenClawAdapter, "_resolve_pending_question", slow):
            result = run(g2, "Keep going")
        sends = [m for m in g2.sent if m.get("method") == "chat.send"]
        self.assertEqual(len(sends), 1, "this test must exercise the fallback")
        self.assertGreaterEqual(result.latency_ms, 150)

    def test_a_lost_ack_with_the_run_streaming_is_not_treated_as_a_refusal(self):
        # The ack and the resumed run's output are unordered. If the ack is
        # slow or lost, "no ack" is NOT "refused" — and the fallback aborts
        # the accepted run and re-sends the same text, running the user's
        # answer twice against side effects already underway.
        #
        # A run blocked on a question emits nothing, so frames carrying the
        # ASKING run's id are proof it resumed, which only happens once the
        # gateway accepts. Evidence, not a heuristic — the socket carries
        # every run in the container, so the run id is what makes it evidence.
        _, second, g2 = two_turn_replay(
            [ASK], "Keep going", [says("Sheet shared: the link.")],
            withhold_ack=True,
        )
        sends = [m for m in g2.sent if m.get("method") == "chat.send"]
        self.assertEqual(sends, [], "a lost ack must not re-run the answer")
        aborts = [m for m in g2.sent if m.get("method") == "chat.abort"]
        self.assertEqual(aborts, [], "the accepted run must not be aborted")
        self.assertIn("Sheet shared", second)

    def test_a_lost_ack_with_nothing_streaming_still_falls_back(self):
        # The converse. No ack AND no sign of the run means we have no reason
        # to believe it was accepted, and the user's message must still be
        # delivered rather than silently swallowed.
        _, _, g2 = two_turn_replay(
            [ASK], "Keep going", [], withhold_ack=True,
        )
        sends = [m for m in g2.sent if m.get("method") == "chat.send"]
        self.assertEqual(len(sends), 1, "a message we cannot resolve must still send")

    def test_another_runs_frames_are_not_mistaken_for_ours_resuming(self):
        # Frames arriving during the wait prove nothing on their own — this
        # socket carries every run in the container. Only the asking run's id
        # counts, or an unrelated busy run would suppress the fallback and
        # strand the user's message.
        _, _, g2 = two_turn_replay(
            [ASK], "Keep going", [foreign_says("Someone else's run.")],
            withhold_ack=True,
        )
        sends = [m for m in g2.sent if m.get("method") == "chat.send"]
        self.assertEqual(len(sends), 1, "foreign traffic must not look like our resume")

    def test_a_flood_before_the_ack_truncates_but_never_double_sends(self):
        # Only a run already streaming can flood this window — which means the
        # gateway already accepted the answer. Falling back to abort +
        # chat.send would then run the user's answer a SECOND time, with the
        # first run's side effects already partly done. Dropping everything
        # instead loses the terminal chat event and stalls the turn.
        #
        # So the narration is dropped and the chat channel is not: a visibly
        # truncated reply, rather than a silent double-execution or a stall.
        with mock.patch.object(harness_adapter, "MAX_RESOLVE_BUFFERED_FRAMES", 2):
            _, second, g2 = two_turn_replay(
                [ASK], "Keep going",
                [says(f"chunk{i} ") for i in range(6)],
                resume_before_ack=True,
            )
        sends = [m for m in g2.sent if m.get("method") == "chat.send"]
        self.assertEqual(sends, [], "the answer must never be sent twice")
        aborts = [m for m in g2.sent if m.get("method") == "chat.abort"]
        self.assertEqual(aborts, [], "the accepted run must not be aborted")
        self.assertEqual(g2.question_status, "answered")
        # Completed rather than stalled, and what survived is real text.
        self.assertNotIn("stalled", second)
        self.assertIn("chunk0", second)

    def test_pending_questions_are_capped_and_evict_oldest_first(self):
        adapter = OpenClawAdapter()
        with mock.patch.object(harness_adapter, "MAX_PENDING_QUESTIONS", 3):
            for n in range(5):
                adapter._remember_pending_question(
                    f"session-{n}", f"q-{n}", ["only"], f"run-{n}"
                )
        self.assertEqual(len(adapter._pending_questions), 3)
        # Oldest gone, newest kept — a session that asked and walked away must
        # not pin an entry for the container's life.
        self.assertNotIn("session-0", adapter._pending_questions)
        self.assertIn("session-4", adapter._pending_questions)

    def test_re_asking_in_one_session_replaces_rather_than_accumulates(self):
        adapter = OpenClawAdapter()
        adapter._remember_pending_question("s", "q-first", ["a"], "run-1")
        adapter._remember_pending_question("s", "q-second", ["b"], "run-2")
        self.assertEqual(len(adapter._pending_questions), 1)
        self.assertEqual(adapter._pending_questions["s"]["id"], "q-second")

    def test_the_kill_switch_restores_the_old_behaviour_exactly(self):
        # OPENCLAW_QUESTION_RESOLVE=0 must back this out to what shipped
        # before — abandon the question, abort, re-send — without an image
        # build. An escape hatch that half-works is worse than none.
        _, _, g2 = two_turn_replay(
            [ASK], "Keep going", [says("Done.")],
            env={"OPENCLAW_QUESTION_RESOLVE": "0"},
        )
        resolves = [m for m in g2.sent if m.get("method") == "question.resolve"]
        self.assertEqual(resolves, [])
        sends = [m for m in g2.sent if m.get("method") == "chat.send"]
        self.assertEqual(len(sends), 1, "disabled path must still deliver the message")

    def test_resumed_output_arriving_before_the_ack_is_not_lost(self):
        # question.resolve is a req/res, but the resumed run streams onto the
        # SAME socket and nothing orders it after the ack. Frames read during
        # the resolve wait used to be discarded, so a run that answered fast
        # lost its opening events — or its whole reply.
        _, second, g2 = two_turn_replay(
            [ASK], "Keep going", [says("Sheet shared: the link.")],
            resume_before_ack=True,
        )
        self.assertEqual(g2.question_status, "answered")
        self.assertIn("Sheet shared", second)

    def test_a_turn_with_no_pending_question_is_unchanged(self):
        # The ordinary path must not grow a question.resolve call.
        adapter = OpenClawAdapter()
        adapter._ready = True
        g = FakeGateway([says("Plain answer.")])
        fake_websocket = mock.Mock()
        fake_websocket.create_connection.return_value = g
        fake_websocket.WebSocketTimeoutException = _FakeTimeout
        with mock.patch.dict(sys.modules, {"websocket": fake_websocket}), \
             mock.patch.object(OpenClawAdapter, "_read_turn_usage",
                               return_value={"model_calls": 0, "input": 0,
                                             "output": 0, "cache_read": 0,
                                             "cache_write": 0}), \
             mock.patch.object(harness_adapter, "record_failure"):
            result = adapter._process_once("hello", "session-replay")
        self.assertIn("Plain answer.", result.text)
        self.assertEqual(
            [m for m in g.sent if m.get("method") == "question.resolve"], []
        )
