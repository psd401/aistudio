---
name: psd-instructional-vision
summary: Peninsula School District's instructional framework — Instructional Essentials, UDL, and MTSS guidance, answered from the authorized PSD Instructional Essentials knowledge repository.
description: Peninsula School District's instructional framework and pedagogical beliefs. Use when creating graphics about PSD instruction, designing AI assistants for educators, writing about good teaching practices, or sharing PSD's educational philosophy. Answers come from the district's live Instructional Essentials repository, not from bundled text.
allowed-tools: Bash(node:*)
---

# psd-instructional-vision

Answer questions about Peninsula School District's instructional framework from
the caller's authorized **PSD Instructional Essentials** knowledge repository in
AI Studio.

**The framework text is never bundled in this skill.** Teaching & Learning owns
it and revises it. A copy checked into the agent image goes stale the moment
they update it — and a stale copy is worse than none, because it gets quoted
with the same confidence as current guidance. Retrieve, never recall.

---

## Retrieval

This skill has no CLI of its own. Use the `psd-aistudio` skill's repository
commands, which enforce the caller's own scopes and repository ACLs server-side.

```bash
# 1. Find the repository (selection rules below).
node /opt/psd-skills/psd-aistudio/run.js repositories-list \
  --user <email> --query "Instructional Essentials"

# 2. Search it. Prefer hybrid — it handles both district terminology and paraphrase.
node /opt/psd-skills/psd-aistudio/run.js repositories-search \
  --user <email> --query "scaffolding and differentiation look-fors" \
  --repository-ids <id> --mode hybrid

# 3. Pull fuller context for one hit, only when its excerpt is too thin.
node /opt/psd-skills/psd-aistudio/run.js repositories-source \
  --user <email> --repository-id <id> --item-id <itemId>
```

Search first and answer from what comes back. Reach for `repositories-source`
only when an excerpt is genuinely insufficient — do not pull whole documents
into context by default.

## Repository selection

Select an accessible repository whose name contains **"Instructional
Essentials"**, case-insensitively. If several match, prefer the lowest numeric
id, and say which one you used.

**Never hardcode a repository id.** The id differs per environment, so a
hardcoded value silently reads the wrong repository — or nothing at all.

If no repository matches, say plainly that the PSD Instructional Essentials
repository is not available to the caller's account, and do **not** fall back on
remembered framework content. On an unauthorized or insufficient-scope response,
tell the user to **connect AI Studio access**; if they are already connected,
they should reconnect so current repository scopes are authorized.

## What the repository covers

Ask it rather than assuming — Teaching & Learning maintains the item set and it
changes. At time of writing it holds the Instructional Essentials Playbook, the
PSD UDL Big 6, the MTSS Blueprint, Novak's UDL look-fors, the Danielson/UDL
alignment, and the curriculum framework rationale.

## Answering well

- **Cite the source item** for any specific claim, so the reader can go to the
  document Teaching & Learning maintains.
- **Use the district's own language** for framework terms rather than
  paraphrasing them into generic instructional-coach vocabulary.
- **Say when something is not in the repository.** Do not fill the gap from
  general pedagogical knowledge and present it as PSD's position — that is the
  exact failure this skill exists to prevent.
- Building a graphic, slide, or assistant prompt about PSD instruction? Retrieve
  the current framing first. Visual assets and system prompts outlive the text
  they were built from, so an un-retrieved one quietly ships last year's
  framework.

## Exit codes

Surfaced by `psd-aistudio`; see that skill for the full table. The two that
matter here: a non-zero exit with an authorization message means connect or
reconnect AI Studio access, and an empty result set means the repository is
reachable but has nothing matching — report that rather than inventing content.
