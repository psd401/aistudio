# Silent Failure Patterns

Bugs where code silently does the wrong thing instead of throwing. These are the hardest to catch in code review because they don't produce errors — they produce wrong results.

Consolidated from learnings across database, AI SDK, streaming, security, and API categories.

## Drizzle ORM

### `undefined` vs `null` in `.set()` calls

`undefined` silently **skips the column update**. `null` explicitly **clears the column**.

```typescript
// WRONG — user clears field, but DB retains old value
await db.update(table).set({
  optionalField: data.optionalField, // undefined when cleared → silently skipped
})

// CORRECT — explicit null clears the column
await db.update(table).set({
  optionalField: data.optionalField ?? null,
})
```

**Review rule:** Any `.set()` call with optional/clearable fields must use `?? null`.

### `updated_at` without trigger

Drizzle `defaultNow()` only runs at INSERT. Without a PostgreSQL trigger, `updated_at` is permanently stale after creation.

```sql
-- Required in every migration with updated_at
-- update_updated_at_column() is defined in /infra/database/schema/
-- Verify the function exists before relying on it: \df update_updated_at_column
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON your_table_name
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

**Review rule:** Every new table with `updated_at` must have a trigger in the migration SQL.

## Fetch / HTTP

### `response.json().catch(() => fallback)` hides HTTP status codes

Using `.catch()` on `.json()` as a fallback silently discards the HTTP status code and the actual error body. When an ALB returns 502/503 with an HTML body, `.json()` throws a parse error and the catch swallows all diagnostic signal — infra failures become indistinguishable from app errors.

```typescript
// WRONG — HTTP status code and error body are silently lost
const data = await response.json().catch(() => ({ error: 'Upload failed' }))

// CORRECT — check response.ok first, then parse with appropriate content-type handling
if (!response.ok) {
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => null);
  throw new Error(`Request failed: HTTP ${response.status} — ${typeof body === 'object' && body !== null ? JSON.stringify(body) : (body ?? 'no body')}`);
}
const data = await response.json();
```

**Review rule:** Every `.json()` call on a fetch response must be preceded by a `response.ok` (or status code) check. Flag any `.catch(() => fallback)` on a `.json()` call as a potential diagnostic blackhole.

## AI SDK v6

### `onStepFinish` fires before tool execution

`onStepFinish.toolResults` is always `[]`. Tool results are only available in `onFinish` via `event.steps`.

```typescript
// WRONG — toolResults is always empty here
onStepFinish: (step) => {
  persistToolResults(step.toolResults) // silently persists nothing
}

// CORRECT — results available after all steps complete
onFinish: async (event) => {
  for (const step of event.steps) {
    for (const result of step.toolResults) {
      await persistToolResult(result)
    }
  }
}
```

### `convertToModelMessages` requires `state` + `input` on every tool-call part

AI SDK v6's `convertToModelMessages()` REQUIRES both `state: 'output-available'` AND `input: Record<string, unknown>` on every tool-call `UIMessage` part. If either field is missing, the SDK emits a `tool_use` block with no matching `tool_result` block, which Anthropic's API rejects on the next user turn with `AI_MissingToolResultsError: "Expected toolResult blocks"`.

```typescript
// WRONG — missing state and input; SDK silently omits the tool_result block
{
  type: 'tool-call',
  toolCallId: 'tc_123',
  toolName: 'my_tool',
  args: { query: 'hello' },
  // no state, no input → Anthropic rejects follow-up with AI_MissingToolResultsError
}

// CORRECT — both fields required for SDK to emit paired tool_use + tool_result
{
  type: 'tool-call',
  toolCallId: 'tc_123',
  toolName: 'my_tool',
  args: { query: 'hello' },
  state: 'output-available',   // required: one of 'input-available' | 'output-available' | 'output-error' | 'partial-call'
  input: { query: 'hello' },   // required: mirrors args, used by SDK to reconstruct tool_result
}
```

**Review rule:** Any code path that builds or persists assistant tool-call parts (especially `buildAssistantParts`, history adapters, and `convertContentToParts`) MUST set `state` and `input`. Also validate `state` against the allowed enum when reading it from storage — a stored `state: undefined` must not silently downgrade to `input-available`. See `app/api/nexus/chat/chat-helpers.ts` and `lib/nexus/history-adapter.ts`.

### Multi-step MCP tool runs must persist per-step DB rows

When `maxSteps > 1` (enabled for MCP connector runs), AI SDK v6's `streamText` may complete multiple assistant→tool→assistant turns in one streaming call. Consolidating these into a **single DB row** produces a message containing both tool-call parts AND text. On conversation reload, `convertToModelMessages()` cannot reconstruct the correct multi-turn Anthropic structure from a single row, producing consecutive user turns that the Anthropic API rejects.

```typescript
// WRONG — one consolidated row covers all steps; replay produces consecutive user turns
await executeQuery(
  (db) => db.insert(messages).values({
    content: JSON.stringify(allStepsConsolidated), // tool-calls + text in one row
  }),
  'saveConversation'
)

// CORRECT — each step (assistant turn, tool result turn) gets its own row,
// all written atomically inside a single executeTransaction
await executeTransaction(async (tx) => {
  for (const step of event.steps) {
    await tx.insert(messages).values({ content: JSON.stringify(step.parts), role: 'assistant' })
    if (step.toolResults.length > 0) {
      await tx.insert(messages).values({ content: JSON.stringify(step.toolResults), role: 'tool' })
    }
  }
}, 'saveConversationSteps')
```

**Review rule:** Any streaming handler that uses `maxSteps > 1` MUST call `saveConversationSteps()` (or equivalent) rather than a single-row persist. If existing conversations contain consolidated multi-step rows, a `normalizeMultiStepMessages()` pre-processing step is required before passing history to `convertToModelMessages()`. See `app/api/nexus/chat/chat-helpers.ts` (`saveConversationSteps`) and `lib/streaming/unified-streaming-service.ts` (`normalizeMultiStepMessages`).

### `execute()` return shape vs sanitization

If `execute()` returns `{ id, success }`, any arg sanitization inside it is **dead code**. The frontend reads args from the streaming tool invocation object, not from `execute()` return.

```typescript
// WRONG — sanitizing inside execute() has no effect on what the frontend displays
execute: async (args) => {
  args.title = escapeHtml(args.title) // dead code — frontend already has raw args
  return { id: args.chartId, success: true }
}

// CORRECT — sanitize in the render/display layer
// In the tool result renderer component:
const safeTitle = escapeHtml(toolInvocation.args.title)
```

**Review rule:** Check what `execute()` actually returns. Sanitize at the render layer, not the execute layer.

### `customFetch` must throw (not return) after showing a toast

When a `customFetch` implementation shows a toast for an error response and then **returns** the response instead of throwing, the AI SDK `streamText` runtime receives a resolved promise and attempts to parse the non-streaming JSON error body as an SSE stream, producing a `TypeError`.

```typescript
// WRONG — AI SDK treats the resolved promise as a valid stream
if (!response.ok) {
  toast.error('Something went wrong');
  return response; // SDK will try to parse HTML/JSON error body as SSE
}

// CORRECT — throw so the SDK never attempts stream parsing
if (!response.ok) {
  toast.error('Something went wrong');
  throw new Error('Request failed'); // MUST throw — toast and throw are not mutually exclusive
}
```

**Review rule:** Any `customFetch` with a non-2xx branch that returns instead of throwing will cause a `TypeError` in the SDK stream parser. Review all `customFetch` implementations for non-throwing error branches.

### In-place mutation of tool args

Mutating AI SDK `args` in-place breaks `argsText` invariant in assistant-ui. Always return new objects from sanitization functions.

```typescript
// WRONG — mutates SDK's reference
function sanitize(args: ChartArgs): void { args.title = escapeHtml(args.title) }

// CORRECT — returns new object
function sanitize(args: ChartArgs): ChartArgs { return { ...args, title: escapeHtml(args.title) } }
```

### `fromThreadMessageLike` format

> **Version note:** This applies to `@assistant-ui/react` v0.12.x. Check the assistant-ui changelog if upgrading — the format may change.

Only accepts `type: 'tool-call'` (dynamic format). Static formats like `tool-show_chart` silently fail to deserialize.

```typescript
// WRONG — static format, silently skipped during history reload
{ type: 'tool-show_chart', args: { ... } }

// CORRECT — dynamic format fromThreadMessageLike expects
{ type: 'tool-call', toolName: 'show_chart', args: { ... } }
```

Also: HTML entities in tool args (e.g. `&amp;`) must be decoded at save boundary and at history load — `argsText` must match `JSON.stringify(args)` exactly or the append-only check fails.

## AWS APIs

### SNS Subject 100-char limit causes silent publish failures

SNS `publish()` rejects subjects longer than 100 characters, but the SDK does not surface an error in normal success-path logging. Any dynamic Subject construction from variable-length arrays is a latent silent failure.

```typescript
// WRONG — joined categories can exceed 100 chars silently
const subject = `Guardrail blocked: ${blockedCategories.join(', ')}`;
await sns.publish({ TopicArn, Subject: subject, Message });

// CORRECT — truncate before publishing
const raw = `Guardrail blocked: ${blockedCategories.join(', ')}`;
const subject = raw.length > 100 ? raw.slice(0, 97) + '...' : raw;
await sns.publish({ TopicArn, Subject: subject, Message });
```

**Review rule:** Treat SNS Subject as a 100-char-max field. Flag any `array.join()` or template literal used as an SNS Subject without a length guard.

### Bedrock guardrail assessment: check ALL sub-properties of SDK objects

AWS SDK assessment objects often have multiple sub-properties. Iterating only one silently drops entire blocking categories from observability. For example, `WordPolicyAssessment` has both `customWords` and `managedWordLists` — PROFANITY is enforced via managed word lists and is invisible if only `customWords` is checked.

```typescript
// WRONG — misses PROFANITY (managed word list) blocks entirely
wordPolicy?.customWords?.forEach(word => track(word));

// CORRECT — covers both sub-properties
wordPolicy?.customWords?.forEach(word => track(word));
wordPolicy?.managedWordLists?.forEach(word => track(word));
```

**Review rule:** Before shipping any monitoring/extraction function that reads AWS SDK assessment objects, enumerate all properties of the relevant type via TypeDoc or SDK source. A missing sub-property silently drops an entire blocking category.

## Caching

### SWR cache: `null` return conflates not-found with error

When a DB accessor returns `null` for both "row not found" and "DB error", a stale-while-revalidate cache cannot distinguish them. A background refresh that writes `null` back to the cache during a transient DB error silently overwrites valid cached state with a default/empty value.

```typescript
// WRONG — null from error overwrites cache; caller can't distinguish not-found from DB outage
async function getSetting(key: string): Promise<Setting | null> {
  try { return await db.query(...) } catch { return null }
}

// CORRECT — throw on error so SWR can retain stale cache; null = definitively not found
async function getSetting(key: string): Promise<Setting | null> {
  return await db.query(...) // throws on DB error; returns null only for missing rows
}

// In SWR refresh: on null/error, preserve existing cache rather than overwriting
```

**Generation counter pattern** — prevents a slow background refresh from overwriting cache with stale data after an explicit invalidation:

```typescript
let refreshGeneration = 0;

async function refreshCache(key: string) {
  const myGen = ++refreshGeneration;
  const data = await fetchFreshData(key);
  if (myGen !== refreshGeneration) return; // a newer refresh started; discard result
  cache.set(key, data);
}
```

**Review rule:** Before implementing SWR, audit the DB accessor's null semantics. If it returns null for errors, fix the accessor first. Background refresh callbacks must use a generation counter to avoid writing stale data after explicit cache invalidation.

## Third-Party SDK Types

### `@google/genai` SDK `Blob` is not the Web API `Blob`

`@google/genai` defines its own `Blob` interface: `{ data: string; mimeType: string }` where `data` is base64-encoded. It is structurally incompatible with the browser/Node.js `Blob`. TypeScript may not catch the mismatch if the web `Blob` partially satisfies the structural check — the SDK silently receives an unusable object.

```typescript
// WRONG — web API Blob, silently fails inside the SDK
await session.sendRealtimeInput({ audio: webBlob });

// CORRECT — SDK Blob type: base64-encoded data with explicit mimeType
const arrayBuffer = await webBlob.arrayBuffer();
const base64 = Buffer.from(arrayBuffer).toString('base64');
await session.sendRealtimeInput({
  audio: { data: base64, mimeType: 'audio/pcm;rate=16000' }
});
```

**Review rule:** When using `@google/genai`, any parameter typed as `Blob` is the SDK's custom type. Verify shapes directly in `node_modules/@google/genai/types.d.ts` before passing audio or binary data.

## Prototype Pollution

### Model-controlled key accumulators

When iterating keys from model/user-controlled data, `{}` is vulnerable to `__proto__` pollution.

```typescript
// WRONG — __proto__ key mutates prototype chain
const result = data.reduce((acc, item) => { acc[item.key] = item.value; return acc }, {})

// CORRECT — no prototype to pollute
const result = data.reduce((acc, item) => { acc[item.key] = item.value; return acc }, Object.create(null))
```

## NextAuth SessionProvider

### `refetchOnWindowFocus` causes silent remounts

Default `refetchOnWindowFocus=true` creates new session object reference on every tab switch. If `session` is in a `useEffect` dependency array, the effect re-runs and can reset component state.

```typescript
// In SessionProvider config
<SessionProvider refetchOnWindowFocus={false} refetchInterval={5 * 60}>

// In effects: use primitive status, not session object
useEffect(() => { ... }, [status, conversationId]) // not [session, conversationId]
```

## HTML Entity Decoding

### Null bytes and double-unescaping

`&#0;` decodes to U+0000, which PostgreSQL rejects. Sequential `.replace()` chains trigger CodeQL double-unescaping alerts.

```typescript
// WRONG — two-pass, triggers CodeQL; fromCharCode breaks surrogate pairs
text.replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))

// CORRECT — single-pass regex that decodes all entity types in one .replace() call.
// Reject control chars (U+0000–U+001F minus tab/newline/CR) at decode time, not just at save time.
// Use String.fromCodePoint (not fromCharCode) for correct supplementary-plane handling.
// See actual implementation: lib/utils/text-sanitizer.ts
```

**Review rule:** Test with `&#0;`, `&#x0;`, and surrogate-pair entities (`&#55357;&#56832;`) when touching any entity decoder.

---

*Source: learnings from database, ai-sdk, streaming, security, frontend, api-patterns, infrastructure, and monitoring categories (2026-02-18 through 2026-05-15)*
