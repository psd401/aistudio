---
title: Reproduce and measure prod UI bug reports on dev before writing a fix
category: debugging
tags: [ui, reproduction, measurement, nexus, prod-vs-dev]
severity: medium
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

Working issue #1793 (5 reported layout findings), two of the five did not reproduce on `dev`.
The Share-dialog overflow had already been fixed by an earlier commit (134b5c0f4) that had not
reached the prod build the reporter tested against — a probe that forcibly reverted the
suspected cause still produced zero overflow. The composer textarea's reported "horizontal
scroll" measured `scrollWidth == clientWidth`, `scrollLeft: 0` — never actually overflowed.

## Root Cause

A UI bug report filed against prod can describe a defect that's already fixed on `dev` but
undeployed, or can be inaccurate/stale. Writing a fix from static CSS analysis, without
measuring the live DOM, produced a speculative change with no failing case behind it —
i.e. new technical debt disguised as a defensive fix.

## Solution

For each reported finding: load the actual page on `dev`, measure `scrollWidth` /
`clientWidth` / `scrollLeft` (or the equivalent concrete signal) in the browser, and only write
a fix for findings that reproduce. Revert any speculative fix once a probe disproves the
suspected cause.

## Prevention

- Treat "reported against prod" as a signal to diff against `dev` state first, not to fix
  blind — the defect may already be resolved by a merged-but-undeployed commit.
- Never land a CSS/layout fix without a measured failing case (concrete `scrollWidth` >
  `clientWidth`, etc.) backing it.
