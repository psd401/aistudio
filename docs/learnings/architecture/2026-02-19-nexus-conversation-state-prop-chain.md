---
title: Nexus conversation state requires dual prop chains for API body vs UI display
category: architecture
tags:
  - nexus
  - mcp
  - connectors
  - component-hierarchy
  - state-management
severity: high
date: 2026-02-19
source: work
applicable_to: project
---

## What Happened

Implemented MCP connector popover for Nexus chat. Initially passed connector state only through UI component hierarchy, but the API request body needed the selected connector ID before reaching the composer controls where the UI consumes it.

## Root Cause

Nexus requires state to flow through **two separate chains**:

1. **API body chain** (page → ConversationRuntimeProvider) — state needed in POST request
2. **UI display chain** (page → Thread → Composer → ComposerControls → Popover) — state needed for rendering

The runtime provider wraps the chat UI and creates `useChatRuntime`, which intercepts API calls. State needed in the API body must be accessible at the runtime provider level.

## Solution

State pattern for per-conversation features:

```typescript
// page.tsx: Declare state at page level
const [selectedMcpConnectorId, setSelectedMcpConnectorId] = useState<string | null>(null)

// Pass to runtime provider for API access
<ConversationRuntimeProvider
  customState={{ selectedMcpConnectorId }}  // For body() callback
>
  {/* Pass to UI tree for display */}
  <Thread>
    <Composer>
      <ComposerControls selectedMcpConnectorId={selectedMcpConnectorId} />
    </Composer>
  </Thread>
</ConversationRuntimeProvider>

// In runtime body callback (runtime provider)
body: () => ({
  modelId: selectedModel.modelId,
  selectedMcpConnectorId: selectedMcpConnectorIdRef.current,  // Via ref
  // ...
})

// In popover (UI leaf)
function McpPopover({ selectedMcpConnectorId, onSelect }) {
  return (
    <button onClick={() => onSelect(connectorId)}>
      {selectedMcpConnectorId === connectorId && '✓'}
    </button>
  )
}
```

**Key**: Use a ref (`selectedMcpConnectorIdRef`) in the body callback to avoid dependency array issues.

## Prevention

When adding new per-conversation state to Nexus:

1. Declare at page level (alongside `conversationId`, `modelId`)
2. **If state affects API**: Pass to ConversationRuntimeProvider, access via ref in `body()` callback
3. **If state is UI-only**: Pass through component tree only
4. **If state affects both**: Do both — it's the standard Nexus pattern
