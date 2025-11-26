# Nexus Conversation Architecture

**Last Updated:** January 2025
**Critical:** Read this before modifying conversation handling code

## Table of Contents
1. [Overview](#overview)
2. [Component Hierarchy](#component-hierarchy)
3. [State Management](#state-management)
4. [Message Flow: New Conversations](#message-flow-new-conversations)
5. [Message Flow: Loading Existing Conversations](#message-flow-loading-existing-conversations)
6. [Runtime Creation and Memoization](#runtime-creation-and-memoization)
7. [Message Format Conversions](#message-format-conversions)
8. [Common Pitfalls](#common-pitfalls)
9. [Troubleshooting Guide](#troubleshooting-guide)

---

## Overview

The Nexus conversation system manages AI chat interactions using:
- **@assistant-ui/react v0.11.37** - UI framework for AI assistants
- **@assistant-ui/react-ai-sdk v1.1.9** - AI SDK integration
- **AI SDK v5** - Vercel's AI SDK with streaming support
- **Next.js 15.2.3** - App Router with React 19.2.0

### Key Design Principles

1. **Streaming Preservation**: Runtime must persist during conversation ID assignment
2. **Stable Components**: Minimize re-renders to maintain streaming state
3. **Ref-Based Access**: Use refs for dynamic values in callbacks to prevent dependency issues
4. **Separation of Concerns**: Separate initialization state from runtime state

---

## Component Hierarchy

```
NexusPage (Main export with Suspense)
  └─ NexusPageContent (Uses useSearchParams)
      └─ NexusShell (Layout/header)
          └─ ConversationInitializer (Loads messages on mount)
              └─ ConversationRuntimeProvider (Creates runtime)
                  ├─ MultiProviderToolUIs
                  ├─ PromptAutoLoader
                  ├─ Thread (Main chat UI)
                  └─ ConversationPanel (Sidebar)
```

### Component Responsibilities

**NexusPage**
- Wraps content in Suspense boundary for useSearchParams
- Location: `/app/(protected)/nexus/page.tsx:384-397`

**NexusPageContent**
- Manages conversation ID from URL (`?id=xxx`)
- Handles model selection
- Manages tool enablement
- Location: `/app/(protected)/nexus/page.tsx:191-381`

**ConversationInitializer**
- **Critical:** Only loads messages on initial mount
- Does NOT reload when conversation ID is assigned during runtime
- Uses `stableConversationId` prop to prevent remounting
- Location: `/app/(protected)/nexus/page.tsx:112-188`

**ConversationRuntimeProvider**
- Creates `useChatRuntime` instance (memoized)
- Handles streaming via `AssistantChatTransport`
- Intercepts `X-Conversation-Id` header from server
- Location: `/app/(protected)/nexus/page.tsx:34-109`

---

## State Management

### Three Types of Conversation ID State

**CRITICAL:** Understanding these three states is essential to prevent bugs.

#### 1. `conversationId` (React State)
```typescript
const [conversationId, setConversationId] = useState<string | null>(validatedConversationId)
```
- **Purpose**: Tracks current conversation ID for URL and UI updates
- **Changes**: Updates when new conversation is created or user navigates
- **Used by**: URL updates, ConversationPanel, ConversationRuntimeProvider

#### 2. `stableConversationId` (Immutable State)
```typescript
const [stableConversationId] = useState<string | null>(validatedConversationId)
```
- **Purpose**: Prevents ConversationInitializer from remounting
- **Changes**: NEVER (set only on initial render)
- **Used by**: ConversationInitializer prop
- **Why Critical**: If this changes, ConversationInitializer remounts, losing streaming state

#### 3. `conversationIdRef` (Ref)
```typescript
const conversationIdRef = useRef(conversationId)
useEffect(() => {
  conversationIdRef.current = conversationId
}, [conversationId])
```
- **Purpose**: Synchronous access in callbacks without causing re-renders
- **Changes**: Synced with `conversationId` via useEffect
- **Used by**: API body callback in AssistantChatTransport
- **Why Critical**: Prevents runtime recreation when ID changes

---

## Message Flow: New Conversations

### Step-by-Step Flow

**1. User sends first message**
```
User types → Thread component → runtime.append() → AssistantChatTransport
```

**2. POST /api/nexus/chat**
```typescript
// customFetch is called with request
POST /api/nexus/chat
Body: {
  modelId: "gemini-2.0-flash-lite",
  provider: "google",
  enabledTools: [],
  conversationId: undefined  // First message has no ID
}
```

**3. Server creates conversation and returns header**
```http
HTTP/1.1 200 OK
X-Conversation-Id: 4ce24d7f-2c03-4d65-bd84-2b1225739cf0
Content-Type: text/event-stream

data: {"type":"text-delta","textDelta":"Hello"}
data: {"type":"text-delta","textDelta":" there"}
...
```

**4. customFetch intercepts header**
```typescript
// Location: page.tsx:62-81
const customFetch = useCallback(async (input, init) => {
  const response = await fetch(input, init)

  const newConversationId = response.headers.get('X-Conversation-Id')
  if (newConversationId && newConversationId !== conversationIdRef.current) {
    // Update ref immediately (synchronous)
    conversationIdRef.current = newConversationId

    // Update parent state (triggers re-render)
    if (onConversationIdChange) {
      onConversationIdChange(newConversationId)
    }
  }

  return response
}, [onConversationIdChange])
```

**5. handleConversationIdChange updates URL**
```typescript
// Location: page.tsx:274-287
const handleConversationIdChange = useCallback((newConversationId: string) => {
  setConversationId(newConversationId)  // Update state
  conversationContext.setConversationId(newConversationId)

  // Update URL without reload
  const newUrl = `/nexus?id=${newConversationId}`
  router.push(newUrl, { scroll: false })
}, [conversationId, conversationContext, router])
```

**6. Component re-renders but does NOT remount**
```
conversationId: null → "4ce24d7f-2c03-4d65-bd84-2b1225739cf0" ✓ Changes
stableConversationId: null → null ✓ NO CHANGE (critical!)
conversationIdRef.current: null → "4ce24d7f-2c03-4d65-bd84-2b1225739cf0" ✓ Changes

ConversationInitializer: NO REMOUNT (receives same stableConversationId)
ConversationRuntimeProvider: Re-renders but runtime is memoized
Thread: Continues showing streaming response ✓
```

**7. Streaming completes**
```
Assistant response fully displayed
URL shows: /nexus?id=4ce24d7f-2c03-4d65-bd84-2b1225739cf0
Ready for follow-up messages
```

---

## Message Flow: Loading Existing Conversations

### Step-by-Step Flow

**1. User navigates to conversation URL**
```
User clicks conversation in sidebar OR
Browser loads /nexus?id=4ce24d7f-2c03-4d65-bd84-2b1225739cf0
```

**2. NexusPageContent initializes with ID**
```typescript
// Location: page.tsx:197-208
const urlConversationId = searchParams.get('id')
const validatedConversationId = useMemo(() => {
  if (validateConversationId(urlConversationId)) {
    return urlConversationId  // "4ce24d7f-2c03-4d65-bd84-2b1225739cf0"
  }
  return null
}, [urlConversationId])

// Both states initialized with ID
const [conversationId] = useState(validatedConversationId)  // Has ID
const [stableConversationId] = useState(validatedConversationId)  // Has ID
```

**3. ConversationInitializer loads messages**
```typescript
// Location: page.tsx:122-174
useEffect(() => {
  if (!conversationId) {
    setMessages([])
    setLoading(false)
    return
  }

  setLoading(true)

  // GET /api/nexus/conversations/{id}/messages
  fetch(`/api/nexus/conversations/${conversationId}/messages`)
    .then(res => res.json())
    .then(data => {
      const loadedMessages = data.messages || []

      // Convert to UIMessage format
      const threadMessages = loadedMessages.map(msg => ({
        id: msg.id,
        role: msg.role,
        parts: Array.isArray(msg.content)
          ? msg.content.map(part => ({
              type: part.type as 'text',
              text: part.text || ''
            }))
          : [{ type: 'text' as const, text: msg.content }]
      }))

      setMessages(threadMessages)
      setLoading(false)
    })
}, [conversationId])
```

**4. ConversationRuntimeProvider receives initialMessages**
```typescript
// Location: page.tsx:86-110
const runtime = useMemo(() => useChatRuntime({
  transport: new AssistantChatTransport({ /* ... */ }),
  adapters: { /* ... */ },
  messages: initialMessages  // Pre-loaded messages
}), [/* ... */])
```

**5. Thread displays conversation**
```
Messages appear immediately
User can send follow-up messages
Streaming works normally
```

---

## Runtime Creation and Memoization

### Why Memoization is Critical

**Problem:** `useChatRuntime` creates a new runtime instance on every render. When `conversationId` changes from `null` → `"uuid"`, the component re-renders and creates a new runtime, **losing streaming state**.

**Solution:** Wrap `useChatRuntime` in `useMemo` with stable dependencies.

### Implementation

```typescript
// Location: page.tsx:86-110
const runtime = useMemo(() => useChatRuntime({
  transport: new AssistantChatTransport({
    api: '/api/nexus/chat',
    fetch: customFetch,
    body: () => selectedModel ? {
      modelId: selectedModel.modelId,
      provider: selectedModel.provider,
      enabledTools: enabledToolsRef.current,
      conversationId: conversationIdRef.current || undefined  // ← Ref, not state
    } : {}
  }),
  adapters: {
    attachments: attachmentAdapter,
    history: historyAdapter,
    speech: new WebSpeechSynthesisAdapter(),
  },
  messages: initialMessages
}), [
  customFetch,           // Stable (memoized with useCallback)
  selectedModel?.modelId, // Only changes when model changes
  selectedModel?.provider,
  attachmentAdapter,     // Stable (memoized)
  historyAdapter,        // Stable (created per conversationId)
  initialMessages        // Only changes on initial load
  // NOTE: conversationId is NOT a dependency!
])
```

### Key Points

1. **conversationId accessed via ref**: `conversationIdRef.current` is read inside `body()` callback
2. **No conversationId dependency**: Runtime doesn't recreate when ID changes
3. **Stable dependencies**: Only recreates when model or adapters change
4. **Pattern from Assistant Architect**: Same approach used in `/app/(protected)/assistant-architect/_components/assistant-architect-streaming.tsx:600-615`

---

## Message Format Conversions

### Three Message Formats

**1. API Response Format (Database)**
```typescript
{
  id: "msg_123",
  role: "user" | "assistant" | "system",
  content: "Hello world" | [{ type: "text", text: "Hello" }],
  createdAt: "2025-01-26T10:00:00Z"
}
```

**2. UIMessage Format (AI SDK)**
```typescript
{
  id: "msg_123",
  role: "user" | "assistant" | "system",
  parts: [
    { type: "text", text: "Hello world" }
  ]
  // NO createdAt field
}
```

**3. ThreadMessage Format (assistant-ui)**
```typescript
{
  id: "msg_123",
  role: "user" | "assistant" | "system",
  content: [  // Note: 'content' not 'parts'
    { type: "text", text: "Hello world" }
  ],
  createdAt: Date
}
```

### Conversion: API → UIMessage

**Critical:** `useChatRuntime` expects UIMessage format with `parts` field.

```typescript
// Location: page.tsx:144-160
const threadMessages = loadedMessages.map((msg) => ({
  id: msg.id,
  role: msg.role,
  parts: Array.isArray(msg.content)        // ← MUST be 'parts'
    ? msg.content.map(part => ({
        type: part.type as 'text',
        text: part.text || ''
      }))
    : typeof msg.content === 'string'
    ? [{ type: 'text' as const, text: msg.content }]
    : [{ type: 'text' as const, text: '' }]
  // NO createdAt - UIMessage doesn't support it
}))
```

### Conversion: ThreadMessage ↔ Storage (History Adapter)

```typescript
// Location: lib/nexus/history-adapter.ts:174-189
messages: exportedRepo.messages.map(item => {
  const threadMessage = item.message

  const storageEntry = {
    id: threadMessage.id,
    parent_id: item.parentId,
    format: formatAdapter.format,
    content: {
      role: threadMessage.role,
      parts: threadMessage.content,  // content → parts conversion
      ...(threadMessage.createdAt && { createdAt: threadMessage.createdAt }),
    } as unknown as TStorageFormat
  }

  return formatAdapter.decode(storageEntry)
})
```

---

## Common Pitfalls

### ❌ Pitfall 1: Passing conversationId to ConversationInitializer

```typescript
// WRONG - causes remount when ID changes
<ConversationInitializer conversationId={conversationId}>
```

```typescript
// CORRECT - stable ID prevents remount
<ConversationInitializer conversationId={stableConversationId}>
```

**Why:** When `conversationId` changes from `null` → `"uuid"`, React sees it as a prop change and remounts the component, losing streaming state.

### ❌ Pitfall 2: Using conversationId in useMemo dependencies

```typescript
// WRONG - runtime recreates when ID changes
const runtime = useMemo(() => useChatRuntime({
  // ...
}), [conversationId])  // ← BAD
```

```typescript
// CORRECT - use ref in callback, not as dependency
const runtime = useMemo(() => useChatRuntime({
  body: () => ({
    conversationId: conversationIdRef.current  // ← Access via ref
  })
}), [/* conversationId NOT here */])
```

### ❌ Pitfall 3: Wrong message format (content vs parts)

```typescript
// WRONG - useChatRuntime expects 'parts'
const messages = loadedMessages.map(msg => ({
  id: msg.id,
  role: msg.role,
  content: [...]  // ← ERROR: 'content' not 'parts'
}))
```

```typescript
// CORRECT - use 'parts' for UIMessage
const messages = loadedMessages.map(msg => ({
  id: msg.id,
  role: msg.role,
  parts: [...]  // ← CORRECT
}))
```

**Error:** `TypeError: Cannot read properties of undefined (reading 'filter')`
**Cause:** AI SDK's encode function calls `parts.filter()` which fails when parts is undefined.

### ❌ Pitfall 4: Not memoizing attachmentAdapter

```typescript
// WRONG - new adapter on every render
const attachmentAdapter = createEnhancedNexusAttachmentAdapter({...})
```

```typescript
// CORRECT - memoize with stable dependencies
const attachmentAdapter = useMemo(() =>
  createEnhancedNexusAttachmentAdapter({...}),
  [handleAttachmentProcessingStart, handleAttachmentProcessingComplete]
)
```

### ❌ Pitfall 5: Fetching messages on every conversationId change

```typescript
// WRONG - fetches every time ID changes (including during runtime)
useEffect(() => {
  if (conversationId) {
    fetch(`/api/nexus/conversations/${conversationId}/messages`)
  }
}, [conversationId])  // ← Triggers on null → uuid
```

```typescript
// CORRECT - only fetch on initial mount (now handled by stableConversationId)
// The component doesn't remount, so useEffect only runs once
```

---

## Troubleshooting Guide

### Issue: First message doesn't display until reload

**Symptoms:**
- User sends message
- Streaming happens (visible in network logs)
- Response doesn't appear in UI
- Reload shows both messages

**Root Cause:** Component remounting when conversation ID is assigned.

**Check:**
1. Is `ConversationInitializer` receiving `stableConversationId`?
   - Location: `page.tsx:357`
   - Should be: `<ConversationInitializer conversationId={stableConversationId}>`

2. Is runtime memoized?
   - Location: `page.tsx:86`
   - Should start with: `const runtime = useMemo(() => useChatRuntime({`

3. Is `conversationId` in runtime dependencies?
   - Location: `page.tsx:103-110`
   - Should NOT include `conversationId`

**Fix:**
```typescript
// 1. Use stable ID for initializer
<ConversationInitializer conversationId={stableConversationId}>

// 2. Memoize runtime
const runtime = useMemo(() => useChatRuntime({
  body: () => ({
    conversationId: conversationIdRef.current  // Access via ref
  })
}), [/* stable dependencies only */])
```

### Issue: Messages don't load from database

**Symptoms:**
- Navigate to `/nexus?id=xxx`
- "Loading conversation..." appears
- No messages display OR error in console

**Root Cause:** Message format conversion issue or fetch failure.

**Check:**
1. Is conversation ID valid?
   - Check: `validateConversationId(urlConversationId)`
   - Location: `page.tsx:198-208`

2. Are messages converted to `parts` format?
   - Location: `page.tsx:152`
   - Must use `parts:` not `content:`

3. Check network tab for API errors
   - Should see: `GET /api/nexus/conversations/{id}/messages`
   - Should return 200 with `{messages: [...]}`

**Fix:**
```typescript
// Correct message conversion
const threadMessages = loadedMessages.map(msg => ({
  id: msg.id,
  role: msg.role,
  parts: Array.isArray(msg.content)  // ← 'parts' not 'content'
    ? msg.content.map(part => ({
        type: part.type as 'text',
        text: part.text || ''
      }))
    : [{ type: 'text' as const, text: msg.content }]
}))
```

### Issue: TypeError: Cannot read properties of undefined (reading 'filter')

**Symptoms:**
- Error in browser console
- Messages don't display

**Root Cause:** Using `content` instead of `parts` in UIMessage.

**Check:**
- Location: `page.tsx:152`
- Must be: `parts: Array.isArray(msg.content) ? ...`

**Fix:** See "Wrong message format" in Common Pitfalls.

### Issue: Streaming works on follow-ups but not first message

**Symptoms:**
- First message: no response
- Reload page: both messages appear
- Follow-up messages: streaming works perfectly

**Root Cause:** Race condition between streaming completion and component remount.

**Diagnosis:** This is the EXACT issue we just fixed. The component was remounting, and sometimes the stream finished before the remount (so you'd see it), sometimes after (so you wouldn't).

**Fix:** Ensure `stableConversationId` pattern is implemented correctly.

---

## Testing Checklist

After making changes to conversation handling, test ALL of these scenarios:

### New Conversation
- [ ] Navigate to `/nexus` (no conversation ID)
- [ ] Send first message
- [ ] ✓ Assistant response streams and displays immediately
- [ ] ✓ URL updates to `/nexus?id=xxx`
- [ ] ✓ No "Loading conversation..." interruption
- [ ] Send follow-up message
- [ ] ✓ Streaming works
- [ ] ✓ Message appears immediately

### Loading Existing Conversation
- [ ] Navigate to `/nexus?id=xxx` directly (or click in sidebar)
- [ ] ✓ Messages load from database
- [ ] ✓ Full conversation history displays
- [ ] Send new message
- [ ] ✓ Streaming works
- [ ] Reload page
- [ ] ✓ New message persisted

### Edge Cases
- [ ] Send message while previous is still streaming
- [ ] ✓ Both messages display correctly
- [ ] Switch models mid-conversation
- [ ] ✓ Conversation resets (expected behavior)
- [ ] Invalid conversation ID in URL
- [ ] ✓ Redirects to clean `/nexus`
- [ ] Very long message (>1000 tokens)
- [ ] ✓ Streams correctly without interruption

---

## Related Files

### Core Files
- `/app/(protected)/nexus/page.tsx` - Main conversation page
- `/lib/nexus/history-adapter.ts` - Message persistence
- `/lib/nexus/enhanced-attachment-adapters.ts` - Attachment handling
- `/lib/nexus/conversation-navigation.ts` - ID validation

### API Routes
- `/app/api/nexus/chat/route.ts` - Streaming endpoint
- `/app/api/nexus/conversations/[id]/messages/route.ts` - Message loading
- `/app/api/nexus/messages/route.ts` - Message saving

### Components
- `/app/(protected)/nexus/_components/thread.tsx` - Chat UI
- `/app/(protected)/nexus/_components/conversation-panel.tsx` - Sidebar
- `/components/assistant-ui/thread.tsx` - Base thread component

---

## Version History

### January 2025 - Stable Conversation ID Pattern
- **Problem:** Component remounting on conversation ID assignment
- **Solution:** Introduced `stableConversationId` to prevent remounting
- **Files Changed:** `page.tsx:237, 357`
- **Breaking:** None (internal implementation only)

### January 2025 - Runtime Memoization
- **Problem:** Runtime recreating on conversationId changes
- **Solution:** Wrapped `useChatRuntime` in `useMemo`
- **Files Changed:** `page.tsx:86-110`
- **Breaking:** None

### January 2025 - UIMessage Format Fix
- **Problem:** TypeError - undefined.filter() in encode function
- **Solution:** Changed `content` → `parts` in message conversion
- **Files Changed:** `page.tsx:152`
- **Breaking:** None (format correction)

---

## Emergency Contacts

If conversation handling breaks again:

1. **Read this document first**
2. Check Playwright test results: `npm run test:e2e`
3. Review browser console for errors
4. Check network tab for API failures
5. Verify message format conversions

**Key Insight:** Almost all conversation bugs trace back to:
- Component remounting (breaks streaming)
- Runtime recreation (loses state)
- Message format mismatches (parts vs content)

---

**Last Verified Working:** January 26, 2025
**Next Review:** When upgrading @assistant-ui/react or AI SDK
