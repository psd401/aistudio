"""Unit tests for mantle_proxy usage extraction, include_usage injection, and
the Claude Sonnet 5 request-shaping + Bedrock prompt-caching logic (issue #1089).

Covers:
  * issue #1083 capture point: read token `usage` from streaming (final usage
    chunk) and non-streaming OpenAI-compatible Mantle responses, capture the
    real model id, inject `stream_options.include_usage=true`.
  * issue #1089: de-cache the billable input, extract the cache-read/cache-write
    split, strip Sonnet-rejected sampling params, force thinking disabled, and
    inject cache_control breakpoints at the stable prefix boundary.

`mantle_proxy` imports `aiohttp` at module scope, which is part of the container
image but not the local test env. The functions under test are pure and never
touch aiohttp, so we stub it in sys.modules before import — the test exercises
the parsing logic, not the HTTP server.
"""

import sys
import types
import unittest

# Stub aiohttp BEFORE importing mantle_proxy so the module-level
# `from aiohttp import web, ClientSession, ClientTimeout` succeeds without the
# real package. The stub objects are never invoked by the pure functions.
if "aiohttp" not in sys.modules:
    _aiohttp = types.ModuleType("aiohttp")

    class _FakeJsonResponse:
        """Minimal stand-in for aiohttp.web.json_response — records the payload
        so tests can assert on the /usage body."""

        def __init__(self, payload):
            self.payload = payload

    _aiohttp.web = types.SimpleNamespace(
        Request=object, Response=object, StreamResponse=object,
        Application=object,
        json_response=lambda payload, *a, **k: _FakeJsonResponse(payload),
        run_app=lambda *a, **k: None,
    )
    _aiohttp.ClientSession = object
    _aiohttp.ClientTimeout = object
    sys.modules["aiohttp"] = _aiohttp

import asyncio  # noqa: E402

import mantle_proxy  # noqa: E402
from mantle_proxy import (  # noqa: E402
    _extract_usage,
    _is_anthropic_model,
    inject_include_usage,
    shape_request_for_sonnet,
    inject_cache_breakpoints,
    detect_trailing_prefill,
    handle_usage,
    CACHE_TTL,
    _is_anthropic_messages_path,
    inject_anthropic_cache_breakpoints,
    _parse_anthropic_stream,
    _parse_anthropic_response,
)


class TestExtractUsage(unittest.TestCase):
    """_extract_usage now returns a 4-tuple:
    (billable_input, completion, cache_read, cache_write). billable_input is the
    full-rate input, computed shape-aware: the OpenAI `prompt_tokens` TOTAL is
    de-cached (minus cache read/write), while the Anthropic `input_tokens` field
    is used verbatim because it is ALREADY the non-cached input (cache read/write
    are reported separately, not inside it). This avoids both double-counting
    (OpenAI) and undercounting (Anthropic)."""

    def test_openai_field_names_no_cache(self):
        # No caching: billable == prompt_tokens, cache split 0.
        self.assertEqual(
            _extract_usage({"usage": {"prompt_tokens": 120, "completion_tokens": 45}}),
            (120, 45, 0, 0),
        )

    def test_alternate_field_names_no_cache(self):
        self.assertEqual(
            _extract_usage({"usage": {"input_tokens": 7, "output_tokens": 3}}),
            (7, 3, 0, 0),
        )

    def test_prompt_tokens_take_priority_over_input_tokens(self):
        self.assertEqual(
            _extract_usage({
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 20,
                    "input_tokens": 999,
                    "output_tokens": 999,
                }
            }),
            (10, 20, 0, 0),
        )

    def test_no_usage_key(self):
        self.assertEqual(_extract_usage({"choices": []}), (None, None, 0, 0))

    def test_usage_not_a_dict(self):
        self.assertEqual(_extract_usage({"usage": "garbage"}), (None, None, 0, 0))

    def test_partial_usage(self):
        self.assertEqual(
            _extract_usage({"usage": {"prompt_tokens": 50}}),
            (50, None, 0, 0),
        )

    def test_non_dict_input(self):
        self.assertEqual(_extract_usage(None), (None, None, 0, 0))
        self.assertEqual(_extract_usage([1, 2, 3]), (None, None, 0, 0))

    def test_non_int_token_values_ignored(self):
        self.assertEqual(
            _extract_usage({"usage": {"prompt_tokens": "10", "completion_tokens": 5.5}}),
            (None, None, 0, 0),
        )

    def test_openai_cached_tokens_de_cached(self):
        # OpenAI-completions shape: prompt_tokens is the TOTAL and includes the
        # cached subset. billable_input = 1000 - 600 cached = 400.
        self.assertEqual(
            _extract_usage({
                "usage": {
                    "prompt_tokens": 1000,
                    "completion_tokens": 50,
                    "prompt_tokens_details": {"cached_tokens": 600},
                }
            }),
            (400, 50, 600, 0),
        )

    def test_anthropic_native_cache_fields_de_cached(self):
        # Anthropic-via-Mantle spelling: cache_read_input_tokens +
        # cache_creation_input_tokens, with prompt_tokens the total.
        self.assertEqual(
            _extract_usage({
                "usage": {
                    "prompt_tokens": 3000,
                    "completion_tokens": 120,
                    "cache_read_input_tokens": 2000,
                    "cache_creation_input_tokens": 500,
                }
            }),
            (500, 120, 2000, 500),
        )

    def test_cache_write_alt_spelling(self):
        # Anthropic shape (no prompt_tokens): input_tokens is ALREADY the
        # de-cached billable input, so it must NOT be reduced by the cache-write
        # count. billable=800 verbatim, cache_write=300 reported separately
        # (chatgpt-codex #1092 review — subtracting here undercounted/clamped).
        self.assertEqual(
            _extract_usage({
                "usage": {
                    "input_tokens": 800,
                    "output_tokens": 10,
                    "cache_write_input_tokens": 300,
                }
            }),
            (800, 10, 0, 300),
        )

    def test_anthropic_input_tokens_not_de_cached_on_cache_hit(self):
        # Regression for the #1092 de-caching bug: with the Anthropic shape and a
        # large cache read, subtracting cache tokens from input_tokens would
        # clamp billable to 0. input_tokens (5) is already billable; cache_read
        # (2000) is separate.
        self.assertEqual(
            _extract_usage({
                "usage": {
                    "input_tokens": 5,
                    "output_tokens": 12,
                    "cache_read_input_tokens": 2000,
                }
            }),
            (5, 12, 2000, 0),
        )

    def test_de_cache_never_negative(self):
        # Defensive: if cache tokens exceed the reported total, clamp at 0.
        self.assertEqual(
            _extract_usage({
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 5,
                    "cache_read_input_tokens": 500,
                }
            }),
            (0, 5, 500, 0),
        )

    def test_streaming_final_usage_chunk_shape(self):
        chunk = {
            "id": "chatcmpl-x",
            "model": "anthropic.claude-sonnet-5",
            "choices": [],
            "usage": {"prompt_tokens": 1500, "completion_tokens": 320},
        }
        self.assertEqual(_extract_usage(chunk), (1500, 320, 0, 0))


class TestInjectIncludeUsage(unittest.TestCase):
    def test_streaming_request_gets_include_usage(self):
        payload = {"stream": True, "messages": []}
        self.assertTrue(inject_include_usage(payload))
        self.assertEqual(payload["stream_options"], {"include_usage": True})

    def test_non_streaming_untouched(self):
        payload = {"stream": False, "messages": []}
        self.assertFalse(inject_include_usage(payload))
        self.assertNotIn("stream_options", payload)

    def test_non_dict_input(self):
        self.assertFalse(inject_include_usage(None))


class TestIsAnthropicModel(unittest.TestCase):
    def test_sonnet_ids(self):
        self.assertTrue(_is_anthropic_model("anthropic.claude-sonnet-5"))
        self.assertTrue(_is_anthropic_model("us.anthropic.claude-sonnet-5"))
        self.assertTrue(_is_anthropic_model("CLAUDE-SONNET-5"))

    def test_glm5_is_not_anthropic(self):
        self.assertFalse(_is_anthropic_model("zai.glm-5"))
        self.assertFalse(_is_anthropic_model(None))
        self.assertFalse(_is_anthropic_model(""))


class TestShapeRequestForSonnet(unittest.TestCase):
    def test_strips_sampling_and_sets_thinking_disabled(self):
        payload = {
            "model": "anthropic.claude-sonnet-5",
            "temperature": 0.7,
            "top_p": 0.9,
            "top_k": 40,
            "reasoning_effort": "high",
            "messages": [],
        }
        changes = shape_request_for_sonnet(payload)
        self.assertNotIn("temperature", payload)
        self.assertNotIn("top_p", payload)
        self.assertNotIn("top_k", payload)
        self.assertNotIn("reasoning_effort", payload)
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertIn("thinking:disabled", changes)
        self.assertIn("strip:temperature", changes)

    def test_glm5_untouched(self):
        payload = {"model": "zai.glm-5", "temperature": 0.7, "messages": []}
        changes = shape_request_for_sonnet(payload)
        self.assertEqual(changes, [])
        self.assertEqual(payload["temperature"], 0.7)
        self.assertNotIn("thinking", payload)

    def test_idempotent_when_already_shaped(self):
        payload = {
            "model": "anthropic.claude-sonnet-5",
            "thinking": {"type": "disabled"},
            "messages": [],
        }
        changes = shape_request_for_sonnet(payload)
        self.assertEqual(changes, [])


class TestInjectCacheBreakpoints(unittest.TestCase):
    def _bp(self, block):
        return block.get("cache_control") if isinstance(block, dict) else None

    def test_system_and_last_message_breakpoints(self):
        payload = {
            "model": "anthropic.claude-sonnet-5",
            "messages": [
                {"role": "system", "content": "SOUL + rules + tools"},
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"},
                {"role": "user", "content": "and now?"},
            ],
        }
        placed = inject_cache_breakpoints(payload)
        self.assertEqual(placed, 2)
        # System message -> content-parts form with cache_control.
        sys_content = payload["messages"][0]["content"]
        self.assertIsInstance(sys_content, list)
        self.assertEqual(
            sys_content[-1]["cache_control"], {"type": "ephemeral", "ttl": CACHE_TTL}
        )
        # Last message also carries a breakpoint.
        last_content = payload["messages"][-1]["content"]
        self.assertIsInstance(last_content, list)
        self.assertEqual(last_content[-1]["cache_control"]["ttl"], CACHE_TTL)

    def test_anchors_leading_system_not_trailing_reminder(self):
        # A trailing role=system reminder (build_retry_body appends these) must
        # NOT be where breakpoint 1 lands — it anchors the LEADING system block.
        payload = {
            "model": "anthropic.claude-sonnet-5",
            "messages": [
                {"role": "system", "content": "stable prefix"},
                {"role": "user", "content": "q"},
                {"role": "system", "content": "reminder: reply now"},
            ],
        }
        inject_cache_breakpoints(payload)
        # Leading system got the breakpoint...
        self.assertIn("cache_control", payload["messages"][0]["content"][-1])
        # ...trailing reminder is the LAST message, so it also gets breakpoint 2,
        # but the leading-system one is independent and byte-stable.
        self.assertNotEqual(payload["messages"][0], payload["messages"][2])

    def test_glm5_no_breakpoints(self):
        payload = {
            "model": "zai.glm-5",
            "messages": [{"role": "system", "content": "x"}, {"role": "user", "content": "y"}],
        }
        self.assertEqual(inject_cache_breakpoints(payload), 0)
        # Content stays a plain string (untouched).
        self.assertEqual(payload["messages"][0]["content"], "x")

    def test_empty_system_not_cached(self):
        payload = {
            "model": "anthropic.claude-sonnet-5",
            "messages": [{"role": "system", "content": "   "},
                         {"role": "user", "content": "hi"}],
        }
        placed = inject_cache_breakpoints(payload)
        # Empty system can't be cached; only the user turn gets a breakpoint.
        self.assertEqual(placed, 1)

    def test_deterministic(self):
        import copy
        payload = {
            "model": "anthropic.claude-sonnet-5",
            "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}],
        }
        a = copy.deepcopy(payload)
        b = copy.deepcopy(payload)
        inject_cache_breakpoints(a)
        inject_cache_breakpoints(b)
        self.assertEqual(a, b)


class TestDetectTrailingPrefill(unittest.TestCase):
    def test_trailing_assistant_prefill_detected(self):
        payload = {
            "model": "anthropic.claude-sonnet-5",
            "messages": [{"role": "user", "content": "q"},
                         {"role": "assistant", "content": "prefill"}],
        }
        self.assertTrue(detect_trailing_prefill(payload))

    def test_normal_tail_not_a_prefill(self):
        payload = {
            "model": "anthropic.claude-sonnet-5",
            "messages": [{"role": "assistant", "content": "a"},
                         {"role": "user", "content": "q"}],
        }
        self.assertFalse(detect_trailing_prefill(payload))

    def test_glm5_never_flagged(self):
        payload = {
            "model": "zai.glm-5",
            "messages": [{"role": "assistant", "content": "prefill"}],
        }
        self.assertFalse(detect_trailing_prefill(payload))


class TestUsageEndpoint(unittest.TestCase):
    """The /usage endpoint + the cumulative-counter delta contract (a
    before/after delta captures ONE turn's usage; counters are monotonic).
    Now also reports the cache-read/cache-write split (issue #1089)."""

    def setUp(self):
        mantle_proxy._cumulative_input_tokens = 0
        mantle_proxy._cumulative_output_tokens = 0
        mantle_proxy._cumulative_cache_read_tokens = 0
        mantle_proxy._cumulative_cache_write_tokens = 0
        mantle_proxy._last_model = None
        mantle_proxy._usage_events = 0

    def _usage_body(self):
        return asyncio.run(handle_usage(None)).payload

    def test_reports_zero_initially(self):
        body = self._usage_body()
        self.assertEqual(body["input_tokens"], 0)
        self.assertEqual(body["output_tokens"], 0)
        self.assertEqual(body["cache_read_input_tokens"], 0)
        self.assertEqual(body["cache_write_input_tokens"], 0)
        self.assertIsNone(body["model"])

    def test_reflects_cache_counters(self):
        mantle_proxy._cumulative_input_tokens = 500
        mantle_proxy._cumulative_output_tokens = 320
        mantle_proxy._cumulative_cache_read_tokens = 30000
        mantle_proxy._cumulative_cache_write_tokens = 1000
        mantle_proxy._last_model = "anthropic.claude-sonnet-5"
        body = self._usage_body()
        self.assertEqual(body["cache_read_input_tokens"], 30000)
        self.assertEqual(body["cache_write_input_tokens"], 1000)
        self.assertEqual(body["model"], "anthropic.claude-sonnet-5")

    def test_before_after_delta_captures_one_turn_cache(self):
        mantle_proxy._cumulative_cache_read_tokens = 10000
        baseline = self._usage_body()
        mantle_proxy._cumulative_cache_read_tokens += 32000
        final = self._usage_body()
        self.assertEqual(
            final["cache_read_input_tokens"] - baseline["cache_read_input_tokens"],
            32000,
        )


class TestAnthropicPathDetection(unittest.TestCase):
    def test_detects_anthropic_messages_path(self):
        self.assertTrue(_is_anthropic_messages_path("anthropic/v1/messages"))
        self.assertTrue(_is_anthropic_messages_path("/anthropic/v1/messages"))
        self.assertTrue(_is_anthropic_messages_path("v1/messages"))

    def test_rejects_openai_completions_path(self):
        self.assertFalse(_is_anthropic_messages_path("v1/chat/completions"))
        self.assertFalse(_is_anthropic_messages_path("chat/completions"))
        self.assertFalse(_is_anthropic_messages_path(""))


class TestInjectAnthropicCacheBreakpoints(unittest.TestCase):
    def test_string_system_becomes_cached_block(self):
        p = {"system": "big fixed prefix", "messages": [{"role": "user", "content": "hi"}]}
        placed = inject_anthropic_cache_breakpoints(p)
        self.assertEqual(placed, 2)  # system + last message
        self.assertIsInstance(p["system"], list)
        self.assertEqual(p["system"][0]["cache_control"], {"type": "ephemeral", "ttl": CACHE_TTL})
        # last message string content also converted + cached
        self.assertIsInstance(p["messages"][0]["content"], list)
        self.assertEqual(
            p["messages"][0]["content"][0]["cache_control"], {"type": "ephemeral", "ttl": CACHE_TTL}
        )

    def test_list_system_caches_last_block(self):
        p = {"system": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}
        placed = inject_anthropic_cache_breakpoints(p)
        self.assertEqual(placed, 1)
        self.assertNotIn("cache_control", p["system"][0])
        self.assertIn("cache_control", p["system"][1])

    def test_no_system_no_messages_is_noop(self):
        self.assertEqual(inject_anthropic_cache_breakpoints({}), 0)
        self.assertEqual(inject_anthropic_cache_breakpoints({"system": ""}), 0)

    def test_normalizes_openclaw_5m_blocks_to_1h_without_adding(self):
        # OpenClaw injects its OWN cache_control at 5m. Anthropic 400s if a 1h
        # block comes after a 5m block, so we must upgrade OpenClaw's blocks in
        # place to 1h and NOT add a second block (regression for the live 400:
        # "a ttl='1h' cache_control block must not come after a ttl='5m'").
        p = {
            "system": [
                {"type": "text", "text": "base",
                 "cache_control": {"type": "ephemeral", "ttl": "5m"}},
                {"type": "text", "text": "more"},
            ],
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "hi",
                 "cache_control": {"type": "ephemeral", "ttl": "5m"}}]}],
            "tools": [{"name": "t", "cache_control": {"type": "ephemeral", "ttl": "5m"}}],
        }
        placed = inject_anthropic_cache_breakpoints(p)
        self.assertEqual(placed, 3)  # 3 existing blocks normalized (tools+system+msg)
        self.assertEqual(p["system"][0]["cache_control"]["ttl"], CACHE_TTL)
        # No NEW block added onto the un-cached trailing system block.
        self.assertNotIn("cache_control", p["system"][1])
        self.assertEqual(p["messages"][0]["content"][0]["cache_control"]["ttl"], CACHE_TTL)
        self.assertEqual(p["tools"][0]["cache_control"]["ttl"], CACHE_TTL)


class TestParseAnthropicStream(unittest.TestCase):
    STREAM = (
        'event: message_start\n'
        'data: {"type":"message_start","message":{"model":"claude-sonnet-5",'
        '"usage":{"input_tokens":12,"cache_creation_input_tokens":30,'
        '"cache_read_input_tokens":2000}}}\n\n'
        'event: content_block_delta\n'
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n'
        'event: content_block_delta\n'
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n'
        'event: message_delta\n'
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},'
        '"usage":{"input_tokens":12,"cache_creation_input_tokens":30,'
        '"cache_read_input_tokens":2000,"output_tokens":7}}\n\n'
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    )

    def test_parses_content_usage_and_cache(self):
        content, stop, ui, uo, cr, cw, model = _parse_anthropic_stream(self.STREAM)
        self.assertEqual(content, "Hello")
        self.assertEqual(stop, "end_turn")
        # input_tokens is already de-cached on the Anthropic shape -> used as-is
        self.assertEqual(ui, 12)
        self.assertEqual(uo, 7)
        self.assertEqual(cr, 2000)  # cache_read
        self.assertEqual(cw, 30)    # cache_creation
        self.assertEqual(model, "claude-sonnet-5")


class TestParseAnthropicResponse(unittest.TestCase):
    def test_non_streaming_json(self):
        body = (
            '{"model":"claude-sonnet-5","content":[{"type":"text","text":"Pong!"}],'
            '"stop_reason":"end_turn","usage":{"input_tokens":8,'
            '"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":13}}'
        )
        content, stop, ui, uo, cr, cw, model = _parse_anthropic_response(body)
        self.assertEqual(content, "Pong!")
        self.assertEqual(stop, "end_turn")
        self.assertEqual(ui, 8)
        self.assertEqual(uo, 13)
        self.assertEqual(cr, 0)
        self.assertEqual(cw, 0)
        self.assertEqual(model, "claude-sonnet-5")

    def test_streaming_dispatch(self):
        # Delegates to the stream parser when SSE data lines are present.
        content, *_ = _parse_anthropic_response(TestParseAnthropicStream.STREAM)
        self.assertEqual(content, "Hello")


if __name__ == "__main__":
    unittest.main()
