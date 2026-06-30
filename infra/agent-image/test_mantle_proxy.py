"""Unit tests for mantle_proxy usage extraction + include_usage injection.

Covers the issue #1083 capture point: the proxy must read token `usage` from
both streaming (final usage chunk) and non-streaming OpenAI-compatible Mantle
responses, capture the real model id, and inject
`stream_options.include_usage=true` into streaming requests.

`mantle_proxy` imports `aiohttp` at module scope, which is part of the
container image but not the local test env. The functions under test are pure
and never touch aiohttp, so we stub it in sys.modules before import — the test
exercises the parsing logic, not the HTTP server.
"""

import sys
import types
import unittest

# Stub aiohttp BEFORE importing mantle_proxy so the module-level
# `from aiohttp import web, ClientSession, ClientTimeout` succeeds without the
# real package. The stub objects are never invoked by the pure functions.
if "aiohttp" not in sys.modules:
    _aiohttp = types.ModuleType("aiohttp")
    _aiohttp.web = types.SimpleNamespace(
        Request=object, Response=object, StreamResponse=object,
        Application=object, json_response=lambda *a, **k: None,
        run_app=lambda *a, **k: None,
    )
    _aiohttp.ClientSession = object
    _aiohttp.ClientTimeout = object
    sys.modules["aiohttp"] = _aiohttp

from mantle_proxy import (  # noqa: E402
    _extract_usage,
    inject_include_usage,
)


class TestExtractUsage(unittest.TestCase):
    def test_openai_field_names(self):
        # Standard OpenAI usage object.
        self.assertEqual(
            _extract_usage({"usage": {"prompt_tokens": 120, "completion_tokens": 45}}),
            (120, 45),
        )

    def test_alternate_field_names(self):
        # Some gateways emit input_tokens / output_tokens instead.
        self.assertEqual(
            _extract_usage({"usage": {"input_tokens": 7, "output_tokens": 3}}),
            (7, 3),
        )

    def test_openai_names_take_priority(self):
        # When both are present, the OpenAI names win (checked first).
        self.assertEqual(
            _extract_usage({
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 20,
                    "input_tokens": 999,
                    "output_tokens": 999,
                }
            }),
            (10, 20),
        )

    def test_no_usage_key(self):
        self.assertEqual(_extract_usage({"choices": []}), (None, None))

    def test_usage_not_a_dict(self):
        self.assertEqual(_extract_usage({"usage": "garbage"}), (None, None))

    def test_partial_usage(self):
        # Only one direction present — the other comes back None.
        self.assertEqual(
            _extract_usage({"usage": {"prompt_tokens": 50}}),
            (50, None),
        )

    def test_non_dict_input(self):
        self.assertEqual(_extract_usage(None), (None, None))
        self.assertEqual(_extract_usage([1, 2, 3]), (None, None))

    def test_non_int_token_values_ignored(self):
        # Float / string token values must not be trusted as ints.
        self.assertEqual(
            _extract_usage({"usage": {"prompt_tokens": "10", "completion_tokens": 5.5}}),
            (None, None),
        )

    def test_streaming_final_usage_chunk_shape(self):
        # The include_usage final chunk: empty choices + usage object.
        chunk = {
            "id": "chatcmpl-x",
            "model": "zai.glm-5",
            "choices": [],
            "usage": {"prompt_tokens": 1500, "completion_tokens": 320},
        }
        self.assertEqual(_extract_usage(chunk), (1500, 320))

    def test_non_streaming_response_shape(self):
        # A full non-streaming completion always carries usage.
        body = {
            "id": "chatcmpl-y",
            "model": "zai.glm-5",
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": "hi"},
                 "finish_reason": "stop"}
            ],
            "usage": {"prompt_tokens": 42, "completion_tokens": 8},
        }
        self.assertEqual(_extract_usage(body), (42, 8))


class TestInjectIncludeUsage(unittest.TestCase):
    def test_streaming_request_gets_include_usage(self):
        payload = {"stream": True, "messages": []}
        changed = inject_include_usage(payload)
        self.assertTrue(changed)
        self.assertEqual(payload["stream_options"], {"include_usage": True})

    def test_streaming_preserves_existing_stream_options(self):
        payload = {"stream": True, "stream_options": {"foo": "bar"}, "messages": []}
        changed = inject_include_usage(payload)
        self.assertTrue(changed)
        self.assertEqual(
            payload["stream_options"], {"foo": "bar", "include_usage": True}
        )

    def test_already_set_is_noop(self):
        payload = {"stream": True, "stream_options": {"include_usage": True}}
        changed = inject_include_usage(payload)
        self.assertFalse(changed)
        self.assertEqual(payload["stream_options"], {"include_usage": True})

    def test_non_streaming_untouched(self):
        payload = {"stream": False, "messages": []}
        changed = inject_include_usage(payload)
        self.assertFalse(changed)
        self.assertNotIn("stream_options", payload)

    def test_missing_stream_flag_untouched(self):
        payload = {"messages": []}
        changed = inject_include_usage(payload)
        self.assertFalse(changed)
        self.assertNotIn("stream_options", payload)

    def test_non_dict_input(self):
        self.assertFalse(inject_include_usage(None))
        self.assertFalse(inject_include_usage([]))

    def test_clobbers_non_dict_stream_options(self):
        # If stream_options is present but not a dict, replace it.
        payload = {"stream": True, "stream_options": "weird"}
        changed = inject_include_usage(payload)
        self.assertTrue(changed)
        self.assertEqual(payload["stream_options"], {"include_usage": True})


if __name__ == "__main__":
    unittest.main()
