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
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

# `_process_once` does `import websocket` at call time and references
# `websocket.WebSocketTimeoutException`. The package is not a test dependency
# (the container installs it), so stand in a module exposing just that name.
# create_connection is never reached — `_open_gateway_socket` is patched — but
# it raises rather than returning a mock so a patching mistake fails loudly
# instead of silently opening nothing.
_websocket_stub = types.ModuleType("websocket")


class _FakeTimeout(Exception):
    """Stands in for websocket.WebSocketTimeoutException (an idle gap)."""


def _refuse_connect(*_args, **_kwargs):
    raise AssertionError(
        "create_connection reached — _open_gateway_socket was not patched"
    )


_websocket_stub.WebSocketTimeoutException = _FakeTimeout
_websocket_stub.create_connection = _refuse_connect
sys.modules.setdefault("websocket", _websocket_stub)

import harness_adapter  # noqa: E402
from harness_adapter import OpenClawAdapter  # noqa: E402


def agent_event(stream, data):
    """One `event:agent` frame, matching the captured envelope."""
    return {
        "type": "event",
        "event": "agent",
        "payload": {
            "runId": "run-replay",
            "stream": stream,
            "data": data,
            "sessionKey": "agent:main:replay",
            "agentId": "main",
            "isHeartbeat": False,
        },
    }


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

    def __init__(self, agent_events):
        self._agent_events = agent_events
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
        elif method == "chat.abort":
            self._reply(request_id, {})
        elif method == "chat.send":
            for event in self._agent_events:
                self._outbox.append(json.dumps(event))
            self._reply(request_id, {"status": "final"})

    def recv(self):
        if not self._outbox:
            raise _FakeTimeout()
        return self._outbox.popleft()

    # -- helpers ------------------------------------------------------------
    def _reply(self, request_id, payload):
        self._outbox.append(
            json.dumps({"type": "res", "id": request_id, "ok": True, "payload": payload})
        )


def aborts(stop_reason="cancelled"):
    """A chat event that ends the turn without a final answer."""
    return {
        "type": "event",
        "event": "chat",
        "payload": {"state": "aborted", "stopReason": stop_reason},
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

    with mock.patch.object(
        OpenClawAdapter, "_open_gateway_socket", staticmethod(lambda *_: gateway)
    ), mock.patch.object(
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


if __name__ == "__main__":
    unittest.main()
