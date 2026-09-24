---
type: Architecture
title: Streaming Architecture & SSE Keep-Alive
description: SSE streaming infrastructure with keep-alive frames for long-running AI turns, preventing ALB idle timeout disconnections during reasoning phases.
tags: [architecture, streaming, sse, reliability]
openwiki:
  roles: [architecture]
  change_kinds: [lifecycle, public-api]
  source_paths:
    - lib/streaming/sse-keep-alive.ts
    - lib/streaming/deferred-ui-message-stream.ts
    - lib/streaming/provider-adapters/base-adapter.ts
    - lib/streaming/nexus/nexus-streaming-service.ts
  test_paths:
    - lib/streaming/__tests__/sse-keepalive.test.ts
    - lib/streaming/__tests__/deferred-ui-message-stream.test.ts
    - tests/e2e/nexus-chat-slow-stream-visible-error.functional.spec.ts
    - tests/e2e/assistant-architect-slow-chain-visible-error.functional.spec.ts
  invariants:
    - ALB idle timeout is 300s; keep-alive interval is 15s (well under common proxy timeouts)
    - SSE comment frames (`: keep-alive`) are invisible to eventsource-parser — parsed chunk sequence unchanged
    - Backpressure preserved — slow client stalls model stream, not in-memory buffer
    - 40-minute lifetime ceiling prevents infinite streams when deadline missing
    - Deferred response commits after grace period — failure after commit surfaces as UI-message error chunk
    - Prompt chains run all but last prompt before streaming begins — deferred response required
  validation_commands:
    - bun run typecheck
    - bun test lib/streaming/__tests__/sse-keepalive.test.ts
    - bun test lib/streaming/__tests__/deferred-ui-message-stream.test.ts
---

# Streaming Architecture

AI Studio uses Server-Sent Events (SSE) for real-time streaming responses from AI models. The streaming layer includes reliability mechanisms to handle long-running turns that would otherwise timeout.

## The Silent Stream Problem

**Issue**: #1698 (FS#164150)

The Application Load Balancer (ALB) in front of ECS closes connections after 300 seconds with no bytes in either direction (`infra/lib/constructs/ecs-service.ts`, `idleTimeout`). Reasoning-tier models (GPT-5, Claude) emit a `start` chunk immediately and can then go completely silent for the entire think/tool phase.

### Why This Matters

- **GPT-5 per-step budget**: 300 seconds (`lib/streaming/provider-adapters/openai-adapter.ts`, `maxTimeoutMs`)
- **ALB timeout**: 300 seconds
- **Result**: Socket dies at or before the app-level abort fires
- **Symptom**: Terminal `error` chunk enqueued into a stream nobody is reading — turn stops with no answer and no error

### Why Raising ALB Timeout Doesn't Fix

Raising the ALB timeout would not fix this because:
1. Any intermediary proxy can cut a silent stream (common proxies use 60s timeouts)
2. Requires CDK deployment for infrastructure changes
3. Emitting a byte removes the idle constraint entirely

## SSE Keep-Alive Implementation

### Solution: Invisible Comment Frames

The standard SSE no-op frame `: keep-alive\n\n` is used for keep-alive because:
- `eventsource-parser` routes `:`-prefixed lines to `onComment` handler
- AI SDK does not supply `onComment`, so frames are discarded before reaching `processUIMessageStream`
- Parsed chunk sequence is identical to unwrapped stream
- A `data-*` chunk would NOT work — `isVisibleChunkType` counts them as visible output, suppressing "empty response" notices

### Keep-Alive Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `SSE_KEEP_ALIVE_INTERVAL_MS` | 15,000 (15s) | Well under 300s ALB timeout and 60s proxy timeouts; single dropped frame leaves buffer |
| `SSE_MAX_LIFETIME_MS` | 2,400,000 (40min) | Above longest route budget (nexus/chat: 30min); backstop for missing deadlines |
| Frame format | `: keep-alive\n\n` | Standard SSE comment; discarded by parser |

### Implementation: `withSseKeepAlive()`

**Location**: `lib/streaming/sse-keep-alive.ts`

```typescript
export function withSseKeepAlive(
  source: ReadableStream<Uint8Array>,
  options?: SseKeepAliveOptions
): ReadableStream<Uint8Array>
```

**Key behaviors**:
- Timer skipped when real bytes sent within interval — byte-identical to unwrapped stream
- Backpressure preserved — source only read when consumer has room (`desiredSize > 0`)
- Timers always released on end-of-stream, error, and consumer cancel
- Stream after `maxLifetimeMs` is errored (not cleanly closed) so client sees failure

**Call sites**:
- `lib/streaming/provider-adapters/base-adapter.ts` — All provider responses
- `app/api/compare/route.ts` — Model comparison
- `app/api/compare-models/route.ts` — Model comparison

### Response Helper: `withSseKeepAliveResponse()`

Applies keep-alive to a Response's body while preserving status and headers:

```typescript
export function withSseKeepAliveResponse(
  response: Response,
  options?: SseKeepAliveOptions
): Response
```

## Deferred Response for Prompt Chains

### Problem: No Body to Keep-Alive

`withSseKeepAlive` can only fill gaps in a body that already exists. Prompt-chain assistants run every prompt except the last to completion before building the streaming Response for the final one:

- **Execution**: `executePromptChain` in `app/api/assistant-architect/execute/route.ts`
- **Service**: `lib/api/assistant-execution-service.ts`
- **Issue**: Slow earlier prompt leaves socket with no bytes at all — not even headers

### Solution: `deferUIMessageStreamResponse()`

**Location**: `lib/streaming/deferred-ui-message-stream.ts`

```typescript
export async function deferUIMessageStreamResponse(
  pending: Promise<Response>,
  options: DeferUIMessageStreamOptions
): Promise<Response>
```

**Behavior**:
1. Wait grace period (default: 15s) for real Response
2. If Response arrives in time → return exactly what caller would have gotten
3. If timeout → commit to 200 SSE response immediately
4. Fill wait with keep-alive comments
5. Stream real body once it exists
6. If work fails after commit → single UI-message `error` chunk with user-facing message

**Call sites**:
- `app/api/assistant-architect/execute/route.ts` — Prompt chain execution
- `lib/api/assistant-execution-service.ts` — Execution service

### Error Handling After Commit

When a failure arrives after response was committed:
- Status code can no longer be sent (already committed 200)
- Error Response mapped to user-facing message via `onLateError` callback
- Single `error` UI-message chunk enqueued: `{ type: 'error', errorText: string }`
- Error Response also used for logging/compensation side effects

## Provider Adapter Integration

### Base Provider Adapter

All provider responses are wrapped with keep-alive at the provider adapter layer:

**Location**: `lib/streaming/provider-adapters/base-adapter.ts`

```typescript
// Keep socket warm through silent reasoning/tool stretch
return withSseKeepAliveResponse(
  createUIMessageStreamResponse({
    stream,
    headers: options?.headers,
  })
);
```

This means:
- All AI provider calls (OpenAI, Claude, Gemini, Bedrock) automatically get keep-alive
- No per-route configuration needed
- Consistent behavior across Nexus Chat, Model Compare, and Assistant execution

### Streaming Service

**Location**: `lib/streaming/nexus/nexus-streaming-service.ts`

The Nexus streaming service orchestrates:
- Multi-provider requests
- Response caching
- Cost optimization
- Telemetry tracking

All responses flow through the provider adapter layer and receive keep-alive.

## Change Guidance

### When to Modify Keep-Alive

**Adjust interval** when:
- New intermediary proxy with stricter timeout discovered
- Profile shows excessive keep-alive traffic in normal operation

**Adjust lifetime ceiling** when:
- Route `maxDuration` increases beyond 30 minutes
- New long-running feature (e.g., extended research agents)

### Adding New Streaming Routes

New routes that stream AI responses should:

1. **Use provider adapters** (automatic keep-alive)
2. **For deferred scenarios** (no body initially), use `deferUIMessageStreamResponse`
3. **Set route `maxDuration`** to match expected execution time
4. **Handle abort gracefully** — `buildAbortAwareResponse` appends terminal error chunk

### Testing Long-Running Streams

**Unit tests** (fast, controlled):
- `lib/streaming/__tests__/sse-keepalive.test.ts` — Timer behavior, backpressure, lifetime ceiling
- `lib/streaming/__tests__/deferred-ui-message-stream.test.ts` — Grace period, late errors

**E2E tests** (real browser stack):
- `tests/e2e/nexus-chat-slow-stream-visible-error.functional.spec.ts` — Client-side error visibility
- `tests/e2e/assistant-architect-slow-chain-visible-error.functional.spec.ts` — Prompt chain deferred response

**E2E note**: Uses mocked network responses (not real multi-minute delays). Tests wire format and client behavior.

### Silent Failure Pattern

**From**: `docs/guides/silent-failure-patterns.md`

```typescript
// WRONG — data-* counted as visible output, suppresses "empty response" notice
controller.enqueue({ type: 'data-keepalive' })

// CORRECT — SSE comment frame, below transport, discarded by parser
controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'))
```

**Review rule**: Any new long-lived SSE/WebSocket response must emit something well inside 300s. Always release timers on end-of-stream, error, AND consumer cancel.

## Related Infrastructure

- **ALB Configuration**: `infra/lib/constructs/ecs-service.ts` — `idleTimeout: cdk.Duration.seconds(300)`
- **Route Max Durations**:
  - Nexus Chat: 1800s (30min)
  - Assistant Architect: 900s (15min)
- **WebSocket Constraints**: `lib/voice/constants.ts` — Same ALB timeout applies to WebSocket path

## See Also

- **[architecture/overview.md](overview.md)** — Layered architecture, infrastructure layer
- **[app-features/overview.md](../app-features/overview.md)** — Nexus Chat, Assistant Architect features
- **[api-integration/overview.md](../api-integration/overview.md)** — REST API endpoints using streaming
- `/lib/streaming/README.md` — Developer reference for streaming service
- `/docs/guides/silent-failure-patterns.md` — SSE transport pitfalls
