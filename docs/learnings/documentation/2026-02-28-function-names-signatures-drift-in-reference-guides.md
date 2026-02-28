---
title: Function names and signatures in reference guides drift from source code
category: documentation
tags:
  - documentation
  - code-review
  - verification
  - helper-functions
severity: medium
date: 2026-02-28
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #818 (review of documentation guides) revealed 3 factual errors in `docs/guides/auth-security-checklist.md`:
1. Wrong function name: `isAllowedUrl` (documented) vs `rejectUnsafeMcpUrl` (actual source)
2. Wrong function signature: `requireUserAccess(route)` (documented) vs `requireUserAccess(req, next)` (actual source)
3. Wrong constant prefix: `oauth_state_` (documented) vs `mcp_oauth_state_` (actual source in `/app/api/auth/oauth/callback.ts`)

All errors were caught by Copilot and verified against actual source before fixing.

## Root Cause

Documentation consolidated from memory/learnings or reference notes can become stale when:
- Helper function names are refactored (rename without updating docs)
- Function signatures evolve (new parameters added, old ones removed)
- Constants are updated (prefix changes, enum value renames)
- No automated verification ties docs to code (snapshot-in-time problem)

## Solution

When writing reference guides that include **helper function names, signatures, or constant values**:

1. **Always cross-check against actual source** before merging docs
2. **Use exact line references** in the guide (e.g., "See `/app/api/auth/mcp-connector-auth.ts:45`")
3. **For frequently-changed functions**, include a disclaimer: "Copy function names from source; docs may lag"
4. **Test code snippets** if the guide includes them (even pseudocode should reference real APIs)

## Prevention

- Before marking a doc PR as ready, search the codebase for each helper/function/constant mentioned
- For security/auth guides, pin to specific source files and line ranges
- Add a "Last verified" date to guides that reference implementation details
- Code review should include: "Do all function names/signatures in docs match source?"
