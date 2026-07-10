---
name: psd-summarize
summary: Records-safe summarization — summarize text with student/personnel content excluded so the summary is safe to retain as a public record.
description: Summarize text while excluding sensitive content (student PII, personnel matters) so what's retained is records-safe. Use to condense a transcript, document, or notes; or when asked to summarize something that may contain private info.
allowed-tools: Bash(node:*)
---

# psd-summarize

Turn source text into a **records-conscious summary** for a public school
district. Sensitive categories are excluded so the summary — which may become a
disclosable public record — doesn't carry raw private detail. This is the
standard place the district's "keep out of records" policy lives; other skills
(e.g. `psd-plaud`) pipe content through it.

It calls the model **directly** (not through AI Studio's logging proxy), so the
**input text is never written to logs**.

## Invoke

    printf '%s' "<text>" | node /opt/psd-skills/psd-summarize/run.js \
      [--profiles students,personnel,topics-only] \
      [--output summary|action-items|decisions|key-topics] \
      [--length brief|standard|detailed] \
      [--context "what this is"]

Pass the source text on **stdin** (safe for large transcripts). Output is
`{"status":"ok","summary":"..."}` on stdout.

## Redaction profiles (combine with commas)

| Profile | Excludes |
|---|---|
| `students` | student names/IDs/PII, discipline, grades, health, family status |
| `personnel` | named staff tied to discipline/performance/complaints/salary/medical |
| `topics-only` | everything except decisions, action items, and topics (no quotes/attribution) |

Default when `--profiles` is omitted: `students,personnel` (conservative).

## Output & length

- `--output` — `summary` (default) · `action-items` · `decisions` · `key-topics`
- `--length` — `brief` · `standard` (default) · `detailed`

## Important

Summarization **reduces** but does **not guarantee** removal of sensitive
content — it's risk-reduction, not a compliance guarantee. Never treat the
output as certified-clean; apply human review for high-stakes records.
