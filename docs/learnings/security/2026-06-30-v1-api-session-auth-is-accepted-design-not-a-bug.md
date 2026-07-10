---
title: Session-cookie auth on /api/v1 routes is by design — not a reviewer-flaggable bug
category: security
tags:
  - api-auth
  - session-auth
  - scopes
  - reviewer-feedback
  - openapi
severity: low
date: 2026-06-30
source: auto — /lfg
applicable_to: project
---

## What Happened

During PR #1088 review, a reviewer flagged "reject session auth on content routes" as a finding. `withApiAuth` is intentionally dual-mode (Bearer token OR session cookie) across ALL `/api/v1` routes — a session-authenticated user is assigned `scopes: ["*"]`, but role/ownership checks still apply downstream in the services. `openapi.yaml` documents `sessionAuth` as a first-class scheme alongside bearer auth.

## Root Cause

The reviewer treated a repo-wide, intentional v1 API design decision as a per-PR authorization bug, without checking `withApiAuth`'s dual-mode contract or `openapi.yaml`'s documented `sessionAuth` scheme.

## Solution

No code change — confirmed against `withApiAuth` implementation and `openapi.yaml` that session auth on `/api/v1` is accepted, v1-wide design, and declined the reviewer's suggested change.

## Prevention

- Before acting on a reviewer finding about auth scheme rejection, check whether the pattern is repo-wide/intentional (`withApiAuth`, `openapi.yaml` security schemes) rather than assuming it's a PR-local bug.
- A wildcard scope (`["*"]`) from session auth does not itself grant capabilities — always verify whether downstream role/ownership/capability checks still gate the actual action (see [[publish-gate-bypassed-via-sibling-write-paths]] for a case where a wildcard-derived boolean nearly did bypass a gate).
- See [[automated-reviewer-false-positives]] for the general pattern of verifying reviewer claims against source before acting.
