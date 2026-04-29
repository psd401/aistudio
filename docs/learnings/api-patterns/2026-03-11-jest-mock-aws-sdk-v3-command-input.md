---
title: Jest auto-mock of AWS SDK v3 Command classes loses input property — use mockImplementation to capture
category: api-patterns
tags:
  - dynamodb
  - aws-sdk-v3
  - jest-mocking
  - batch-operations
  - deduplication
severity: medium
date: 2026-03-11
source: auto — /work
applicable_to: project
---

## What Happened

`PIITokenizationService.batchGetTokenMappings` was passing duplicate token IDs to DynamoDB `BatchGetItem`. `text.matchAll` returns every occurrence of a pattern, so repeated tokens produced duplicate keys, which DynamoDB rejects. Tests were also failing to assert on command inputs because Jest auto-mock doesn't preserve the `input` property on AWS SDK v3 Command constructors.

## Root Cause

Two issues combined:
1. Token IDs extracted via `matchAll` were passed directly to `BatchGetItem` without deduplication.
2. `jest.mock('...BatchGetItemCommand')` replaces the constructor with a no-op — the `input` property is never set on the resulting mock instance, so assertions like `expect(mock.calls[0][0].input.RequestItems)` always see `undefined`.

## Solution

- Deduplicate before batching: `[...new Set(tokens)]` prior to constructing `BatchGetItem` keys.
- To assert on command inputs in tests, use `MockedCommand.mockImplementation(function(input) { this.input = input; capturedInputs.push(input); })` so the input is stored on the instance and inspectable after `send()` is called.

## Prevention

- Any time `matchAll` or similar regex iteration feeds into a batch write/get, wrap results in `new Set()` before use.
- When writing tests for AWS SDK v3 commands, always verify mock instances expose `.input` before asserting — if not, apply `mockImplementation` to manually preserve it.
