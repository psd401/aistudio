---
title: "use server" action files may only export async functions
category: build-errors
tags: [nextjs, server-actions, use-server, build]
severity: medium
date: 2026-06-30
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1083 (agent platform token/cost telemetry) initially exported a plain
constant (`AGENT_MODEL_ID`) from a `"use server"` action file. This broke the
Next.js build.

## Root Cause

Next.js enforces that every export from a file marked `"use server"` must be
an async function (it wraps each export as a server action reference). A
non-function const export violates that constraint and fails the build.

## Solution

Move shared constants used by both server actions and other modules into a
plain (non-`"use server"`) module — e.g. `lib/agents/platform-model.ts` — and
import the constant from there in the action file.

## Prevention

Never add non-async exports (constants, types re-exported as values, etc.) to
a `"use server"` file. If a value needs to be shared across the action file
and other consumers, give it its own plain module.
