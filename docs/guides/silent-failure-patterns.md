# Silent Failure Patterns

Bugs where code silently does the wrong thing instead of throwing. These are the hardest to catch in code review because they don't produce errors — they produce wrong results.

Consolidated from ~8 learnings across database, AI SDK, streaming, and security categories.

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
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON your_table_name
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

**Review rule:** Every new table with `updated_at` must have a trigger in the migration SQL.

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

### `execute()` return shape vs sanitization

If `execute()` returns `{ id, success }`, any arg sanitization inside it is **dead code**. The frontend reads args from the streaming tool invocation object, not from `execute()` return.

**Review rule:** Check what `execute()` actually returns. Sanitize at the render layer, not the execute layer.

### In-place mutation of tool args

Mutating AI SDK `args` in-place breaks `argsText` invariant in assistant-ui. Always return new objects from sanitization functions.

```typescript
// WRONG — mutates SDK's reference
function sanitize(args: ChartArgs): void { args.title = escapeHtml(args.title) }

// CORRECT — returns new object
function sanitize(args: ChartArgs): ChartArgs { return { ...args, title: escapeHtml(args.title) } }
```

### `fromThreadMessageLike` format

Only accepts `type: 'tool-call'` (dynamic format). Static formats like `tool-show_chart` silently fail to deserialize.

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

**Fix:** Use single-pass regex with control char filtering and `String.fromCodePoint` (not `fromCharCode`).

---

*Source: learnings from database, ai-sdk, streaming, security, and frontend categories (2026-02-18 through 2026-02-26)*
