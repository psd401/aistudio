---
title: Choose CJS sanitizers for unit-testable XSS fixes; never mark migrations complete before DDL
category: security
tags:
  - atrium
  - xss
  - dompurify
  - jsdom
  - sanitization
  - codeql
  - jest
  - esm
  - next-jest
  - transformIgnorePatterns
  - migration
  - idempotency
  - pr-review
severity: high
date: 2026-06-24
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1061 (Atrium Phase 0 content API) had a regex-based HTML sanitizer in
`lib/content/render/markdown-render.ts` flagged by 4 CodeQL HIGH alerts (XSS
via entity-encoded schemes, malformed tags, `formaction`, SVG vectors). The
candidate replacement was a hast/unified/rehype-sanitize pipeline (ESM-only),
but those packages cannot be imported in Jest unit tests — they throw
`Unexpected token 'export'`. The fix was DOMPurify+jsdom (both CJS,
already transitive deps), which runs unmocked in Jest's jsdom env and in the
Next.js SSR runtime. A separate finding: a migration file ran
`UPDATE migration_log SET completed` before the DDL statements, permanently
skip-locking the migration row on partial failure.

## Root Cause

1. **next/jest ESM wall**: `next/jest` prepends `/node_modules/` to
   `transformIgnorePatterns`. Custom entries in `jest.config.ts` only APPEND —
   they cannot remove or override the leading node_modules exclusion. Any
   ESM-only package (hast-util-*, unified, rehype-*) will throw
   `Unexpected token 'export'` in Jest and must be mocked, defeating real XSS
   coverage.
2. **Migration ordering anti-pattern**: marking a migration as completed
   (writing the `completed` row to `migration_log`) before the DDL succeeds
   means `checkMigrationRun` skips the file on re-entry — the migration is
   permanently stuck even after fixing the DDL failure.

## Solution

1. Replaced the regex sanitizer with `DOMPurify` (via `dompurify` + `jsdom`
   for the server-side DOM context). Both are CommonJS-compatible — real
   sanitizer code runs in Jest without mocking.
2. Reordered the failing migration so the `migration_log` insert/update only
   executes after all DDL statements complete. Use idempotent DDL
   (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) so re-running
   after a partial failure is safe.

## Prevention

- When choosing a server-side library that needs unit-test coverage in this
  project, verify it is CommonJS-compatible before adopting it. ESM-only
  packages (unified ecosystem, many hast-util-* packages) require mocking in
  Jest, which undermines security-critical coverage.
- Never write the `migration_log` completed record before the DDL block.
  Rely on idempotent DDL + the runner's failed-run re-entry; the log row is
  only meaningful after the migration actually succeeds.
- See also: [[jest-esm-mcp-connector-lazy-import]] for the complementary
  lazy-import workaround when you cannot swap the library.
