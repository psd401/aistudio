---
title: A capability gate for a directory-exposing agent READ goes inside that read's branch, not in dispatch or the shared read function
category: security
tags:
  - atrium
  - agent-broker
  - capability
  - authorization
  - people-lookup
severity: high
date: 2026-10-04
source: auto — /lfg #1860 (PR #1862)
applicable_to: project
---

## What Happened

The new `GET /_people` route on the owner-bound Atrium agent broker
(`executeOwnerAtriumOperation` → `executeAtriumRead`) returns directory rows
(name/email → `users.id`) rather than content. Unlike every other read on that
broker, this one needed a capability check — exposing the staff directory
to any caller who can reach the agent is a different risk than reading
already-visible content.

## Root Cause

`executeAtriumRead` is the shared dispatcher for every GET branch and its
documented invariant (reinforced by
[[2026-07-27-decomposing-a-guarded-handler-needs-a-gate-test]]) is that reads
are ungated — content reads degrade gracefully for any viewer who already has
visibility. Putting the capability check in the central dispatch would
over-gate every other read on the broker (content lookups, collection
listings) that are intentionally open. Putting it in the shared read function
itself would violate that function's invariant for every other caller.

## Solution

Place `assertContentAuthoringCapability` inside the `/_people` branch
specifically, ahead of the directory query, leaving every other branch in
`executeAtriumRead` ungated exactly as before.

## Prevention

- When a new agent-broker route returns something riskier than the rest of
  its dispatch group (directory data vs. content, system config vs. object
  state), gate that one branch — do not widen the central dispatch's gate and
  do not narrow the shared read function's "reads are ungated" invariant.
- Add the new branch to the all-branches gate test described in
  [[2026-07-27-decomposing-a-guarded-handler-needs-a-gate-test]] so the gate's
  presence on this one route is pinned, not positional.
