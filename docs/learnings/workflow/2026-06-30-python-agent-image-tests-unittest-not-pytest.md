---
title: Python agent-image tests run via unittest (not pytest) and are not CI-gated; stub module-scope imports before importing
category: workflow
tags: [python, unittest, testing, agent-image, mocking]
severity: low
date: 2026-06-30
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1083 added unit tests for `infra/agent-image/mantle_proxy.py` (usage
counter delta logic). The module imports `aiohttp` at module scope, which
isn't present in the local `uv` environment used to run these tests.

## Root Cause

`infra/agent-image` Python tests use plain `unittest`, invoked via `uv run -m
unittest`, and are NOT run in CI (no pytest, no CI gate). Importing
`mantle_proxy` directly fails at collection time because `aiohttp` isn't
installed in the test env, even though the functions under test don't
actually need it.

## Solution

Stub `aiohttp` in `sys.modules` before importing `mantle_proxy`, so the
module-level import succeeds and the pure functions (usage delta math) can be
unit-tested in isolation:
```python
sys.modules["aiohttp"] = MagicMock()
from mantle_proxy import ...  # now safe to import
```

## Prevention

For any `infra/agent-image` Python test file, run with `uv run -m unittest`
(not pytest) and check the module under test for module-scope third-party
imports — stub them in `sys.modules` first if they're not in the local uv
env and not required by the code path being tested. Remember these tests are
not enforced in CI, so they must be run manually before relying on them.
