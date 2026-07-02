#!/usr/bin/env python3
"""
Transparent logging proxy for Bedrock Mantle.

Why: we need ground-truth visibility into what OpenClaw actually sends to
Mantle. OpenClaw's logs don't include request bodies, and the "!"-loop
degeneracy we see isn't reproducible via direct curl calls with the same
apparent payload. This proxy sits on 127.0.0.1:18791, logs request +
response to stdout (CloudWatch), and forwards byte-for-byte to
https://bedrock-mantle.us-east-1.api.aws.

If this process dies, OpenClaw's requests also fail — so the entrypoint
should (a) verify the proxy's /health before starting the gateway and
(b) pass traffic through even on non-2xx upstream responses so we capture
error bodies.
"""
import asyncio
import json
import logging
import re
import sys
import time
from typing import Optional

from aiohttp import web, ClientSession, ClientTimeout


logging.basicConfig(
    level=logging.INFO,
    format='{"level":"%(levelname)s","logger":"mantle_proxy","message":%(message)s,"timestamp":"%(asctime)s"}',
    stream=sys.stdout,
    force=True,
)
log = logging.getLogger("mantle_proxy")


def j(msg: str, **kw) -> str:
    """JSON-safe log payload embedded as the `message` field."""
    payload = {"evt": msg, **kw}
    return json.dumps(payload, default=str)


UPSTREAM = "https://bedrock-mantle.us-east-1.api.aws"

# ---------------------------------------------------------------------------
# Cumulative token-usage accounting (issue #1083)
#
# The admin Agents dashboard needs real token counts + the real model id per
# agent turn. OpenClaw does not surface usage on its WebSocket event stream
# reliably, but Mantle's OpenAI-compatible responses DO carry a `usage` object
# — streaming responses emit it in a final chunk when the request asks for
# `stream_options.include_usage=true`, and non-streaming responses always
# include it. This proxy already parses every upstream response, so it is the
# clean capture point.
#
# We keep MODULE-LEVEL CUMULATIVE counters (never reset) plus the last model
# id. agentcore_wrapper.py reads `/usage` once before adapter.process() and
# once after, then takes the delta — that correctly sums a single turn's usage
# across the many sub-calls a tool loop makes. This works because the proxy is
# per-container = per-microVM = per-session and turns are serial, so no
# concurrent turn can interleave its usage into another turn's delta window.
#
# Only the FINAL adopted upstream response (post-retry, post-rescue) is counted,
# so a retried/degenerate first attempt does not double-count.
# ---------------------------------------------------------------------------
_usage_lock = asyncio.Lock()
_cumulative_input_tokens = 0
_cumulative_output_tokens = 0
# Bedrock prompt-caching token split (issue #1089). Cumulative like the
# input/output counters; agentcore_wrapper.py reads the before/after delta so a
# single turn's cache activity is summed across the tool-loop sub-calls.
_cumulative_cache_read_tokens = 0
_cumulative_cache_write_tokens = 0
_last_model: Optional[str] = None
_usage_events = 0  # count of upstream responses that carried a usage object


def _extract_usage(
    parsed: dict,
) -> tuple[Optional[int], Optional[int], int, int]:
    """Pull (billable_input, completion, cache_read, cache_write) from a `usage`
    object. Returns (None, None, 0, 0) when no usage is present.

    Accepts both the OpenAI field names (prompt_tokens/completion_tokens +
    prompt_tokens_details.cached_tokens) and the Anthropic-via-Mantle spelling
    (input_tokens/output_tokens + cache_read_input_tokens/
    cache_creation_input_tokens).

    IMPORTANT — de-caching (issue #1089): the two usage shapes count input
    tokens DIFFERENTLY, so cache subtraction must be shape-aware:

      * OpenAI shape (`prompt_tokens`): the TOTAL prompt, which INCLUDES the
        cached reads/writes. Recording that total as billable input AND pricing
        cache_read/cache_write separately would double-count, so we de-cache:
        `billable_input = prompt_tokens - cache_read - cache_write`.
      * Anthropic shape (`input_tokens`): ALREADY the de-cached, full-rate input
        — `cache_read_input_tokens` and `cache_creation_input_tokens` are
        counted SEPARATELY, not inside `input_tokens`. Subtracting again would
        undercount and clamp to 0 on cache-hit turns (chatgpt-codex #1092
        review), so we use `input_tokens` verbatim.

    With no caching (GLM-5) cache_read/write are 0 and both branches reduce to
    the old behaviour.
    """
    if not isinstance(parsed, dict):
        return None, None, 0, 0
    usage = parsed.get("usage")
    if not isinstance(usage, dict):
        return None, None, 0, 0

    # Track WHICH field the input count came from — only the OpenAI total gets
    # de-cached below (the Anthropic field is already billable).
    prompt_tokens = usage.get("prompt_tokens")
    input_tokens = usage.get("input_tokens")

    ct = usage.get("completion_tokens")
    if not isinstance(ct, int):
        ct = usage.get("output_tokens")

    # Cache reads: Anthropic-native field, else the OpenAI cached_tokens subset.
    cache_read = usage.get("cache_read_input_tokens")
    if not isinstance(cache_read, int):
        details = usage.get("prompt_tokens_details")
        if isinstance(details, dict):
            cache_read = details.get("cached_tokens")
    cache_read = cache_read if isinstance(cache_read, int) and cache_read > 0 else 0

    # Cache writes: Anthropic spells it cache_creation_input_tokens.
    cache_write = usage.get("cache_creation_input_tokens")
    if not isinstance(cache_write, int):
        cache_write = usage.get("cache_write_input_tokens")
    cache_write = cache_write if isinstance(cache_write, int) and cache_write > 0 else 0

    if isinstance(prompt_tokens, int):
        # OpenAI total includes cache read/write — de-cache to billable input.
        billable_input = max(0, prompt_tokens - cache_read - cache_write)
    elif isinstance(input_tokens, int):
        # Anthropic input_tokens is already the de-cached billable input.
        billable_input = input_tokens
    else:
        billable_input = None

    return (billable_input,
            ct if isinstance(ct, int) else None,
            cache_read,
            cache_write)


def inject_include_usage(payload: dict) -> bool:
    """When a request is streaming, ensure `stream_options.include_usage` is
    true so Mantle emits a final usage chunk. Mutates `payload` in place.
    Returns True if a change was made (caller must reserialize the body).

    Non-streaming requests are untouched — their responses always carry usage.
    """
    if not isinstance(payload, dict):
        return False
    if not payload.get("stream"):
        return False
    opts = payload.get("stream_options")
    if not isinstance(opts, dict):
        opts = {}
        payload["stream_options"] = opts
    if opts.get("include_usage") is True:
        return False
    opts["include_usage"] = True
    return True


# ---------------------------------------------------------------------------
# Claude Sonnet 5 request-shaping + Bedrock prompt caching (issue #1089)
#
# When the harness model is switched from GLM-5 to Claude Sonnet 5 the proxy
# becomes the request-shaping layer, because OpenClaw's OpenAI-completions path
# cannot express Anthropic-Messages concepts and Bedrock rejects some params
# that GLM-5 tolerated:
#
#   * Sonnet 5 400s on non-default temperature/top_p/top_k -> strip them.
#   * On Bedrock, a forced tool_choice ({type:tool|any}) REQUIRES thinking
#     disabled; OpenClaw's loop forces tool_choice, so set thinking:disabled.
#   * Bedrock has no automatic prompt caching -> inject explicit cache_control
#     breakpoints at the stable prefix boundary so the ~32k fixed prefix is
#     re-read at ~0.1x instead of re-charged at full input price every turn.
#
# All of this is GATED on the model being an Anthropic/Claude model, so a
# rollback to GLM-5 (revert openclaw.json, keep this image) leaves GLM-5
# requests byte-for-byte unchanged.
# ---------------------------------------------------------------------------

# 1-hour TTL: agent turns are often minutes apart, so a 5-minute cache would
# expire between turns and re-pay the write every turn. 1h (2x write, break-even
# at >=3 reads) keeps the stable prefix warm across the gaps.
CACHE_TTL = "1h"

# Sampling params Sonnet 5 rejects with a 400 when set to a non-default value.
_SONNET_STRIP_KEYS = ("temperature", "top_p", "top_k")


def _is_anthropic_model(model: Optional[str]) -> bool:
    """True for Claude/Anthropic model ids (e.g. anthropic.claude-sonnet-5,
    us.anthropic.claude-sonnet-5). The Sonnet request-shaping below only applies
    to these, so GLM-5 (zai.glm-5) traffic is never touched."""
    if not isinstance(model, str):
        return False
    m = model.lower()
    return "claude" in m or "anthropic" in m or "sonnet" in m


def shape_request_for_sonnet(payload: dict) -> list:
    """Strip params Sonnet 5 rejects and force thinking disabled. Mutates
    `payload` in place. Returns a list of change tags for logging (empty = no
    change). No-op for non-Anthropic models."""
    if not isinstance(payload, dict):
        return []
    if not _is_anthropic_model(payload.get("model")):
        return []
    changes: list = []
    for key in _SONNET_STRIP_KEYS:
        if key in payload:
            del payload[key]
            changes.append(f"strip:{key}")
    # OpenClaw's OpenAI path may carry reasoning_effort; with thinking disabled
    # it is redundant and can conflict with the explicit thinking field, so drop
    # it and set thinking:disabled (required alongside forced tool_choice on
    # Bedrock).
    if "reasoning_effort" in payload:
        del payload["reasoning_effort"]
        changes.append("strip:reasoning_effort")
    if payload.get("thinking") != {"type": "disabled"}:
        payload["thinking"] = {"type": "disabled"}
        changes.append("thinking:disabled")
    return changes


def _add_cache_control(msg: dict, ttl: str) -> bool:
    """Attach a cache_control breakpoint to an OpenAI-format message by moving
    its content into the content-parts form (the shape the Anthropic
    OpenAI-compat layer reads cache_control from). Returns True if a breakpoint
    was placed. Deterministic -> does not itself invalidate the cache."""
    if not isinstance(msg, dict):
        return False
    breakpoint_obj = {"type": "ephemeral", "ttl": ttl}
    content = msg.get("content")
    if isinstance(content, str):
        if not content.strip():
            return False
        msg["content"] = [
            {"type": "text", "text": content, "cache_control": breakpoint_obj}
        ]
        return True
    if isinstance(content, list) and content:
        # Attach to the last block that can carry cache_control.
        for block in reversed(content):
            if isinstance(block, dict):
                block["cache_control"] = breakpoint_obj
                return True
    return False


def inject_cache_breakpoints(payload: dict) -> int:
    """Inject up to two cache_control breakpoints so the byte-stable prefix is
    cached across turns (issue #1089). No-op for non-Anthropic models. Mutates
    `payload` in place; returns the number of breakpoints placed.

    Placement (render order is tools -> system -> messages):
      1. End of the LEADING system block (messages[0..k] where role==system).
         The compat layer maps the system message onto Anthropic `system`, so a
         breakpoint there caches tools + the full ~32k system prefix. We anchor
         on the *leading* system block, not the last system message, so the
         retry-reminder system messages this proxy appends at the tail (see
         build_retry_body) never shift the breakpoint and bust the cache.
      2. End of the LAST message overall — reuses the whole conversation prefix
         on multi-turn follow-ups.
    Volatile per-turn content (the user's new question, any per-request caller
    line) lives in the trailing user turn, i.e. AFTER breakpoint 1 — so the
    cached prefix stays byte-stable turn to turn.
    """
    if not isinstance(payload, dict):
        return 0
    if not _is_anthropic_model(payload.get("model")):
        return 0
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        return 0

    placed = 0
    # 1. Last message of the contiguous leading system block.
    last_leading_system_idx = -1
    for idx, msg in enumerate(messages):
        if isinstance(msg, dict) and msg.get("role") == "system":
            last_leading_system_idx = idx
        else:
            break
    if last_leading_system_idx >= 0:
        if _add_cache_control(messages[last_leading_system_idx], CACHE_TTL):
            placed += 1

    # 2. Last message overall (skip if it is the same leading-system message).
    last_idx = len(messages) - 1
    if last_idx != last_leading_system_idx:
        if _add_cache_control(messages[last_idx], CACHE_TTL):
            placed += 1

    return placed


# ---------------------------------------------------------------------------
# Anthropic Messages path (issue #1089 — CORRECTED handoff)
#
# Bedrock Mantle does NOT serve Claude on the OpenAI-completions endpoint
# (`/v1/chat/completions` returns 400 "does not support the '/v1/chat/completions'
# API"). Claude is served on the Anthropic Messages endpoint
# `https://bedrock-mantle.<region>.api.aws/anthropic/v1/messages`. OpenClaw is
# therefore configured with `api: "anthropic-messages"` (openclaw.json), so it
# sends NATIVE Anthropic Messages requests here. This proxy branch:
#   * injects `cache_control` in the ANTHROPIC shape (top-level `system` +
#     last message content block) — verified to cache on this endpoint
#     (cache_creation on turn 1 → cache_read on turn 2), and
#   * parses the Anthropic SSE stream (message_start / content_block_delta /
#     message_delta) for usage.
# The OpenAI-only request-shaping (thinking:disabled, stream_options,
# OpenAI-format cache injection) is NOT applied here — it would 400 a native
# Anthropic request.
# ---------------------------------------------------------------------------


def _is_anthropic_messages_path(path: str) -> bool:
    """True when the forwarded path targets Mantle's Anthropic Messages API
    (e.g. `anthropic/v1/messages`). OpenClaw's `anthropic-messages` provider
    hits `<baseUrl>/v1/messages`, and our baseUrl ends in `/anthropic`, so the
    proxy path is `anthropic/v1/messages`."""
    if not isinstance(path, str):
        return False
    p = path.lstrip("/")
    return p.startswith("anthropic/") or p.endswith("/v1/messages") or p == "v1/messages"


def _cache_ctrl() -> dict:
    return {"type": "ephemeral", "ttl": CACHE_TTL}


def inject_anthropic_cache_breakpoints(payload: dict) -> int:
    """Inject up to two `cache_control` breakpoints into a native Anthropic
    Messages request so the byte-stable prefix is cached across turns
    (issue #1089). Mutates `payload` in place; returns breakpoints placed.

    Placement (Anthropic render order is tools -> system -> messages):
      1. Last block of the top-level `system` (the big fixed prefix: SOUL +
         rules + tool guidance). This is the highest-yield breakpoint.
      2. Last content block of the last message (multi-turn prefix reuse).
    Verified against Mantle: a 2014-token system block wrote the cache on the
    first call and read it on the second.
    """
    if not isinstance(payload, dict):
        return 0
    placed = 0

    # 1. system — string or list-of-blocks.
    system = payload.get("system")
    if isinstance(system, str) and system.strip():
        payload["system"] = [
            {"type": "text", "text": system, "cache_control": _cache_ctrl()}
        ]
        placed += 1
    elif isinstance(system, list) and system:
        for block in reversed(system):
            if isinstance(block, dict):
                block["cache_control"] = _cache_ctrl()
                placed += 1
                break

    # 2. last message's last cacheable content block.
    messages = payload.get("messages")
    if isinstance(messages, list) and messages:
        last = messages[-1]
        if isinstance(last, dict):
            content = last.get("content")
            if isinstance(content, str) and content.strip():
                last["content"] = [
                    {"type": "text", "text": content, "cache_control": _cache_ctrl()}
                ]
                placed += 1
            elif isinstance(content, list) and content:
                for block in reversed(content):
                    if isinstance(block, dict) and block.get("type") in (
                        "text", "tool_result", "tool_use", "image", "document"
                    ):
                        block["cache_control"] = _cache_ctrl()
                        placed += 1
                        break

    return placed


def _parse_anthropic_stream(joined: str):
    """Parse an Anthropic Messages SSE stream. Returns
    (content, stop_reason, usage_in, usage_out, cache_read, cache_write, model).

    Event shapes (verified against Mantle):
      message_start  -> {"message":{"model","usage":{input_tokens,
                          cache_creation_input_tokens, cache_read_input_tokens}}}
      content_block_delta -> {"delta":{"type":"text_delta","text":"..."}}
      message_delta  -> {"usage":{output_tokens, ...}, "delta":{"stop_reason"}}
    Usage is merged across message_start (input + cache) and message_delta
    (output, and a repeat of input/cache on Mantle) taking the latest non-None.
    """
    content = ""
    stop_reason = None
    usage_in = usage_out = None
    cache_read = cache_write = 0
    model = None
    for line in joined.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            d = json.loads(payload)
        except Exception:
            continue
        if not isinstance(d, dict):
            continue
        t = d.get("type")
        if t == "message_start":
            msg = d.get("message") or {}
            if isinstance(msg, dict):
                if isinstance(msg.get("model"), str):
                    model = msg["model"]
                ui, uo, cr, cw = _extract_usage(msg)
                if ui is not None:
                    usage_in = ui
                if uo is not None:
                    usage_out = uo
                if cr:
                    cache_read = cr
                if cw:
                    cache_write = cw
        elif t == "content_block_delta":
            delta = d.get("delta") or {}
            if isinstance(delta, dict) and delta.get("type") == "text_delta":
                content += delta.get("text", "") or ""
        elif t == "message_delta":
            ui, uo, cr, cw = _extract_usage(d)
            if ui is not None:
                usage_in = ui
            if uo is not None:
                usage_out = uo
            if cr:
                cache_read = cr
            if cw:
                cache_write = cw
            dd = d.get("delta") or {}
            if isinstance(dd, dict) and dd.get("stop_reason"):
                stop_reason = dd["stop_reason"]
    return content, stop_reason, usage_in, usage_out, cache_read, cache_write, model


def _parse_anthropic_response(joined: str):
    """Parse an Anthropic Messages response (streaming SSE or non-streaming
    JSON). Same 7-tuple as _parse_anthropic_stream."""
    if "data:" in joined:
        return _parse_anthropic_stream(joined)
    try:
        d = json.loads(joined)
    except Exception:
        return "", None, None, None, 0, 0, None
    if not isinstance(d, dict):
        return "", None, None, None, 0, 0, None
    content = ""
    for block in d.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            content += block.get("text", "") or ""
    ui, uo, cr, cw = _extract_usage(d)
    model = d.get("model") if isinstance(d.get("model"), str) else None
    return content, d.get("stop_reason"), ui, uo, cr, cw, model


def detect_trailing_prefill(payload: dict) -> bool:
    """Sonnet 5 400s on a last-assistant-turn prefill. OpenClaw's tool loop
    should never send one (the last turn is user/tool), but detect it so a
    surprise surfaces in CloudWatch rather than as an opaque 400. Non-
    destructive: we log, we do not mutate (dropping the message could corrupt
    the turn)."""
    if not isinstance(payload, dict):
        return False
    if not _is_anthropic_model(payload.get("model")):
        return False
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        return False
    last = messages[-1]
    if not isinstance(last, dict) or last.get("role") != "assistant":
        return False
    content = last.get("content")
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        return len(content) > 0
    return False


# ---------------------------------------------------------------------------
# Tool-call-id repair for Kimi K2.5 on Bedrock Mantle
#
# Kimi K2's native tool_call_id format is `functions.<name>:<idx>` (documented
# by vLLM / Moonshot). OpenClaw's pi-agent-core harness strips the `.` and `:`
# when echoing its own tool_calls back in history, so Kimi sees IDs like
# `functionsexec0` in prior assistant messages. With short history Kimi
# tolerates this; once history exceeds ~6 messages Kimi silently returns empty
# responses (zero content deltas, finish_reason=stop) or degenerates into
# repeating a single punctuation token — exact symptom proven by replaying
# the failing body with the IDs restored: 0 content → 186 chars of real text.
#
# This proxy repairs the IDs before forwarding to Mantle so the on-the-wire
# shape matches what Kimi expects regardless of what the harness wrote.
# ---------------------------------------------------------------------------

# Matches OpenClaw's stripped form: `functions` + name (lowercase+underscore) +
# trailing digits. Captures name and index for reinsertion of the separators.
_STRIPPED_TC_ID = re.compile(r"^functions([a-z][a-z0-9_]*?)(\d+)$")


def _restore_tool_call_id(raw: str) -> str:
    """Rewrite `functionsexec0` → `functions.exec:0`. Untouched if already
    contains `.` or `:` (already in native format), or if it doesn't match
    the OpenClaw-stripped shape."""
    if not isinstance(raw, str):
        return raw
    if "." in raw or ":" in raw:
        return raw
    m = _STRIPPED_TC_ID.match(raw)
    if not m:
        return raw
    return f"functions.{m.group(1)}:{m.group(2)}"


def repair_tool_call_ids(payload: dict) -> int:
    """Walk the messages array, restore tool_call ids and tool_call_id
    references to Kimi's native format. Returns count of fields rewritten."""
    rewrites = 0
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        tcs = msg.get("tool_calls")
        if isinstance(tcs, list):
            for tc in tcs:
                if not isinstance(tc, dict):
                    continue
                old_id = tc.get("id")
                new_id = _restore_tool_call_id(old_id)
                if new_id != old_id:
                    tc["id"] = new_id
                    rewrites += 1
        ref = msg.get("tool_call_id")
        new_ref = _restore_tool_call_id(ref)
        if new_ref != ref:
            msg["tool_call_id"] = new_ref
            rewrites += 1
    return rewrites


# Max bytes of request body we log. CloudWatch accepts up to 256KB per event,
# but lines of that size make CLI consumption painful — so we cap at 80KB per
# log event and, when the body exceeds, we emit it across multiple chunks
# that can be reassembled offline.
MAX_REQ_LOG = 80000
# Max bytes per individual log record (keeps each CloudWatch line small enough
# for interactive grep but still fits the proxy's biggest realistic request).
MAX_REQ_CHUNK_LOG = 20000
# Cap chunks logged for a streaming response. The degenerate "!" stream emits
# ~400 chunks; logging them all bloats the log group without adding signal
# past the first handful.
MAX_RESP_CHUNKS_LOGGED = 60
# Max bytes per response chunk in the log.
MAX_RESP_CHUNK_BYTES = 800
# Detector thresholds for the "model bailed after a tool result" failure.
# Two conditions trigger rescue:
#   1. Trivial ack: trimmed model output < 20 chars (e.g. "Done.", "👍").
#   2. Disproportionate abandonment: tool result >= MIN_TOOL_LEN_FOR_RATIO
#      chars AND model output < min(RATIO_CAP_CHARS, RATIO_FRACTION * tool_len).
#      Catches cases like the 2026-05-15 Morning Brief where the model
#      received a 3446-char rendered brief but replied with 45 chars of
#      hallucinated "delivered" text. Ratio fires only when the tool result
#      is substantial — small tool results commonly get legitimate short
#      acks, and we don't want to dump 200 chars on top of a 4-char "ok".
EMPTY_RELAY_LIMIT = 20
MIN_TOOL_LEN_FOR_RATIO = 1500
RATIO_FRACTION = 0.05
RATIO_CAP_CHARS = 150

# Graceful synthesised reply when the model produces zero content in
# response to a *user* message (different failure mode from the post-tool
# silence — there's no tool output we could relay verbatim, so we just
# tell the user we dropped the turn and ask them to try again).
EMPTY_USER_MSG_FALLBACK = (
    "Sorry — I dropped that turn and didn't produce a reply. "
    "Can you say that again or rephrase?"
)


def _extract_last_tool_text(parsed) -> Optional[str]:
    """Return the trailing tool message's text content, or None if the
    last message isn't a tool result. Used to detect (and rescue) the
    post-tool empty-relay failure mode."""
    if not isinstance(parsed, dict):
        return None
    messages = parsed.get("messages")
    if not isinstance(messages, list) or not messages:
        return None
    last = messages[-1]
    if not isinstance(last, dict) or last.get("role") != "tool":
        return None
    content = last.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return None


def _last_message_role(parsed) -> Optional[str]:
    """Return the role of the trailing message in the request, or None.
    Used to discriminate empty-response failure modes (post-tool silence
    vs the model going silent when the user just spoke)."""
    if not isinstance(parsed, dict):
        return None
    messages = parsed.get("messages")
    if not isinstance(messages, list) or not messages:
        return None
    last = messages[-1]
    if not isinstance(last, dict):
        return None
    role = last.get("role")
    return role if isinstance(role, str) else None


def _synthesize_relay_chunks(tool_text: str, model_name: Optional[str],
                             streaming: bool) -> list:
    """Build response chunks that relay `tool_text` verbatim as if the
    model had produced it. Mirrors the SSE / JSON shape OpenClaw and the
    harness adapter already parse. Synthesis is the last-resort rescue
    path when retries don't dislodge the model from an empty-relay turn."""
    msg_id = f"chatcmpl-rescue-{int(time.time() * 1000)}"
    created = int(time.time())
    model = model_name or "rescue"
    if streaming:
        delta_chunk = {
            "id": msg_id,
            "model": model,
            "created": created,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": tool_text},
                "finish_reason": None,
            }],
        }
        stop_chunk = {
            "id": msg_id,
            "model": model,
            "created": created,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
            }],
        }
        sse = (
            f"data: {json.dumps(delta_chunk, ensure_ascii=False)}\n\n"
            f"data: {json.dumps(stop_chunk, ensure_ascii=False)}\n\n"
            "data: [DONE]\n\n"
        )
        return [sse.encode("utf-8")]
    # Non-streaming JSON body.
    body = {
        "id": msg_id,
        "model": model,
        "created": created,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": tool_text},
            "finish_reason": "stop",
        }],
    }
    return [json.dumps(body, ensure_ascii=False).encode("utf-8")]


async def handle_health(_request: web.Request) -> web.Response:
    return web.Response(text="ok")


async def handle_usage(_request: web.Request) -> web.Response:
    """Return the cumulative token usage + last model id observed across all
    Mantle calls this container has proxied (issue #1083).

    agentcore_wrapper.py reads this once before adapter.process() and once
    after, then takes the delta to get a single turn's usage. Counters are
    monotonic and never reset; the delta is what matters, not the absolute.
    """
    async with _usage_lock:
        payload = {
            "input_tokens": _cumulative_input_tokens,
            "output_tokens": _cumulative_output_tokens,
            "cache_read_input_tokens": _cumulative_cache_read_tokens,
            "cache_write_input_tokens": _cumulative_cache_write_tokens,
            "model": _last_model,
            "usage_events": _usage_events,
        }
    return web.json_response(payload)


async def handle_proxy(request: web.Request) -> web.StreamResponse:
    path = request.match_info.get("path", "")
    url = f"{UPSTREAM}/{path}"
    req_id = f"{int(time.time()*1000)}-{id(request) % 100000}"
    t0 = time.time()

    req_body: Optional[bytes] = None
    if request.method in ("POST", "PUT", "PATCH"):
        req_body = await request.read()

    # Log request summary + truncated body
    try:
        parsed = json.loads(req_body) if req_body else None
    except Exception:
        parsed = None

    # REQUEST-REWRITE STEP: two INDEPENDENT concerns, each with its own guard,
    # before anything else touches the body. Reserialize only if we actually
    # mutated the payload — keeps the wire body byte-identical otherwise.
    #   (a) tool_call_id repair — needs a messages array to walk.
    #   (b) include_usage injection — only needs `stream:true`; it must NOT be
    #       gated on `messages` (a future change to the repair guard would
    #       otherwise silently disable usage tracking). Decoupled per review.
    # The Anthropic Messages path (Claude Sonnet 5, issue #1089) needs
    # DIFFERENT handling than the OpenAI-completions path: OpenClaw sends a
    # native Anthropic request, so we inject cache_control in the Anthropic
    # shape and apply NONE of the OpenAI-only shaping (thinking:disabled,
    # stream_options, OpenAI-format cache injection) which would 400 it.
    is_anthropic = _is_anthropic_messages_path(path)
    if isinstance(parsed, dict):
        if is_anthropic:
            cache_breakpoints = inject_anthropic_cache_breakpoints(parsed)
            if cache_breakpoints:
                req_body = json.dumps(parsed, ensure_ascii=False).encode("utf-8")
                log.info(j("request_rewritten_anthropic", req_id=req_id,
                           cache_breakpoints=cache_breakpoints))
        else:
            rewrites = repair_tool_call_ids(parsed) if parsed.get("messages") else 0
            usage_injected = inject_include_usage(parsed)
            # Legacy OpenAI-completions request-shaping (GLM-5/Kimi). No-op for
            # non-Anthropic models; Anthropic traffic never reaches this branch.
            sonnet_changes = shape_request_for_sonnet(parsed)
            cache_breakpoints = inject_cache_breakpoints(parsed)
            if detect_trailing_prefill(parsed):
                log.warning(j("sonnet_trailing_prefill_detected", req_id=req_id,
                              note="last message is an assistant prefill"))
            if rewrites or usage_injected or sonnet_changes or cache_breakpoints:
                req_body = json.dumps(parsed, ensure_ascii=False).encode("utf-8")
                log.info(j("request_rewritten", req_id=req_id, rewrites=rewrites,
                           include_usage_injected=usage_injected,
                           sonnet_changes=sonnet_changes,
                           cache_breakpoints=cache_breakpoints))

    if parsed and isinstance(parsed, dict):
        summary = {
            "req_id": req_id,
            "method": request.method,
            "path": f"/{path}",
            "model": parsed.get("model"),
            "stream": parsed.get("stream"),
            "tool_choice": parsed.get("tool_choice"),
            "tools_count": len(parsed.get("tools") or []),
            "messages_count": len(parsed.get("messages") or []),
            "max_tokens": parsed.get("max_tokens"),
            "temperature": parsed.get("temperature"),
            "top_p": parsed.get("top_p"),
            "reasoning_effort": parsed.get("reasoning_effort"),
            "other_keys": sorted([
                k for k in parsed.keys()
                if k not in {"model", "stream", "tool_choice", "tools",
                             "messages", "max_tokens", "temperature",
                             "top_p", "reasoning_effort"}
            ]),
        }
        # Surface which tools were offered and their names (no schemas, keeps
        # the log small) plus message roles so we can see conversation shape.
        tool_names = [(t.get("function") or {}).get("name") for t in parsed.get("tools") or []]
        msg_shape = [
            {"role": m.get("role"),
             "has_tool_calls": bool(m.get("tool_calls")),
             "content_len": (len(m.get("content")) if isinstance(m.get("content"), str)
                             else sum(len(json.dumps(p)) for p in (m.get("content") or [])))}
            for m in (parsed.get("messages") or [])
        ]
        log.info(j("req_summary", **summary,
                   tool_names=tool_names,
                   messages_shape=msg_shape))
    else:
        log.info(j("req", req_id=req_id, method=request.method, path=f"/{path}",
                   body_size=len(req_body) if req_body else 0))

    if req_body:
        body_str = req_body.decode(errors="replace")
        total_len = len(body_str)
        # Log the body as a sequence of numbered chunks. The offline
        # reassembly rule is: concat `part 0..N-1` where N == n_parts.
        # This preserves the full body up to MAX_REQ_LOG without blowing
        # past the per-CloudWatch-event size ceiling.
        capped = body_str[:MAX_REQ_LOG]
        n_parts = (len(capped) + MAX_REQ_CHUNK_LOG - 1) // MAX_REQ_CHUNK_LOG or 1
        for i in range(n_parts):
            start = i * MAX_REQ_CHUNK_LOG
            log.info(j("req_body_part",
                       req_id=req_id,
                       part=i,
                       n_parts=n_parts,
                       total_len=total_len,
                       body=capped[start:start + MAX_REQ_CHUNK_LOG]))
        if total_len > MAX_REQ_LOG:
            log.warning(j("req_body_truncated",
                          req_id=req_id,
                          total_len=total_len,
                          logged=MAX_REQ_LOG))

        # Parallel path: emit each message individually so we can reason
        # about role/content/tool_call structure without reassembling.
        if isinstance(parsed, dict) and isinstance(parsed.get("messages"), list):
            for idx, msg in enumerate(parsed["messages"]):
                # Shrink any single message to 8KB. We want shape visibility,
                # not the full tool output blob.
                m_json = json.dumps(msg, ensure_ascii=False)
                log.info(j("req_message",
                           req_id=req_id,
                           idx=idx,
                           role=msg.get("role"),
                           has_tool_calls=bool(msg.get("tool_calls")),
                           content_type=("string" if isinstance(msg.get("content"), str)
                                         else type(msg.get("content")).__name__),
                           content_len=(len(msg["content"]) if isinstance(msg.get("content"), str)
                                         else None),
                           raw=m_json[:8000]))

    # Forward — preserve auth + content-type, drop hop-by-hop headers
    fwd_headers = {}
    for k, v in request.headers.items():
        kl = k.lower()
        if kl in {"host", "content-length", "connection", "transfer-encoding"}:
            continue
        fwd_headers[k] = v

    timeout = ClientTimeout(total=300, sock_read=300, sock_connect=30)

    # Capture the last tool-result text so we can detect the "model bailed
    # after tool result" signature and synthesize a verbatim relay if all
    # retries fail. See is_retryable_failure / rescue logic below.
    last_tool_text: Optional[str] = _extract_last_tool_text(parsed)
    # Also capture the last message role so we can distinguish two empty-
    # turn failure modes: (a) silence after a tool result — rescue by
    # relaying the tool text; (b) silence after a user message — rescue
    # by sending a graceful "try again" reply. The 2026-05-19 incident
    # was case (b): user accused the agent of merging a PR autonomously
    # and the model produced zero chars / finish=stop / no tool events.
    last_role: Optional[str] = _last_message_role(parsed)

    async def fetch_upstream(attempt_label: str, body_override: Optional[bytes] = None):
        """One upstream fetch. Buffers the whole body (full headers + all
        chunks) so we can inspect the response and decide whether to retry
        before committing it to the client.

        Returns (status, headers_dict, chunks_list, content_text, finish_reason,
        usage_in, usage_out, cache_read, cache_write, model). `content_text` is
        the reassembled assistant delta text (from SSE `data:` events when
        streaming), used to detect empty/degenerate outputs. `usage_in` is the
        de-cached billable input; `cache_read`/`cache_write` are the Bedrock
        prompt-caching token split (issue #1089). All usage numbers are pulled
        from the response (None/0 when absent) and fed to the cumulative
        `/usage` counters by the caller.
        """
        body_to_send = body_override if body_override is not None else req_body
        async with ClientSession(timeout=timeout) as session:
            async with session.request(
                request.method, url, data=body_to_send, headers=fwd_headers,
                allow_redirects=False,
            ) as upstream:
                status = upstream.status
                up_headers = {k: v for k, v in upstream.headers.items()
                              if k.lower() not in {
                                  "content-encoding", "content-length",
                                  "transfer-encoding", "connection"}}
                chunks: list = []
                total = 0
                async for ch in upstream.content.iter_any():
                    chunks.append(ch)
                    total += len(ch)
                # Reassemble SSE content for streaming responses.
                content = ""
                finish = None
                usage_in: Optional[int] = None
                usage_out: Optional[int] = None
                cache_read = 0
                cache_write = 0
                resp_model: Optional[str] = None
                joined = b"".join(chunks).decode(errors="replace")
                if is_anthropic:
                    # Native Anthropic Messages response (streaming or JSON).
                    (content, finish, usage_in, usage_out,
                     cache_read, cache_write, resp_model) = _parse_anthropic_response(joined)
                elif "data:" in joined:
                    for line in joined.splitlines():
                        line = line.strip()
                        if not line.startswith("data: "):
                            continue
                        payload = line[6:]
                        if payload == "[DONE]":
                            continue
                        try:
                            d = json.loads(payload)
                        except Exception:
                            continue
                        if isinstance(d, dict):
                            # Usage + model can ride on ANY chunk — the final
                            # usage chunk (stream_options.include_usage) carries
                            # `usage` with an empty `choices: []`, while `model`
                            # appears on every chunk. Capture both before the
                            # empty-choices skip below.
                            ui, uo, cr, cw = _extract_usage(d)
                            if ui is not None:
                                usage_in = ui
                            if uo is not None:
                                usage_out = uo
                            if cr:
                                cache_read = cr
                            if cw:
                                cache_write = cw
                            m = d.get("model")
                            if isinstance(m, str) and m:
                                resp_model = m
                        # A present-but-empty `choices: []` (the usage chunk
                        # emitted for stream_options.include_usage, which OpenClaw
                        # 2026.6.11 now requests) makes `.get("choices", [{}])`
                        # return [] — the default only applies when the key is
                        # ABSENT — so [0] would IndexError. Skip empty/usage
                        # chunks; the raw bytes still relay to OpenClaw untouched,
                        # this parse only feeds the retry/rescue classification.
                        choices = d.get("choices") or []
                        if not choices:
                            continue
                        ch_obj = choices[0]
                        delta = ch_obj.get("delta") or {}
                        if delta.get("content"):
                            content += delta["content"]
                        if ch_obj.get("finish_reason"):
                            finish = ch_obj["finish_reason"]
                else:
                    # Non-streaming: parse once.
                    try:
                        d = json.loads(joined)
                        # Same empty-`choices` guard as the streaming path: a
                        # present-but-empty list must not be indexed (the prior
                        # `[{}]` default silently dropped content here under the
                        # except: pass).
                        if isinstance(d, dict):
                            usage_in, usage_out, cache_read, cache_write = _extract_usage(d)
                            m = d.get("model")
                            if isinstance(m, str) and m:
                                resp_model = m
                            choices = d.get("choices") or []
                            if choices:
                                msg = choices[0].get("message", {})
                                content = msg.get("content") or ""
                                finish = choices[0].get("finish_reason")
                    except Exception:
                        pass
                log.info(j(
                    "upstream_fetched",
                    req_id=req_id,
                    attempt=attempt_label,
                    status=status,
                    total_bytes=total,
                    content_len=len(content),
                    finish=finish,
                    usage_in=usage_in,
                    usage_out=usage_out,
                    cache_read=cache_read,
                    cache_write=cache_write,
                    resp_model=resp_model,
                    elapsed_ms=int((time.time() - t0) * 1000),
                ))
                return (status, up_headers, chunks, content, finish,
                        usage_in, usage_out, cache_read, cache_write, resp_model)

    def is_retryable_failure(status: int, content: str, finish: Optional[str]) -> Optional[str]:
        """Classify the upstream response. Return a reason-string if the
        response should be retried, else None. Only retry when the upstream
        returned 200 but the completion was empty / obviously degenerate /
        an empty relay after a tool result — provider-level protocol errors
        (4xx/5xx) should surface unmodified.

        `empty_post_tool` is the specific failure mode the user hit on the
        2026-05-14 Morning Brief: model received a 4.6KB tool result, then
        ended the turn with effectively no user-visible text. We detect by
        (a) `finish=stop`, (b) trimmed content shorter than `EMPTY_RELAY_LIMIT`,
        (c) the trailing request message was `role=tool`. The trim length
        excludes thin acks ("Done.", " ", "👍") but lets a real summary pass.
        """
        if status != 200:
            return None
        # Degeneracy: the tail is a single-character repetition (e.g. "!!!!!").
        # Check this BEFORE the empty-content branch so a long degenerate
        # reply doesn't get reclassified as empty_completion on retry.
        if content and len(content) >= 80 and len(set(content[-80:])) <= 2:
            return "degenerate_repetition"
        # Empty / near-empty content: discriminate by what the model was
        # responding to. Post-tool silence is rescued by verbatim relay
        # of the tool text; post-user silence is rescued by a graceful
        # "try again" reply (no tool to relay).
        if finish == "stop" and last_tool_text:
            stripped_len = len(content.strip())
            tool_len = len(last_tool_text)
            # Case 1: trivial ack.
            if stripped_len < EMPTY_RELAY_LIMIT:
                return "empty_post_tool_relay"
            # Case 2: disproportionate abandonment of substantial tool result.
            if tool_len >= MIN_TOOL_LEN_FOR_RATIO:
                ratio_limit = min(RATIO_CAP_CHARS, int(RATIO_FRACTION * tool_len))
                if stripped_len < ratio_limit:
                    return "empty_post_tool_relay"
        if finish == "stop" and last_role == "user" and not content.strip():
            # Model produced zero content in reply to a user message. This
            # is the catastrophic empty-turn case — the user said something
            # and got nothing back. Always retry.
            return "empty_post_user_msg"
        # Generic empty-completion fallback for cases the above didn't catch
        # (no last_tool_text AND last_role != "user", or finish=length, etc.).
        if not content and finish in ("stop", "length"):
            return "empty_completion"
        return None

    def build_retry_body(failure_mode: str) -> bytes:
        """Reserialize the request with a system reminder appended,
        tailored to the failure mode. Only safe to call when `parsed`
        is a dict with a messages array."""
        if not (isinstance(parsed, dict) and isinstance(parsed.get("messages"), list)):
            return req_body or b""
        if failure_mode == "empty_post_tool_relay":
            reminder = (
                "Your previous attempt produced no user-visible text after a "
                "tool result. The user cannot see tool output directly. "
                "Produce the user-facing response now, relaying or "
                "summarizing the tool result so the user sees the answer."
            )
        elif failure_mode == "empty_post_user_msg":
            reminder = (
                "Your previous attempt produced no reply to the user's "
                "message. The user is waiting for a response. Even a single "
                "short sentence acknowledging what they said is better than "
                "silence. Reply now."
            )
        else:
            # Generic nudge for empty_completion / other modes; harmless
            # to include even if the model has nothing extra to say.
            reminder = (
                "Your previous attempt produced no user-visible text. "
                "Produce a reply now."
            )
        new_parsed = dict(parsed)
        new_messages = list(parsed["messages"])
        new_messages.append({"role": "system", "content": reminder})
        new_parsed["messages"] = new_messages
        return json.dumps(new_parsed, ensure_ascii=False).encode("utf-8")

    try:
        # First attempt.
        (status, headers, chunks, content, finish,
         usage_in, usage_out, cache_read, cache_write, resp_model) = await fetch_upstream("first")
        # The native Anthropic path (Sonnet 5) does not use the OpenAI-shaped
        # empty-relay/degeneracy retry+rescue — that was a GLM-5/Kimi workaround
        # and its detectors assume the OpenAI response shape. We forward the
        # response through and only account usage.
        reason = None if is_anthropic else is_retryable_failure(status, content, finish)
        retry_attempts = 0
        # Up to 2 retries (3 total upstream calls). Stop as soon as one
        # succeeds. The retry body carries the empty-relay reminder only
        # for the post-tool case; other failures retry with the original
        # body since the cause is upstream-side.
        while reason is not None and retry_attempts < 2:
            retry_attempts += 1
            # Inject a tailored reminder for the two empty-turn modes;
            # let other failures (degenerate_repetition, empty_completion
            # with no last-message context) retry against the same body
            # since the cause is upstream-side.
            retry_body = (
                build_retry_body(reason)
                if reason in ("empty_post_tool_relay", "empty_post_user_msg")
                else None
            )
            log.warning(j("retrying_on_failure", req_id=req_id, reason=reason,
                          attempt=retry_attempts,
                          first_content_len=len(content), first_finish=finish,
                          inject_reminder=bool(retry_body)))
            (status_r, headers_r, chunks_r, content_r, finish_r,
             usage_in_r, usage_out_r, cache_read_r, cache_write_r,
             resp_model_r) = await fetch_upstream(
                f"retry{retry_attempts}", body_override=retry_body
            )
            reason_r = is_retryable_failure(status_r, content_r, finish_r)
            # Always adopt the latest attempt's response body — if it succeeds
            # we use it directly; if it fails we still prefer it as the most
            # recent attempt before any rescue synthesis.
            status, headers, chunks, content, finish = (
                status_r, headers_r, chunks_r, content_r, finish_r
            )
            # Usage carry-forward: adopt the retry's usage ONLY when it actually
            # reported usage — a retry whose response was differently-shaped (no
            # `usage` object) must NOT discard the real, already-generated token
            # count from the prior attempt (that would undercount cost). We take
            # the latest NON-None value per field so the final billed usage is
            # the freshest real number, not a null overwrite (review round 2).
            if usage_in_r is not None:
                usage_in = usage_in_r
            if usage_out_r is not None:
                usage_out = usage_out_r
            # Cache tokens ride the same carry-forward rule: adopt the retry's
            # split ONLY when the retry actually carried a usage object, so a
            # usage-less retry response doesn't zero out the real cache numbers
            # from the prior attempt.
            if usage_in_r is not None or usage_out_r is not None:
                cache_read = cache_read_r
                cache_write = cache_write_r
            if resp_model_r:
                resp_model = resp_model_r
            if reason_r is None:
                log.info(j("retry_succeeded", req_id=req_id,
                           attempt=retry_attempts,
                           retry_content_len=len(content_r),
                           retry_finish=finish_r))
                reason = None
                break
            reason = reason_r
            log.warning(j("retry_also_failed", req_id=req_id,
                          attempt=retry_attempts,
                          retry_reason=reason_r,
                          retry_content_len=len(content_r)))

        # Rescue synthesis: if all retries left us with an empty-turn
        # signature, replace the response chunks with synthesised text.
        # The harness adapter will see real assistant content instead of
        # an empty final, but still writes an empty_response failure
        # record so we can dashboard rescue rate.
        rescue_text: Optional[str] = None
        rescue_label: Optional[str] = None
        if reason == "empty_post_tool_relay" and last_tool_text:
            rescue_text = last_tool_text
            rescue_label = "rescued_from_tool_result"
        elif reason == "empty_post_user_msg":
            rescue_text = EMPTY_USER_MSG_FALLBACK
            rescue_label = "rescued_from_user_msg"
        if rescue_text is not None:
            is_streaming = bool(parsed and parsed.get("stream"))
            chunks = _synthesize_relay_chunks(
                tool_text=rescue_text,
                model_name=(parsed or {}).get("model") if isinstance(parsed, dict) else None,
                streaming=is_streaming,
            )
            headers = dict(headers)
            headers["Content-Type"] = (
                "text/event-stream" if is_streaming else "application/json"
            )
            status = 200
            log.warning(j(rescue_label,
                          req_id=req_id,
                          synth_text_len=len(rescue_text),
                          retries_attempted=retry_attempts))

        # Account the FINAL adopted response's usage into the cumulative
        # counters so agentcore_wrapper's before/after `/usage` delta captures
        # this turn's tokens. Rescue synthesis replaces the chunks but keeps the
        # usage from the last real upstream attempt (usage_in/out unchanged),
        # which is the right number to bill for the turn.
        if usage_in is not None or usage_out is not None or resp_model:
            global _cumulative_input_tokens, _cumulative_output_tokens
            global _cumulative_cache_read_tokens, _cumulative_cache_write_tokens
            global _last_model, _usage_events
            async with _usage_lock:
                if isinstance(usage_in, int):
                    _cumulative_input_tokens += usage_in
                if isinstance(usage_out, int):
                    _cumulative_output_tokens += usage_out
                if isinstance(cache_read, int):
                    _cumulative_cache_read_tokens += cache_read
                if isinstance(cache_write, int):
                    _cumulative_cache_write_tokens += cache_write
                if resp_model:
                    _last_model = resp_model
                if usage_in is not None or usage_out is not None:
                    _usage_events += 1

        # Forward the (possibly retried) response to the client.
        resp = web.StreamResponse(status=status, headers=headers)
        await resp.prepare(request)
        total_sent = 0
        logged_chunks = 0
        for ch in chunks:
            if logged_chunks < MAX_RESP_CHUNKS_LOGGED:
                log.info(j("resp_chunk", req_id=req_id,
                           idx=logged_chunks,
                           bytes=len(ch),
                           body=ch[:MAX_RESP_CHUNK_BYTES].decode(errors="replace")))
                logged_chunks += 1
            try:
                await resp.write(ch)
                total_sent += len(ch)
            except (ConnectionResetError, asyncio.CancelledError):
                log.warning(j("resp_client_disconnect", req_id=req_id,
                              bytes_sent=total_sent))
                raise
        await resp.write_eof()
        log.info(j("resp_done",
                   req_id=req_id,
                   status=status,
                   total_bytes=total_sent,
                   chunks_logged=logged_chunks,
                   elapsed_ms=int((time.time() - t0) * 1000)))
        return resp
    except Exception as exc:  # noqa: BLE001
        log.error(j("proxy_error", req_id=req_id, err=str(exc)[:400],
                    elapsed_ms=int((time.time() - t0) * 1000)))
        return web.Response(status=502, text=f"proxy error: {exc}")


def main() -> None:
    app = web.Application(client_max_size=50 * 1024 * 1024)
    app.router.add_get("/health", handle_health)
    app.router.add_get("/usage", handle_usage)
    app.router.add_route("*", "/{path:.*}", handle_proxy)
    log.info(j("starting", host="127.0.0.1", port=18791, upstream=UPSTREAM))
    web.run_app(app, host="127.0.0.1", port=18791, access_log=None,
                print=lambda *a, **k: None)


if __name__ == "__main__":
    main()
