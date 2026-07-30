---
name: psd-deep-research
summary: Produce cited, multi-source reports with Gemini Deep Research.
description: Research complex topics with Gemini Deep Research and return a cited, multi-source report. Use for deep research, literature reviews, market scans, and evidence synthesis.
allowed-tools: Bash(node:*)
---

# psd-deep-research

Run a paid Gemini Deep Research job through the fixed owner-bound broker. The
shared Google API key remains in the trusted web tier and never enters the
agent process.

**Identity.** Every command requires `--user <caller-email>`. Copy the email
verbatim from the current user turn's `[caller: Name <email>]` header. Never
substitute a selected, remembered, or inferred identity.

## Before Starting

Tell the user that a standard run is district-funded, usually costs about
$1–3, and normally takes 5–20 minutes. Do not promise an exact completion
time. Agent access is the authorization gate; there is intentionally no
separate role/capability gate.

## Start and Wait

```bash
node /opt/psd-skills/psd-deep-research/research.js \
  --user <caller-email> \
  --prompt "<research question>"
```

The command starts a background interaction, checks it about every 20 seconds,
and waits up to 20 minutes by default. Override that cap when needed:

```bash
node /opt/psd-skills/psd-deep-research/research.js \
  --user <caller-email> \
  --prompt "<research question>" \
  --max-wait-min 30
```

Success prints:

```json
{
  "report": "# Research report...",
  "citations": [{ "url": "https://example.org/source", "title": "Source" }],
  "interactionId": "interaction-id",
  "durationMs": 540000
}
```

## Resume

If the command reaches its wait cap, preserve the printed `interactionId` and
resume in a later turn or scheduled run:

```bash
node /opt/psd-skills/psd-deep-research/research.js \
  --user <caller-email> \
  --check <interactionId>
```

`--check` performs one short status request. If the run is still active, use
the returned resume command later; do not start a duplicate paid run.

## Required Reply Format

Relay the full report to the user and preserve its citation URLs. Do not say
research succeeded unless the command returned a completed report. If the
report is too long for a useful chat response, offer to publish the complete
report with `psd-atrium` or `psd-html-artifact` instead of silently truncating
it.

## Errors

- **`user_concurrency`** — this caller already has an active run. Resume the
  existing interaction or wait for it to finish.
- **`deployment_concurrency`** — all deployment run slots are occupied. Ask
  the user to retry after another run finishes.
- **`user_budget`** — the caller's rolling hourly reservation ceiling is
  exhausted. State that no report was created and retry after the window
  resets.
- **`deployment_budget`** — the deployment-wide rolling hourly ceiling is
  exhausted. State that no report was created and retry later.
- **`upstream_error`** — Google, model configuration, or the broker failed.
  Surface the message and interaction id when present. Do not automatically
  start a replacement paid run.

There is no capability-denial error for this skill. Do not invoke
`check-skill-access`.
