---
title: fromThreadMessageLike requires 'tool-call' format, not static tool names
category: ai-sdk
tags: [assistant-ui, tool-calls, history-adapter, silent-failure]
severity: high
date: 2026-02-20
source: auto — /work
applicable_to: project
---

## What Happened

Issue #798: Tool call args mismatched on conversation reload. History adapter saved tool calls using static format (e.g., `tool-show_chart`), but `assistant-ui`'s `fromThreadMessageLike` only accepts `type='tool-call'`. Silently failed to deserialize, breaking conversation history.

## Root Cause

Two encoding issues converged:
1. **Format mismatch**: History adapter used static tool format; `fromThreadMessageLike` only recognizes `type='tool-call'` (dynamic format)
2. **HTML entity encoding**: AI models generate HTML entities in tool args (`&amp;` instead of `&`). When argsText recomputed from parsed args, JSON.stringify produces unencoded output, causing append-only check failure

## Solution

- **Format**: Use `type: 'tool-call'` in history adapter (not static `tool-{name}`)
- **Encoding**: Decode HTML entities at save boundary (db.save) and load boundary (conversation history load). argsText must match `JSON.stringify(args)` exactly.
- **API response**: Strip redundant argsText from response (client recomputes from args if needed)

See `/app/api/v1/conversations/[conversationId]/messages/route.ts` — decode step before storing, and history adapter format fix in conversation-schema.ts.

## Prevention

- Validate `fromThreadMessageLike` input format before using history adapters
- Test round-trip: parse → recompute argsText → compare. Encoding differences are silent bugs.
- Use decode/encode utilities at persistence boundaries, not in business logic
