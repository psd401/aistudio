---
title: getVisibilityAction is ungated; listGrantOptionsAction is capability-gated — and they must stay split
category: architecture
tags:
  - atrium
  - capabilities
  - scopes
  - authorization
  - server-actions
  - visibility
  - grants
severity: medium
date: 2026-06-29
source: auto — /work
applicable_to: project
---

## What Happened

Atrium Phase 3 introduced two server actions with different capability requirements that are easy to conflate:

- `getVisibilityAction` — returns the grants on a specific content object for display. Intentionally NOT capability-gated: any viewer who can see the content (e.g. via a public or internal grant) may read its visibility settings.
- `listGrantOptionsAction` — returns the full system-wide role name list for the grant picker. IS capability-gated (`atrium-content`): only users with authoring access need this list, and it exposes all role names in the system.

## Root Cause

The underlying data model uses `getRoles()` (admin-only) to retrieve role names. `listGrantOptionsAction` exists specifically to give non-admin authors the role list they need for the grant picker without exposing the full admin `getRoles` API. Conflating the two actions — applying the same gate to both, or removing the gate from `listGrantOptionsAction` — would either over-restrict visibility reads or leak system role names to all authenticated users.

## Solution

Keep the two actions separate with distinct gate policies:
- `getVisibilityAction`: no capability check (visibility reads should degrade gracefully for any viewer)
- `listGrantOptionsAction`: `requireCapability(session, "atrium-content")` before returning role names

## Prevention

- Any action that returns system-wide configuration (role names, scope lists, feature flags) must be capability-gated even if the backing data appears non-sensitive — role enumeration is a recon vector.
- "Read grants on object" and "list all grant options" are separate concerns. Do not merge them into a single action with a single gate.
- See `docs/architecture/capabilities-and-scopes.md` for the capability vs. scope split decision tree.
