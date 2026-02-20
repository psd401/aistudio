---
title: React hooks must be called before all conditional returns, even unused paths
category: react-patterns
tags:
  - react-hooks
  - assistant-ui
  - tool-rendering
  - mcp
severity: medium
date: 2026-02-19
source: auto — /work
applicable_to: project
---

## What Happened

Implemented `ConnectorToolFallback` to conditionally render connector-specific tool call/result UI in Nexus chat. The component used a `ConnectorToolContext` to map tool names to server metadata, then delegated non-connector tools to `GenericToolFallback`. `useMemo` hooks were initially placed after an early conditional return, causing a React hooks rules violation.

## Root Cause

React requires all hooks to be called on every render in the same order. Placing `useMemo` calls after a conditional `return null` (or early guard) means hooks execute on some renders but not others, violating the Rules of Hooks.

## Solution

Move all `useMemo` (and any other hooks) above the first conditional return statement, even if the computed values are only used in one branch of the conditional:

```tsx
// Correct
function ConnectorToolFallback({ toolName, ...props }) {
  const serverMeta = useConnectorToolContext(toolName); // hook first
  const displayName = useMemo(() => ..., [serverMeta]);  // hook first

  if (!serverMeta) {
    return <GenericToolFallback {...props} />;  // conditional return after all hooks
  }
  return <ConnectorToolUI displayName={displayName} />;
}
```

## Prevention

- Lint rule `react-hooks/rules-of-hooks` will catch this at compile time — ensure it is enabled
- When wrapping or replacing a `ToolFallback` component with a conditional-delegation pattern, always audit hook positions relative to early returns before testing
