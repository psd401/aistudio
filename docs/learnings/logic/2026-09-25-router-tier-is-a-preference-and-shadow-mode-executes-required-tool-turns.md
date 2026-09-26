---
title: A router tier is a preference, not a floor — and shadow mode DOES execute the routed model when a required tool is present
category: logic
tags:
  - model-router
  - nexus
  - shadow-mode
  - telemetry
  - fallback-ordering
  - reason-codes
severity: high
date: 2026-09-25
source: auto — /lfg (issue #1840, PR #1841)
applicable_to: universal
---

## What Happened

#1840 asked for one line of behaviour: when an editable Atrium artifact is bound
to a Nexus turn, raise the model tier floor to `medium`, because the shortest
authoring follow-ups ("did that work?") classify as `light` and the light tier was
observed skipping its tools and inventing UI instead of calling
`update_workspace_artifact`.

Setting `decision.tier = "medium"` did **not** produce a floor, and it quietly
broke a guarantee elsewhere. Eight review rounds were needed, each one exposing a
case the previous fix's own regression test had masked.

## Root Cause

Two independent facts about `lib/ai/model-router/core.ts` and
`lib/nexus/model-router/router.ts`:

**1. `tier` is a search-order hint, not a constraint.**
`selectRoutedTextModel` tries the configured candidates for that tier, then the
exact tier, then sweeps `[tier, "medium", "light", "high"]`, then the client's
fallback model. With `tier: "medium"` that sweep order is `medium, light, high` —
so a deployment with no accessible medium model **prefers an accessible LIGHT
model over an accessible HIGH one**. The turn lands on precisely the model the
floor existed to avoid, while `metadata.tier` reads `"medium"`. The candidate
arrays default to `[]` for every family, so no misconfiguration is required to
hit this.

**2. Shadow mode only keeps the legacy model when `requiredTools` is empty.**
`selectedRuntimeModel` returns `fallback` for `mode === "shadow" &&
requiredTools.length === 0`, and `selection.model` otherwise. So a shadow turn
carrying any required tool (`enabledToolNames: ["searchNexusAttachments"]`, an
attachment retrieval, a server-required input tool) **executes what routing
picked**. Raising `tier` on those turns made shadow mode silently reroute live
traffic to the configured medium candidate — the opposite of shadow's entire
contract, and present in the very first commit of the PR.

Worse, `requiredTools` is a **mutable array that changes during routing**. A
`web-search` decision has its own tool pushed onto it (`addRequiredWebSearchTool`)
after classification, and the fetch-only degradation splices that tool back out
again. So "is this turn tool-carrying?" has three different answers at three points
in one request, and a gate that reads it at the wrong moment — or caches its answer
— is wrong in one direction or the other.

Two smaller traps in the same fix:
- **`intent` does not tell you whether tier was consulted.** `selectModel` takes its
  image-specialist branch only while no input tool is required; an `image` turn
  *with* one falls through to ordinary tier-aware routing. And a `web-search` turn
  consults its specialist list first but falls back to the tier-aware sweep. So
  "specialist intents ignore tier" is false for both.
- **The first E2E draft skipped itself green.** It POSTed a hand-written payload
  that omitted the schema-required `modelId`, got a 400, found no routing header,
  and hit its own `test.skip` guard. A green run reported two skips.

The regression tests hid the behavioural bugs too. The "no medium model accessible"
fixture removed all medium access, so the reroute-to-medium case could not fire in
it; the telemetry-only fix passed its own test while the executed model was still
wrong.

## Solution

Three distinct mechanisms, not one:

```typescript
// 1. Tier as a genuine minimum, via the selector's existing eligibility hook.
//    Below-floor models become ineligible, so the sweep reaches `high`.
minTier?: NexusRouterTier
additionalEligibility: model => … && meetsMinTier(model, args.minTier) && …

// 2. Strongest-first attempts, every preference dropped for the last one, so a
//    floor can never become a new way to FAIL a turn. Function calling outranks
//    the tier: a model that cannot invoke a tool is useless at any tier.
//    [functionCalling+floor] → [functionCalling] → [floor] → unconstrained

// 3. ONE predicate deciding whether the floor may be applied at all, consulted by
//    the tier raise, the preference list AND the telemetry — so they cannot drift.
function artifactFloorMayApply(mode, requiredToolCount): boolean {
  return mode === "active" || requiredToolCount === 0
}

// 4. Evaluated against the required-tool list AT EACH POINT rather than cached:
//    a lookahead (`willAddRequiredWebSearchTool`) for the pre-classification raise,
//    the live array everywhere after, and a `refloor` callback so the fetch-only
//    retry is re-judged once the tool it removed is gone.
```

Plus an explicit `workspace_artifact_min_tier_unmet` reason code for when the
final unconstrained attempt still lands below the floor. Without it, the presence
of `workspace_artifact_min_tier` looks like proof the fix is live on exactly the
turns where it was defeated.

Tests are written in **pairs**, each pair a discriminator rather than a
restatement of the selector's own behaviour:
- artifact + only light & high accessible → `high`; **same access, no workspace →
  `light`** (proves the floor changed the outcome).
- shadow + required tool → original route, classifier's own tier, no floor codes;
  **active + the same required tool → floored** (proves withholding is scoped and
  not a silent loss of the fix).

And one E2E spec that drives the real authenticated route, verified to FAIL when the
floor is stubbed out — the live classifier does rate "Did that work?" as `light`, so
the spec proves the fix rather than restating the classifier.

## Prevention

- Before treating a router/selector `tier`, `priority` or `preference` field as a
  bound, read the resolver. If it has a fallback sweep, the field orders the
  search and guarantees nothing — enforce a minimum through the eligibility
  predicate instead.
- A tier fallback list containing the floor's own neighbours (`[medium, light,
  high]`) will reach *below* the floor before *above* it. Raising the requested
  tier is not the same as excluding what is under it.
- When a "propose only" / dry-run / shadow mode exists, find every branch where it
  still executes the computed result before changing what that computation
  produces. Grep the function that chooses between proposal and execution
  (`selectedRuntimeModel` here) rather than trusting the mode's name.
- Gate such a change behind ONE named predicate that every consumer calls —
  behaviour, preference and telemetry. Three inlined copies of `mode === "active"
  && …` drift, and the telemetry copy drifting is the worst of the three because
  it makes the bug invisible.
- When a fix can be silently defeated by configuration or per-user access, emit a
  distinct reason code for the defeated case. "The mitigation was requested" and
  "the mitigation took effect" are different facts and monitoring needs both.
- Write the negative half of every routing test. A fixture that removes the
  resource under test (all medium models, here) cannot observe a wrong selection
  of that resource, and will pass while the bug ships.
- Never cache a gate whose input is a **mutable** array that routing itself edits.
  Evaluate it where it is used, and where one evaluation must happen before the
  mutation, make the lookahead share its predicate with the mutator
  (`willAddRequiredWebSearchTool` / `addRequiredWebSearchTool`) rather than
  duplicating the condition.
- Do not infer "this code path ignores X" from an `intent`/`type` field. Read the
  branch that consumes it: here the image specialist is chosen only when no tool is
  required, and the web-search specialist still falls through to the tier sweep.
  Prefer the narrow predicate — a false "X is irrelevant" silently drops the fix,
  while a false negative costs one retried attempt.
- **Prove an E2E test can fail.** Stub the fix to a no-op and confirm the spec goes
  red, then restore it. A spec whose `test.skip` guard fires on a malformed request
  reports green with zero coverage — which is what the first draft of this one did,
  from a payload missing a schema-required field.
