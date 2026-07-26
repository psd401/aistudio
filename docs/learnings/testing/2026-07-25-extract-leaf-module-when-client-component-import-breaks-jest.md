---
title: A helper imported from a client component drags in server-action/ESM chains — extract a dependency-free leaf
category: testing
tags:
  - jest
  - server-actions
  - drizzle
  - esm
  - module-boundaries
  - atrium
severity: medium
date: 2026-07-25
source: auto — /work #1336 (PR #1339)
applicable_to: project
---

## What Happened

Importing a helper from a client component for unit testing pulled in the
component's server-action import chain (and, separately, the ESM-only
unified/rehype markdown stack), and the jest suite failed to parse. Same class of
problem hit `publish-service` importing `surface-helpers`, which itself pulls in
`@/utils/roles` and the Drizzle client — untestable in isolation under jest.

## Root Cause

Pure logic was co-located with a module that has heavy transitive imports
(server actions, Drizzle client, ESM-only packages). Testing the pure logic meant
jest had to resolve the entire import graph of the host module.

## Solution

Extract the pure/testable logic into a dependency-free leaf module and re-export
from the original file. Here, `reader-links.ts` was pulled out of
`surface-helpers` as a leaf, with `surface-helpers` re-exporting it — the leaf has
no `@/utils/roles` or Drizzle import, so it's directly jest-testable.

## Prevention

- When a jest suite fails to parse/import a module you didn't directly touch,
  suspect a transitive import chain (server actions, Drizzle client, or an
  ESM-only package) rather than a jest config issue first.
- See also `testing/2026-06-26-next-jest-cannot-transform-esm-node-modules.md` for
  the ESM-specific variant of this same "extract a leaf module" fix.
