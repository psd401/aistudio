---
title: Scope row-action button locators inside tbody tr to avoid multi-match errors in data tables
category: testing
tags:
  - playwright
  - e2e
  - locator
  - data-table
  - admin
severity: medium
date: 2026-06-15
source: auto — /lfg issue #581 (PR #1029)
applicable_to: project
---

## What Happened

PR #1029 tests the User Management data table's per-row action menu (the "..." button that opens "View Details" / "Edit User" / "Delete User"). Each table row renders a `[data-testid="user-row-actions"]` button. Using `page.locator('[data-testid="user-row-actions"]')` alone would match all N rows simultaneously — Playwright throws a "strict mode violation" error if `.click()` is called on a multi-element locator.

## Correct Pattern: Chain Through the Row

```typescript
async function openRowActionsMenu(page: Page, rowIndex = 0): Promise<void> {
  const row = page.locator('tbody tr').nth(rowIndex)
  const actionsBtn = row.locator('[data-testid="user-row-actions"]')
  await actionsBtn.click()
}
```

The two-step chain (`tbody tr` → child locator) constrains the inner selector to the specific row. `nth(0)` gives the first data row; callers can pass a different index to target any row.

## Why `tbody tr` Not Just `tr`

`table` elements contain both `thead tr` (header row) and `tbody tr` (data rows). Using `page.locator('tr').nth(0)` would target the header row, not the first data row. Always scope to `tbody tr` for data rows.

## General Rule

For any component that is rendered once-per-row in a table, always locate it via:
```typescript
page.locator('tbody tr').nth(rowIndex).locator('[data-testid="<per-row-selector>"]')
```

Never select by `data-testid` alone when the same testid appears in multiple rows.

## Where Applied

- `tests/e2e/admin-users.spec.ts` — `openRowActionsMenu()` helper, line 42–46
- `app/(protected)/admin/users/_components/users-data-table.tsx` — `data-testid="user-row-actions"` on row action trigger button, line 204
