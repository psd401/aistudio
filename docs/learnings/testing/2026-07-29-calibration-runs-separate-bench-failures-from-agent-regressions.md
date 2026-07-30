---
title: Calibrate agent evals on a low-risk harness change before interpreting model regressions
category: testing
tags:
  - agent-eval
  - calibration
  - openclaw
  - websocket
  - deterministic-graders
severity: medium
date: 2026-07-29
source: issue #1429
applicable_to: project
---

## What Happened

The first full agent-image comparison used an OpenClaw harness bump while
holding the model and prompt fixed. Early results appeared to show widespread
skill failures even though the harness change was expected to preserve most
behavior.

The failures came from two bench compatibility gaps:

1. `websocket-client` synthesized an `Origin` header. OpenClaw 2026.7.2 treats
   Origin-bearing connections as browser clients, so the eval adapter did not
   receive the scope-preserving local CLI path expected by the newer host.
2. Two deterministic graders accepted only one textual form even though the
   agent returned equivalent contract-valid identifiers: `skill.image-gen` for
   a denied image-generation request, and a failure record ID for a successfully
   filed failure report.

After binding the gateway client identity to the pinned harness, suppressing
the synthetic browser Origin, and widening the graders to the valid output
contract, the harness candidate had no regression-suite skill drops. The
original broad-red result was bench miscalibration, not evidence of widespread
skill regressions.

## Root Cause

An image-level harness bump changes more than the visible HTTP invocation
surface. It can also change:

- accepted configuration paths;
- reserved gateway client identities and modes;
- browser-versus-backend WebSocket classification; and
- the exact wording or identifier shape returned around otherwise unchanged
  tool behavior.

The exact-output boot canary did not exercise those seams. Deterministic
graders also became accidental wording graders where they should have graded
the stable behavioral contract.

## Solution

- Keep harness-specific config migrations and gateway client identity in the
  candidate manifest so the one-axis comparison remains explicit and
  reproducible.
- Open the container-local backend WebSocket with `suppress_origin=True`; do
  not weaken OpenClaw's browser-origin checks.
- Unit-test the selected gateway identity and WebSocket options.
- Accept every documented contract-valid denial/report identifier in code
  graders while continuing to reject missing side effects or unrelated text.
- Rerun affected tasks for both baseline and candidate, then regenerate both
  summaries with the same final evaluator commit.

## Prevention

- Run the lowest-risk harness comparison before prompt or model arms.
- Treat a broad regression on that calibration arm as a reason to inspect the
  bench first, not as immediate proof that the candidate is broken.
- Exercise gateway authentication, one real tool route, and deterministic
  grader variants in focused tests; an `OK` boot canary is necessary but not
  sufficient.
- When a harness changes config or gateway contracts, encode the difference in
  an allowlisted candidate manifest rather than adding an implicit runtime
  fallback.
- Grade stable behavior—route, payload, side effect, or documented identifier—
  instead of a single model-generated phrase.
