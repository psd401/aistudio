---
title: Use composite data-testid + data-<label> attributes to disambiguate repeated component instances
category: testing
tags:
  - playwright
  - e2e
  - data-testid
  - locators
  - admin
severity: medium
date: 2026-06-15
source: auto — /lfg issue #581 (PR #1029)
applicable_to: project
---

## What Happened

PR #1029 added E2E tests for the User Management stats cards. There are 4 `StatCard` components rendered in a grid, all with the same structure. A plain `[data-testid="stat-card"]` selector returns all 4 and cannot distinguish "Total Users" from "Admins".

## Pattern: Two-Attribute Composite Selector

Add a semantic secondary attribute alongside `data-testid` to carry the instance identity:

```tsx
// stats-cards.tsx — StatCard component
<Card
  data-testid="stat-card"
  data-stat-label={label}   // ← instance identity
>
```

In tests, target a specific card using both attributes together:

```typescript
// Select a specific stat card by label
await expect(
  page.locator('[data-testid="stat-card"][data-stat-label="Total Users"]')
).toBeVisible({ timeout: 10_000 })

// Count all stat cards (structural assertion)
await expect(page.locator('[data-testid="stat-card"]')).toHaveCount(4, {
  timeout: 10_000,
})
```

## Why Not Use Text Content

`filter({ hasText: 'Total Users' })` works but is brittle — it matches anywhere in the subtree and breaks if the label is used in a tooltip, title, or trend text nearby. The `data-stat-label` attribute is an exact, scoped match.

## Naming Convention

- `data-testid` → component type (`stat-card`, `user-row`, `nav-item`)
- `data-<semantic-name>` → instance discriminator (`data-stat-label`, `data-nav-id`, `data-row-id`)

The secondary attribute name should be prefixed with the noun it describes, not a generic `data-label` that would conflict across component types.

## Where Applied

- `app/(protected)/admin/users/_components/stats-cards.tsx` — `StatCard` component, lines 40 + 107
- Test: `tests/e2e/admin-users.spec.ts` — Stats Cards suite
