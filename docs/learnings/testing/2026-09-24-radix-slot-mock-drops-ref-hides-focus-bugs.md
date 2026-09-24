---
title: Jest Slot mock replacing (not composing) refs makes focus() bugs invisible in jsdom
category: testing
tags:
  - jest
  - radix-ui
  - slot
  - react-hook-form
  - focus-management
  - jsdom
  - false-positive
severity: high
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1697: `IconPicker` never forwarded `field.ref`, so
`form.setFocus("imagePath")` was a no-op — but no test caught it. Root cause
traced to `tests/mocks/radix-ui-slot.js`, which did
`cloneElement(child, {...slotProps, ...child.props, ref})`, **replacing** the
child's existing ref with the new one instead of composing them.

## Root Cause

Real Radix `Slot` composes refs (`composeRefs(forwardedRef, childrenRef)`) so
both the forwarding component's ref and the child's own ref fire. That
composition is how react-hook-form's `field.ref` reaches an `<Input>` nested
inside `<FormControl>`/`Slot`. The jest mock's `cloneElement` silently
overwrote the child's ref instead of composing, so `field.ref` never attached
in tests — `setFocus()` appeared to work (no error) but did nothing, in jsdom
only. The same code worked in a real browser via real Radix.

## Solution

Any Slot/ref-forwarding mock must compose refs, not replace them, e.g. merge
via a small `composeRefs`-equivalent that calls both the incoming ref and the
child's original ref.

## Prevention

- Treat "mock passes the compiler/runtime silently" as insufficient — a
  ref-dropping mock produces a false pass for any `setFocus`/`scrollIntoView`/
  imperative-handle behavior with zero error signal.
- Before writing or trusting a component mock that touches `ref`, check it
  against how the real implementation composes forwarded refs (see
  `@radix-ui/react-compose-refs`).
- A hypothesis that "all `@radix-ui` jest.mock factories collapse to one
  resolved path" was tested by deleting five mocks and running the suite —
  three suites went red (e.g. `components/ui/select.tsx` reads
  `SelectPrimitive.Trigger.displayName`), falsifying the broad theory. The
  narrower, verified fact: only the Slot factory needed its own
  `moduleNameMapper` target above the `^@radix-ui/(.*)$` catch-all. Verify a
  mock-resolution theory by deleting and running — don't act on it unverified.
