---
title: Migration tests must assert RELATIVE order, never position from the end of the ledger
category: testing
tags:
  - migrations
  - brittle-tests
  - false-positives
  - merge-conflicts
severity: medium
date: 2026-07-27
source: auto — /lfg psd-sop-creator
applicable_to: project
---

## What Happened

Adding one migration (`161-atrium-sop-collection.sql`) to
`infra/database/migrations.json` broke two completely unrelated test suites:

```
● migration 158 — student room navigation › is the registered migration immediately after rooms
  - "157-rooms.sql",
    "158-student-rooms-navigation.sql",
  + "159-atrium-sop-collection.sql",
```

Both asserted their position **from the end of the list**:

```ts
expect(manifest.migrationFiles.slice(-2)).toEqual([...])    // "I am last"
expect(manifest.migrationFiles.slice(-3, -1)).toEqual([...]) // "I am second-to-last"
```

`dev` hit the identical failure at the same time and fixed it independently —
two branches, same day, same brittle assertion. It merge-conflicted on both
test files.

## Root Cause

`slice(-N)` encodes "nothing has been added since me", which is **not** the
invariant these tests care about and is guaranteed to become false. The real
invariant is a dependency: the student-rooms nav row is meaningless unless the
rooms tables exist, so 158 must come after 157. Where that pair sits relative
to the tail of an ever-growing list is irrelevant.

The failure mode is the expensive kind: a red suite that says nothing about the
code being changed, on a file the author never touched.

## Solution

Assert the dependency by index comparison:

```ts
const rooms = manifest.migrationFiles.indexOf("157-rooms.sql");
const nav = manifest.migrationFiles.indexOf("158-student-rooms-navigation.sql");
expect(rooms).toBeGreaterThanOrEqual(0);   // registered at all
expect(nav).toBeGreaterThan(rooms);        // and ordered after its dependency
```

Adjacency (`migrationFiles[roomsIndex + 1] === "158-…"`) is also fine and
slightly stricter — that is what `dev` chose, and it is what this branch took
in the merge to avoid diverging on a file neither change was really about.

## Prevention

- In any test over an **append-only manifest** (migrations, a nav registry, a
  capability list, a skills list), never anchor to the end. Anchor to the item
  you actually depend on.
- Ask: "will this assertion still be correct after someone appends an unrelated
  entry?" If not, it will fail for the wrong person at the wrong time.
- When a migration number collides on merge (both branches claimed 159),
  renumber and grep for every reference — the SQL header comment and any code
  comment naming the migration, not just `migrations.json`.
