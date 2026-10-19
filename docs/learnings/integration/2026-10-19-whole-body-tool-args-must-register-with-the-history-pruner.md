---
title: a new tool whose argument is a whole document body must be registered with the model-history pruner
category: integration
tags:
  - nexus
  - context-window
  - tool-history
  - document-generation
severity: medium
date: 2026-10-19
source: auto — issue #1898, PR #1941 (Codex review round 3)
applicable_to: project
---

## What Happened

`generate_document` takes the full markdown body as `args.content`. That
argument is persisted on the tool-call part and re-sent to the model on every
later turn of the conversation. A user who asks for a long report, or for
several documents, pays for every body again on each follow-up, and the
context fills with text the model has already turned into a file.

## Root Cause

`lib/nexus/workspace-tool-history.ts` (#1791 finding 7) stubs superseded
workspace sources in the MODEL-side history, but it only recognises the tools
in `WORKSPACE_SOURCE_TOOLS`. A new tool with the same payload shape is
invisible to it unless added, and nothing fails when it is missing — the
history just grows.

## Solution

The pruner now recognises `generate_document` parts (both the `tool-<name>`
UI shape and the persisted `toolName`/`args` shape), keys every call under
one synthetic object id, treats each as a replacing write, and stubs the
`content` of every call but the newest with a message that says the file was
already delivered — not the workspace stub, which tells the model to call
`read_workspace_content`. Persistence is untouched, so the download card still
renders on reload.

## Prevention

When adding a tool whose input or output carries a whole document, artifact
or file body (≥ 2 KB routinely), wire it into the pruner in the same PR and
pin the behaviour in `lib/nexus/__tests__/workspace-tool-history.test.ts`:
newest kept verbatim, earlier bodies stubbed, part shape and result intact.
Same pattern as the retention sweep: a new heavy payload has to be registered
with the mechanism that bounds it, or it silently escapes.
