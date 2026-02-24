---
title: React key prop on a Provider component unmounts the entire subtree on key change
category: react-patterns
tags:
  - react-key
  - provider
  - streaming
  - mcp
  - remount
severity: high
date: 2026-02-20
source: auto — /review-pr
applicable_to: project
---

## What Happened

The page reset and lost streaming state on the first prompt submission. `ConnectorToolProvider` had `key={conversationId ?? 'new'}`. When `conversationId` transitioned from `null` to a UUID after the first message, React unmounted and remounted the entire provider subtree, destroying all streaming state.

## Root Cause

React uses the `key` prop to track component identity. Changing a `key` value on a component (even a Provider) is equivalent to destroying and recreating it from scratch. The `null → UUID` transition on conversation creation is a predictable key change that always fires on first prompt.

## Solution

Remove the `key` prop from providers that wrap streaming or stateful children. If identity-keying is needed, apply `key` only to leaf components where full remount is intentional and harmless.

```tsx
// Before — causes full subtree remount when conversationId changes
<ConnectorToolProvider key={conversationId ?? 'new'} ...>

// After — provider is stable across conversation lifecycle
<ConnectorToolProvider ...>
```

## Prevention

- Never put `key` on a Provider or context wrapper unless intentional destruction is acceptable.
- When `conversationId` transitions from null → value, any component keyed on it will remount — pass the ID as a prop instead.
- Use React DevTools "highlight updates" to spot unexpected full unmounts during normal interaction.
