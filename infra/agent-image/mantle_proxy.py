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


async def handle_health(_request: web.Request) -> web.Response:
    return web.Response(text="ok")


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

    # REPAIR STEP: fix stripped tool_call_ids before anything else touches
    # the body. Reserialize only if we actually rewrote fields — keeps the
    # wire payload byte-identical when no repair is needed.
    if isinstance(parsed, dict) and parsed.get("messages"):
        rewrites = repair_tool_call_ids(parsed)
        if rewrites:
            req_body = json.dumps(parsed, ensure_ascii=False).encode("utf-8")
            log.info(j("tool_call_id_repair", req_id=req_id, rewrites=rewrites))

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

    async def fetch_upstream(attempt_label: str):
        """One upstream fetch. Buffers the whole body (full headers + all
        chunks) so we can inspect the response and decide whether to retry
        before committing it to the client.

        Returns (status, headers_dict, chunks_list, content_text, finish_reason).
        `content_text` is the reassembled assistant delta text (from SSE `data:`
        events when streaming), used to detect empty/degenerate outputs.
        """
        async with ClientSession(timeout=timeout) as session:
            async with session.request(
                request.method, url, data=req_body, headers=fwd_headers,
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
                joined = b"".join(chunks).decode(errors="replace")
                if "data:" in joined:
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
                        ch_obj = d.get("choices", [{}])[0]
                        delta = ch_obj.get("delta") or {}
                        if delta.get("content"):
                            content += delta["content"]
                        if ch_obj.get("finish_reason"):
                            finish = ch_obj["finish_reason"]
                else:
                    # Non-streaming: parse once.
                    try:
                        d = json.loads(joined)
                        msg = d.get("choices", [{}])[0].get("message", {})
                        content = msg.get("content") or ""
                        finish = d.get("choices", [{}])[0].get("finish_reason")
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
                    elapsed_ms=int((time.time() - t0) * 1000),
                ))
                return status, up_headers, chunks, content, finish

    def is_retryable_failure(status: int, content: str, finish: Optional[str]) -> Optional[str]:
        """Classify the upstream response. Return a reason-string if the
        response should be retried, else None. Only retry when the upstream
        returned 200 but the completion was empty or obviously degenerate —
        provider-level protocol errors (4xx/5xx) should surface unmodified."""
        if status != 200:
            return None
        if not content and finish in ("stop", "length"):
            return "empty_completion"
        # Degeneracy: the tail is a single-character repetition (e.g. "!!!!!")
        if content and len(content) >= 80 and len(set(content[-80:])) <= 2:
            return "degenerate_repetition"
        return None

    try:
        # First attempt.
        status, headers, chunks, content, finish = await fetch_upstream("first")
        reason = is_retryable_failure(status, content, finish)
        if reason:
            log.warning(j("retrying_on_failure", req_id=req_id, reason=reason,
                          first_content_len=len(content), first_finish=finish))
            # One retry. We re-use the repaired request body verbatim.
            status2, headers2, chunks2, content2, finish2 = await fetch_upstream("retry")
            reason2 = is_retryable_failure(status2, content2, finish2)
            if reason2 is None:
                # Retry succeeded. Use its chunks.
                status, headers, chunks = status2, headers2, chunks2
                log.info(j("retry_succeeded", req_id=req_id,
                           retry_content_len=len(content2), retry_finish=finish2))
            else:
                log.warning(j("retry_also_failed", req_id=req_id,
                              retry_reason=reason2, retry_content_len=len(content2)))
                # Fall through: forward the retry's response (same shape, same failure);
                # the harness adapter will surface its fail-loud message.
                status, headers, chunks = status2, headers2, chunks2

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
    app.router.add_route("*", "/{path:.*}", handle_proxy)
    log.info(j("starting", host="127.0.0.1", port=18791, upstream=UPSTREAM))
    web.run_app(app, host="127.0.0.1", port=18791, access_log=None,
                print=lambda *a, **k: None)


if __name__ == "__main__":
    main()
