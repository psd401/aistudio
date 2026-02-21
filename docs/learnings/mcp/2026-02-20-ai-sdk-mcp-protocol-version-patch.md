---
title: "@ai-sdk/mcp Protocol Version Patch"
category: mcp
tags:
  - mcp
  - dependencies
  - protocol-version
  - patch
severity: blocker
date: 2026-02-20
source: auto — /review-pr
---

# @ai-sdk/mcp Protocol Version Patch

## Problem

`@ai-sdk/mcp` 1.0.21 (latest as of 2026-02-20) rejects MCP servers advertising protocol version `2025-11-25`. The SDK only accepts `["2025-06-18", "2025-03-26", "2024-11-05"]`.

Error: `"Server's protocol version is not supported: 2025-11-25"`

This blocked the PSD Data Lambda MCP connector on AWS dev (and locally).

## Solution

Applied a bun patch (`patches/@ai-sdk%2Fmcp@1.0.21.patch`) that:
- Sets `LATEST_PROTOCOL_VERSION` to `"2025-11-25"`
- Keeps `"2025-06-18"` in the supported list for backward compat

## Key facts

- MCP `2025-11-25` is backward compatible with `2025-06-18`
- The patch only extends an allowlist, no logic changes
- Verified on `vercel/ai` main branch (2026-02-20): still no native `2025-11-25` support
- See [../../../patches/README.md](../../../patches/README.md) for removal instructions

## Watch for

- New `@ai-sdk/mcp` releases — check if they add `2025-11-25` natively
- If `bun install` warns about patch conflict after upgrade, check and regenerate or remove
