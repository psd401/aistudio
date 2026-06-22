---
title: Confirmation/destructive dialogs use role="alertdialog" not role="dialog" — target them differently in tests
category: testing
tags:
  - playwright
  - e2e
  - aria
  - dialog
  - accessibility
severity: low
date: 2026-06-15
source: auto — /lfg issue #581 (PR #1029)
applicable_to: project
---

## What Happened

PR #1029 tests both a user detail sheet (informational) and a delete-confirmation dialog (destructive). Both are rendered via shadcn/ui `Dialog` and `AlertDialog` components, but they get different ARIA roles:

- Detail/edit sheet → `role="dialog"`
- Delete confirmation → `role="alertdialog"`

Using `page.locator('[role="dialog"]')` to assert on the delete confirmation would match both simultaneously if both were open, or miss the alertdialog if only it was visible.

## Correct Selectors

```typescript
// Informational / edit dialogs
await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 10_000 })

// Destructive confirmation dialogs (AlertDialog)
await expect(page.locator('[role="alertdialog"]')).toBeVisible({ timeout: 10_000 })
```

## shadcn/ui Mapping

| shadcn Component | ARIA Role | Use Case |
|---|---|---|
| `<Dialog>` | `role="dialog"` | Info panels, edit forms, detail sheets |
| `<AlertDialog>` | `role="alertdialog"` | Destructive confirmations (delete, reset, revoke) |

This mapping is baked into shadcn/ui's component output — no custom ARIA attributes needed.

## Why It Matters for Tests

- `role="alertdialog"` is semantically required by ARIA spec for dialogs that interrupt the user's workflow and require an immediate response
- Using the correct role in tests also acts as a correctness check: if a delete confirmation is accidentally rendered as a `<Dialog>` instead of `<AlertDialog>`, the test will fail
- Avoids flaky cross-matching when both dialog types are open simultaneously

## Where Applied

- `tests/e2e/admin-users.spec.ts` — Suite 6 uses `[role="dialog"]` for detail sheet; Suite 8 uses `[role="alertdialog"]` for delete confirmation (lines 371, 538)
